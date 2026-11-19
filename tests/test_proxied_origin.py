"""Issue 288: first setup in the Mac window answered "Couldn't connect" on Create address.

The Mac window's door (try-wizard local-proxy.conf) shows a same-origin write to an app behind Serve with Serve's
Origin (https://<box>.ts.net:<port>) but kept the window's Host (127.0.0.1:48023). Messenger accepts a write when its
Origin names the Host it came to, so it refused every write there with origin_forbidden, and the view had no words
for that code. The browser's own Sec-Fetch-Site: same-origin (no page script can set it) now counts as proof too;
the session cookie and CSRF token still guard the write."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from test_web import FakeEngine, TOKEN
from web import ViewServer

WINDOW_HOST = '127.0.0.1:48023'
SERVE_ORIGIN = 'https://box.tail1234.ts.net:8796'
PASSWORD = 'mac-window-fixture-passphrase'


class ProxiedOrigin(unittest.TestCase):
    def setUp(self):
        # A Store install: MESSENGER_ALLOWED_ORIGINS is left empty, so only Origin == Host (or the browser) counts.
        self.engine = FakeEngine()
        self.server = ViewServer(('127.0.0.1', 0), self.engine, TOKEN, [])
        self.temp = tempfile.TemporaryDirectory()
        self.server.static_root = Path(self.temp.name)
        (self.server.static_root / 'index.html').write_text('<h1>Messenger</h1>')
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        h = {'Connection': 'close', 'Host': WINDOW_HOST, **(headers or {})}
        if body is not None:
            h['Content-Type'] = 'application/json'; body = json.dumps(body)
        conn.request(method, path, body, headers=h)
        response = conn.getresponse()
        data = response.read(); status = response.status; result_headers = dict(response.getheaders()); conn.close()
        return status, result_headers, json.loads(data) if data else {}

    def setup_session(self):
        # The page's own GET: browsers send no Origin on a same-origin GET.
        status, headers, body = self.request('GET', '/api/view/session', headers={'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200, body)
        return headers['Set-Cookie'].split(';')[0], body['result']['csrf_token']

    def create(self, **headers):
        cookie, csrf = self.setup_session()
        return self.request('POST', '/api/setup', {'action': 'create', 'vault_password': PASSWORD, 'display_name': 'Jan'},
                            {'Cookie': cookie, 'Origin': SERVE_ORIGIN, 'X-Messenger-CSRF': csrf, **headers})

    def test_create_address_through_a_proxy_that_kept_the_window_host(self):
        status, _, body = self.create(**{'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200, body)
        self.assertEqual(body['result']['state'], 'ready')
        # ...and the passphrase then opens Messenger through the same door.
        status, _, body = self.request('POST', '/api/view/unlock', {'vault_password': PASSWORD},
                                       {'Origin': SERVE_ORIGIN, 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200, body)
        self.assertIn('csrf_token', body['result'])

    def test_a_mismatched_origin_without_the_browsers_word_is_still_refused(self):
        for extra in ({}, {'Sec-Fetch-Site': 'same-site'}, {'Sec-Fetch-Site': 'cross-site'}, {'Sec-Fetch-Site': 'none'}):
            status, _, body = self.create(**extra)
            self.assertEqual((status, body['error']['code']), (403, 'origin_forbidden'), extra)
        self.assertEqual(self.engine.calls, 0)

    def test_same_origin_still_needs_the_session_and_its_csrf(self):
        cookie, _ = self.setup_session()
        status, _, body = self.request('POST', '/api/setup', {'action': 'create', 'vault_password': PASSWORD},
                                       {'Cookie': cookie, 'Origin': SERVE_ORIGIN, 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual((status, body['error']['code']), (403, 'csrf_forbidden'))
        status, _, body = self.request('POST', '/api/setup', {'action': 'create', 'vault_password': PASSWORD},
                                       {'Origin': SERVE_ORIGIN, 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 401)
        self.assertEqual(self.engine.calls, 0)

    def test_a_cross_site_page_never_gets_a_setup_session(self):
        status, headers, _ = self.request('GET', '/api/view/session', headers={'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(status, 403)
        self.assertNotIn('Set-Cookie', headers)


if __name__ == '__main__':
    unittest.main()
