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
            # Issue 217: every switch carries the optional feedback fields (tried, vote; null = no vote).
            self.assertTrue(all(sw.pop('tried') is False and sw.pop('vote') is None for sw in body['switches']))
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
                'id': 'row-tap-menu', 'name': 'Tap beside a message for its menu',
                'description': "On a phone, tapping the empty space to the right of someone's message opens that "
                               "message's menu (Reply, react, Select), the same one holding it opens. Tapping a photo "
                               'still opens it.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#182']}, {
                'id': 'unread-count', 'name': 'Unread count on the phone icon',
                'description': 'Messenger tells the Wizard phone app how many chats are unread (a number only, never '
                               'names or messages), so the Messenger icon on your home screen can show it. Muted, '
                               'Medium and Low priority chats never count. Your private Messenger chats count too.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#296',
                                                           'humanitylabs-org/wizard-messenger#302']}, {
                'id': 'share-files', 'name': 'Share files to Messenger',
                'description': 'Sharing a file from another Wizard app (a PDF, a note, a document from a chat) offers '
                               'Messenger. The file waits in the chosen chat\'s message box as an attachment, like '
                               'one added with +, until you tap Send. Files over 25 MB are too big.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#314']}, {
                'id': 'video-prefetch', 'name': 'Background video download',
                'description': 'The phone also quietly downloads videos up to 25 MB from the newest messages of your '
                               'newest chats, on Wi-Fi only unless you chose Always for photos, so a tapped video plays '
                               'at once from the phone. Bigger videos still stream on tap.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#320']}, {
                'id': 'agent-inbox-door', 'name': 'Agent chat through your agent inbox',
                'description': 'When your Wizard\'s agent inbox is on, the Agent chat uses it instead of its own list: '
                               'each note becomes a background task there (the tick shows once it is in), Sweep shows '
                               'the same card as Daily with one-tap answers, and urgent alerts arrive as one-line '
                               'pings. With the inbox off, the Agent chat works as before.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#325']}, {
                'id': 'telegram-emoji', 'name': 'Emoji panel like Telegram',
                'description': 'The emoji panel gets a category bar that jumps to a section, a delete key (hold to '
                               'keep deleting), a keyboard button that swaps the panel for the keyboard and back, '
                               'skin tones on a long press, a Recent row ranked by how often you use each emoji, and '
                               'on a phone the same height as your keyboard.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#349']}, {
                'id': 'stacked-drafts', 'name': 'Several drafts in one chat',
                'description': 'Your agent can line up to five drafts in one chat. With two or more, they wait as '
                               'stacked bubbles above the message box, oldest first, each with Send, Edit and '
                               'Remove. One draft works as before. Nothing is ever sent on its own.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#353']}])
            self.assertEqual(body['feedback'], {})

    def test_thumbs_up_or_down_stays_on_the_box(self):
        # Issue 202: Try new features records a thumbs up / down per switch, and that the owner turned it on.
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches/feedback', {'id': 'photo-warm', 'vote': 'up'}, h)
        self.assertEqual(status, 200)
        self.assertEqual(body['feedback'], {'photo-warm': {'tried': False, 'vote': 'up'}})
        self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, h)
        self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': False}, h)
        status, _, body = self.request('POST', '/api/view/switches/feedback', {'id': 'photo-warm', 'vote': None}, h)
        self.assertEqual(body['feedback'], {'photo-warm': {'tried': True}})
        self.assertEqual(self.request('GET', '/api/switches', headers=self.owner())[2]['feedback'], {'photo-warm': {'tried': True}})
        for bad in ({'id': 'photo-warm', 'vote': 'meh'}, {'id': 'photo-warm'}, {'id': 'photo-warm', 'vote': 'up', 'on': True}):
            self.assertEqual(self.request('POST', '/api/view/switches/feedback', bad, h)[0], 400, bad)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'nope', 'vote': 'up'}, h)[0], 404)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'photo-warm', 'vote': 'up'}, self.owner())[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'photo-warm', 'vote': 'up'}, {'Origin': ORIGIN, **WRITE})[0], 401)
        self.assertEqual(self.request('GET', '/api/view/switches/feedback', headers=self.owner())[0], 405)

    def test_shared_section_votes_on_the_switches_path(self):
        # Issue 217 (wizard-os docs/APP_SWITCHES.md): the shared Try new features section posts {"id", "vote"} to the
        # switches path itself and reads `tried` / `vote` on each switch.
        h = {**self.owner(), **WRITE}
        for path in ('/api/view/switches', '/api/switches'):
            status, _, body = self.request('POST', path, {'id': 'photo-warm', 'vote': 'down'}, h)
            self.assertEqual(status, 200)
            warm = body['switches'][0]
            self.assertEqual((warm['id'], warm['vote'], warm['tried'], warm['on']), ('photo-warm', 'down', False, False))
        self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'on': True}, h)
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'vote': None}, h)
        self.assertEqual((body['switches'][0]['vote'], body['switches'][0]['tried']), (None, True))
        self.assertEqual(body['feedback'], {'photo-warm': {'tried': True}})
        for bad in ({'id': 'photo-warm', 'vote': 'meh'}, {'id': 'photo-warm', 'vote': 'up', 'on': True}):
            self.assertEqual(self.request('POST', '/api/view/switches', bad, h)[0], 400, bad)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'nope', 'vote': 'up'}, h)[0], 404)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'photo-warm', 'vote': 'up'}, self.owner())[0], 403)

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
            # Issue 202: turning a switch on also records that the owner tried it (Try new features feedback).
            self.assertEqual(json.loads(path.read_text()), {'switches': {'photo-warm': True}, 'feedback': {'photo-warm': {'tried': True}}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(SwitchStore(path).is_on('photo-warm'))
            SwitchStore(path).set('photo-warm', False)
            self.assertEqual(json.loads(path.read_text()), {'switches': {}, 'feedback': {'photo-warm': {'tried': True}}})

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

    def test_transcript_paragraphs_is_no_longer_a_switch(self):
        # Issue 248: Transcripts in paragraphs was approved (switch-default), so it is always on; a stored value from
        # before is ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"transcript-paragraphs": false, "photo-warm": true}}')
            store = SwitchStore(path)
            self.assertNotIn('transcript-paragraphs', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('transcript-paragraphs', True)
            store.set('photo-instant', True)
            self.assertNotIn('transcript-paragraphs', json.loads(path.read_text())['switches'])

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
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})

    def test_agent_chat_is_gone_and_its_stored_value_cleared(self):
        # Issue 265: the Agent chat is on for everyone now; a stored value and its feedback are dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-chat": false, "photo-warm": true}, '
                            '"feedback": {"agent-chat": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-chat', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('agent-chat', True)
            store.set('photo-instant', True)
            stored = json.loads(path.read_text())
            self.assertEqual(stored['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('agent-chat', stored.get('feedback', {}))

    def test_agent_documents_is_gone_and_its_stored_value_cleared(self):
        # Issue 245: agent-documents is on for everyone now; a stored value and its feedback are dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-documents": true, "photo-warm": true}, '
                            '"feedback": {"agent-documents": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-documents', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('agent-documents'))
            with self.assertRaises(UnknownSwitch):
                store.set('agent-documents', False)
            store.set('photo-instant', True)
            raw = json.loads(path.read_text())
            self.assertEqual(raw['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('agent-documents', raw['feedback'])

    def test_agent_drafts_is_gone_and_its_stored_value_cleared(self):
        # Issue 178: agent-drafts is on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-drafts": true, "photo-warm": true}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-drafts', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('agent-drafts'))
            with self.assertRaises(UnknownSwitch):
                store.set('agent-drafts', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})

    def test_line_photo_groups_is_gone_and_its_stored_value_cleared(self):
        # Issue 188: LINE photo groups are on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"line-photo-groups": true, "photo-warm": true}}')
            store = SwitchStore(path)
            self.assertNotIn('line-photo-groups', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('line-photo-groups'))
            with self.assertRaises(UnknownSwitch):
                store.set('line-photo-groups', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})

    def test_on_device_translate_is_gone_and_its_stored_value_cleared(self):
        # Issue 199: Translate on this device is on for everyone now; a stored value from before is dropped on the next
        # write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"on-device-translate": false, "photo-warm": true}, '
                            '"feedback": {"on-device-translate": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('on-device-translate', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('on-device-translate', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('on-device-translate'))
            with self.assertRaises(UnknownSwitch):
                store.set('on-device-translate', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('on-device-translate', json.loads(path.read_text()).get('feedback', {}))

    def test_device_auto_translate_is_gone_and_its_stored_value_cleared(self):
        # Issue 204: Auto-translate on this device is on for everyone now; a stored value from before is dropped on the next
        # write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"device-auto-translate": false, "photo-warm": true}, '
                            '"feedback": {"device-auto-translate": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('device-auto-translate', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('device-auto-translate', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('device-auto-translate'))
            with self.assertRaises(UnknownSwitch):
                store.set('device-auto-translate', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('device-auto-translate', json.loads(path.read_text()).get('feedback', {}))

    def test_clean_settings_is_gone_and_its_stored_value_cleared(self):
        # Issue 202: Clean Settings is how Settings looks for everyone now; a stored value from before is dropped on the
        # next write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"clean-settings": true, "photo-warm": true}, '
                            '"feedback": {"clean-settings": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('clean-settings', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('clean-settings', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('clean-settings'))
            with self.assertRaises(UnknownSwitch):
                store.set('clean-settings', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('clean-settings', json.loads(path.read_text()).get('feedback', {}))

    def test_photo_file_names_is_gone_and_its_stored_value_cleared(self):
        # Issue 337: saved photos keep their own or a dated file name for everyone now; a stored value is dropped.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"photo-file-names": false, "photo-warm": true}, '
                            '"feedback": {"photo-file-names": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('photo-file-names', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('photo-file-names', store.listing().get('feedback', {}))
            with self.assertRaises(UnknownSwitch):
                store.set('photo-file-names', True)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('photo-file-names', json.loads(path.read_text()).get('feedback', {}))

    def test_list_draft_ready_is_gone_and_its_stored_value_cleared(self):
        # Issue 201: the chat-list draft item and the header Drafts toggle are on for everyone now.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"list-draft-ready": true, "photo-warm": true}, '
                            '"feedback": {"list-draft-ready": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('list-draft-ready', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('list-draft-ready', store.listing().get('feedback', {}))
            with self.assertRaises(UnknownSwitch):
                store.set('list-draft-ready', False)
            store.set('photo-instant', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'photo-warm': True, 'photo-instant': True})
            self.assertNotIn('list-draft-ready', json.loads(path.read_text()).get('feedback', {}))

    def test_phone_notifications_is_gone_and_its_stored_value_cleared(self):
        # Issue 308: Messages on your phone was approved (switch-default), so it is always on; a stored value and its
        # feedback from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"phone-notifications": false, "photo-warm": true}, '
                            '"feedback": {"phone-notifications": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('phone-notifications', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('phone-notifications', store.listing()['feedback'])
            with self.assertRaises(UnknownSwitch):
                store.set('phone-notifications', True)
            store.set('photo-instant', True)
            saved = json.loads(path.read_text())
            self.assertNotIn('phone-notifications', saved['switches'])
            self.assertNotIn('phone-notifications', saved.get('feedback', {}))

    def test_feedback_survives_switch_writes(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            store = SwitchStore(path)
            store.vote('row-tap-menu', 'down')
            store.set('row-tap-menu', True)
            self.assertEqual(json.loads(path.read_text()), {'switches': {'row-tap-menu': True},
                                                            'feedback': {'row-tap-menu': {'tried': True, 'vote': 'down'}}})
            store.set('row-tap-menu', False)
            self.assertEqual(SwitchStore(path).listing()['feedback'], {'row-tap-menu': {'tried': True, 'vote': 'down'}})
            with self.assertRaises(UnknownSwitch):
                store.vote('gone', 'up')

    def test_a_damaged_file_reads_as_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            for raw in ('{', '[]', '{"switches": {"photo-warm": "1", "gone": true}}'):
                path.write_text(raw)
                self.assertFalse(SwitchStore(path).is_on('photo-warm'))
                self.assertEqual([s['id'] for s in SwitchStore(path).listing()['switches']], ['photo-warm', 'photo-instant', 'viewer-placeholder', 'photo-prefetch', 'photo-timings', 'row-tap-menu', 'unread-count', 'share-files', 'video-prefetch', 'agent-inbox-door', 'telegram-emoji', 'stacked-drafts'])


if __name__ == '__main__':
    unittest.main()
