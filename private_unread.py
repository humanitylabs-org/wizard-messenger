"""Issue 302 (switch unread-count): Messenger's own private chats (Marmot, static/app.js) in the phone icon count.

The view keeps a chat's "seen" marker per device (record.seen in localStorage), so the box could not tell which
private chats are unread. The view now also hands the box one mark per chat: the newest message id it has shown,
plus whether the chat is quiet (muted, Medium or Low priority: the same rule as the unified inbox's count). Nothing
else is stored: no names, no text, no peers.

A private chat counts when its newest message was received and is not the seen one. Reading the newest message
needs the unlocked engine. While it is locked (after every box restart, until the owner opens Messenger) the count
keeps the last one worked out while it was unlocked, because the owner cannot have read anything in between: a
fresh 0 would clear the phone's badge while chats are still unread.
"""
import json
import os
import re
import threading
import time
from pathlib import Path

MESSAGE = re.compile('[0-9a-f]{64}')
MAX_CHATS = 1000
TTL = 30.0


class PrivateUnread:
    def __init__(self, path):
        self.path = Path(path) if path else None
        self.lock = threading.Lock()
        self.cache = None  # (count, expires at)
        data = self._read()
        self.marks = data['marks']
        self.last = data['last']

    def _read(self):
        try:
            data = json.loads(self.path.read_text()) if self.path else {}
        except (OSError, ValueError):
            data = {}
        marks = {}
        for group, mark in (data.get('marks') or {}).items() if isinstance(data, dict) else ():
            if isinstance(group, str) and isinstance(mark, dict):
                seen = mark.get('seen')
                marks[group] = {'seen': seen if isinstance(seen, str) and MESSAGE.fullmatch(seen) else None,
                                'quiet': mark.get('quiet') is True}
        last = data.get('last') if isinstance(data, dict) else None
        return {'marks': marks, 'last': last if isinstance(last, int) and not isinstance(last, bool) and last >= 0 else 0}

    def _write(self):
        if not self.path:
            return
        tmp = self.path.with_name(self.path.name + '.tmp')
        tmp.write_text(json.dumps({'marks': self.marks, 'last': self.last}, sort_keys=True))
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    def mark(self, payload, valid_group):
        """POST body {"marks": [{"group": <id>, "seen": <message id>|null, "quiet": bool}, ...]}: merged per chat, so
        two devices each add what they have seen."""
        marks = payload.get('marks') if isinstance(payload, dict) else None
        if not isinstance(marks, list) or not 1 <= len(marks) <= 200 or set(payload) != {'marks'}:
            raise ValueError('Send {"marks": [{"group", "seen", "quiet"}]}')
        clean = {}
        for mark in marks:
            if not isinstance(mark, dict) or set(mark) - {'group', 'seen', 'quiet'}:
                raise ValueError('Send {"group", "seen", "quiet"} per chat')
            group, seen, quiet = mark.get('group'), mark.get('seen'), mark.get('quiet', False)
            valid_group(group)
            if seen is not None and not (isinstance(seen, str) and MESSAGE.fullmatch(seen)):
                raise ValueError('Invalid message identifier')
            if not isinstance(quiet, bool):
                raise ValueError('quiet is true or false')
            clean[group] = {'seen': seen, 'quiet': quiet}
        with self.lock:
            for group, mark in clean.items():
                old = self.marks.get(group) or {}
                # A device that never opened the chat sends seen null: never forget another device's mark.
                self.marks[group] = {'seen': mark['seen'] or old.get('seen'), 'quiet': mark['quiet']}
            while len(self.marks) > MAX_CHATS:
                self.marks.pop(next(iter(self.marks)))
            self.cache = None
            self._write()
        return {'saved': len(clean)}

    def count(self, engine):
        """How many private chats have an unread newest message (a number only)."""
        with self.lock:
            if self.cache and self.cache[1] > time.monotonic():
                return self.cache[0]
            marks = dict(self.marks)
        if engine is None:
            return self.last
        try:
            ready = engine.status().get('state') == 'ready'
        except Exception:
            ready = False
        if not ready:
            return self.last
        try:
            dms = engine.dms().get('dms')
        except Exception:
            return self.last
        if not isinstance(dms, list):
            return self.last
        total = 0
        for dm in dms:
            group = dm.get('group_id') if isinstance(dm, dict) else None
            if not group or dm.get('pending_confirmation'):
                continue
            mark = marks.get(group) or {}
            if mark.get('quiet'):
                continue
            try:
                rows = engine.messages(group, 1).get('messages')
            except Exception:
                continue
            last = rows[-1] if isinstance(rows, list) and rows else None
            if isinstance(last, dict) and last.get('direction') == 'received' and last.get('message_id') != mark.get('seen'):
                total += 1
        with self.lock:
            self.cache = (total, time.monotonic() + TTL)
            if total != self.last:
                self.last = total
                try:
                    self._write()
                except OSError:
                    pass
        return total
