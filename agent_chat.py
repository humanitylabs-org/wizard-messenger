"""The owner's agent chat (issue 265; on for everyone since its switch was removed).

One pinned chat with the owner's own agent, kept on the box (people store kv `agent_chat`), never on a network.

- A note: anything the owner writes there is a note to self. The agent never answers it with text. It marks the note
  with a check (seen) once it picked it up (messenger_agent_chat_ack) and works on it in the background.
- Sweep: the owner taps Sweep. The agent answers that one request with ONE post: a numbered list of only what needs
  the owner since the last sweep, each item with the agent's recommendation and up to four buttons (label + value).
  A tap answers that item; the agent carries it out and collapses the item to its result (messenger_agent_chat_done).
- Urgent ping: one line (with an optional link), only for something time-sensitive. It makes the chat unread and
  counts on Messenger's badge.
- Report: a longer write-up. Reports stay out of the chat itself and show in their own Reports chat next to it.
- Photos and voice notes (issue 266): a note can be a photo or a voice note. The file stays on the box (data dir
  `unified/agent-chat/`, dropped with its entry) and the agent fetches it with messenger_agent_chat_attachment.
- Wake (issue 266): a note, a Sweep tap or a button answer wakes every agent that asked with
  messenger_agent_chat_wake_me (a signed event to its own event inbox, never the words), so the tick comes within
  seconds instead of on the agent's schedule.

Quiet-mode guarantee: there is no reply kind. A ping is one short line, a sweep needs an open Sweep request (and
answers it), a report goes to Reports. So a note can never get a text reply in the chat.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

from engine import EngineError

KEY = 'agent_chat'
MAX_ENTRIES = 400
SHOWN = 200
NOTE_MAX = 4000
PING_MAX = 200
REPORT_MAX = 16000
ITEM_MAX = 600
REC_MAX = 300
RESULT_MAX = 300
ITEMS_MAX = 20
BUTTONS_MAX = 4
LABEL_MAX = 24
VALUE_MAX = 64
KINDS = ('ping', 'sweep', 'report')
MEDIA_MAX = 25 * 1024 * 1024
PHOTO_MIME = ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
VOICE_MIME = ('audio/ogg', 'audio/webm', 'audio/mp4', 'audio/wav')
MEDIA_EXT = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/ogg': 'ogg',
             'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/wav': 'wav'}
TRANSCRIPT_MAX = 20000
WAKE_KEY = 'agent_chat_wake'
WAKE_EVENT = 'messenger.agent_chat'
WAKE_DELAY = 1.5   # seconds: a burst (a photo, then a note) becomes one wake
WAKE_SUBS_MAX = 16
WAKE_LEVELS = ('draft_only', 'draft_and_send')   # ticking a note needs Draft-only, so only those are woken


def _now():
    return int(time.time() * 1000)


def _bad(code, message, status=400) -> NoReturn:
    raise EngineError(code, message, status)


def _load(store):
    try:
        raw = json.loads(store.get(KEY) or 'null')
    except (ValueError, TypeError):
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    entries = raw.get('entries') if isinstance(raw.get('entries'), list) else []
    return {'seq': raw.get('seq') if type(raw.get('seq')) is int else 0,
            'read_at': raw.get('read_at') if type(raw.get('read_at')) is int else 0,
            'reports_read_at': raw.get('reports_read_at') if type(raw.get('reports_read_at')) is int else 0,
            'entries': [e for e in entries if isinstance(e, dict) and isinstance(e.get('id'), str)]}


def _media_dir(unified):
    return Path(unified.root) / 'agent-chat'


def _media_path(unified, media):
    name = (media or {}).get('file')
    if not isinstance(name, str) or len(name) != 32 or not all(c in '0123456789abcdef' for c in name):
        return None
    return _media_dir(unified) / name


def _save(store, data, unified=None):
    dropped = data['entries'][:-MAX_ENTRIES] if len(data['entries']) > MAX_ENTRIES else []
    data['entries'] = data['entries'][-MAX_ENTRIES:]
    store.put(KEY, json.dumps(data, ensure_ascii=False))
    # Issue 266: a photo or voice note leaves the box with its entry.
    for e in dropped:
        path = _media_path(unified, e.get('media')) if unified is not None else None
        if path is not None:
            try:
                path.unlink()
            except OSError:
                pass


def _new_id(data, prefix):
    data['seq'] += 1
    return prefix + str(data['seq'])


def _text(value, name, maximum, required=True, one_line=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or '\x00' in value:
        _bad('invalid_' + name, name.capitalize() + ' must be text')
    value = value.strip()
    if one_line:
        value = ' '.join(value.split())
    if not value:
        if required:
            _bad('invalid_' + name, name.capitalize() + ' is empty')
        return None
    if len(value) > maximum:
        _bad('invalid_' + name, '%s is too long (up to %d characters)' % (name.capitalize(), maximum))
    return value


def _link(value):
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) <= 32 for c in value):
        _bad('invalid_link', 'link must be an http(s) address')
    try:
        parts = urlsplit(value)
    except ValueError:
        _bad('invalid_link', 'link must be an http(s) address')
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        _bad('invalid_link', 'link must be an http(s) address')
    return value


def _items(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > ITEMS_MAX:
        _bad('invalid_items', 'items must be a list of up to %d' % ITEMS_MAX)
    out = []
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            _bad('invalid_items', 'Each item must be an object')
        buttons = item.get('buttons') or []
        if not isinstance(buttons, list) or len(buttons) > BUTTONS_MAX:
            _bad('invalid_items', 'Each item has up to %d buttons' % BUTTONS_MAX)
        seen, clean = set(), []
        for b in buttons:
            if not isinstance(b, dict):
                _bad('invalid_items', 'A button is {"label", "value"}')
            label = _text(b.get('label'), 'label', LABEL_MAX, one_line=True)
            value = _text(b.get('value') if b.get('value') is not None else label, 'value', VALUE_MAX, one_line=True)
            if value in seen:
                _bad('invalid_items', 'Two buttons of one item have the same value')
            seen.add(value)
            clean.append({'label': label, 'value': value})
        out.append({'n': i, 'text': _text(item.get('text'), 'item', ITEM_MAX),
                    'recommendation': _text(item.get('recommendation'), 'recommendation', REC_MAX, required=False),
                    'buttons': clean, 'answer': None, 'result': None})
    return out


def _find(data, entry_id):
    for e in data['entries']:
        if e['id'] == entry_id:
            return e
    return None


def _open_sweep(data):
    for e in reversed(data['entries']):
        if e.get('kind') == 'ask' and not e.get('done'):
            return e
    return None


def _last_sweep_at(data):
    for e in reversed(data['entries']):
        if e.get('kind') == 'sweep':
            return e['at']
    return None


# ---- owner (Messenger view; no agent capability maps to /api/unified/agent-chat) ----
def state(unified):
    data = _load(unified.store)
    entries = data['entries']
    posts = [e for e in entries if e.get('by') == 'agent' and e.get('kind') != 'report']
    unread = [e for e in posts if e['at'] > data['read_at']]
    reports = [e for e in entries if e.get('kind') == 'report']
    return {'entries': entries[-SHOWN:], 'unread': len(unread), 'urgent': any(e['kind'] == 'ping' for e in unread),
            'reports_unread': sum(1 for e in reports if e['at'] > data['reports_read_at']),
            'reports_read_at': data['reports_read_at'],
            'sweep_open': _open_sweep(data) is not None, 'read_at': data['read_at'],
            # Is anyone listening (Miguel on issue 265: "how exactly do I use this?"): woken = an agent asked to be
            # woken here; checked = an agent has ever ticked a note or posted.
            'agent': {'woken': bool(_wake_load(unified.store)['subs']),
                      'checked': any(e.get('seen') or e.get('by') == 'agent' for e in entries)}}


def note(unified, payload):
    body = _text((payload or {}).get('text'), 'note', NOTE_MAX)
    store = unified.store
    with store.lock:
        data = _load(store)
        entry = {'id': _new_id(data, 'n'), 'kind': 'note', 'by': 'owner', 'text': body, 'at': _now(), 'seen': None}
        data['entries'].append(entry)
        data['read_at'] = max(data['read_at'], entry['at'])
        _save(store, data, unified)
    wake(unified, 'note')
    return state(unified)


def media_note(unified, raw, query=None):
    """Issue 266: a photo or voice note (raw bytes, type sniffed here, never taken from the client)."""
    from unified import sniff
    q = lambda k: ((query or {}).get(k) or [None])[0]
    kind = q('kind')
    if kind not in ('photo', 'voice'):
        _bad('invalid_upload', 'Choose a photo or a voice note')
    data = raw or b''
    if not 0 < len(data) <= MEDIA_MAX:
        _bad('too_large', 'Photos and voice notes up to 25 MB', 413)
    mime = sniff(data)
    if kind == 'voice' and mime == 'video/mp4':
        mime = 'audio/mp4'  # Safari records voice into an mp4 container
    if mime not in (PHOTO_MIME if kind == 'photo' else VOICE_MIME):
        _bad('invalid_upload', 'That file type is not supported here', 415)
    media = {'type': kind, 'mime': mime, 'size': len(data), 'file': secrets.token_hex(16)}
    if kind == 'voice':
        duration = q('duration')
        if duration and duration.isdigit() and 0 < int(duration) <= 4 * 3600 * 1000:
            media['duration'] = int(duration)
        elif mime == 'audio/wav' and len(data) > 44 and int.from_bytes(data[28:32], 'little'):
            media['duration'] = (len(data) - 44) * 1000 // int.from_bytes(data[28:32], 'little')  # header byte rate
    folder = _media_dir(unified)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = folder / media['file']
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    store = unified.store
    with store.lock:
        loaded = _load(store)
        entry = {'id': _new_id(loaded, 'n'), 'kind': 'note', 'by': 'owner', 'text': '', 'media': media, 'at': _now(),
                 'seen': None}
        loaded['entries'].append(entry)
        loaded['read_at'] = max(loaded['read_at'], entry['at'])
        _save(store, loaded, unified)
    wake(unified, 'note')
    return state(unified)


def media_blob(unified, entry_id):
    """The file of a photo or voice note (owner view, and the agent's attachment tool)."""
    from unified import Blob
    e = _find(_load(unified.store), entry_id) if isinstance(entry_id, str) else None
    media = (e or {}).get('media') if (e or {}).get('kind') == 'note' else None
    path = _media_path(unified, media)
    if path is None or not path.is_file():
        _bad('not_found', 'That photo or voice note is gone', 404)
    return Blob(path, media['mime'], 'photo.' + MEDIA_EXT.get(media['mime'], 'bin') if media['type'] == 'photo'
                else 'voice-note.' + MEDIA_EXT.get(media['mime'], 'bin'), True)


def transcript(unified, payload):
    """The owner's view transcribed a voice note (Wizard's own transcription): kept for the agent."""
    payload = payload or {}
    entry_id = payload.get('id')
    body = _text(payload.get('text'), 'transcript', TRANSCRIPT_MAX)
    store = unified.store
    with store.lock:
        data = _load(store)
        e = _find(data, entry_id) if isinstance(entry_id, str) else None
        if e is None or e.get('kind') != 'note' or (e.get('media') or {}).get('type') != 'voice':
            _bad('not_found', 'That voice note is gone', 404)
        e['media']['transcript'] = body
        _save(store, data, unified)
    return state(unified)


def sweep(unified):
    store = unified.store
    asked = False
    with store.lock:
        data = _load(store)
        if _open_sweep(data) is None:
            at = _now()
            data['entries'].append({'id': _new_id(data, 's'), 'kind': 'ask', 'ask': 'sweep', 'by': 'owner', 'at': at,
                                    'since': _last_sweep_at(data), 'seen': None, 'done': None})
            data['read_at'] = max(data['read_at'], at)
            _save(store, data, unified)
            asked = True
    if asked:
        wake(unified, 'sweep')
    return state(unified)


def answer(unified, payload):
    payload = payload or {}
    post_id, n, value = payload.get('post_id'), payload.get('item'), payload.get('value')
    if not isinstance(post_id, str) or type(n) is not int or not isinstance(value, str):
        _bad('invalid_answer', 'Choose one of the item\'s buttons')
    store = unified.store
    with store.lock:
        data = _load(store)
        post = _find(data, post_id)
        item = next((i for i in (post or {}).get('items') or [] if i.get('n') == n), None)
        if post is None or post.get('by') != 'agent' or item is None:
            _bad('not_found', 'That item is gone', 404)
        button = next((b for b in item.get('buttons') or [] if b.get('value') == value), None)
        if button is None:
            _bad('invalid_answer', 'Choose one of the item\'s buttons')
        if item.get('result') or (item.get('answer') or {}).get('seen'):
            _bad('already_answered', 'Your agent is already on it', 409)
        item['answer'] = {'label': button['label'], 'value': value, 'at': _now(), 'seen': None}
        _save(store, data, unified)
    wake(unified, 'answer')
    return state(unified)


def read(unified, payload=None):
    reports = (payload or {}).get('reports') is True
    store = unified.store
    with store.lock:
        data = _load(store)
        data['reports_read_at' if reports else 'read_at'] = _now()
        _save(store, data, unified)
    return state(unified)


def dispatch(unified, method, suffix, payload, query=None, raw=None):
    if suffix == [] and method == 'GET':
        return state(unified)
    if suffix == [] and method == 'POST':
        return note(unified, payload)
    if suffix == ['media'] and method == 'PUT':
        return media_note(unified, raw, query)
    if len(suffix) == 2 and suffix[0] == 'media' and method == 'GET':
        return media_blob(unified, suffix[1])
    if suffix == ['transcript'] and method == 'POST':
        return transcript(unified, payload)
    if suffix == ['sweep'] and method == 'POST':
        return sweep(unified)
    if suffix == ['answer'] and method == 'POST':
        return answer(unified, payload)
    if suffix == ['read'] and method == 'POST':
        return read(unified, payload)
    _bad('not_found', 'No such agent chat route', 404)


# ---- agent (MCP tools) ----
def inbox(unified):
    data = _load(unified.store)
    notes, sweeps, answers = [], [], []
    for e in data['entries']:
        if e.get('kind') == 'note' and not e.get('seen'):
            item = {'id': e['id'], 'text': e['text'], 'at': e['at']}
            media = e.get('media')
            if isinstance(media, dict):
                item['attachment'] = {k: media[k] for k in ('type', 'mime', 'size', 'duration', 'transcript') if media.get(k)}
                item['attachment']['fetch'] = {'tool': 'messenger_agent_chat_attachment', 'note_id': e['id']}
            notes.append(item)
        elif e.get('kind') == 'ask' and not e.get('done'):
            sweeps.append({'id': e['id'], 'at': e['at'], 'since': e.get('since')})
        elif e.get('by') == 'agent':
            for i in e.get('items') or []:
                a = i.get('answer')
                if a and not a.get('seen') and not i.get('result'):
                    answers.append({'id': '%s/%d' % (e['id'], i['n']), 'post_id': e['id'], 'item': i['n'],
                                    'item_text': i['text'], 'answer': a['value'], 'label': a['label'], 'at': a['at']})
    return {'notes': notes, 'sweep_requests': sweeps, 'answers': answers}


def ack(unified, agent, ids):
    if not isinstance(ids, list) or not ids or not all(isinstance(x, str) for x in ids):
        _bad('invalid_arguments', 'ids: the note and answer ids to mark as picked up')
    store, marked, unknown = unified.store, [], []
    with store.lock:
        data = _load(store)
        now = _now()
        for raw in ids[:100]:
            entry_id, _, n = raw.partition('/')
            e = _find(data, entry_id)
            if e is not None and n == '' and e.get('kind') == 'note':
                if not e.get('seen'):
                    e['seen'] = {'at': now, 'by': agent}
                marked.append(raw)
                continue
            if e is not None and n.isdigit() and e.get('by') == 'agent':
                item = next((i for i in e.get('items') or [] if i.get('n') == int(n)), None)
                if item and item.get('answer'):
                    item['answer']['seen'] = item['answer'].get('seen') or now
                    marked.append(raw)
                    continue
            unknown.append(raw)
        _save(store, data, unified)
    return {'picked_up': marked, 'unknown': unknown}


def post(unified, agent, kind, text, link=None, items=None):
    if kind not in KINDS:
        _bad('invalid_arguments', 'kind must be ping, sweep or report')
    if kind == 'ping':
        if items:
            _bad('invalid_arguments', 'An urgent ping is one line: no items')
        body = _text(text, 'text', PING_MAX, one_line=True)
        clean = []
    elif kind == 'sweep':
        body = _text(text, 'text', ITEM_MAX, required=False) or ''
        clean = _items(items)
        if not clean and not body:
            body = 'Nothing needs you right now.'
    else:
        if items:
            _bad('invalid_arguments', 'A report has no buttons')
        body = _text(text, 'text', REPORT_MAX)
        clean = []
    url = _link(link)
    store = unified.store
    with store.lock:
        data = _load(store)
        entry = {'id': _new_id(data, 'p'), 'kind': kind, 'by': 'agent', 'agent': agent, 'text': body, 'link': url,
                 'items': clean, 'at': _now()}
        if kind == 'sweep':
            ask = _open_sweep(data)
            if ask is None:
                _bad('no_sweep_asked', 'The owner has not tapped Sweep. Post a sweep only as the answer to a sweep '
                     'request; for something that cannot wait, post one urgent ping.', 409)
            ask['done'] = entry['id']
            ask['seen'] = ask.get('seen') or {'at': entry['at'], 'by': agent}
            entry['reply_to'] = ask['id']
        data['entries'].append(entry)
        _save(store, data, unified)
    return {'posted': entry['id'], 'kind': kind}


def done(unified, post_id, n, result):
    result = _text(result, 'result', RESULT_MAX, one_line=True)
    store = unified.store
    with store.lock:
        data = _load(store)
        e = _find(data, post_id) if isinstance(post_id, str) else None
        item = next((i for i in (e or {}).get('items') or [] if i.get('n') == n), None)
        if e is None or e.get('by') != 'agent' or item is None:
            _bad('not_found', 'No such sweep item', 404)
        item['result'] = result
        if item.get('answer'):
            item['answer']['seen'] = item['answer'].get('seen') or _now()
        _save(store, data, unified)
    return {'done': '%s/%d' % (post_id, n)}



def attachment(unified, note_id):
    """Issue 266: the details and the file of a photo or voice note, for messenger_agent_chat_attachment."""
    e = _find(_load(unified.store), note_id) if isinstance(note_id, str) else None
    media = (e or {}).get('media') if (e or {}).get('kind') == 'note' else None
    if not isinstance(media, dict):
        _bad('not_found', 'That note has no photo or voice note', 404)
    blob = media_blob(unified, note_id)
    meta = {k: media[k] for k in ('type', 'mime', 'size', 'duration', 'transcript') if media.get(k)}
    meta.update(note_id=note_id, at=e['at'], seen=bool(e.get('seen')))
    return meta, blob


# ---- wake (issue 266): the agent hears about a note, a Sweep tap or an answer within seconds ----
def _wake_load(store):
    try:
        raw = json.loads(store.get(WAKE_KEY) or 'null')
    except (ValueError, TypeError):
        raw = None
    subs = raw.get('subs') if isinstance(raw, dict) and isinstance(raw.get('subs'), dict) else {}
    return {'subs': {k: v for k, v in subs.items() if isinstance(k, str) and isinstance(v, dict)}}


def _wake_public(sub):
    return {'url': sub.get('url'), 'since': sub.get('at'), 'last_wake': sub.get('last_wake'),
            'last_error': sub.get('last_error')}


def wake_register(unified, agent, url=None, secret=None, off=False):
    """The agent ({'id', 'name'}) asks to be woken at `url` (a Hermes webhook subscription) with its secret, or stops."""
    import draft_wake
    store, ident = unified.store, str((agent or {}).get('id') or '')
    if not ident:
        _bad('agent_required', 'Only an agent with its own Messenger access can be woken', 403)
    with store.lock:
        data = _wake_load(store)
        if off:
            data['subs'].pop(ident, None)
            store.put(WAKE_KEY, json.dumps(data))
            return {'woken': False, 'note': 'Messenger no longer wakes you for the Agent chat.'}
        if not draft_wake.valid_url(url):
            _bad('invalid_url', 'url must be an http(s) address of your event inbox')
        if not isinstance(secret, str) or not 16 <= len(secret) <= 256 or any(ord(c) < 33 for c in secret):
            _bad('invalid_secret', 'secret must be the 16..256 character secret of that subscription')
        if ident not in data['subs'] and len(data['subs']) >= WAKE_SUBS_MAX:
            _bad('wake_limit', 'Too many agents ask to be woken', 409)
        data['subs'][ident] = {'url': url, 'secret': secret, 'name': str((agent or {}).get('name') or '')[:60],
                               'at': _now()}
        store.put(WAKE_KEY, json.dumps(data))
        sub = data['subs'][ident]
    return {'woken': True, 'wake': _wake_public(sub),
            'note': 'Messenger now posts {"event": "%s", "reason": "note" | "sweep" | "answer", "waiting": {...}} to '
                    'this url (signed with X-Webhook-Signature-V2) when something waits for you in the Agent chat. '
                    'Then call messenger_agent_chat_inbox. Never the words in the event.' % WAKE_EVENT}


def wake_status(unified, agent):
    sub = _wake_load(unified.store)['subs'].get(str((agent or {}).get('id') or ''))
    return {'woken': bool(sub), 'wake': _wake_public(sub) if sub else None}


class Waker:
    """One short wait (WAKE_DELAY) so a burst becomes one wake, then a signed post to every agent that asked and that
    the owner gives Draft-only or higher right now. Best effort: the agent can still check its inbox itself."""

    def __init__(self, unified, post=None, delay=WAKE_DELAY):
        import draft_wake
        self.unified, self.post, self.delay = unified, post or draft_wake.post, delay
        self.lock, self.timer, self.reasons = threading.Lock(), None, []

    def poke(self, reason):
        with self.lock:
            if reason not in self.reasons:
                self.reasons.append(reason)
            if self.timer is None:
                self.timer = threading.Timer(self.delay, self._fire)
                self.timer.daemon = True
                self.timer.start()

    def _fire(self):
        with self.lock:
            reasons, self.reasons, self.timer = self.reasons, [], None
        try:
            self.wake(reasons)
        except Exception:
            pass

    def close(self):
        with self.lock:
            timer, self.timer = self.timer, None
        if timer is not None:
            timer.cancel()

    def wake(self, reasons):
        unified = self.unified
        levels_fn = getattr(unified, 'wake_levels', None)
        levels = levels_fn() if callable(levels_fn) else {}
        subs = _wake_load(unified.store)['subs']
        targets = [(ident, sub) for ident, sub in subs.items() if levels.get(ident) in WAKE_LEVELS]
        if not targets:
            return 0
        waiting = inbox(unified)
        counts = {k: len(waiting[k]) for k in ('notes', 'sweep_requests', 'answers')}
        if not any(counts.values()):
            return 0
        now = _now()
        payload = {'event': WAKE_EVENT, 'reason': (reasons or ['note'])[0], 'reasons': reasons or ['note'],
                   'waiting': counts, 'at': now}
        results = {ident: bool(self.post(sub['url'], sub['secret'], payload)) for ident, sub in targets}
        store = unified.store
        with store.lock:
            data = _wake_load(store)
            for ident, ok in results.items():
                sub = data['subs'].get(ident)
                if sub is not None:
                    sub.update({'last_wake': now, 'last_error': None} if ok else {'last_error': 'unreachable'})
            store.put(WAKE_KEY, json.dumps(data))
        return sum(results.values())


def wake(unified, reason):
    """Something now waits for the agent. Cheap when nobody asked to be woken."""
    try:
        if not _wake_load(unified.store)['subs']:
            return
        waker = unified.__dict__.get('agent_chat_waker')
        if waker is None:
            waker = unified.__dict__.setdefault('agent_chat_waker', Waker(unified))
        waker.poke(reason)
    except Exception:
        pass  # a wake never fails the owner's note
