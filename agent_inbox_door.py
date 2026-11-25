"""Messenger's Agent chat as a door to the box's one agent inbox (issue 325, on for everyone).

The Agent Service keeps one agent inbox on the box (wizard-agent-service docs/agent-inbox.md, "App doors", issue 569).
When that inbox is on (the box switch `wizard/agent-inbox`, the only off switch), the Agent chat stops keeping its own
task list:

- Probe: `GET /wizard/v1/agent-inbox/doors` with Messenger's own app token, at most every PROBE_EVERY seconds.
  200 = door mode. 404 (the owner's inbox is off), a refusal, no token or no answer = the Agent chat as it was.
- Notes: each new note (text, link, photo, voice) goes to the box once as a capture with
  `source: {app: 'messenger', item_id: <note id>}`. The Service dedupes on that, so a resend never adds a record. The
  note gets its tick when the box returns the record. Photos and voice stay here; the worker fetches them with
  messenger_agent_chat_attachment.
- Sweep: the Sweep button asks the box for the card (`POST .../sweep {door: 'messenger'}`) and keeps it as the sweep
  post. A button answers that record on the box (`PATCH .../<record id>`), Yes to all posts to the card. Answers
  given in Daily show here when the card is read again (`GET .../sweep`).
- Background: `watch()` runs a pass every REFRESH_EVERY seconds on the box itself, so none of this waits for the
  page to be open (an urgent alert must not sit unread while Messenger is closed).
- Pings: urgent alerts the box already decided (`GET .../pings?keep=1`, after `POST .../doors {pings: true}`) arrive
  as the Agent chat's one-line ping. Each is acked (`POST .../pings {ack}`) only after it is stored here.

Every call is best effort and bounded by TIMEOUT: the Service is on the same box. Without an app token nothing here
runs, and with the box inbox off (any answer but 200 `on: true`) the Agent chat is exactly what it was.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = 'messenger'
BASE = 'http://wizard-agent-service:8787'
PATH = '/wizard/v1/agent-inbox'
TIMEOUT = 6
PROBE_EVERY = 180       # seconds between door probes ("on start and every few minutes")
REFRESH_EVERY = 15      # seconds between background passes (resends, pings, the card's current state)
VOICE_WAIT = 60         # seconds a voice note waits for its transcript before it goes without one
PING_MAX = 200


def _now():
    return int(time.time() * 1000)


def _token():
    value = os.environ.get('MESSENGER_AGENT_INBOX_TOKEN', '').strip()
    if value:
        return value
    path = os.environ.get('MESSENGER_AGENT_INBOX_TOKEN_FILE', '').strip()
    if path:
        try:
            return Path(path).read_text().strip()
        except OSError:
            return ''
    return ''


def http_call(base, token, method, path, body=None):
    """(status, json or None). status 0 = no answer."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base.rstrip('/') + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/json',
        **({'Content-Type': 'application/json'} if data is not None else {})})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            status, raw = response.status, response.read(1024 * 1024)
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read(64 * 1024) if e.fp else b''
    except (OSError, ValueError):
        return 0, None
    try:
        return status, json.loads(raw or b'null')
    except ValueError:
        return status, None


class Door:
    """One per UnifiedInbox (`unified.agent_inbox_door`). `call(method, path, body)` is swappable for tests."""

    def __init__(self, unified, call=None, base=None, token=None):
        self.unified = unified
        self.base = base or os.environ.get('MESSENGER_AGENT_SERVICE', '').strip() or BASE
        self.token = token
        self.call_fn = call
        self.lock = threading.Lock()
        self.probed_at = 0.0
        self.is_open = False
        self.pings = False
        self.passed_at = 0.0
        self.running = False
        self.box_off = False

    # ---- the Service ----
    def call(self, method, path, body=None):
        if self.call_fn is not None:
            return self.call_fn(method, path, body)
        token = self.token if self.token is not None else _token()
        if not token:
            return 0, None
        return http_call(self.base, token, method, PATH + path, body)

    def enabled(self):
        """Can this door reach the Service at all (Messenger has its app token)? Without one nothing here runs."""
        if self.call_fn is not None:
            return True
        return bool(self.token if self.token is not None else _token())

    def probe(self, force=False):
        """Door mode right now (cached for PROBE_EVERY seconds). Never true without a token."""
        if not self.enabled():
            self.is_open, self.box_off = False, False
            return False
        if not force and time.time() - self.probed_at < PROBE_EVERY:
            return self.is_open
        status, body = self.call('GET', '/doors')
        self.probed_at = time.time()
        self.is_open = status == 200 and isinstance(body, dict) and body.get('on') is True
        # The box said clearly that its inbox is off (the owner's wizard/agent-inbox switch): 404, or 200 without on.
        self.box_off = not self.is_open and status in (200, 404)
        if self.is_open and body.get('pings') is not True:
            status, body = self.call('POST', '/doors', {'pings': True})
            self.pings = status == 200 and isinstance(body, dict) and body.get('pings') is True
        elif self.is_open:
            self.pings = True
        return self.is_open

    def opened(self):
        """Door mode as last probed, without a call (for the owner's state and the agent's own inbox)."""
        return self.enabled() and self.is_open

    # ---- background pass: resend notes, take pings, read the card again ----
    def kick(self, force=False):
        if not self.enabled():
            return
        with self.lock:
            if self.running or (not force and time.time() - self.passed_at < REFRESH_EVERY):
                return
            self.running, self.passed_at = True, time.time()
        thread = threading.Thread(target=self._pass, name='agent-inbox-door', daemon=True)
        thread.start()

    def _pass(self):
        try:
            self.run_pass()
        except Exception:
            pass
        finally:
            with self.lock:
                self.running = False

    def run_pass(self):
        import agent_chat
        if not self.probe():
            # The owner turned the box inbox off: every waiting note goes back to Messenger's agent, also one whose
            # capture already went out. No answer or an unclear one: a tried note waits to be sent again.
            agent_chat.door_release(self.unified, switched_off=self.box_off or not self.enabled())
            return
        for entry in agent_chat.door_pending(self.unified):
            self.capture(entry)
        if self.pings:
            self.take_pings()
        status, body = self.call('GET', '/sweep')
        if status == 200 and isinstance(body, dict) and isinstance(body.get('card'), dict):
            agent_chat.door_card(self.unified, body['card'])

    def take_pings(self):
        """Urgent alerts from the box. The box hands a ping out until it is acked, so each one is acked only after it
        is stored in the chat: a lost answer, a crash or a failed store in between gets the same ping next pass."""
        import agent_chat
        status, body = self.call('GET', '/pings?keep=1')   # read without consuming; ack below
        if status != 200 or not isinstance(body, dict):
            return []
        stored = []
        for ping in body.get('pings') or []:
            try:
                if agent_chat.door_ping(self.unified, ping) is not None:
                    stored.append(ping['id'])
            except Exception:
                continue   # not stored: not acked, so it comes again
        if stored:
            self.call('POST', '/pings', {'ack': stored[:500]})
        return stored

    def capture(self, entry):
        import agent_chat
        text = agent_chat.door_text(entry)
        if text is None:
            return False   # a voice note still waiting for its words
        # Once a capture is on its way the box may make the record even if its answer is lost, so this note never goes
        # back to Messenger's own agent on a failed probe; it is sent again with the same item id (the box dedupes).
        agent_chat.door_tried(self.unified, entry['id'])
        status, body = self.call('POST', '', {'source': {'app': APP, 'item_id': entry['id']}, 'text': text,
                                              'title': text.split('\n')[0][:120]})
        record = body.get('record') if isinstance(body, dict) else None
        if status in (200, 201) and isinstance(record, dict) and isinstance(record.get('id'), str):
            agent_chat.door_captured(self.unified, entry['id'], record['id'])
            return True
        if status in (400, 401, 403, 404, 413, 415):
            # A clear refusal: the box made no record, so the note may go back to Messenger's agent as before.
            agent_chat.door_tried(self.unified, entry['id'], False)
        if status == 404:
            self.is_open = False
        return False

    # ---- the owner's taps (the view waits for these) ----
    def sweep(self):
        status, body = self.call('POST', '/sweep', {'door': APP})
        card = body.get('card') if isinstance(body, dict) else None
        if status in (200, 201) and isinstance(card, dict) and isinstance(card.get('id'), str):
            return card
        if status == 404:
            self.is_open = False
        return None

    def answer(self, record_id, option):
        return self.call('PATCH', '/' + record_id, {'action': 'answer', 'option': option})

    def yes_to_all(self, card_id):
        return self.call('POST', '/' + card_id + '/yes-to-all', {})

    def card(self):
        status, body = self.call('GET', '/sweep')
        return body.get('card') if status == 200 and isinstance(body, dict) and isinstance(body.get('card'), dict) else None


def watch(unified):
    """The door's own loop on the box (started with the inbox), so notes go out and urgent alerts arrive as pings,
    with their unread badge and phone notification, while Messenger is closed too: the first pass probes at start,
    then a pass every REFRESH_EVERY seconds (the probe itself is cached for PROBE_EVERY). Without a token it does
    nothing."""
    stop = getattr(unified, 'stop', None)

    def loop():
        while not (stop is not None and stop.is_set()):
            try:
                found = door(unified)
                if found is not None:
                    found.kick()
            except Exception:
                pass
            if stop is not None:
                stop.wait(REFRESH_EVERY)
            else:
                time.sleep(REFRESH_EVERY)

    thread = threading.Thread(target=loop, name='agent-inbox-door-watch', daemon=True)
    thread.start()
    return thread


def door(unified):
    """The inbox's door (made on first use), or None for a bare inbox in a test."""
    if unified is None:
        return None
    found = unified.__dict__.get('agent_inbox_door')
    if found is None:
        found = unified.__dict__.setdefault('agent_inbox_door', Door(unified))
    return found
