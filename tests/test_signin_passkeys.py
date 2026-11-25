"""Issue 282/283: a passkey prompt in a network's sign-in page must not trap the owner.

Chromium shows its own passkey window outside the page, which the owner's live picture never shows and which blocks
every tap on the page. Each sign-in window therefore answers passkey requests at once with "not allowed".

The last test drives a real browser-engine (the signin-browser image) when SIGNIN_BROWSER_DEVTOOLS points at one
whose network reaches this machine's localhost, e.g.
  docker run -d --rm --network host --shm-size 1g -e HOME=/tmp <browser-engine image>
  SIGNIN_BROWSER_DEVTOOLS=http://localhost:9222 python -m pytest tests/test_signin_passkeys.py
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

import browser_signin

PAGE = '''<!doctype html><meta charset=utf-8><body>
<button id=go>Continue</button><p id=out>idle</p>
<a href="#" id=other onclick="document.getElementById('out2').textContent='other';return false">Try another way</a>
<p id=out2>-</p><input id=field>
<script>
document.getElementById('go').onclick = async () => {
  const out = document.getElementById('out'); out.textContent = 'spinning';
  try { await navigator.credentials.get({publicKey: {challenge: new Uint8Array(32), rpId: 'localhost',
          userVerification: 'required', timeout: 300000}}); out.textContent = 'got' }
  catch (e) { out.textContent = 'rejected ' + e.name }
};
window.tryCreate = async () => {
  try { await navigator.credentials.create({publicKey: {challenge: new Uint8Array(32), rp: {name: 'x', id: 'localhost'},
          user: {id: new Uint8Array(8), name: 'a', displayName: 'a'}, pubKeyCredParams: [{type: 'public-key', alg: -7}],
          authenticatorSelection: {userVerification: 'discouraged', residentKey: 'discouraged'}, timeout: 20000}}); return 'created' }
  catch (e) { return 'rejected ' + e.name }
};
</script>'''


class FakeCDP:
    def __init__(self, ws, on_event, fail=()):
        self.calls, self.fail, self.closed = [], set(fail), False

    def send(self, method, params=None, session=None, timeout=15):
        self.calls.append((method, params or {}, session))
        if method in self.fail:
            raise OSError("'WebAuthn.enable' wasn't found")
        return {'Target.createBrowserContext': {'browserContextId': 'ctx'}, 'Target.createTarget': {'targetId': 't1'},
                'Target.attachToTarget': {'sessionId': 's1'}, 'Browser.getVersion': {'userAgent': 'Chrome/156'}}.get(method, {})

    def close(self):
        self.closed = True


class FakeVersion:
    def read(self):
        return b'{"webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/x"}'


def fake_session(fail=()):
    made = []

    def cdp(ws, on_event):
        made.append(FakeCDP(ws, on_event, fail))
        return made[-1]
    with mock.patch.object(browser_signin, 'CDP', cdp), \
            mock.patch.object(browser_signin.socket, 'gethostbyname', lambda host: '127.0.0.1'), \
            mock.patch.object(browser_signin, 'urlopen', lambda url, timeout=5: FakeVersion()):
        sess = browser_signin.Session('facebook', 412, 860, False, url='https://www.facebook.com/')
    return sess, made[0].calls


class PasskeyRefusalTests(unittest.TestCase):
    def test_every_sign_in_window_refuses_passkeys_before_the_page_loads(self):
        sess, calls = fake_session()
        names = [c[0] for c in calls]
        self.assertEqual(sess.state, 'signing_in')
        enable, add, nav = names.index('WebAuthn.enable'), names.index('WebAuthn.addVirtualAuthenticator'), names.index('Page.navigate')
        self.assertLess(enable, add)
        self.assertLess(add, nav)
        self.assertEqual(calls[enable][1], {'enableUI': False})
        options = calls[add][1]['options']
        # A key whose user check always fails: it can neither sign in nor be registered on the account.
        self.assertTrue(options['hasUserVerification'])
        self.assertFalse(options['isUserVerified'])
        self.assertTrue(options['automaticPresenceSimulation'])
        self.assertNotEqual(options['transport'], 'internal')  # never claims a fingerprint/face sensor
        self.assertEqual(calls[enable][2], 's1')
        self.assertEqual(calls[add][2], 's1')
        self.assertNotIn('WebAuthn.addCredential', names)

    def test_an_engine_without_webauthn_still_opens_the_sign_in(self):
        sess, calls = fake_session(fail={'WebAuthn.enable'})
        self.assertEqual(sess.state, 'signing_in')
        self.assertIn('Page.navigate', [c[0] for c in calls])
        self.assertNotIn('WebAuthn.addVirtualAuthenticator', [c[0] for c in calls])


@unittest.skipUnless(os.environ.get('SIGNIN_BROWSER_DEVTOOLS'), 'needs a running browser-engine (SIGNIN_BROWSER_DEVTOOLS)')
class RealBrowserPasskeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        with open(os.path.join(cls.dir.name, 'index.html'), 'w') as f:
            f.write(PAGE)
        root = cls.dir.name

        class Quiet(SimpleHTTPRequestHandler):
            def __init__(self, *a, **k):
                super().__init__(*a, directory=root, **k)

            def log_message(self, format, *args):
                pass
        handler = Quiet
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.dir.cleanup()

    def test_passkey_prompt_ends_at_once_and_the_page_keeps_taking_taps(self):
        url = 'http://localhost:%d/index.html' % self.server.server_address[1]
        with mock.patch.object(browser_signin, 'BROWSER', os.environ['SIGNIN_BROWSER_DEVTOOLS']):
            sess = browser_signin.Session('facebook', 412, 860, False, url=url)
        try:
            ev = lambda x: sess.cdp.send('Runtime.evaluate', {'expression': x, 'returnByValue': True, 'awaitPromise': True},
                                         session=sess.session, timeout=30)['result'].get('value')
            for _ in range(50):
                if ev("document.readyState") == 'complete' and ev("!!document.getElementById('go')"):
                    break
                time.sleep(0.2)

            def tap(el):
                r = json.loads(ev("JSON.stringify(document.getElementById(%s).getBoundingClientRect())" % json.dumps(el)))
                sess.input({'type': 'tap', 'x': (r['x'] + 5) / 412, 'y': (r['y'] + r['height'] / 2) / 860})
            tap('go')
            time.sleep(2)
            self.assertEqual(ev("document.getElementById('out').textContent"), 'rejected NotAllowedError')
            tap('other')
            tap('field')
            sess.input({'type': 'text', 'text': 'hello'})
            time.sleep(0.5)
            self.assertEqual(ev("document.getElementById('out2').textContent"), 'other')
            self.assertEqual(ev("document.getElementById('field').value"), 'hello')
            # No passkey can be registered on the owner's account from here.
            self.assertEqual(ev("tryCreate()"), 'rejected NotAllowedError')
        finally:
            sess.close()


if __name__ == '__main__':
    unittest.main()
