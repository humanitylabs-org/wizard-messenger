"""The owner's agent chat (issue 265, switch agent-chat): notes to self, Sweep with one-tap answers, urgent pings and
reports. Runs through the real view server (owner routes) and the real MCP endpoint (agent key)."""
import json
import unittest
from unittest.mock import Mock

import test_web as fixtures
from drafts import Drafts
from unified import UnifiedInbox
import agent_chat

TOOLS = ('messenger_agent_chat_inbox', 'messenger_agent_chat_ack', 'messenger_agent_chat_post',
         'messenger_agent_chat_done')


class AgentChat(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    tearDown_base = fixtures.ViewBoundary.tearDown
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers

    def setUp(self):
        self.setUp_base()
        self.inbox = UnifiedInbox(self.temp.name, self.server.engine)
        self.server.unified = self.inbox
        self.inbox.mx = Mock(return_value={})
        self.server.drafts = Drafts(self.temp.name)
        self.inbox.store.draft_people = self.server.drafts.waiting_people
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Oscar'}, self.owner)
        self.assertEqual(status, 200, data)
        self.agent_id = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.level('draft_only')

    def tearDown(self):
        self.tearDown_base()

    def level(self, level):
        self.assertEqual(self.request('POST', '/api/view/agents/' + self.agent_id, {'level': level}, self.owner)[0], 200)

    def on(self, value=True):
        self.inbox.switches.set('agent-chat', value)

    def mcp(self, name, args=None, method='tools/call'):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if method == 'tools/call':
            body['params'] = {'name': name, 'arguments': args or {}}
        status, _, data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.key})
        self.assertEqual(status, 200, data)
        if method != 'tools/call':
            return data['result']
        return json.loads(data['result']['content'][0]['text']), data['result'].get('isError', False)

    def owner_call(self, method, path, body=None, headers=None):
        status, _, data = self.request(method, '/api/unified/agent-chat' + path, body, headers or self.owner)
        return status, data

    def ok(self, method, path='', body=None):
        status, data = self.owner_call(method, path, body)
        self.assertEqual(status, 200, data)
        return data['result']

    def test_switch_off_hides_the_tools_and_the_chat(self):
        names = {t['name'] for t in self.mcp(None, method='tools/list')['tools']}
        self.assertFalse(set(TOOLS) & names)
        refused, error = self.mcp('messenger_agent_chat_inbox')
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'feature_off')
        status, data = self.owner_call('GET', '')
        self.assertEqual(status, 409, data)
        self.on()
        names = {t['name'] for t in self.mcp(None, method='tools/list')['tools']}
        self.assertTrue(set(TOOLS) <= names)

    def test_a_note_is_ticked_never_answered(self):
        self.on()
        state = self.ok('POST', '', {'text': 'Buy dog food https://shop.example/food'})
        note = state['entries'][-1]
        self.assertEqual((note['kind'], note['by'], note['seen']), ('note', 'owner', None))
        got, error = self.mcp('messenger_agent_chat_inbox')
        self.assertFalse(error, got)
        self.assertEqual([n['text'] for n in got['notes']], ['Buy dog food https://shop.example/food'])
        done, error = self.mcp('messenger_agent_chat_ack', {'ids': [note['id'], 'n999']})
        self.assertFalse(error, done)
        self.assertEqual(done, {'picked_up': [note['id']], 'unknown': ['n999']})
        state = self.ok('GET')
        self.assertEqual(state['entries'][-1]['seen']['by'], 'Oscar')
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['notes'], [])
        # Quiet mode: there is no reply kind, a sweep needs the owner's Sweep tap, and a ping is one short line.
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'reply', 'text': 'On it!'})
        self.assertTrue(error)
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'sweep', 'text': 'Got your note'})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'no_sweep_asked')
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'x' * 201})
        self.assertTrue(error)
        self.assertEqual([e['kind'] for e in self.ok('GET')['entries']], ['note'])

    def test_sweep_with_one_tap_answers(self):
        self.on()
        self.ok('POST', '/sweep', {})
        state = self.ok('POST', '/sweep', {})  # a second tap while one is open asks nothing new
        self.assertEqual([e['kind'] for e in state['entries']], ['ask'])
        self.assertTrue(state['sweep_open'])
        got = self.mcp('messenger_agent_chat_inbox')[0]
        self.assertEqual(len(got['sweep_requests']), 1)
        self.assertIsNone(got['sweep_requests'][0]['since'])
        items = [{'text': "Buddy's comment on your post", 'recommendation': 'Reply with thanks',
                  'buttons': [{'label': 'Yes', 'value': 'yes'}, {'label': 'Skip', 'value': 'skip'},
                              {'label': 'Later', 'value': 'later'}]},
                 {'text': 'Dentist wants a date', 'buttons': [{'label': 'Tue'}, {'label': 'Wed'}]}]
        posted, error = self.mcp('messenger_agent_chat_post', {'kind': 'sweep', 'items': items})
        self.assertFalse(error, posted)
        state = self.ok('GET')
        ask, sweep = state['entries']
        self.assertEqual(ask['done'], posted['posted'])
        self.assertFalse(state['sweep_open'])
        self.assertEqual(state['unread'], 1)
        self.assertEqual([i['n'] for i in sweep['items']], [1, 2])
        self.assertEqual(sweep['items'][1]['buttons'], [{'label': 'Tue', 'value': 'Tue'}, {'label': 'Wed', 'value': 'Wed'}])
        # A tap answers one item; a value that is not one of its buttons is refused.
        status, data = self.owner_call('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'maybe'})
        self.assertEqual(status, 400, data)
        self.ok('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'skip'})
        self.ok('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'yes'})  # changed before pick-up
        answers = self.mcp('messenger_agent_chat_inbox')[0]['answers']
        self.assertEqual([(a['id'], a['answer']) for a in answers], [(sweep['id'] + '/1', 'yes')])
        self.mcp('messenger_agent_chat_ack', {'ids': [answers[0]['id']]})
        status, data = self.owner_call('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'skip'})
        self.assertEqual(status, 409, data)
        done, error = self.mcp('messenger_agent_chat_done', {'post_id': sweep['id'], 'item': 1, 'result': 'Replied to Buddy'})
        self.assertFalse(error, done)
        item = self.ok('GET')['entries'][-1]['items'][0]
        self.assertEqual((item['answer']['label'], item['result']), ('Yes', 'Replied to Buddy'))
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['answers'], [])
        # The next Sweep tells the agent where the last one ended.
        self.ok('POST', '/read', {})
        self.ok('POST', '/sweep', {})
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['sweep_requests'][0]['since'], sweep['at'])

    def test_urgent_ping_and_reports(self):
        self.on()
        posted, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': "Buddy's comment\nneeds a reply",
                                                                'link': 'https://social.example/p/1'})
        self.assertFalse(error, posted)
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'x', 'link': 'javascript:alert(1)'})
        self.assertTrue(error)
        self.mcp('messenger_agent_chat_post', {'kind': 'report', 'text': 'Weekly stats\n\nFollowers +12'})
        state = self.ok('GET')
        self.assertEqual(state['entries'][0]['text'], "Buddy's comment needs a reply")
        self.assertEqual((state['unread'], state['urgent'], state['reports_unread']), (1, True, 1))
        state = self.ok('POST', '/read', {})
        self.assertEqual((state['unread'], state['urgent'], state['reports_unread']), (0, False, 1))
        state = self.ok('POST', '/read', {'reports': True})
        self.assertEqual(state['reports_unread'], 0)

    def test_owner_only_and_levels(self):
        self.on()
        # An agent key can never use the owner's routes.
        status, data = self.owner_call('GET', '', headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, data)
        status, data = self.owner_call('POST', '', {'text': 'fake note'}, headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, data)
        self.level('read_only')
        self.assertFalse(self.mcp('messenger_agent_chat_inbox')[1])
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'hi'})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'agent_permission_denied')

    def test_store_keeps_a_bounded_history(self):
        self.on()
        for i in range(agent_chat.MAX_ENTRIES + 5):
            agent_chat.note(self.inbox, {'text': 'n%d' % i})
        data = agent_chat._load(self.inbox.store)
        self.assertEqual(len(data['entries']), agent_chat.MAX_ENTRIES)
        self.assertEqual(len(agent_chat.state(self.inbox)['entries']), agent_chat.SHOWN)


if __name__ == '__main__':
    unittest.main()
