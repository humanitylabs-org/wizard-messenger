"""Messages on the phone (issue 308, on for everyone).

Messenger posts one item to the Notifications app for each new incoming message, and one for
each urgent Agent chat ping. Each item is tagged `app:messenger` (the Notifications `notify` tool's `app`), so the
Wizard phone app (wizard-ux switch wizard/phone-app-notifications) shows it as a Messenger notification on its own
Android channel, and a tap opens the item's link: this Wizard's Messenger at `#chat=<chat id>`.

- Quiet chats never notify: muted, Medium and Low priority chats, and WhatsApp Status updates (the same rule as the
  unread count and the Wizard inbox feed). A message already read (last_read_ts) or older than MAX_AGE (a backlog
  after a reconnect) does not notify either.
- The item carries the chat name as title and the start of the message (the inbox feed's preview line), never more.
- Delivery is best effort and off the sync thread: a bounded queue and one worker thread call the Notifications
  app's MCP `notify` tool on the box (uses: notifications in wizard.md, so the App Manager links the two apps).
  A failed post is dropped, never retried into a flood.
- The link needs this Wizard's own https address, which the box can't see: the view tells it (`POST
  api/unified/phone-notify` {base}) once per page. Until then the item has no link and a tap opens
  Messenger itself.
"""
from __future__ import annotations

import json
import os
import queue
import re
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

APP = 'messenger'
NOTIFY_URL = os.environ.get('MESSENGER_NOTIFICATIONS_URL', 'http://notifications:8080/mcp')
KV_BASE = 'phone_notify_base'
TITLE_MAX = 120
TEXT_MAX = 200
MAX_AGE_MS = 10 * 60 * 1000
QUEUE_MAX = 100
SENT_MAX = 500
AGENT_CHAT = 'agent:notes'
CHAT_ID = re.compile(r'[A-Za-z0-9_-]{1,64}|agent:notes|agent:reports')

ROW_SQL = '''
SELECT m.id, m.outgoing, m.deleted, m.original, m.msgtype, m.media, m.sender, m.timestamp,
       i.id AS identity_id, i.person_id, i.kind, i.last_read_ts, p.display_name, p.muted, p.low_priority,
       p.medium_priority
FROM message m JOIN identity i ON i.id = m.identity_id JOIN person p ON p.id = i.person_id
WHERE m.id = ?
'''


def clip(text, limit):
    text = ' '.join(str(text or '').split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def clean_base(value):
    """The view's own Messenger address (e.g. https://box.ts.net/messenger/), or None. Only a plain https address
    with no user, query or fragment; the path always ends with '/'."""
    if not isinstance(value, str) or len(value) > 500 or any(c.isspace() or ord(c) < 32 for c in value):
        return None
    try:
        u = urlsplit(value)
        port = u.port
    except ValueError:
        return None
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment:
        return None
    path = u.path or '/'
    if not path.endswith('/'):
        path = path.rsplit('/', 1)[0] + '/'
    return 'https://' + u.hostname + (':%d' % port if port else '') + path


def chat_link(base, chat_id):
    if not base or not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id):
        return ''
    return base + '#chat=' + chat_id


def message_note(store, message_id, now_ms=None):
    """The Notifications item for one stored message, or None when it must stay quiet."""
    from inbox_feed import preview
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    with store.db() as db:
        row = db.execute(ROW_SQL, (message_id,)).fetchone()
        if not row:
            return None
        status = row['identity_id'] in store.status_identities(db)
    if row['outgoing'] or row['deleted'] or row['muted'] or row['low_priority'] or row['medium_priority']:
        return None
    if row['kind'] not in ('person', 'group') or status:
        return None
    if row['timestamp'] <= (row['last_read_ts'] or 0) or now_ms - row['timestamp'] > MAX_AGE_MS:
        return None
    text = preview(dict(row, status_chat=False))
    return {'key': row['id'], 'chat': row['person_id'], 'title': clip(row['display_name'] or 'Messenger', TITLE_MAX),
            'message': clip(text, TEXT_MAX) or 'New message', 'priority': 'default'}


def ping_note(text, key, name=None):
    """An urgent Agent chat ping: high priority, opens the Agent chat."""
    return {'key': key, 'chat': AGENT_CHAT, 'title': clip(name or 'Agent', TITLE_MAX),
            'message': clip(text, TEXT_MAX) or 'Urgent', 'priority': 'high'}


def arguments(note, base):
    """The Notifications `notify` tool's arguments for one note."""
    args = {'title': note['title'], 'message': note['message'], 'priority': note['priority'], 'app': APP}
    link = chat_link(base, note.get('chat'))
    if link:
        args['link'] = link
    return args


def post(args, url=NOTIFY_URL, timeout=10):
    """One MCP tools/call to the Notifications app. True when it took the item."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': 'notify', 'arguments': args}}).encode()
    req = Request(url, data=body, method='POST', headers={'Content-Type': 'application/json',
                                                          'Accept': 'application/json, text/event-stream'})
    with urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed box-internal URL
        text = r.read(65536).decode('utf-8', 'replace')
    return '"result"' in text and '"isError":true' not in text.replace(' ', '')


class Notifier:
    """One worker thread and a bounded queue, so the sync thread never waits on Notifications."""

    def __init__(self, unified, send=None):
        self.unified = unified
        self.send = send or post
        self.queue = queue.Queue(maxsize=QUEUE_MAX)
        self.sent = []
        self.lock = threading.Lock()
        self.thread = None
        self.stats = {'posted': 0, 'failed': 0, 'dropped': 0}

    def base(self):
        try:
            return clean_base(self.unified.store.get(KV_BASE) or '')
        except Exception:
            return None

    def add(self, note):
        if not note:
            return False
        with self.lock:
            if note['key'] in self.sent:
                return False
            self.sent = (self.sent + [note['key']])[-SENT_MAX:]
            if self.thread is None or not self.thread.is_alive():
                self.thread = threading.Thread(target=self.run, name='phone-notify', daemon=True)
                self.thread.start()
        try:
            self.queue.put_nowait(note)
            return True
        except queue.Full:
            self.stats['dropped'] += 1
            return False

    def run(self):
        while True:
            note = self.queue.get()
            if note is None:
                return
            self.deliver(note)

    def deliver(self, note):
        try:
            ok = self.send(arguments(note, self.base()))
        except Exception:
            ok = False
        self.stats['posted' if ok else 'failed'] += 1
        return ok


def notifier(unified):
    n = getattr(unified, 'phone_notifier', None)
    if n is None:
        n = unified.__dict__.setdefault('phone_notifier', Notifier(unified))
    return n


def incoming(unified, message_id):
    """A live incoming message was stored: post it when the chat isn't quiet."""
    return notifier(unified).add(message_note(unified.store, message_id))


def urgent(unified, entry_id, text, name=None):
    """The agent posted an urgent ping in the Agent chat."""
    return notifier(unified).add(ping_note(text, 'agent-chat:' + str(entry_id), name))


def dispatch(unified, method, payload):
    """Owner route api/unified/phone-notify: GET {on, base}; POST {base} remembers the view's own address."""
    if method == 'GET':
        return {'on': True, 'base': clean_base(unified.store.get(KV_BASE) or '') or None}
    if method == 'POST':
        from engine import EngineError
        base = clean_base((payload or {}).get('base'))
        if not base:
            raise EngineError('invalid_input', 'base must be an https address', 400)
        if unified.store.get(KV_BASE) != base:
            unified.store.put(KV_BASE, base)
        return {'ok': True, 'base': base}
    from engine import EngineError
    raise EngineError('method_not_allowed', 'Use GET or POST', 405)
