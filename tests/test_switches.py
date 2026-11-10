"""Messenger feature switches for the WizardOS Tracker (wizard.app-switches/1, issue 150)."""
import json
import tempfile
import unittest
from pathlib import Path

import test_trusted_owner
import test_web
from switches import CONTRACT, SwitchStore

TOKEN = test_web.TOKEN
ORIGIN = test_web.ORIGIN
WRITE = {'X-Wizard-Switch': '1'}


class SwitchEndpoint(unittest.TestCase):
    setUp = test_web.ViewBoundary.setUp
    tearDown = test_web.ViewBoundary.tearDown
    request = test_web.ViewBoundary.request
    ticket = test_web.ViewBoundary.ticket
    session = test_web.ViewBoundary.session
    owner_headers = test_web.ViewBoundary.owner_headers

    def owner(self):
        # The Tracker sends the owner cookie and the box's own Origin, but has no Messenger CSRF token.
        h = self.owner_headers(); del h['X-Messenger-CSRF']
        return h

    def test_lists_drafts_first_off_by_default(self):
        for path in ('/api/view/switches', '/api/switches'):
            status, _, body = self.request('GET', path, headers=self.owner())
            self.assertEqual(status, 200)
            self.assertEqual(body['contract'], CONTRACT)
            self.assertEqual(body['switches'], [{
                'id': 'drafts-first', 'name': 'Drafts at top',
                'description': 'Chats with a waiting draft lead the Inbox, newest draft first.',
                'on': False, 'default': False,
                'issues': ['humanitylabs-org/wizard-messenger#133', 'humanitylabs-org/wizard-messenger#150']}, {
                'id': 'photo-warm', 'name': 'Photos ready on arrival',
                'description': 'The box fetches incoming photos, stickers, GIFs and videos as they arrive, so they open at once.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#162']}])

    def test_owner_flips_it_and_every_reader_sees_it(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': True}, h)
        self.assertEqual(status, 200)
        self.assertTrue(body['switches'][0]['on'])
        self.assertTrue(self.request('GET', '/api/switches', headers=self.owner())[2]['switches'][0]['on'])
        # Messenger's own Settings sends its CSRF token as well; that is fine.
        status, _, body = self.request('POST', '/api/switches', {'id': 'drafts-first', 'on': False}, {**self.owner_headers(), **WRITE})
        self.assertEqual(status, 200)
        self.assertFalse(body['switches'][0]['on'])

    def test_owner_only(self):
        status, _, body = self.request('GET', '/api/view/switches', headers={'Origin': ORIGIN})
        self.assertEqual(status, 401); self.assertIsInstance(body['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': True}, {'Origin': ORIGIN, **WRITE})[0], 401)
        for auth in ({'Authorization': 'Bearer ' + TOKEN}, {**self.owner(), 'Authorization': 'Bearer ' + TOKEN}):
            status, _, body = self.request('GET', '/api/view/switches', headers=auth)
            self.assertEqual(status, 403); self.assertIsInstance(body['error'], str)
            self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': True}, {**auth, **WRITE})[0], 403)
        self.assertFalse(self.server.switches.is_on('drafts-first'))

    def test_write_needs_origin_and_header(self):
        body = {'id': 'drafts-first', 'on': True}
        cookie = {'Cookie': self.owner()['Cookie'], **WRITE}
        self.assertEqual(self.request('POST', '/api/view/switches', body, cookie)[0], 403)  # no Origin
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**cookie, 'Origin': 'https://evil.example'})[0], 403)
        status, _, reply = self.request('POST', '/api/view/switches', body, self.owner())  # no X-Wizard-Switch
        self.assertEqual(status, 403); self.assertIsInstance(reply['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**self.owner(), 'X-Wizard-Switch': '0'})[0], 403)
        self.assertFalse(self.server.switches.is_on('drafts-first'))

    def test_unknown_id_and_bad_body(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'nope', 'on': True}, h)
        self.assertEqual(status, 404); self.assertIsInstance(body['error'], str)
        for bad in ({'id': 'drafts-first'}, {'id': 'drafts-first', 'on': 'yes'}, {'id': 7, 'on': True}, {'on': True},
                    {'id': 'drafts-first', 'on': True, 'extra': 1}):
            status, _, body = self.request('POST', '/api/view/switches', bad, h)
            self.assertEqual(status, 400, bad); self.assertIsInstance(body['error'], str)
        status, _, body = self.request('POST', '/api/view/switches', b'not json', {**h, 'Content-Type': 'application/json'})
        self.assertEqual(status, 400)
        status, _, body = self.request('POST', '/api/view/switches', b'{}', {**h, 'Content-Type': 'text/plain'})
        self.assertEqual(status, 400)
        self.assertEqual(self.request('DELETE', '/api/view/switches', None, h)[0], 405)


class SwitchesWithWizardOwnerProof(unittest.TestCase):
    """Wizard owner access on: the App Manager calls the switches server-side with the platform owner proof and no
    Messenger cookie (the Tracker's Try it, one catalog for core and apps). A proof is required; a bearer never works."""
    setUp = test_trusted_owner.PlatformOwnerProof.setUp
    tearDown = test_trusted_owner.TrustedOwnerHTTP.tearDown
    start = test_trusted_owner.TrustedOwnerHTTP.start
    stop = test_trusted_owner.TrustedOwnerHTTP.stop

    def request(self, method, target, body=None, *, proof=True, headers=None):
        from trusted_owner import PLATFORM_HEADER, sign_platform_request
        h = dict(headers or {})
        if proof and PLATFORM_HEADER not in h:
            h[PLATFORM_HEADER] = sign_platform_request(self.proof, 'messenger', method, target)
        return test_trusted_owner.TrustedOwnerHTTP.request(self, method, target, body, proof=False, headers=h)

    def test_proof_alone_lists_and_flips_without_a_session(self):
        status, _, body = self.request('GET', '/api/view/switches')
        self.assertEqual(status, 200); self.assertFalse(body['switches'][0]['on'])
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': True}, headers=WRITE)
        self.assertEqual(status, 200); self.assertTrue(body['switches'][0]['on'])
        self.assertTrue(self.server.switches.is_on('drafts-first'))

    def test_no_proof_a_reused_proof_or_a_bearer_is_refused(self):
        self.assertEqual(self.request('GET', '/api/view/switches', proof=False)[0], 403)
        from trusted_owner import PLATFORM_HEADER, sign_platform_request
        once = sign_platform_request(self.proof, 'messenger', 'POST', '/api/view/switches')
        h = {**WRITE, PLATFORM_HEADER: once}
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': True}, headers=h)[0], 200)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': False}, headers=h)[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': False},
                                      headers={**WRITE, 'Authorization': 'Bearer ' + TOKEN})[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'drafts-first', 'on': False}, headers={})[0], 403)
        self.assertTrue(self.server.switches.is_on('drafts-first'))


class SwitchStorage(unittest.TestCase):
    def test_kept_on_the_box_and_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            SwitchStore(path).set('drafts-first', True)
            self.assertEqual(json.loads(path.read_text()), {'switches': {'drafts-first': True}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(SwitchStore(path).is_on('drafts-first'))
            SwitchStore(path).set('drafts-first', False)
            self.assertEqual(json.loads(path.read_text()), {'switches': {}})

    def test_a_damaged_file_reads_as_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            for raw in ('{', '[]', '{"switches": {"drafts-first": "1", "gone": true}}'):
                path.write_text(raw)
                self.assertFalse(SwitchStore(path).is_on('drafts-first'))
                self.assertEqual([s['id'] for s in SwitchStore(path).listing()['switches']], ['drafts-first', 'photo-warm'])


if __name__ == '__main__':
    unittest.main()
