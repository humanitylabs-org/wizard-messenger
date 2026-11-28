"""Issue 484: GET /api/view/boot answers the first open's reads (trusted-owner, session, status, identity, people,
groups) in one round trip. Each step must answer exactly what its own call would, stop where the view stops asking,
and give nothing to a bearer, another site or a request without the owner's proof. Synthetic data only."""
import gzip
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import test_web as fx
from test_trusted_owner import SyntheticEngine, PASSWORD
from trusted_owner import HEADER, sign_request
from unified import UnifiedInbox
from web import ViewServer

ORIGIN = fx.ORIGIN


class Base(unittest.TestCase):
    def serve(self, engine, origins):
        self.server = ViewServer(('127.0.0.1', 0), engine, fx.TOKEN, origins)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()
    def request(self, path, headers=None, raw=False):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request('GET', path, headers={'Connection': 'close', **(headers or {})})
        r = c.getresponse(); body = r.read(); h = dict(r.getheaders()); c.close()
        if raw: return r.status, h, body
        return r.status, h, json.loads(body)
    def boot(self, headers=None):
        status, h, body = self.request('/api/view/boot', headers)
        self.assertEqual(status, 200, body)
        return h, body['result']['answers']


class PlainBoot(Base):
    """A box without the Wizard owner proof (most boxes): the session cookie is the owner's key."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = fx.FakeEngine(); self.engine.ready = True; self.engine.data = self.temp.name
        self.serve(self.engine, [ORIGIN])
        self.server.unified = UnifiedInbox(self.temp.name, self.engine)
        inbox = self.server.unified
        for i, net in enumerate(['telegram', 'whatsapp', 'signal']):
            meta = {'network': net, 'kind': 'person', 'label': 'Friend %d' % i, 'names': {}}
            inbox.rooms['!r%d' % i] = meta
            ident = inbox.store.identity(net, '!r%d' % i, 'Friend %d' % i)
            inbox.ingest(ident, meta, {'event_id': '$e%d' % i, 'type': 'm.room.message', 'sender': '@x%d:m' % i,
                                       'origin_server_ts': 1790000000000 + i, 'content': {'msgtype': 'm.text', 'body': 'hello %d' % i}})
        token, self.session = self.server.auth.create()
        self.cookie = 'wizard_messenger_session=' + token

    def test_ready_owner_gets_every_answer_each_one_equal_to_its_own_call(self):
        _, answers = self.boot({'Cookie': self.cookie})
        self.assertEqual(list(answers), ['api/view/trusted-owner', 'api/view/session', 'api/status', 'api/identity',
                                         'api/unified/people', 'api/unified/groups'])
        for path, answer in answers.items():
            status, _, body = self.request('/' + path, {'Cookie': self.cookie})
            self.assertEqual((answer['status'], answer['body']), (status, body), path)
        self.assertEqual(answers['api/view/session']['body']['result']['csrf_token'], self.session['csrf'])
        self.assertEqual(len(answers['api/unified/people']['body']['result']['people']), 3)
        self.assertIsInstance(answers['api/unified/people']['body']['result']['seq'], int)

    def test_locked_account_stops_after_status_and_holds_no_identity_or_chats(self):
        self.engine.ready = False
        _, answers = self.boot({'Cookie': self.cookie})
        self.assertEqual(list(answers), ['api/view/trusted-owner', 'api/view/session', 'api/status'])
        self.assertEqual(answers['api/status']['body']['result']['state'], 'setup_required')

    def test_without_a_session_once_a_passphrase_exists_only_the_unlock_answer_comes(self):
        self.server.auth.remember_password('synthetic-only-vault-passphrase')
        _, answers = self.boot()
        self.assertEqual(list(answers), ['api/view/trusted-owner', 'api/view/session'])
        self.assertEqual(answers['api/view/session']['status'], 401)
        self.assertEqual(answers['api/view/session']['body']['error']['code'], 'session_unlock_required')

    def test_fresh_install_opens_setup_session_and_later_steps_use_it(self):
        # Issue 214: no account, no passphrase, no owner proof: the session step opens a setup-only session. The steps
        # after it must run as that session (status yes; a chat list is never part of it) and the cookie is sent.
        self.engine.ready = False
        headers, answers = self.boot()
        self.assertIn('wizard_messenger_session=', headers.get('Set-Cookie', ''))
        self.assertTrue(answers['api/view/session']['body']['result']['authenticated'])
        self.assertEqual(answers['api/status']['status'], 200)
        self.assertEqual(answers['api/status']['body']['result']['state'], 'setup_required')
        self.assertNotIn('api/unified/people', answers)
        token = headers['Set-Cookie'].split(';')[0].split('=', 1)[1]
        self.assertTrue(self.server.auth.lookup(token)['setup_only'])

    def test_a_session_from_one_boot_never_leaks_into_the_next_request_on_the_connection(self):
        self.engine.ready = False
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request('GET', '/api/view/boot'); r = c.getresponse(); r.read()
        self.assertIn('Set-Cookie', dict(r.getheaders()))
        c.request('GET', '/api/status'); r = c.getresponse(); body = json.loads(r.read()); c.close()
        self.assertEqual(r.status, 401, body)

    def test_bearer_gateway_grant_other_site_and_query_get_nothing(self):
        for headers in ({'Authorization': 'Bearer ' + fx.TOKEN}, {'X-Wizard-Grant': 'anything'},
                        {'Cookie': self.cookie, 'Sec-Fetch-Site': 'cross-site'},
                        {'Cookie': self.cookie, 'Origin': 'https://evil.example'}):
            status, _, body = self.request('/api/view/boot', headers)
            self.assertIn(status, (401, 403), headers)
            self.assertNotIn('result', body)
        status, _, body = self.request('/api/view/boot?x=1', {'Cookie': self.cookie})
        self.assertEqual(status, 400)

    def test_answer_is_gzip_encoded_when_the_browser_accepts_it(self):
        status, h, raw = self.request('/api/view/boot', {'Cookie': self.cookie, 'Accept-Encoding': 'gzip, deflate'}, raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(h.get('Content-Encoding'), 'gzip'); self.assertEqual(h.get('Vary'), 'Accept-Encoding')
        self.assertEqual(h.get('Cache-Control'), 'no-store')
        plain = self.request('/api/view/boot', {'Cookie': self.cookie}, raw=True)[2]
        self.assertEqual(json.loads(gzip.decompress(raw)), json.loads(plain))
        self.assertLess(len(raw), len(plain))

    def test_kept_alive_answers_are_not_held_back_by_nagle(self):
        # The issue: headers and body in two writes waited ~40 ms per answer for a delayed ACK. TCP_NODELAY on.
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.connect(); took = []
        for _ in range(10):
            t = time.perf_counter(); c.request('GET', '/api/drafts', headers={'Cookie': self.cookie}); r = c.getresponse(); r.read()
            took.append(time.perf_counter() - t)
        c.close()
        took.sort(); self.assertLess(took[5], 0.02, took)


class TrustedBoot(Base):
    """A trusted Wizard (owner proof on): the proof is checked once, for the boot request itself."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name); data = root / 'data'; data.mkdir()
        self.proof = secrets.token_bytes(32)
        for name, key in [('proof', self.proof), ('wrap', secrets.token_bytes(32))]:
            (root / name).write_bytes(key); (root / name).chmod(0o600)
        self.env = patch.dict(os.environ, {'MESSENGER_TRUST_WIZARD_OWNER': '1',
            'MESSENGER_OWNER_PROOF_KEY_FILE': str(root / 'proof'), 'MESSENGER_OWNER_WRAP_KEY_FILE': str(root / 'wrap'),
            'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0', 'UNIFIED_ENABLED': '0', 'MESSENGER_REMOTE_AUTHORITY_URL': ''})
        self.env.start()
        self.engine = SyntheticEngine(data)
        self.serve(self.engine, ['https://wizard.example.com'])
        self.server.auth.remember_password(PASSWORD)
    def tearDown(self):
        super().tearDown(); self.env.stop()
    def signed(self, extra=None):
        return {HEADER: sign_request(self.proof, 'GET', '/api/view/boot'), **(extra or {})}

    def test_remembered_wizard_opens_with_one_proof(self):
        self.server.trusted_owner.remember(PASSWORD, self.server.auth.credential)
        headers, answers = self.boot(self.signed())
        self.assertEqual(answers['api/view/trusted-owner']['body']['result'], {'enabled': True, 'remembered': True})
        self.assertEqual(answers['api/view/session']['status'], 200)
        self.assertIn('wizard_messenger_session=', headers['Set-Cookie'])
        self.assertEqual(answers['api/status']['body']['result']['state'], 'ready')
        self.assertTrue(self.engine.ready)
        self.assertEqual(list(answers)[-1], 'api/identity')  # SyntheticEngine has no identity: the view stops there too

    def test_not_remembered_asks_for_the_passphrase_and_stops(self):
        _, answers = self.boot(self.signed())
        self.assertEqual(answers['api/view/trusted-owner']['body']['result']['remembered'], False)
        self.assertEqual(answers['api/view/session']['body']['error']['code'], 'session_unlock_required')
        self.assertEqual(list(answers), ['api/view/trusted-owner', 'api/view/session'])

    def test_missing_replayed_or_other_path_proof_gets_nothing(self):
        self.server.trusted_owner.remember(PASSWORD, self.server.auth.credential)
        for headers in ({}, {HEADER: sign_request(self.proof, 'GET', '/api/view/session')}):
            status, _, body = self.request('/api/view/boot', headers)
            self.assertEqual(status, 403); self.assertNotIn('result', body)
        once = self.signed()
        self.assertEqual(self.request('/api/view/boot', once)[0], 200)
        self.assertEqual(self.request('/api/view/boot', once)[0], 403)


if __name__ == '__main__':
    unittest.main()
