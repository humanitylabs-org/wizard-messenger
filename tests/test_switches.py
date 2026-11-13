"""Messenger feature switches for the WizardOS Tracker (wizard.app-switches/1, issue 150)."""
import json
import tempfile
import unittest
from pathlib import Path

import test_trusted_owner
import test_web
from switches import CONTRACT, SwitchStore, UnknownSwitch

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

    def test_lists_every_switch_off_by_default(self):
        for path in ('/api/view/switches', '/api/switches'):
            status, _, body = self.request('GET', path, headers=self.owner())
            self.assertEqual(status, 200)
            self.assertEqual(body['contract'], CONTRACT)
            self.assertEqual(body['switches'], [{
                'id': 'photo-warm', 'name': 'Photos ready on arrival',
                'description': 'The box fetches incoming photos, stickers, GIFs and videos as they arrive, so they open at once.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#162']}, {
                'id': 'photo-instant', 'name': 'Photos open instantly',
                'description': 'A tapped photo shows its thumbnail at once and sharpens to a screen-size copy the box keeps; '
                               'zooming in loads the original.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#164']}, {
                'id': 'viewer-placeholder', 'name': "Photos ready in Wizard's viewer",
                'description': "A photo opened in Wizard's shared viewer comes with a ready copy (the one this phone "
                               'downloaded, else its thumbnail) to show until the original is in. Save and Share still use '
                               'the original.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#170']}, {
                'id': 'photo-prefetch', 'name': 'Background photo download',
                'description': 'The phone quietly downloads recent photos from your newest chats, on Wi-Fi only unless you '
                               'choose Always, so they open at once.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#166']}, {
                'id': 'photo-timings', 'name': 'Photo timings',
                'description': 'Messenger measures how fast photos appear (box ready on arrival, thumbnail, tap to picture, '
                               'black frames) per network and shows the numbers in Settings. Only times and sizes, never content.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#168']}, {
                'id': 'agent-drafts', 'name': 'Agent keeps drafts ready',
                'description': 'Pick chats (chat ⋯ > Agent keeps a draft ready), or every unread chat, and your agent keeps '
                               'a reply drafted there for you to send, edit or discard. It learns from how you change its '
                               'drafts. It never sends, and needs Draft-only access.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#178']}, {
                'id': 'row-tap-menu', 'name': 'Tap beside a message for its menu',
                'description': "On a phone, tapping the empty space to the right of someone's message opens that "
                               "message's menu (Reply, react, Select), the same one holding it opens. Tapping a photo "
                               'still opens it.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#182']}, {
                'id': 'line-photo-groups', 'name': 'LINE photo groups',
                'description': 'Several photos sent together to a LINE chat go as one photo group, like LINE sends '
                               'them, instead of only the first photo arriving.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#188']}])

    def test_owner_flips_it_and_every_reader_sees_it(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, h)
        self.assertEqual(status, 200)
        self.assertTrue(body['switches'][0]['on'])
        self.assertTrue(self.request('GET', '/api/switches', headers=self.owner())[2]['switches'][0]['on'])
        # Messenger's own Settings sends its CSRF token as well; that is fine.
        status, _, body = self.request('POST', '/api/switches', {'id': 'photo-warm', 'on': False}, {**self.owner_headers(), **WRITE})
        self.assertEqual(status, 200)
        self.assertFalse(body['switches'][0]['on'])

    def test_owner_only(self):
        status, _, body = self.request('GET', '/api/view/switches', headers={'Origin': ORIGIN})
        self.assertEqual(status, 401); self.assertIsInstance(body['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, {'Origin': ORIGIN, **WRITE})[0], 401)
        for auth in ({'Authorization': 'Bearer ' + TOKEN}, {**self.owner(), 'Authorization': 'Bearer ' + TOKEN}):
            status, _, body = self.request('GET', '/api/view/switches', headers=auth)
            self.assertEqual(status, 403); self.assertIsInstance(body['error'], str)
            self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, {**auth, **WRITE})[0], 403)
        self.assertFalse(self.server.switches.is_on('photo-warm'))

    def test_write_needs_origin_and_header(self):
        body = {'id': 'photo-warm', 'on': True}
        cookie = {'Cookie': self.owner()['Cookie'], **WRITE}
        self.assertEqual(self.request('POST', '/api/view/switches', body, cookie)[0], 403)  # no Origin
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**cookie, 'Origin': 'https://evil.example'})[0], 403)
        status, _, reply = self.request('POST', '/api/view/switches', body, self.owner())  # no X-Wizard-Switch
        self.assertEqual(status, 403); self.assertIsInstance(reply['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**self.owner(), 'X-Wizard-Switch': '0'})[0], 403)
        self.assertFalse(self.server.switches.is_on('photo-warm'))

    def test_unknown_id_and_bad_body(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'nope', 'on': True}, h)
        self.assertEqual(status, 404); self.assertIsInstance(body['error'], str)
        for bad in ({'id': 'photo-warm'}, {'id': 'photo-warm', 'on': 'yes'}, {'id': 7, 'on': True}, {'on': True},
                    {'id': 'photo-warm', 'on': True, 'extra': 1}):
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
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, headers=WRITE)
        self.assertEqual(status, 200); self.assertTrue(body['switches'][0]['on'])
        self.assertTrue(self.server.switches.is_on('photo-warm'))

    def test_no_proof_a_reused_proof_or_a_bearer_is_refused(self):
        self.assertEqual(self.request('GET', '/api/view/switches', proof=False)[0], 403)
        from trusted_owner import PLATFORM_HEADER, sign_platform_request
        once = sign_platform_request(self.proof, 'messenger', 'POST', '/api/view/switches')
        h = {**WRITE, PLATFORM_HEADER: once}
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, headers=h)[0], 200)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': False}, headers=h)[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': False},
                                      headers={**WRITE, 'Authorization': 'Bearer ' + TOKEN})[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': False}, headers={})[0], 403)
        self.assertTrue(self.server.switches.is_on('photo-warm'))


class SwitchStorage(unittest.TestCase):
    def test_kept_on_the_box_and_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            SwitchStore(path).set('photo-warm', True)
            self.assertEqual(json.loads(path.read_text()), {'switches': {'photo-warm': True}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(SwitchStore(path).is_on('photo-warm'))
            SwitchStore(path).set('photo-warm', False)
            self.assertEqual(json.loads(path.read_text()), {'switches': {}})

    def test_drafts_at_top_is_no_longer_a_switch(self):
        # Issue 150: Drafts at top was approved, so it is always on and leaves the list; a box that stored it on or
        # off before keeps working and the stale value is ignored.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"drafts-first": true, "photo-warm": true}}')
            store = SwitchStore(path)
            self.assertNotIn('drafts-first', [s['id'] for s in store.listing()['switches']])
            self.assertTrue(store.is_on('photo-warm'))
            with self.assertRaises(UnknownSwitch):
                store.set('drafts-first', True)

    def test_a_removed_switch_is_ignored_and_cleared(self):
        # Issue 176: new-contact-drafts is on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"new-contact-drafts": false, "photo-warm": true}}')
            store = SwitchStore(path)
            self.assertNotIn('new-contact-drafts', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('new-contact-drafts', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text()), {'switches': {'photo-warm': True, 'photo-instant': True}})

    def test_a_damaged_file_reads_as_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            for raw in ('{', '[]', '{"switches": {"photo-warm": "1", "gone": true}}'):
                path.write_text(raw)
                self.assertFalse(SwitchStore(path).is_on('photo-warm'))
                self.assertEqual([s['id'] for s in SwitchStore(path).listing()['switches']], ['photo-warm', 'photo-instant', 'viewer-placeholder', 'photo-prefetch', 'photo-timings', 'agent-drafts', 'row-tap-menu', 'line-photo-groups'])


if __name__ == '__main__':
    unittest.main()
