"""Issue 342: Connected accounts' Agent access screen reads and sets Messenger's
agent level through GET/POST /api/agent-levels. Messenger stays the only store (wizard_agents.py).

Synthetic agents and accounts only: nothing leaves the process."""
import http.client
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from trusted_owner import HEADER, sign_request
from web import ViewServer, chat_accounts

ORIGIN = 'https://wizard.example.com'
TOKEN = 'synthetic-machine-token-' + 'd' * 40
TARGET = '/api/agent-levels'
WRITE = {'X-Wizard-Agent-Level': '1', 'Content-Type': 'application/json'}


class FakeInbox:
    def __init__(self):
        self.profiles = [
            ('whatsapp', {'id': '15550001111', 'name': '+1 555 000 1111', 'state': {'state_event': 'CONNECTED'},
                          'profile': {'name': 'Sam Example', 'phone': '+15550001111'}}),
            ('line', {'id': 'u123', 'name': 'sam.line', 'state_event': 'CONNECTED'}),
            ('signal', {'id': 'x', 'name': 'Gone', 'state': {'state_event': 'LOGGED_OUT'}}),
            ('telegram', {'id': 't', 'name': 'Sam T', 'access_token': 'never-shown'}),
        ]

    def own_profiles(self):
        return list(self.profiles)

    def close(self):
        pass


class Base(unittest.TestCase):
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
        self.server.unified = FakeInbox()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(lambda: (self.server.shutdown(), self.server.server_close(), self.thread.join()))

    def owner(self):
        if self.trusted:
            return {'Origin': ORIGIN}
        token, _ = self.server.auth.create()
        return {'Cookie': 'wizard_messenger_session=' + token, 'Origin': ORIGIN}

    def request(self, method='GET', body=None, *, proof=True, headers=None):
        h = dict(headers or {})
        if proof and self.trusted:
            h[HEADER] = sign_request(self.proof, method, TARGET)
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request(method, TARGET, None if body is None else json.dumps(body), h)
        r = c.getresponse(); out = (r.status, json.loads(r.read() or b'null')); c.close()
        return out



class AgentLevels(Base):
    def test_always_on_even_with_a_stale_stored_off(self):
        # The old switch connected-accounts-levels is gone; a value still stored for it changes nothing.
        self.server.switches.path.write_text(json.dumps({'switches': {'connected-accounts-levels': False}}))
        self.assertNotIn('connected-accounts-levels', [s['id'] for s in self.server.switches.listing()['switches']])
        status, body = self.request(headers=self.owner())
        self.assertEqual(status, 200)
        self.assertEqual(body['app'], 'messenger')
        status, body = self.request('POST', {'agent': 'hermes', 'level': 'draft_only'}, headers={**self.owner(), **WRITE})
        self.assertEqual(status, 200)
        self.assertEqual(self.server.wizard_agents.list()[0]['level'], 'draft_only')

    def test_lists_accounts_names_only_and_messengers_levels(self):
        self.server.wizard_agents.caller('research', 'Research')
        status, body = self.request(headers=self.owner())
        self.assertEqual(status, 200)
        self.assertEqual(body['app'], 'messenger')
        self.assertEqual(body['accounts'], [
            {'network': 'whatsapp', 'label': 'WhatsApp', 'name': 'Sam Example'},
            {'network': 'line', 'label': 'LINE', 'name': 'sam.line'},
            {'network': 'telegram', 'label': 'Telegram', 'name': 'Sam T'}])
        self.assertNotIn('never-shown', json.dumps(body))
        self.assertNotIn('15550001111', json.dumps(body))
        self.assertEqual([(a['id'], a['main'], a['level']) for a in body['agents']],
                         [('hermes', True, 'no_access'), ('research', False, 'no_access')])
        self.assertEqual([(l['id'], l['recommended']) for l in body['levels']],
                         [('no_access', False), ('read_only', False), ('draft_only', True)])

    def test_set_here_shows_in_settings_agents_and_back(self):
        status, body = self.request('POST', {'agent': 'hermes', 'level': 'draft_only'}, headers={**self.owner(), **WRITE})
        self.assertEqual(status, 200)
        self.assertEqual(body['agents'][0]['level'], 'draft_only')
        # Messenger's own store moved (the row Settings > Agents and the gateway read).
        self.assertEqual(self.server.wizard_agents.list()[0]['level'], 'draft_only')
        stored = json.loads((self.data / 'wizard-agents.json').read_text())
        self.assertEqual(stored['agents']['hermes']['level'], 'draft_only')
        # A change made in Messenger shows here.
        self.server.wizard_agents.set_level('hermes', 'read_only')
        self.assertEqual(self.request(headers=self.owner())[1]['agents'][0]['level'], 'read_only')
        self.assertTrue(any('Connected accounts' in str(r) for r in self.server.agent_access.recent(5)))

    def test_bad_writes_change_nothing(self):
        good = {'agent': 'hermes', 'level': 'draft_only'}
        cases = [
            (good, {**self.owner(), 'Content-Type': 'application/json'}, 403),  # no X-Wizard-Agent-Level
            (good, {**self.owner(), 'X-Wizard-Agent-Level': '1'}, 400),  # not JSON
            ({'agent': 'hermes', 'level': 'draft_and_send'}, {**self.owner(), **WRITE}, 400),  # never send
            ({'agent': 'stranger', 'level': 'draft_only'}, {**self.owner(), **WRITE}, 404),
            ({'agent': 'hermes', 'level': 'draft_only', 'x': 1}, {**self.owner(), **WRITE}, 400),
            (good, {**WRITE}, 403),  # no Origin on a write
            (good, {**WRITE, 'Origin': 'https://evil.example'}, 403),
            (good, {**self.owner(), **WRITE, 'Sec-Fetch-Site': 'cross-site'}, 403),
            (good, {**self.owner(), **WRITE, 'Authorization': 'Bearer ' + TOKEN}, 403),
            (good, {**self.owner(), **WRITE, 'X-Wizard-Grant': 'g' * 40}, 403),
        ]
        for body, headers, want in cases:
            with self.subTest(headers=headers, body=body):
                status, answer = self.request('POST', body, headers=headers)
                self.assertEqual(status, want, answer)
                self.assertNotIn('agents', answer)
        self.assertEqual(self.server.wizard_agents.list()[0]['level'], 'no_access')

    def test_needs_the_owner(self):
        status, body = self.request(proof=False, headers={'Origin': ORIGIN})
        self.assertIn(status, (401, 403)); self.assertNotIn('agents', body)

    def test_a_bridge_that_is_down_hides_only_its_accounts(self):
        def boom():
            raise RuntimeError('bridge down')
        self.server.unified.own_profiles = boom
        status, body = self.request(headers=self.owner())
        self.assertEqual((status, body['accounts']), (200, []))
        self.assertEqual(body['agents'][0]['id'], 'hermes')


class AgentLevelsWithSession(AgentLevels):
    """Same boundary on a box without Wizard owner proof: the owner's Messenger view session."""
    trusted = False

    def test_setup_only_session_is_refused(self):
        token, session = self.server.auth.create()
        session['setup_only'] = True
        status, _ = self.request(headers={'Cookie': 'wizard_messenger_session=' + token, 'Origin': ORIGIN})
        self.assertEqual(status, 403)


class Accounts(unittest.TestCase):
    def test_unknown_networks_and_odd_rows_are_skipped(self):
        self.assertEqual(chat_accounts([('nope', {'name': 'x'}), ('whatsapp', 'x'), ('slack', {'name': '  A   B  '}),
                                        ('slack', {'name': 'A B'})]),
                         [{'network': 'slack', 'label': 'Slack', 'name': 'A B'}])


if __name__ == '__main__':
    unittest.main()
