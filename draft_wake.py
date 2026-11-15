"""Messenger wakes the owner's agent when a chat needs a draft (issue 223, switch agent-wake).

Before this, an agent kept drafts ready only by asking messenger_chats_needing_draft on a schedule (a cron job per
owner). With the switch on, an incoming message in a chat with drafts on (or any unread chat when the owner chose
Every unread chat) starts a short wait (about 20 s, so a burst of messages becomes one wake). Then, if the chat still
needs a draft (draft_watch.needing: same rules as the tool), Messenger posts one small signed event to every agent
that the owner gave Draft access and that asked to be woken:

    {"event": "messenger.draft_needed", "chat_id": "...", "reason": "watched" | "unread", "at": <ms>}

Never message text. The agent then does what it does today: messenger_chats_needing_draft, read the thread, save or
update the draft. Nothing is sent by anyone but the owner.

An agent asks to be woken with the messenger_wake_me tool (Draft-only or higher): the URL of its own event inbox (a
Hermes webhook subscription) and that subscription's secret. The post is signed the way Hermes' generic webhook route
checks it: X-Webhook-Timestamp plus X-Webhook-Signature-V2 = hex HMAC-SHA256 of "<timestamp>.<body>". The access the
owner picked is read again at every wake, so turning an agent down to Read-only or No access stops its wakes at once.

When no agent can be woken (none asked, or the post failed), the chat is marked paused and the chat shows a quiet
"Drafts paused" line until a wake gets through again.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

from engine import EngineError
import draft_watch

SWITCH = 'agent-wake'
KEY = 'draft_wake'
DEBOUNCE = 20.0   # seconds of quiet after the newest message before the wake
MAX_WAIT = 60.0   # a chat that never goes quiet is still woken after this long
TIMEOUT = 10
MAX_SUBS = 16
EVENT = 'messenger.draft_needed'
PAUSED_TEXT = {'no_agent': 'No agent with Draft access is set up to be woken.',
               'unreachable': 'Your agent could not be reached.'}


def _load(store):
    try:
        raw = json.loads(store.get(KEY) or 'null')
    except (ValueError, TypeError):
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    subs = raw.get('subs') if isinstance(raw.get('subs'), dict) else {}
    paused = raw.get('paused') if isinstance(raw.get('paused'), dict) else {}
    return {'subs': {k: v for k, v in subs.items() if isinstance(k, str) and isinstance(v, dict)},
            'paused': {k: v for k, v in paused.items() if isinstance(k, str) and isinstance(v, dict)}}


def _save(store, data):
    store.put(KEY, json.dumps(data))


def valid_url(url):
    if not isinstance(url, str) or not 8 <= len(url) <= 500 or any(ord(c) <= 32 for c in url):
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    return parts.scheme in ('http', 'https') and bool(parts.hostname) and not parts.username and not parts.password


def _public(sub):
    return {'url': sub.get('url'), 'since': sub.get('at'), 'last_wake': sub.get('last_wake'),
            'last_error': sub.get('last_error')}


def register(unified, agent, url=None, secret=None, off=False):
    """The agent `agent` ({'id', 'name'}) asks to be woken at `url` (or, with off, stops). The caller already holds
    Draft-only or higher (agent_tools checks the route); the level is checked again at every wake."""
    store = unified.store
    ident = str((agent or {}).get('id') or '')
    if not ident:
        raise EngineError('agent_required', 'Only an agent with its own Messenger access can be woken', 403)
    with store.lock:
        data = _load(store)
        if off:
            data['subs'].pop(ident, None)
            _save(store, data)
            return {'woken': False, 'note': 'Messenger no longer wakes you.'}
        if not valid_url(url):
            raise EngineError('invalid_url', 'url must be an http(s) address of your event inbox', 400)
        if not isinstance(secret, str) or not 16 <= len(secret) <= 256 or any(ord(c) < 33 for c in secret):
            raise EngineError('invalid_secret', 'secret must be the 16..256 character secret of that subscription', 400)
        if ident not in data['subs'] and len(data['subs']) >= MAX_SUBS:
            raise EngineError('wake_limit', 'Too many agents ask to be woken', 409)
        data['subs'][ident] = {'url': url, 'secret': secret, 'name': str((agent or {}).get('name') or '')[:60],
                               'at': int(time.time() * 1000)}
        # Someone can be woken now: chats paused for want of an agent wait for the next message instead.
        data['paused'] = {k: v for k, v in data['paused'].items() if v.get('reason') != 'no_agent'}
        _save(store, data)
        sub = data['subs'][ident]
    return {'woken': True, 'wake': _public(sub),
            'note': 'Messenger now posts {"event": "%s", "chat_id": ...} to this url (signed with X-Webhook-Signature-V2) '
                    'when a chat with drafts on gets a new message. Then call messenger_chats_needing_draft and draft '
                    'there. Never message text in the event.' % EVENT}


def status(unified, agent):
    sub = _load(unified.store)['subs'].get(str((agent or {}).get('id') or ''))
    return {'woken': bool(sub), 'wake': _public(sub) if sub else None}


def paused(unified):
    """chat id -> plain reason, for the chats where the last wake found nobody to wake."""
    if not unified.switch_on(SWITCH):
        return {}
    watch = draft_watch.settings(unified.store)
    return {k: PAUSED_TEXT.get(v.get('reason'), PAUSED_TEXT['unreachable'])
            for k, v in _load(unified.store)['paused'].items() if watch['all_unread'] or k in watch['watched']}


def sign(secret, body, timestamp):
    return hmac.new(secret.encode(), str(timestamp).encode() + b'.' + body, hashlib.sha256).hexdigest()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def post(url, secret, payload):
    """One signed POST. True on a 2xx answer. Never follows a redirect."""
    body = json.dumps(payload, separators=(',', ':')).encode()
    stamp = str(int(time.time()))
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type': 'application/json', 'User-Agent': 'WizardMessenger',
        'X-Request-ID': uuid.uuid4().hex, 'X-Webhook-Timestamp': stamp,
        'X-Webhook-Signature-V2': sign(secret, body, stamp)})
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


class Waker:
    """Debounces incoming messages per chat and wakes the agents. `targets()` -> [(agent id, level)] of the owner's
    current agents; `drafts()` -> the draft rows (both wired by the view server)."""

    def __init__(self, unified, post=post, delay=DEBOUNCE, max_wait=MAX_WAIT, clock=time.monotonic):
        self.unified, self.post, self.delay, self.max_wait, self.clock = unified, post, delay, max_wait, clock
        self.lock = threading.Lock()
        self.timers = {}   # chat id -> (timer, first seen)

    def incoming(self, person_id):
        """A live message from someone else landed in `person_id`. Cheap: no store reads unless the switch is on."""
        if not isinstance(person_id, str) or not self.unified.switch_on(SWITCH):
            return
        settings = draft_watch.settings(self.unified.store)
        if person_id not in settings['watched'] and not settings['all_unread']:
            return
        with self.lock:
            old = self.timers.pop(person_id, None)
            first = old[1] if old else self.clock()
            if old:
                old[0].cancel()
            wait = max(0.0, min(self.delay, first + self.max_wait - self.clock()))
            timer = threading.Timer(wait, self._fire, (person_id,))
            timer.daemon = True
            self.timers[person_id] = (timer, first)
            timer.start()

    def _fire(self, person_id):
        with self.lock:
            self.timers.pop(person_id, None)
        try:
            self.wake(person_id)
        except Exception:
            pass  # a wake is best effort: the agent can still ask messenger_chats_needing_draft

    def close(self):
        with self.lock:
            timers, self.timers = list(self.timers.values()), {}
        for timer, _ in timers:
            timer.cancel()

    def wake(self, person_id):
        """Wake every Draft-access agent that asked, if `person_id` still needs a draft. Returns how many got it."""
        unified = self.unified
        if not unified.switch_on(SWITCH):
            return 0
        rows_fn = getattr(unified, 'wake_drafts', None)
        rows = rows_fn() if callable(rows_fn) else []
        found, _ = draft_watch.needing(unified, rows, limit=100000)
        match = next(((p, reason) for p, _, reason in found if p['id'] == person_id), None)
        store = unified.store
        if match is None:
            with store.lock:
                data = _load(store)
                if data['paused'].pop(person_id, None) is not None:
                    _save(store, data)
            return 0
        levels_fn = getattr(unified, 'wake_levels', None)
        levels = levels_fn() if callable(levels_fn) else {}
        subs = _load(store)['subs']
        targets = [(ident, sub) for ident, sub in subs.items() if levels.get(ident) in ('draft_only', 'draft_and_send')]
        now = int(time.time() * 1000)
        payload = {'event': EVENT, 'chat_id': person_id, 'reason': match[1], 'at': now}
        results = {ident: bool(self.post(sub['url'], sub['secret'], payload)) for ident, sub in targets}
        delivered = sum(results.values())
        with store.lock:
            data = _load(store)
            for ident, ok in results.items():
                sub = data['subs'].get(ident)
                if sub is not None:
                    if ok:
                        sub['last_wake'], sub['last_error'] = now, None
                    else:
                        sub['last_error'] = 'unreachable'
            if delivered:
                data['paused'].pop(person_id, None)
            else:
                data['paused'][person_id] = {'reason': 'unreachable' if targets else 'no_agent', 'at': now}
            _save(store, data)
        return delivered
