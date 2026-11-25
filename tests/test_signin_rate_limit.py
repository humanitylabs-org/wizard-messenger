"""Issue 284: a site that answers its sign-in page with 429 "too many requests" must not leave the owner on Chrome's
opaque "This page isn't working / HTTP ERROR 429" page.

Instagram answers https://www.instagram.com/accounts/login/ with 429 for some internet addresses. The sign-in window
now notices the answer, closes itself (no Reload loop against the site) and tells the owner what happened.

The last test drives a real browser-engine (the signin-browser image) when SIGNIN_BROWSER_DEVTOOLS points at one
whose network reaches this machine's localhost, e.g.
  docker run -d --rm --network host --shm-size 1g -e HOME=/tmp <browser-engine image>
  SIGNIN_BROWSER_DEVTOOLS=http://localhost:9222 python -m pytest tests/test_signin_rate_limit.py
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import threading
import time
import unittest
from unittest import mock

import browser_signin
from test_signin_passkeys import FakeCDP, FakeVersion


def fake_session(network='instagram', url='https://www.instagram.com/accounts/login/'):
    made = []

    def cdp(ws, on_event):
        made.append(FakeCDP(ws, on_event))
        made[-1].on_event = on_event
        return made[-1]
    with mock.patch.object(browser_signin, 'CDP', cdp), \
            mock.patch.object(browser_signin.socket, 'gethostbyname', lambda host: '127.0.0.1'), \
            mock.patch.object(browser_signin, 'urlopen', lambda url, timeout=5: FakeVersion()):
        sess = browser_signin.Session(network, 412, 860, False, url=url, step={'type': 'cookies', 'cookies': {'url': url}})
    return sess, made[0]


def answer(cdp, status, url='https://www.instagram.com/accounts/login/', frame='t1', kind='Document'):
    cdp.on_event({'method': 'Network.responseReceived', 'sessionId': 's1',
                  'params': {'type': kind, 'frameId': frame, 'response': {'status': status, 'url': url}}})


def settle(signin, sess, seconds=5):
    end = time.time() + seconds
    while time.time() < end and sess.state == 'signing_in':
        time.sleep(0.1)


class Connectors:
    pending = {}


class RateLimitTests(unittest.TestCase):
    def test_a_429_sign_in_page_closes_the_window_and_says_why(self):
        sess, cdp = fake_session()
        signin = browser_signin.BrowserSignIn(Connectors())
        signin.sessions[sess.id] = sess
        answer(cdp, 429)
        settle(signin, sess)
        frame = sess.wait_frame(0, hold=0)
        self.assertEqual(frame['state'], 'rate_limited')
        self.assertIn('Instagram', frame['message'])
        self.assertIn('too many requests', frame['message'])
        self.assertIn('not a problem with your account', frame['message'])
        self.assertIn('username and password', frame['message'])
        self.assertEqual(frame['retry_in'], browser_signin.RETRY_SECONDS)
        # The window is signed out and destroyed: nothing keeps asking the site again.
        names = [c[0] for c in cdp.calls]
        self.assertIn('Target.disposeBrowserContext', names)
        self.assertTrue(cdp.closed)
        self.assertEqual(signin.dispatch('POST', [sess.id, 'input'], {'type': 'tap', 'x': .5, 'y': .5}, {}), {'ok': False})

    def test_other_networks_get_their_own_name_and_no_password_hint(self):
        sess, cdp = fake_session('linkedin', 'https://www.linkedin.com/login')
        signin = browser_signin.BrowserSignIn(Connectors())
        signin.sessions[sess.id] = sess
        answer(cdp, 429, 'https://www.linkedin.com/login')
        settle(signin, sess)
        self.assertEqual(sess.state, 'rate_limited')
        self.assertIn('LinkedIn is not letting', sess.message)
        self.assertNotIn('password', sess.message)

    def test_normal_pages_and_limited_side_requests_leave_the_sign_in_open(self):
        sess, cdp = fake_session()
        signin = browser_signin.BrowserSignIn(Connectors())
        signin.sessions[sess.id] = sess
        answer(cdp, 200)
        answer(cdp, 429, 'https://www.instagram.com/api/graphql', kind='XHR')
        answer(cdp, 429, 'https://www.instagram.com/ad', frame='child-frame')
        time.sleep(3.5)
        self.assertEqual(sess.state, 'signing_in')
        self.assertNotIn('retry_in', sess.wait_frame(0, hold=0))
        sess.close()


@unittest.skipUnless(os.environ.get('SIGNIN_BROWSER_DEVTOOLS'), 'needs a running browser-engine (SIGNIN_BROWSER_DEVTOOLS)')
class RealBrowserRateLimitTests(unittest.TestCase):
    def test_a_real_429_page_is_reported_not_shown(self):
        class Limited(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'<!doctype html><title>x</title>' if self.path == '/ok' else b''
                self.send_response(200 if self.path == '/ok' else 429)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Limited)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_address[1]
        try:
            with mock.patch.object(browser_signin, 'BROWSER', os.environ['SIGNIN_BROWSER_DEVTOOLS']):
                signin = browser_signin.BrowserSignIn(Connectors())
                limited = browser_signin.Session('instagram', 412, 860, False, url='http://localhost:%d/accounts/login/' % port)
                fine = browser_signin.Session('linkedin', 412, 860, False, url='http://localhost:%d/ok' % port)
            signin.sessions[limited.id] = limited
            signin.sessions[fine.id] = fine
            settle(signin, limited, 10)
            self.assertEqual(limited.state, 'rate_limited')
            self.assertTrue(limited.cdp.closed)
            time.sleep(2)
            self.assertEqual(fine.state, 'signing_in')
            fine.close()
        finally:
            server.shutdown()


if __name__ == '__main__':
    unittest.main()
