"""Drafts to new contacts (issue 176, on for everyone). Synthetic contacts and a recorded bridge only:
no real number, LINE or Telegram account is ever contacted, and nothing here may call a send route."""
import json
import unittest
from unittest.mock import Mock

import test_web as fixtures
from connector_sender import LocalOwnerSender
from drafts import Drafts
from engine import EngineError
from start_chat import identifier
from unified import UnifiedInbox
import agent_tools



class RecordedBridge:
    """Stands in for Connectors: records every provisioning call and answers like a bridgev2 bridge."""

    def __init__(self, known=(), line_ids=None, state='connected'):
        self.calls = []
        self.known = set(known)
        self.line_ids = line_ids or {}
        self.state = state

    def status(self, network):
        return {'network': network, 'state': self.state}

    def request(self, network, path, method='GET', body=None, txn_id='', query=None, timeout=15):
        self.calls.append((network, method, path, body))
        if path.startswith('/resolve_identifier/'):
            if path.split('/', 2)[2] not in self.known:
                raise EngineError('upstream_rejected', 'Upstream rejected the request (M_NOT_FOUND)', 502)
            return {'id': 'u-' + network, 'name': 'Khun Somchai'}
        if path == '/search_users':
            mid = self.line_ids.get(body['query'])
            return {'results': [{'id': mid, 'name': 'Property Scout'}] if mid else []}
        if path.startswith('/create_dm/'):
            return {'id': 'u-' + network, 'name': 'Khun Somchai' if network != 'line' else 'Property Scout',
                    'dm_room_mxid': '!dm-' + network + ':messenger.internal'}
        raise AssertionError('unexpected bridge route ' + path)

    def routes(self):
        return [(n, m, p) for n, m, p, _ in self.calls]


class Identifier(unittest.TestCase):
    def test_numbers_usernames_and_line_ids(self):
        self.assertEqual(identifier('whatsapp', '+66 92 000 0000'), '+66920000000')
        self.assertEqual(identifier('whatsapp', '0066-92-000-0000'), '+66920000000')
        self.assertEqual(identifier('WhatsApp', '+1 (555) 010-0100'), '+15550100100')
        self.assertEqual(identifier('telegram', '@rental_agent'), '@rental_agent')
        self.assertEqual(identifier('telegram', 'https://t.me/rental_agent'), '@rental_agent')
        self.assertEqual(identifier('line', '@PropertyScout'), '@propertyscout')
        self.assertEqual(identifier('line', 'somchai.k'), 'somchai.k')

    def test_clear_errors(self):
        for network, to in (('whatsapp', '092 000 0000'), ('whatsapp', '+0123'), ('whatsapp', ''), ('telegram', '@ab'),
                            ('telegram', '@a__b_c'), ('line', 'a/b'), ('line', 'a..b'), ('line', 'x' * 60),
                            ('signal', '+66920000000'), ('whatsapp', None)):
            with self.subTest(network=network, to=to), self.assertRaises(EngineError) as raised:
                identifier(network, to)
            self.assertIn(raised.exception.code, ('invalid_contact', 'unsupported_network'))


class StartDraft(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    tearDown = fixtures.ViewBoundary.tearDown
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers

    def setUp(self):
        self.setUp_base()
        self.inbox = UnifiedInbox(self.temp.name, self.server.engine)
        self.server.unified = self.inbox
        self.inbox.mx = Mock(return_value={})
        self.bridge = RecordedBridge(known={'%2B66920000000', '%40rental_agent'}, line_ids={'@propertyscout': 'u0123abc'})
        self.inbox.connectors = self.bridge
        self.server.drafts = Drafts(self.temp.name)
        self.inbox.store.draft_people = self.server.drafts.waiting_people
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Drafter'}, self.owner)
        self.assertEqual(status, 200, data)
        ident = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.assertEqual(self.request('POST', '/api/view/agents/' + ident, {'level': 'draft_only'}, self.owner)[0], 200)

    def mcp(self, name, args=None, method='tools/call'):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if method == 'tools/call':
            body['params'] = {'name': name, 'arguments': args or {}}
        status, _, data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.key})
        self.assertEqual(status, 200, data)
        if method != 'tools/call':
            return data['result']
        return json.loads(data['result']['content'][0]['text']), data['result'].get('isError', False)

    def chats(self):
        return [p['display_name'] for p in self.inbox.store.people('person')]

    def assert_nothing_sent(self):
        for args in self.inbox.mx.call_args_list:
            self.assertNotIn('/send/', args.args[0])
        for network, method, path in self.bridge.routes():
            self.assertTrue(path.startswith(('/resolve_identifier/', '/search_users', '/create_dm/')), path)

    def test_tool_is_listed_for_everyone(self):
        names = [t['name'] for t in self.mcp(None, method='tools/list')['tools']]
        self.assertIn('messenger_start_draft', names)
        self.assertIn('messenger_create_draft', names)

    def test_whatsapp_number_gets_a_new_chat_with_the_draft_and_nothing_is_sent(self):
        self.assertIn('messenger_start_draft', [t['name'] for t in self.mcp(None, method='tools/list')['tools']])
        seq = self.inbox.store.seq
        result, error = self.mcp('messenger_start_draft', {'network': 'whatsapp', 'to': '+66 92 000 0000', 'text': 'Hi'})
        self.assertFalse(error, result)
        self.assertEqual(result['chat']['network'], 'WhatsApp')
        self.assertEqual(result['draft']['text'], 'Hi')
        self.assertEqual(result['draft']['created_by'], 'Drafter')
        self.assertEqual(self.bridge.routes(), [('whatsapp', 'GET', '/resolve_identifier/%2B66920000000'),
                                                ('whatsapp', 'POST', '/create_dm/%2B66920000000')])
        self.inbox.mx.assert_called_once_with('/join/%21dm-whatsapp%3Amessenger.internal', 'POST', {})
        # The new chat is listed with its draft waiting, like every other draft chat.
        people = self.inbox.store.people('person')
        self.assertEqual([p['display_name'] for p in people], ['Khun Somchai'])
        self.assertTrue(people[0]['started'])
        self.assertEqual(people[0]['unread'], 0)
        self.assertGreater(self.inbox.store.seq, seq)
        self.assert_nothing_sent()
        # Discard removes the empty chat again (and the change feed tells open screens).
        seq = self.inbox.store.seq
        out = self.server.drafts.dispatch('DELETE', [result['draft']['id']], {'revision': result['draft']['revision']},
                                          self.inbox, owner=True)
        self.assertTrue(out['deleted'])
        self.assertEqual(self.chats(), [])
        self.assertGreater(self.inbox.store.seq, seq)
        update = self.inbox.updates(seq, 0)
        self.assertIn(result['chat']['chat_id'], update['removed'])
        self.assert_nothing_sent()

    def test_unknown_number_is_a_clear_error_and_never_opens_a_chat(self):
        result, error = self.mcp('messenger_start_draft', {'network': 'whatsapp', 'to': '+66 81 111 1111', 'text': 'Hi'})
        self.assertTrue(error)
        self.assertEqual(result['error'], {'code': 'contact_not_found', 'message': "This number isn't on WhatsApp"})
        self.assertEqual(self.bridge.routes(), [('whatsapp', 'GET', '/resolve_identifier/%2B66811111111')])
        self.inbox.mx.assert_not_called()
        self.assertEqual(self.server.drafts.dispatch('GET', [], {}, self.inbox)['drafts'], [])
        self.assertEqual(self.chats(), [])

    def test_line_id_and_telegram_username(self):
        result, error = self.mcp('messenger_start_draft', {'network': 'line', 'to': '@PropertyScout', 'text': 'Hello'})
        self.assertFalse(error, result)
        self.assertEqual(self.bridge.routes()[:2], [('line', 'POST', '/search_users'), ('line', 'POST', '/create_dm/u0123abc')])
        missing, error = self.mcp('messenger_start_draft', {'network': 'line', 'to': 'nobody.here', 'text': 'Hello'})
        self.assertEqual(missing['error'], {'code': 'contact_not_found', 'message': 'LINE ID not found'})
        result, error = self.mcp('messenger_start_draft', {'network': 'telegram', 'to': '@rental_agent', 'text': 'Hi'})
        self.assertFalse(error, result)
        self.assertEqual(sorted(self.chats()), ['Khun Somchai', 'Property Scout'])
        self.assert_nothing_sent()

    def test_disconnected_network_and_bad_input(self):
        self.bridge.state = 'disconnected'
        result, error = self.mcp('messenger_start_draft', {'network': 'whatsapp', 'to': '+66920000000', 'text': 'Hi'})
        self.assertEqual(result['error']['code'], 'network_not_connected')
        result, error = self.mcp('messenger_start_draft', {'network': 'whatsapp', 'to': '0920000000', 'text': 'Hi'})
        self.assertEqual(result['error']['code'], 'invalid_contact')
        self.assertEqual(self.bridge.calls, [])

    def test_owner_new_chat_route_and_agents_cannot_use_it(self):
        status, _, data = self.request('POST', '/api/unified/start-chat', {'network': 'telegram', 'to': '@rental_agent'}, self.owner)
        self.assertEqual(status, 200, data)
        person = data['result']['chat_id']
        # No draft yet: the chat opens for the owner, and is listed once he writes one.
        self.assertEqual(self.chats(), [])
        self.server.drafts.dispatch('POST', [], {'person_id': person, 'identity_id': data['result']['channel_id'], 'text': 'Hey'},
                                    self.inbox, owner=True)
        self.assertEqual(self.chats(), ['Khun Somchai'])
        calls = len(self.bridge.calls)
        status, _, data = self.request('POST', '/api/unified/start-chat', {'network': 'telegram', 'to': '@rental_agent'}, self.key)
        self.assertEqual(status, 403, data)
        self.assertEqual(len(self.bridge.calls), calls)

    def test_existing_chat_with_messages_keeps_its_place(self):
        chat = self.inbox.start_chat('whatsapp', '+66920000000')
        identity = self.inbox.store.identity('whatsapp', '!dm-whatsapp:messenger.internal', 'Khun Somchai')
        self.assertEqual(identity['person_id'], chat['chat_id'])
        self.inbox.store.add_message('$1', identity, '@me', True, 'Hi', 1700000000000)
        self.assertEqual(self.chats(), ['Khun Somchai'])
        self.assertNotIn('started', self.inbox.store.people('person')[0])


class SenderRoutes(unittest.TestCase):
    def test_only_lookup_and_empty_chat_routes_are_added(self):
        sender = LocalOwnerSender('http://127.0.0.1:9', bases={'whatsapp': 'http://127.0.0.1:9', 'line': 'http://127.0.0.1:9'})
        q = '?user_id=%40owner%3Amessenger.internal'
        for network, path in (('whatsapp', '/_matrix/provision/v3/create_dm/%2B66920000000' + q),
                              ('line', '/_matrix/provision/v3/search_users' + q)):
            with self.subTest(path=path), self.assertRaises(EngineError) as raised:
                sender(network=network, base='http://127.0.0.1:9', path=path, method='POST', body={})
            self.assertEqual(raised.exception.code, 'owner_transport_failed')  # allowed; nothing listens on :9
        for path in ('/_matrix/provision/v3/create_dm/a/b' + q, '/_matrix/provision/v3/create_group/group' + q,
                     '/_matrix/provision/v3/create_dm/%2B1' + '?user_id=%40other%3Amessenger.internal',
                     '/_matrix/provision/v3/create_dm/%2e%2e' + q):
            with self.subTest(path=path), self.assertRaises(EngineError) as raised:
                sender(network='whatsapp', base='http://127.0.0.1:9', path=path, method='POST', body={})
            self.assertEqual(raised.exception.code, 'sender_route_denied')


class ToolList(unittest.TestCase):
    def test_listed_with_every_switch_off(self):
        handler = Mock(); handler.service.unified.switches.is_on = lambda sid: False
        self.assertIn('messenger_start_draft', [t['name'] for t in agent_tools.listed(handler)])
        self.assertNotIn('messenger_start_draft', agent_tools.SWITCHED)
        self.assertEqual(agent_tools.ROUTES['messenger_start_draft'], ('POST', '/api/drafts'))


if __name__ == '__main__':
    unittest.main()
