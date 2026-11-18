"""Issue 296 (switch unread-count): GET /api/unread gives the phone one number for Messenger's home-screen icon.

Synthetic chats only: no real contacts, nothing leaves the process."""
import http.client
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from trusted_owner import HEADER, sign_request
from unified import UnifiedInbox
from web import ViewServer

ORIGIN = 'https://wizard.example.com'
TOKEN = 'synthetic-machine-token-' + 'c' * 40


def now_ms(offset=0):
    return int(time.time() * 1000) + offset


class Chats(unittest.TestCase):
    def make_inbox(self, data):
        engine = Mock(); engine.status.return_value = {'state': 'ready'}
        inbox = UnifiedInbox(str(data), engine)
        inbox.matrix_token = lambda: 'x'
        inbox.mx = Mock(return_value={'event_id': '$sent'})
        self.addCleanup(lambda: inbox.store._conn and inbox.store._conn.close())
        return inbox

    def chat(self, inbox, address, name, kind='person'):
        ident = inbox.store.identity('telegram', address, name, kind)
        inbox.rooms[address] = {'telegram': True, 'kind': kind, 'label': name, 'names': {}}
        return ident

    def three_unread(self, inbox):
        t = now_ms()
        amy, bob, team = (self.chat(inbox, '!amy', 'Amy'), self.chat(inbox, '!bob', 'Bob'),
                          self.chat(inbox, '!team', 'Team', 'group'))
        inbox.store.add_message('$a1', amy, 'Amy', False, 'hi', t - 3000)
        inbox.store.add_message('$a2', amy, 'Amy', False, 'again', t - 2500)
        inbox.store.add_message('$b1', bob, 'Bob', False, 'hello', t - 2000)
        inbox.store.add_message('$t1', team, 'Carol', False, 'news', t - 1000)
        return t, [amy, bob, team]


class StoreTests(Chats):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.inbox = self.make_inbox(self.tmp.name)

    def open_chat(self, ident, t):
        # Same route the open chat calls (markRead -> people/<id>/read): the box keeps the read mark.
        self.inbox.dispatch('POST', '/api/unified/people/%s/read' % ident['person_id'], {'timestamp': t})

    def test_three_then_two_then_none(self):
        store = self.inbox.store
        self.assertEqual(store.unread_total(), 0)
        t, chats = self.three_unread(self.inbox)
        self.assertEqual(store.unread_total(), 3)  # chats, not messages: Amy's two lines count once
        self.open_chat(chats[0], t)
        self.assertEqual(store.unread_total(), 2)
        for ident in chats[1:]:
            self.open_chat(ident, t)
        self.assertEqual(store.unread_total(), 0)
        store.add_message('$b2', chats[1], 'Bob', False, 'one more', t + 10)
        self.assertEqual(store.unread_total(), 1)

    def test_same_rule_as_the_badge(self):
        store = self.inbox.store
        t, (amy, bob, team) = self.three_unread(self.inbox)
        store.update(amy['person_id'], {'muted': True})
        store.update(bob['person_id'], {'low_priority': True})
        self.assertEqual(store.unread_total(), 1)
        store.update(team['person_id'], {'medium_priority': True})
        self.assertEqual(store.unread_total(), 0)
        store.update(amy['person_id'], {'muted': False})
        self.assertEqual(store.unread_total(), 1)
        # Own lines and deleted lines are never unread.
        me = self.chat(self.inbox, '!me', 'Me')
        store.add_message('$m1', me, 'me', True, 'sent by me', t)
        self.assertEqual(store.unread_total(), 1)
        # Mark as unread brings a read chat back.
        self.open_chat(amy, t)
        self.assertEqual(store.unread_total(), 0)
        store.mark_unread(amy['person_id'])
        self.assertEqual(store.unread_total(), 1)


class UnreadHTTP(Chats):
    """Route boundary on a trusted-owner install (the Wizard gateway signs each owner request)."""
    trusted = True

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.data = self.root / 'data'; self.data.mkdir()
        self.proof = secrets.token_bytes(32)
        for name, key in [('proof', self.proof), ('wrap', secrets.token_bytes(32))]:
            path = self.root / name; path.write_bytes(key); path.chmod(0o600)
        env = {'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0', 'UNIFIED_ENABLED': '0',
               'MESSENGER_REMOTE_AUTHORITY_URL': '', 'MESSENGER_TRUST_WIZARD_OWNER': '1' if self.trusted else '0',
               'MESSENGER_OWNER_PROOF_KEY_FILE': str(self.root / 'proof'),
               'MESSENGER_OWNER_WRAP_KEY_FILE': str(self.root / 'wrap')}
        self.env = patch.dict(os.environ, env); self.env.start(); self.addCleanup(self.env.stop)
        engine = Mock(); engine.status.return_value = {'state': 'ready'}; engine.relays = []; engine.data = self.data
        self.server = ViewServer(('127.0.0.1', 0), engine, TOKEN, [ORIGIN])
        self.server.unified = self.inbox = self.make_inbox(self.data / 'inbox')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), self.thread.join()))

    def request(self, target='/api/unread', *, method='GET', proof=True, headers=None):
        h = dict(headers or {})
        if proof: h[HEADER] = sign_request(self.proof, method, target)
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request(method, target, None, h)
        r = c.getresponse(); out = (r.status, json.loads(r.read() or b'null')); c.close()
        return out

    def owner(self):
        token, session = self.server.auth.create()
        return {'Cookie': 'wizard_messenger_session=' + token, 'Origin': ORIGIN}

    def switch(self, on):
        self.server.switches.set('unread-count', on)

    def test_off_by_default_is_no_route(self):
        self.three_unread(self.inbox)
        status, body = self.request(headers={'Origin': ORIGIN})
        self.assertEqual((status, body['error']['code']), (404, 'not_found'))
        self.assertNotIn('result', body)

    def test_number_only(self):
        self.switch(True)
        t, chats = self.three_unread(self.inbox)
        status, body = self.request(headers={'Origin': ORIGIN})  # the phone's native call: Origin only
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True, 'result': {'unread_total': 3}})  # exact keys: no ids, names or text
        self.inbox.read(chats[0]['person_id'], {'timestamp': t})
        self.assertEqual(self.request(headers={'Origin': ORIGIN})[1], {'ok': True, 'result': {'unread_total': 2}})
        for ident in chats[1:]:
            self.inbox.read(ident['person_id'], {'timestamp': t})
        self.assertEqual(self.request(headers={'Origin': ORIGIN})[1], {'ok': True, 'result': {'unread_total': 0}})
        self.assertEqual(self.request()[1], {'ok': True, 'result': {'unread_total': 0}})  # no Origin: a plain GET

    def test_refused_like_other_messenger_calls(self):
        self.switch(True)
        self.three_unread(self.inbox)
        self.assertEqual(self.request(proof=False, headers={'Origin': ORIGIN})[0], 403 if self.trusted else 401)
        self.assertEqual(self.request(headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request(headers={'Origin': ORIGIN, 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.request(headers={'Origin': ORIGIN, 'Authorization': 'Bearer ' + TOKEN})[0], 403)
        status, body = self.request(proof=False, headers={'Origin': 'https://evil.example'})
        self.assertIn(status, (401, 403)); self.assertNotIn('result', body)


class UnreadHTTPPassphrase(UnreadHTTP):
    """Without the trusted Wizard ingress the count needs the owner's view session, like every other call."""
    trusted = False

    def request(self, target='/api/unread', *, method='GET', proof=True, headers=None):
        h = dict(headers or {})
        if proof:
            o = self.owner(); o.update(h); h = o
        return super().request(target, method=method, proof=False, headers=h)


if __name__ == '__main__':
    unittest.main()
