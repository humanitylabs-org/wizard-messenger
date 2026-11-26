"""Add contact on the network (issue 399, switch add-contact). A recorded Telegram bridge answers like our patched
mautrix-telegram (plumbing/telegram-bridge/contacts.patch: GET/POST /wizard/contact/<user id>); no real account is
contacted. WhatsApp's upstream bridge has no such route and answers 404."""
import json
import unittest

import test_web as fixtures
from connector_sender import LocalOwnerSender
from engine import EngineError
from network_contact import split_name
from switches import SwitchStore
from unified import UnifiedInbox

D = ':messenger.internal'


class ContactBridge:
    def __init__(self):
        self.calls = []
        self.contacts = {'101'}
        self.connected = {'telegram', 'whatsapp'}

    def status(self, network):
        return {'network': network, 'state': 'connected' if network in self.connected else 'not_configured'}

    def request(self, network, path, method='GET', body=None, txn_id='', query=None, timeout=15):
        self.calls.append((network, method, path, body))
        if network != 'telegram' or not path.startswith('/wizard/contact/'):
            raise EngineError('upstream_unavailable', 'M_UNRECOGNIZED', 404)
        uid = path.rsplit('/', 1)[1]
        if method == 'POST':
            self.contacts.add(uid)
        return {'user_id': uid, 'contact': uid in self.contacts, 'can_add': uid not in self.contacts}

    def adds(self):
        return [c for c in self.calls if c[1] == 'POST']


class Pure(unittest.TestCase):
    def test_split_name(self):
        self.assertEqual(split_name('  Gil   van  Novak '), ('Gil', 'van Novak'))
        self.assertEqual(split_name('Gil'), ('Gil', ''))
        self.assertEqual(split_name(''), ('', ''))


class AddContact(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    tearDown = fixtures.ViewBoundary.tearDown
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers

    def setUp(self):
        self.setUp_base()
        self.inbox = UnifiedInbox(self.temp.name, self.server.engine)
        self.server.unified = self.inbox
        self.bridge = ContactBridge()
        self.inbox.connectors = self.bridge
        self.inbox.switches = SwitchStore()
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Helper'}, self.owner)
        ident = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.request('POST', '/api/view/agents/' + ident, {'level': 'draft_and_send'}, self.owner)
        self.gil = self.chat('telegram', '!gil', '@telegram_555', 'Gil Novak')
        self.dana = self.chat('telegram', '!dana', '@telegram_101', 'Dana Wu')
        self.fern = self.chat('whatsapp', '!fern', '@whatsapp_66810000009', 'Fern Ito')
        group = self.inbox.store.identity('telegram', '!grp' + D, 'Team', 'group')
        self.group = group['person_id']

    def chat(self, network, room, ghost, name):
        ident = self.inbox.store.identity(network, room + D, name, 'person')
        with self.inbox.store.db() as db:
            db.execute('INSERT INTO room_meta VALUES (?,?)', (room + D, json.dumps(
                {'network': network, 'kind': 'person', 'label': name, 'names': {ghost + D: name}})))
        return ident['person_id']

    def on(self):
        self.inbox.switches.set('add-contact', True)

    def go(self, method, pid, body=None, headers=None):
        status, _, data = self.request(method, '/api/unified/people/%s/network-contact' % pid, body or {},
                                       headers or self.owner)
        return status, data

    def test_switch_off_changes_nothing(self):
        for method, body in (('GET', None), ('POST', {'network': 'telegram'})):
            status, data = self.go(method, self.gil, body)
            self.assertEqual(status, 404, data)
            self.assertEqual(data['error']['code'], 'feature_off')
        self.assertEqual(self.bridge.calls, [])

    def test_offered_only_where_the_bridge_can_add_and_not_for_contacts(self):
        self.on()
        status, data = self.go('GET', self.gil)
        self.assertEqual(status, 200, data)
        self.assertEqual(data['result']['networks'], [{'network': 'telegram', 'label': 'Telegram', 'contact': False, 'can_add': True}])
        self.assertEqual(self.go('GET', self.dana)[1]['result']['networks'],
                         [{'network': 'telegram', 'label': 'Telegram', 'contact': True, 'can_add': False}])
        # WhatsApp: no contact route, nothing to offer (and no bridge call at all); groups: never.
        self.assertEqual(self.go('GET', self.fern)[1]['result']['networks'], [])
        self.assertEqual(self.go('GET', self.group)[1]['result']['networks'], [])
        self.assertFalse([c for c in self.bridge.calls if c[0] == 'whatsapp'])
        # A Telegram bridge without the route (older image) also means "not offered".
        self.inbox._network_contact['status'].clear()
        self.bridge.request = lambda *a, **k: (_ for _ in ()).throw(EngineError('upstream_unavailable', 'x', 404))
        self.assertEqual(self.go('GET', self.gil)[1]['result']['networks'], [])

    def test_add_uses_the_chats_own_account_and_name(self):
        self.on()
        status, data = self.go('POST', self.gil, {'network': 'telegram', 'value': '999'})
        self.assertEqual(status, 200, data)
        self.assertTrue(data['result']['contact'])
        self.assertEqual(self.bridge.adds(), [('telegram', 'POST', '/wizard/contact/555', {'first_name': 'Gil', 'last_name': 'Novak'})])
        # Next look: a contact now, so no bar.
        self.assertEqual(self.go('GET', self.gil)[1]['result']['networks'][0]['can_add'], False)
        self.go('POST', self.gil, {'network': 'telegram', 'name': 'Gil from Jana'})
        self.assertEqual(self.bridge.adds()[-1][3], {'first_name': 'Gil', 'last_name': 'from Jana'})

    def test_add_refuses_networks_the_chat_is_not_on(self):
        self.on()
        for pid, network in ((self.fern, 'whatsapp'), (self.gil, 'whatsapp'), (self.group, 'telegram')):
            status, data = self.go('POST', pid, {'network': network})
            self.assertEqual(status, 409, data)
            self.assertEqual(data['error']['code'], 'contact_unsupported')
        self.assertEqual(self.bridge.adds(), [])

    def test_no_agent_can_add_a_contact(self):
        self.on()
        for method, body in (('GET', None), ('POST', {'network': 'telegram'})):
            status, data = self.go(method, self.gil, body, self.key)
            self.assertIn(status, (401, 403), data)
        self.assertEqual(self.bridge.adds(), [])


class Sender(unittest.TestCase):
    def test_owner_sender_allows_only_the_contact_add_shape(self):
        sent = []

        class Answer:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=-1): return b'{"contact": true}'

        class Opener:
            def open(self, request, timeout=None):
                sent.append((request.full_url, json.loads(request.data)))
                return Answer()

        sender = LocalOwnerSender('http://matrix:8008', bases={'telegram': 'http://telegram:29317'})
        sender.opener = Opener()
        q = '?user_id=%40owner%3Amessenger.internal'
        def call(path, body):
            try:
                sender(network='telegram', base='http://telegram:29317', path='/_matrix/provision/v3' + path + q,
                       method='POST', body=body, token='t' * 20)
                return 'sent'
            except EngineError as e:
                self.assertEqual(e.code, 'sender_route_denied')
                return 'denied'
        self.assertEqual(call('/wizard/contact/555', {'first_name': 'Gil', 'last_name': 'Novak'}), 'sent')
        self.assertEqual(call('/wizard/contact/555', {'first_name': 'Gil', 'phone': '+1555'}), 'denied')
        self.assertEqual(call('/wizard/contact/abc', {'first_name': 'Gil'}), 'denied')
        self.assertEqual(call('/wizard/contact/555', {'first_name': 'x' * 200}), 'denied')
        self.assertEqual(call('/wizard/stickers', {}), 'denied')
        self.assertEqual(sent, [('http://telegram:29317/_matrix/provision/v3/wizard/contact/555' + q, {'first_name': 'Gil', 'last_name': 'Novak'})])


if __name__ == '__main__':
    unittest.main()
