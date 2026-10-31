"""A WhatsApp chat whose profile photo the bridge failed to fetch must not keep its initials forever.

mautrix-whatsapp fetches a contact's photo once; a failed fetch is stored as "unknown" and only a
resync retries it (Parinda, 31 Oct 2026). Messenger asks the bridge's management room for
`sync contacts` while a chat has no picture (through the real owner sender's route rules), backs off,
and repaints an open Inbox when the picture finally arrives."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import connector_inbox
from connector_inbox import ConnectorInbox
from connector_sender import LocalOwnerSender
from engine import EngineError

ROOM, MGMT = '!pari:messenger.internal', '!mgmt-wa:messenger.internal'
GHOST, PIC = '@whatsapp_lid-1555:messenger.internal', 'mxc://messenger.internal/PariPhoto'


class PictureRetry(unittest.TestCase):
    def setUp(self):
        self.calls = calls = []

        class Matrix(BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_PUT(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                calls.append((self.command, self.path, json.loads(body or b'{}')))
                out = b'{"event_id":"$x"}'
                self.send_response(200); self.send_header('Content-Length', str(len(out))); self.end_headers(); self.wfile.write(out)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Matrix)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        base = 'http://127.0.0.1:%d' % self.server.server_port
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = ConnectorInbox(self.tmp.name, Mock(), sender=LocalOwnerSender(base))
        self.inbox.matrix = base
        self.store = self.inbox.store
        self.store.put('matrix_token', 'fixture-token')
        self.ident = self.store.identity('whatsapp', ROOM, 'Parinda')
        with self.store.db() as db:
            db.execute('INSERT INTO room_meta VALUES (?,?)', (ROOM, json.dumps(
                {'network': 'whatsapp', 'telegram': False, 'v': 3, 'kind': 'person', 'space': False, 'label': 'Parinda',
                 'names': {GHOST: 'Parinda (WA)'}, 'avatars': {}, 'avatar': None})))

        def config(network):
            if network != 'whatsapp':
                raise EngineError('not_configured', 'off', 409)
            return ('http://whatsapp:29318', 'secret')
        self.inbox.connectors.config = config
        self.inbox.connectors.request = lambda network, path, *a, **k: {'logins': [{'id': '15550001111'}], 'management_room': MGMT}

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.inbox.close(); self.store._conn.close(); self.tmp.cleanup()

    def sends(self):
        return [c for c in self.calls if '/send/m.room.message/' in c[1]]

    def test_missing_whatsapp_picture_asks_the_bridge_to_resync_and_backs_off(self):
        self.inbox.learn_me()
        sends = self.sends()
        self.assertEqual(len(sends), 1, self.calls)
        self.assertIn('/rooms/%21mgmt-wa%3Amessenger.internal/send/m.room.message/', sends[0][1])
        self.assertEqual(sends[0][2], {'msgtype': 'm.text', 'body': 'sync contacts'})
        state = json.loads(self.store.get('picture_retry:whatsapp'))
        # The same missing chat is not asked about again until the back-off has passed, which then doubles.
        self.inbox.retry_pictures(state['at'] + 60)
        self.inbox.retry_pictures(state['at'] + connector_inbox.PICTURE_RETRY_MIN - 1)
        self.assertEqual(len(self.sends()), 1)
        self.inbox.retry_pictures(state['at'] + connector_inbox.PICTURE_RETRY_MIN + 1)
        self.assertEqual(len(self.sends()), 2)
        self.assertEqual(json.loads(self.store.get('picture_retry:whatsapp'))['wait'], 2 * connector_inbox.PICTURE_RETRY_MIN)

    def test_picture_that_arrives_later_repaints_the_chat_and_stops_retries(self):
        before = self.store.person(self.ident['person_id'])
        with self.store.db() as db:
            seq = db.execute('SELECT seq FROM identity WHERE id=?', (self.ident['id'],)).fetchone()[0]
        state = [{'type': 'm.bridge', 'state_key': 'x', 'sender': '@whatsappbot:messenger.internal', 'content': {'protocol': {'id': 'whatsapp'}, 'channel': {'displayname': 'Parinda'},
                                                                     'com.beeper.room_type.v2': 'dm'}},
                 {'type': 'm.room.member', 'state_key': GHOST, 'content': {'membership': 'join', 'displayname': 'Parinda', 'avatar_url': PIC}},
                 {'type': 'm.room.member', 'state_key': '@owner:messenger.internal', 'content': {'membership': 'join', 'displayname': 'owner'}},
                 {'type': 'm.room.avatar', 'state_key': '', 'content': {'url': PIC}}]
        self.inbox.mx = lambda path, *a, **k: state
        woke = []
        self.store.on_change = lambda: woke.append(1)
        self.inbox.room_meta(ROOM, {'timeline': {'events': [dict(state[1], event_id='$m')]}})
        with self.store.db() as db:
            self.assertGreater(db.execute('SELECT seq FROM identity WHERE id=?', (self.ident['id'],)).fetchone()[0], seq)
        self.assertTrue(woke)
        people = self.store.people(kind='person', chats=False)
        row = next(p for p in people if p['id'] == before['id'])
        self.assertTrue(row['avatar'])
        self.inbox.management_rooms['whatsapp'] = MGMT
        self.inbox.retry_pictures()
        self.assertEqual(self.sends(), [])


if __name__ == '__main__':
    unittest.main()
