"""Browser boundary (wizard-os issue 133): in a Messenger window the Wizard sandboxes, the view's fetch to /contacts/
leaves with Origin: null and the browser blocks Contacts' answer. The view then asks Messenger
(/api/view/contacts/<call>), and Messenger calls the granted Contacts itself (contacts_link.py): only the owner's
browser session, only three calls, only to the endpoint the App Manager wrote into WIZARD_GRANTS_FILE."""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import test_web as fx
from contacts_link import ContactsLink

KEY = 'a' * 64


class FakeContacts(ThreadingHTTPServer):
    """Stands in for the Contacts app: records each call and answers like it."""
    def __init__(self):
        self.calls = []
        self.answer = (200, {'contacts': [{'id': 'c_1', 'name': 'Ana Lopez', 'accounts': [{'network': 'whatsapp', 'value': 'lid-111'}]}]})
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def reply(self):
                size = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(size) if size else b''
                outer.calls.append({'method': self.command, 'path': self.path, 'grant': self.headers.get('X-Wizard-Grant'),
                                    'cookie': self.headers.get('Cookie'), 'origin': self.headers.get('Origin'),
                                    'body': json.loads(body) if body else None})
                status, data = outer.answer
                raw = json.dumps(data).encode() if not isinstance(data, bytes) else data
                self.send_response(status)
                if status in (301, 302, 307):
                    self.send_header('Location', 'http://127.0.0.1:1/elsewhere')
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            do_GET = do_POST = reply

            def log_message(self, *a):
                pass
        super().__init__(('127.0.0.1', 0), Handler)


class ContactsLinkView(unittest.TestCase):
    setUp_view = fx.ViewBoundary.setUp
    tearDown_view = fx.ViewBoundary.tearDown
    request = fx.ViewBoundary.request
    session = fx.ViewBoundary.session
    owner_headers = fx.ViewBoundary.owner_headers

    def setUp(self):
        self.setUp_view()
        self.contacts = FakeContacts()
        threading.Thread(target=self.contacts.serve_forever, daemon=True).start()
        self.dir = tempfile.TemporaryDirectory()
        self.grants = os.path.join(self.dir.name, 'grants.json')
        self.grant({'slot:contacts': 'http://127.0.0.1:%d' % self.contacts.server_port})
        self.server.contacts_link = ContactsLink(self.grants)

    def tearDown(self):
        self.contacts.shutdown(); self.contacts.server_close(); self.dir.cleanup()
        self.tearDown_view()

    def grant(self, endpoints, key=KEY):
        with open(self.grants, 'w') as f:
            json.dump({'outgoing': {k: key for k in endpoints}, 'incoming': [], 'provider_endpoints': endpoints, 'enforce': False}, f)

    def test_owner_reads_contacts_through_the_granted_connection(self):
        cookie, _ = self.session()
        status, _, body = self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})
        self.assertEqual(status, 200)
        self.assertEqual(body['result']['contacts'][0]['name'], 'Ana Lopez')
        call = self.contacts.calls[-1]
        self.assertEqual((call['method'], call['path'], call['grant']), ('GET', '/api/contacts', KEY))
        # Messenger's session cookie and the browser's Origin never travel on to Contacts.
        self.assertIsNone(call['cookie']); self.assertIsNone(call['origin'])

    def test_owner_saves_a_person_and_my_card(self):
        self.contacts.answer = (200, {'contact': {'id': 'c_2', 'name': 'Bram'}, 'created': True})
        photo = 'data:image/jpeg;base64,' + 'A' * 300000  # Add to Contacts carries the chat's photo
        status, _, body = self.request('POST', '/api/view/contacts/save', {'name': 'Bram', 'accounts': [{'network': 'whatsapp', 'value': '316123'}], 'photo': photo}, self.owner_headers())
        self.assertEqual(status, 200)
        self.assertEqual(body['result'], {'contact': {'id': 'c_2', 'name': 'Bram'}, 'created': True})
        self.assertEqual(self.contacts.calls[-1]['path'], '/api/save')
        self.assertEqual(self.contacts.calls[-1]['body']['photo'], photo)
        status, _, _ = self.request('POST', '/api/view/contacts/me/connected', {'name': 'Me', 'accounts': []}, self.owner_headers())
        self.assertEqual(status, 200)
        self.assertEqual(self.contacts.calls[-1]['path'], '/api/me/connected')

    def test_without_the_owner_session_nothing_reaches_contacts(self):
        cookie, csrf = self.session()
        cases = [
            ('GET', None, {}),                                                        # no session
            ('GET', None, {'Authorization': 'Bearer ' + fx.TOKEN}),                   # the machine key
            ('POST', {}, {'Cookie': cookie, 'Origin': fx.ORIGIN}),                    # no CSRF
            ('POST', {}, {'Cookie': cookie, 'X-Messenger-CSRF': csrf, 'Origin': 'https://evil.example'}),
            ('POST', {}, {'Authorization': 'Bearer ' + fx.TOKEN, 'Origin': fx.ORIGIN}),
        ]
        for method, body, headers in cases:
            path = '/api/view/contacts/' + ('contacts' if method == 'GET' else 'save')
            self.assertIn(self.request(method, path, body, headers)[0], (401, 403), (method, headers))
        self.assertEqual(self.contacts.calls, [])

    def test_only_the_three_calls_are_forwarded(self):
        cookie, _ = self.session()
        for method, path in (('GET', 'save'), ('GET', 'duplicates'), ('GET', 'export.vcf'), ('GET', 'c_123456789012'),
                             ('GET', '../healthz'), ('GET', 'contacts/../me'), ('POST', 'contacts'), ('POST', 'import'),
                             ('POST', 'c_123456789012/delete'), ('POST', 'sync/setup')):
            headers = self.owner_headers() if method == 'POST' else {'Cookie': cookie}
            self.assertEqual(self.request(method, '/api/view/contacts/' + path, {} if method == 'POST' else None, headers)[0], 404, path)
        self.assertEqual(self.contacts.calls, [])

    def test_no_grant_means_contacts_is_unavailable(self):
        cookie, _ = self.session()
        os.remove(self.grants)
        status, _, body = self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})
        self.assertEqual((status, body['error']['code']), (404, 'contacts_unavailable'))
        for bad in ({}, {'slot:contacts': 'file:///etc/passwd'}, {'slot:contacts': 'http://u:p@127.0.0.1:9'},
                    {'slot:contacts': 'http://127.0.0.1:9/?x=1'}, {'other-app': 'http://127.0.0.1:%d' % self.contacts.server_port}):
            self.grant(bad)
            self.assertEqual(self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})[0], 404, bad)
        self.assertEqual(self.contacts.calls, [])
        # A grant keyed by the app id (not the slot) works too.
        self.grant({'contacts': 'http://127.0.0.1:%d/' % self.contacts.server_port})
        self.assertEqual(self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})[0], 200)

    def test_contacts_refusals_and_redirects(self):
        cookie, _ = self.session()
        self.contacts.answer = (400, {'error': 'Give the contact a name.'})
        status, _, body = self.request('POST', '/api/view/contacts/save', {'accounts': []}, self.owner_headers())
        self.assertEqual((status, body['error']['message']), (400, 'Give the contact a name.'))
        # A redirect is never followed (it could point anywhere on the app network).
        self.contacts.answer = (307, {})
        self.assertEqual(self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})[0], 502)
        self.assertEqual(len(self.contacts.calls), 2)
        self.contacts.answer = (200, b'<html>not json</html>')
        self.assertEqual(self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})[0], 502)
        self.grant({'slot:contacts': 'http://127.0.0.1:1'})  # nothing listening
        self.assertEqual(self.request('GET', '/api/view/contacts/contacts', headers={'Cookie': cookie})[0], 503)


if __name__ == '__main__':
    unittest.main()
