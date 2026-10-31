"""The Wizard's own agents reach Messenger through the Agent Service gateway: the gateway proves itself with
its app grant key (X-Wizard-Grant, checked against this app's grants file) and names the agent; the owner picks each agent's level. No keys to copy, no send.

Real loopback handlers, fake provider I/O. No accounts, networks or real messages.
"""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock
import test_web as fixtures
import test_agent_keys as base
from wizard_agents import GatewayGrant, WizardAgents

KEY = 'a1' * 32  # what the App Manager mints: 32 random bytes, hex


def grants_file(path, rows):
    path.write_text(json.dumps({'outgoing': {}, 'incoming': rows, 'enforce': False}))
    return path


class WizardAgentGateway(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers
    agent = base.AgentKeyHTTP.agent
    level = base.AgentKeyHTTP.level
    mcp = base.AgentKeyHTTP.mcp
    tearDown = fixtures.ViewBoundary.tearDown

    def setUp(self):
        base.AgentKeyHTTP.setUp(self)
        # Only the key's hash is in this app's grants file, as the App Manager writes it (`from: agent-service`).
        self.grants = grants_file(Path(self.temp.name, 'grants.json'), [
            {'from': 'wisdom', 'sha256': hashlib.sha256(b'w' * 64).hexdigest()},
            {'from': 'agent-service', 'sha256': hashlib.sha256(KEY.encode()).hexdigest()}])
        self.server.gateway_grant = GatewayGrant(self.grants)
        self.server.wizard_agents = WizardAgents(self.temp.name)

    def gw(self, agent='hermes', label='Oscar', key=KEY):
        h = {'X-Wizard-Grant': key}
        if agent is not None:
            h['X-Wizard-Agent'] = agent
        if label is not None:
            h['X-Wizard-Agent-Label'] = label
        return h

    def listing(self):
        status, _, data = self.request('GET', '/api/view/agents', headers={'Cookie': self.owner['Cookie']})
        self.assertEqual(status, 200, data)
        return data['result']

    def pick(self, agent, level, headers=None):
        return self.request('POST', '/api/view/agents/wizard/' + agent, {'level': level}, headers or self.owner)

    def test_main_agent_is_listed_before_any_call_and_starts_at_no_access(self):
        result = self.listing()
        self.assertEqual([(a['id'], a['level'], a['main']) for a in result['wizard_agents']], [('hermes', 'no_access', True)])
        self.assertEqual([l['id'] for l in result['wizard_levels']], ['no_access', 'read_only', 'draft_only'])
        self.assertTrue(result['gateway_connected'])

    def test_gateway_lists_tools_and_each_call_uses_the_owner_level_for_that_agent(self):
        names = {t['name'] for t in self.mcp(None, headers=self.gw(None, None), method='tools/list')['tools']}
        self.assertIn('messenger_list_chats', names); self.assertFalse(any('send' in n for n in names))
        data, error = self.mcp('messenger_list_chats', {}, self.gw())
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'agent_access_off')
        self.assertIn('Settings → Agents', data['error']['message'])
        self.assertEqual(self.listing()['wizard_agents'][0]['label'], 'Oscar')  # The gateway named him.
        self.assertEqual(self.pick('hermes', 'draft_only')[0], 200)
        chats, error = self.mcp('messenger_list_chats', {}, self.gw())
        self.assertFalse(error, chats); self.assertEqual({c['title'] for c in chats['chats']}, {'Alice', 'Bob'})
        made, error = self.mcp('messenger_create_draft', {'chat_id': self.alice['person_id'], 'text': 'Hi'}, self.gw())
        self.assertFalse(error, made); self.assertEqual(made['draft']['created_by'], 'Oscar')
        # Another Wizard agent is a different agent with its own (default No access) level.
        data, error = self.mcp('messenger_list_chats', {}, self.gw('helper', 'Helper'))
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'agent_access_off')
        data, error = self.mcp('messenger_update_draft', {'draft_id': made['draft']['id'], 'revision': 1, 'text': 'x'}, self.gw('helper', 'Helper'))
        self.assertTrue(error)
        self.assertEqual({a['id'] for a in self.listing()['wizard_agents']}, {'hermes', 'helper'})
        # Read-only: reads yes, drafts no.
        self.pick('hermes', 'read_only')
        self.assertFalse(self.mcp('messenger_list_chats', {}, self.gw())[1])
        data, error = self.mcp('messenger_create_draft', {'chat_id': self.wiz['person_id'], 'text': 'x'}, self.gw())
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'agent_permission_denied')
        self.inbox.mx.assert_not_called()

    def test_wizard_agents_can_never_be_given_send_and_only_the_owner_picks(self):
        self.assertEqual(self.pick('hermes', 'draft_and_send')[0], 400)
        self.assertEqual(self.pick('hermes', 'full_access')[0], 400)
        self.assertEqual(self.pick('unknown-agent', 'draft_only')[0], 404)
        for h in (self.gw(), {**self.gw(), 'Cookie': self.owner['Cookie'], 'Origin': fixtures.ORIGIN, 'X-Messenger-CSRF': self.owner['X-Messenger-CSRF']},
                  self.keys['draft_and_send'], {'Cookie': self.owner['Cookie']}):
            self.assertIn(self.pick('hermes', 'draft_only', h)[0], (401, 403))
        self.assertEqual(self.listing()['wizard_agents'][0]['level'], 'no_access')
        self.pick('hermes', 'draft_only')
        for path in ('/api/unified/people/p/send', '/api/drafts/d/send'):
            self.assertIn(self.request('POST', path, {}, self.gw())[0], (401, 403))

    def test_gateway_key_is_mcp_only_and_required(self):
        self.pick('hermes', 'draft_only')
        self.assertEqual(self.request('GET', '/api/unified/people', headers=self.gw())[0], 401)
        self.assertEqual(self.request('GET', '/api/drafts', headers=self.gw())[0], 401)
        # A wrong grant, or another app's grant, is not the gateway: it names nobody and gets the public tools only.
        for wrong in (self.gw(key='h' * 64), self.gw(key='w' * 64)):
            names = {t['name'] for t in self.mcp(None, headers=wrong, method='tools/list')['tools']}
            self.assertEqual(names, {'messenger_status', 'messenger_public_identity'})
            self.assertTrue(self.mcp('messenger_list_chats', {}, wrong)[1])
        # The old hand-written gateway bearer is no longer a second key system.
        self.assertEqual(self.request('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
                                      {'Authorization': 'Bearer ' + KEY, 'X-Wizard-Agent': 'hermes'})[0], 401)
        # The agent header alone (no gateway key) names nobody.
        anon = {'X-Wizard-Agent': 'hermes', 'X-Wizard-Agent-Label': 'Oscar'}
        names = {t['name'] for t in self.mcp(None, headers=anon, method='tools/list')['tools']}
        self.assertEqual(names, {'messenger_status', 'messenger_public_identity'})
        data, error = self.mcp('messenger_list_chats', {}, anon)
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'agent_key_required')
        # Without the gateway row (no grants file, or the grant revoked) the gateway names nobody.
        self.server.gateway_grant = GatewayGrant(None)
        self.assertTrue(self.mcp('messenger_list_chats', {}, self.gw())[1])
        self.assertFalse(self.listing()['gateway_connected'])
        self.server.gateway_grant = GatewayGrant(self.grants)
        self.assertFalse(self.mcp('messenger_list_chats', {}, self.gw())[1])
        grants_file(self.grants, [{'from': 'wisdom', 'sha256': hashlib.sha256(b'w' * 64).hexdigest()}])
        os.utime(self.grants, ns=(time.time_ns() + 5 * 10**9,) * 2)
        self.assertTrue(self.mcp('messenger_list_chats', {}, self.gw())[1])  # A revoke applies without a restart.
        self.assertFalse(self.listing()['gateway_connected'])
        grants_file(self.grants, [{'from': 'agent-service', 'sha256': hashlib.sha256(KEY.encode()).hexdigest()}])
        os.utime(self.grants, ns=(time.time_ns() + 10 * 10**9,) * 2)
        # Gateway calls without an agent name list tools but run nothing.
        data, error = self.mcp('messenger_list_chats', {}, self.gw(None, None))
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'agent_access_off')

    def test_levels_persist_and_corrupt_store_fails_closed(self):
        self.pick('hermes', 'draft_only')
        self.mcp('messenger_list_chats', {}, self.gw('helper', 'Hel%C3%A9na'))
        again = WizardAgents(self.temp.name)
        self.assertEqual({a['id']: a['level'] for a in again.list()}, {'hermes': 'draft_only', 'helper': 'no_access'})
        self.assertEqual(next(a for a in again.list() if a['id'] == 'helper')['label'], 'Heléna')
        path = Path(self.temp.name, 'wizard-agents.json')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for raw in ('{broken', '[]', json.dumps({'version': 1, 'agents': {'hermes': {'level': 'draft_and_send'}}})):
            path.write_text(raw)
            self.assertEqual(WizardAgents(self.temp.name).list()[0]['level'], 'no_access')

    def test_bad_agent_names_are_not_trusted(self):
        for bad in ('', 'Hermes', '../x', 'a' * 65, 'a b'):
            data, error = self.mcp('messenger_list_chats', {}, self.gw(bad, 'x'))
            self.assertTrue(error, bad)
        self.assertEqual([a['id'] for a in self.listing()['wizard_agents']], ['hermes'])


if __name__ == '__main__':
    unittest.main()
