"""New group (issue 397, switch new-group). A recorded bridge answers like the pinned bridgev2 bridges
(mautrix-go v0.32 provisioning: /capabilities, /contacts, /create_group/<type>); no real account is contacted."""
import json
import unittest
from unittest.mock import Mock

import test_web as fixtures
from connector_sender import LocalOwnerSender
from engine import EngineError
from group_create import default_name, option
from switches import SwitchStore
from unified import UnifiedInbox

D = ':messenger.internal'
# The exact bodies the pinned bridges answer to GET /_matrix/provision/v3/capabilities: mautrix-go v0.32 writes the
# connector's ProvisioningCapabilities as is (no "provisioning" wrapper), every GroupFieldCapability with its
# "allowed" (whatsapp/telegram v0.2610.0 pkg/connector/capabilities.go).
OFF = {'allowed': False}
CAPS = {
    'whatsapp': {'resolve_identifier': {'create_dm': True, 'lookup_phone': True, 'lookup_email': False, 'lookup_username': False,
                                        'any_phone': False, 'contact_list': True, 'search': False},
                 'group_creation': {'group': {'type_description': 'a group chat',
                                              'name': {'allowed': True, 'max_length': 100}, 'username': OFF, 'avatar': OFF, 'topic': OFF,
                                              'disappear': {'allowed': True, 'settings': {'types': ['after_send'],
                                                                                          'timers': [86400000, 604800000, 7776000000]}},
                                              'participants': {'allowed': True, 'required': True, 'min_length': 1},
                                              'parent': {'allowed': True}}},
                 'image_pack_import': True},
    'telegram': {'resolve_identifier': {'create_dm': True, 'lookup_phone': True, 'lookup_email': False, 'lookup_username': True,
                                        'any_phone': False, 'contact_list': True, 'search': True},
                 'group_creation': {'group': {'type_description': 'a normal group',
                                              'name': {'allowed': True, 'required': True, 'max_length': 255}, 'username': OFF,
                                              'avatar': OFF, 'topic': OFF, 'disappear': OFF,
                                              'participants': {'allowed': True, 'required': True, 'min_length': 1, 'max_length': 200},
                                              'parent': OFF}},
                 'image_pack_import': True},
    'signal': {'resolve_identifier': {'create_dm': True, 'lookup_phone': True, 'lookup_email': False, 'lookup_username': True,
                                      'any_phone': False, 'contact_list': True, 'search': False},
               'group_creation': None},
}
CONTACTS = {
    'whatsapp': [{'id': '66810000001', 'name': 'Ann Lee', 'mxid': '@whatsapp_66810000001' + D},
                 {'id': '66810000002', 'name': 'Bob Ray', 'mxid': '@whatsapp_66810000002' + D},
                 {'id': '66810000003', 'name': 'Cy Moss', 'mxid': '@whatsapp_66810000003' + D},
                 {'id': 'odd', 'name': 'Elsewhere', 'mxid': '@telegram_9' + D}],
    'telegram': [{'id': '101', 'name': 'Dana Wu', 'mxid': '@telegram_101' + D},
                 {'id': '102', 'name': 'Eli Park', 'mxid': '@telegram_102' + D}],
}


class GroupBridge:
    def __init__(self):
        self.calls = []
        self.connected = {'whatsapp', 'telegram', 'signal'}
        self.failed = {}

    def status(self, network):
        return {'network': network, 'state': 'connected' if network in self.connected else 'not_configured'}

    def request(self, network, path, method='GET', body=None, txn_id='', query=None, timeout=15):
        self.calls.append((network, method, path, body))
        if path == '/capabilities':
            return CAPS.get(network, {})
        if path == '/contacts':
            return {'contacts': CONTACTS.get(network, [])}
        if path.startswith('/create_group/'):
            n = sum(1 for c in self.calls if c[2].startswith('/create_group/'))
            return {'id': 'g%d' % n, 'mxid': '!group%d-%s%s' % (n, network, D), 'failed_participants': self.failed}
        raise AssertionError('unexpected bridge route ' + path)

    def creates(self):
        return [c for c in self.calls if c[2].startswith('/create_group/')]


class Pure(unittest.TestCase):
    def test_default_name(self):
        self.assertEqual(default_name(['Ann Lee', 'Bob Ray']), 'Ann and Bob')
        self.assertEqual(default_name(['Ann Lee', 'Bob Ray', 'Cy Moss']), 'Ann, Bob and Cy')
        self.assertEqual(default_name(['Ann', 'Bob', 'Cy', 'Dee', 'Eve']), 'Ann, Bob, Cy +2')
        self.assertEqual(default_name([]), 'New group')

    def test_option_reads_the_bridge_capabilities(self):
        self.assertEqual(option('telegram', 'Telegram', CAPS['telegram']),
                         {'network': 'telegram', 'label': 'Telegram', 'type': 'group', 'name_required': True,
                          'name_max': 255, 'min': 2, 'max': 200, 'photo': True})
        self.assertEqual(option('whatsapp', 'WhatsApp', CAPS['whatsapp'])['max'], None)
        self.assertIsNone(option('signal', 'Signal', CAPS['signal']))
        self.assertIsNone(option('x', 'X', {}))


class NewGroup(unittest.TestCase):
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
        self.inbox.matrix_upload = Mock(return_value={'content_uri': 'mxc://messenger.internal/pic1'})
        self.bridge = GroupBridge()
        self.inbox.connectors = self.bridge
        self.inbox.switches = SwitchStore()
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Drafter'}, self.owner)
        ident = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.request('POST', '/api/view/agents/' + ident, {'level': 'draft_and_send'}, self.owner)

    def on(self):
        self.inbox.switches.set('new-group', True)

    def go(self, method, path, body=None, headers=None):
        status, _, data = self.request(method, '/api/unified/new-group' + path, body or {}, headers or self.owner)
        return status, data

    def groups(self):
        return [p['display_name'] for p in self.inbox.store.people('group')]

    def test_switch_off_changes_nothing(self):
        for method, path, body in (('GET', '', None), ('GET', '/people?network=whatsapp', None),
                                   ('POST', '', {'client_id': 'abcdefgh12', 'network': 'whatsapp',
                                                 'people': ['@whatsapp_66810000001' + D, '@whatsapp_66810000002' + D]})):
            status, data = self.go(method, path, body)
            self.assertEqual(status, 404, data)
            self.assertEqual(data['error']['code'], 'feature_off')
        self.assertEqual(self.bridge.calls, [])
        self.assertEqual(self.groups(), [])

    def test_only_networks_whose_bridge_can_create_groups(self):
        self.on()
        status, data = self.go('GET', '')
        self.assertEqual(status, 200, data)
        self.assertEqual([n['network'] for n in data['result']['networks']], ['telegram', 'whatsapp'])
        self.bridge.connected = {'signal'}
        self.inbox._new_group['options'] = None
        self.assertEqual(self.go('GET', '')[1]['result']['networks'], [])

    def test_people_are_that_networks_contacts_and_chats(self):
        self.on()
        dm = self.inbox.store.identity('whatsapp', '!dm-fern' + D, 'Fern Ito', 'person')
        with self.inbox.store.db() as db:
            db.execute('INSERT INTO room_meta VALUES (?,?)', (dm['address'], json.dumps(
                {'network': 'whatsapp', 'kind': 'person', 'label': 'Fern Ito',
                 'names': {'@whatsapp_66810000009' + D: 'Fern Ito'}})))
        status, data = self.go('GET', '/people?network=whatsapp')
        self.assertEqual(status, 200, data)
        self.assertEqual([(p['id'], p['name']) for p in data['result']['people']],
                         [('@whatsapp_66810000001' + D, 'Ann Lee'), ('@whatsapp_66810000002' + D, 'Bob Ray'),
                          ('@whatsapp_66810000003' + D, 'Cy Moss'), ('@whatsapp_66810000009' + D, 'Fern Ito')])
        self.assertEqual(self.go('GET', '/people?network=signal')[1]['error']['code'], 'group_unsupported')

    def test_create_makes_the_group_lists_it_and_opens_it(self):
        self.on()
        self.go('GET', '/people?network=whatsapp')
        seq = self.inbox.store.seq
        picked = ['@whatsapp_66810000001' + D, '@whatsapp_66810000002' + D]
        status, data = self.go('POST', '', {'client_id': 'tap-0000001', 'network': 'whatsapp', 'people': picked,
                                            'name': '  Trip   to Krabi '})
        self.assertEqual(status, 200, data)
        result = data['result']
        self.assertEqual((result['network'], result['name'], result['not_added']), ('WhatsApp', 'Trip to Krabi', []))
        self.assertEqual(self.bridge.creates(), [('whatsapp', 'POST', '/create_group/group',
                                                  {'participants': picked, 'name': {'name': 'Trip to Krabi'}})])
        self.inbox.mx.assert_called_once_with('/join/%21group1-whatsapp%3Amessenger.internal', 'POST', {})
        # In the Inbox at once, before the first message, and it opens as a group ready to send.
        self.assertEqual(self.groups(), ['Trip to Krabi'])
        self.assertGreater(self.inbox.store.seq, seq)
        status, _, chat = self.request('GET', '/api/unified/people/' + result['chat_id'], None, self.owner)
        self.assertEqual(status, 200, chat)
        self.assertEqual(chat['result']['person']['identities'][0]['kind'], 'group')
        self.assertEqual(chat['result']['person']['identities'][0]['address'], '!group1-whatsapp' + D)
        # People chats are unchanged.
        self.assertEqual(self.inbox.store.people('person'), [])

    def test_same_tap_twice_makes_one_group(self):
        self.on()
        self.go('GET', '/people?network=telegram')
        body = {'client_id': 'tap-0000002', 'network': 'telegram', 'people': ['@telegram_101' + D, '@telegram_102' + D]}
        first = self.go('POST', '', body)[1]['result']
        again = self.go('POST', '', body)[1]['result']
        self.assertEqual(len(self.bridge.creates()), 1)
        self.assertEqual(again['chat_id'], first['chat_id'])
        self.assertTrue(again['repeated'])
        # Telegram requires a name: an empty one becomes the first names.
        self.assertEqual(self.bridge.creates()[0][3]['name'], {'name': 'Dana and Eli'})

    def test_rules(self):
        self.on()
        self.go('GET', '/people?network=whatsapp')
        cases = (({'people': ['@whatsapp_66810000001' + D]}, 'too_few_people'),
                 ({'people': ['@whatsapp_66810000001' + D, '@whatsapp_66819999999' + D]}, 'invalid_people'),
                 ({'people': ['@whatsapp_66810000001' + D, '@telegram_9' + D]}, 'invalid_people'),
                 ({'people': ['@whatsapp_66810000001' + D, '@whatsapp_66810000001' + D]}, 'too_few_people'),
                 ({'network': 'signal'}, 'group_unsupported'),
                 ({'client_id': 'x'}, 'invalid_request'))
        for extra, code in cases:
            body = {'client_id': 'tap-rules-01', 'network': 'whatsapp', **extra}
            with self.subTest(extra=extra):
                status, data = self.go('POST', '', body)
                self.assertEqual(data['error']['code'], code, data)
        self.assertEqual(self.bridge.creates(), [])

    def test_photo_goes_with_whatsapp_and_onto_the_room_elsewhere(self):
        self.on()
        jpeg = b'\xff\xd8\xff\xe0' + b'0' * 64
        pic = self.inbox.dispatch('PUT', '/api/unified/new-group/photo', {}, {}, jpeg)['photo']
        self.inbox.matrix_upload.assert_called_once_with(jpeg, 'photo.jpg', 'image/jpeg')
        self.go('GET', '/people?network=whatsapp')
        r = self.go('POST', '', {'client_id': 'tap-photo-1', 'network': 'whatsapp', 'photo': pic,
                                 'people': ['@whatsapp_66810000001' + D, '@whatsapp_66810000002' + D]})[1]['result']
        self.assertEqual(r['photo'], 'set')
        self.assertEqual(self.bridge.creates()[0][3]['avatar'], {'url': 'mxc://messenger.internal/pic1'})
        pic = self.inbox.dispatch('PUT', '/api/unified/new-group/photo', {}, {}, jpeg)['photo']
        self.go('GET', '/people?network=telegram')
        r = self.go('POST', '', {'client_id': 'tap-photo-2', 'network': 'telegram', 'photo': pic, 'name': 'Book club',
                                 'people': ['@telegram_101' + D, '@telegram_102' + D]})[1]['result']
        self.assertEqual(r['photo'], 'set')
        self.assertNotIn('avatar', self.bridge.creates()[1][3])
        self.inbox.mx.assert_any_call('/rooms/%21group2-telegram%3Amessenger.internal/state/m.room.avatar/', 'PUT',
                                      {'url': 'mxc://messenger.internal/pic1'})
        with self.assertRaises(EngineError) as raised:
            self.inbox.dispatch('PUT', '/api/unified/new-group/photo', {}, {}, b'GIF89a' + b'0' * 20)
        self.assertEqual(raised.exception.code, 'invalid_upload')

    def test_people_whatsapp_would_not_add_are_named(self):
        self.on()
        self.go('GET', '/people?network=whatsapp')
        self.bridge.failed = {'66810000002': {'reason': 'error 403'}}
        r = self.go('POST', '', {'client_id': 'tap-fail-01', 'network': 'whatsapp',
                                 'people': ['@whatsapp_66810000001' + D, '@whatsapp_66810000002' + D]})[1]['result']
        self.assertEqual(r['not_added'], ['Bob Ray'])

    def test_agents_cannot_create_groups(self):
        self.on()
        self.go('GET', '/people?network=whatsapp')
        calls = len(self.bridge.calls)
        for method, path, body in (('GET', '', None), ('POST', '', {'client_id': 'agent-tap-1', 'network': 'whatsapp',
                                                                     'people': ['@whatsapp_66810000001' + D,
                                                                                '@whatsapp_66810000002' + D]})):
            status, data = self.go(method, path, body, self.key)
            self.assertEqual(status, 403, data)
        self.assertEqual(len(self.bridge.calls), calls)
        self.assertEqual(self.groups(), [])


class SenderRoutes(unittest.TestCase):
    def setUp(self):
        self.sender = LocalOwnerSender('http://127.0.0.1:9', bases={'whatsapp': 'http://127.0.0.1:9'})

    def outcome(self, **kw):
        with self.assertRaises(EngineError) as raised:
            self.sender(base='http://127.0.0.1:9', **kw)
        return raised.exception.code

    def test_create_group_and_the_group_picture_only(self):
        q = '?user_id=%40owner%3Amessenger.internal'
        self.assertEqual(self.outcome(network='whatsapp', path='/_matrix/provision/v3/create_group/group' + q,
                                      method='POST', body={}), 'owner_transport_failed')  # allowed; nothing on :9
        room = '/_matrix/client/v3/rooms/%21g%3Amessenger.internal/state/m.room.avatar/'
        self.assertEqual(self.outcome(network='matrix', path=room, method='PUT',
                                      body={'url': 'mxc://messenger.internal/pic1'}), 'owner_transport_failed')
        for network, path, method, body in (
                ('whatsapp', '/_matrix/provision/v3/create_group/a/b' + q, 'POST', {}),
                ('matrix', room, 'PUT', {'url': 'https://x.test/a.png'}),
                ('matrix', room, 'PUT', {'url': 'mxc://messenger.internal/pic1', 'info': {}}),
                ('matrix', room.replace('m.room.avatar', 'm.room.name'), 'PUT', {'name': 'x'}),
                ('matrix', room.replace('m.room.avatar', 'm.room.power_levels'), 'PUT', {'url': 'mxc://a/b'})):
            with self.subTest(path=path, body=body):
                self.assertEqual(self.outcome(network=network, path=path, method=method, body=body), 'sender_route_denied')


if __name__ == '__main__':
    unittest.main()
