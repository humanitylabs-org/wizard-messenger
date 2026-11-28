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


def sample(listing, switch_id='full-reactions'):
    """The sample switch these tests flip, found by id (the list changes as switches are approved and removed)."""
    return next(s for s in listing['switches'] if s['id'] == switch_id)


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
                'id': 'photo-timings', 'name': 'Photo timings',
                'description': 'Messenger measures how fast photos appear (box ready on arrival, thumbnail, tap to picture, '
                               'black frames) per network and shows the numbers in Settings. Only times and sizes, never content.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#168']}, {
                'id': 'calls', 'name': 'Calls',
                'description': 'Encrypted voice and video calls from your own Wizard. Turning it on starts the call '
                               'server on your box (LiveKit); turning it off stops it again.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#445']}, {
                'id': 'full-reactions', 'name': 'Any emoji as a reaction',
                'description': 'The ＋ next to the reactions on a message opens the full emoji panel (search, '
                               'categories, Recent), so any emoji can be a reaction, like Telegram. The quick row '
                               'shows the reactions you use most. Chats that only allow some reactions show only '
                               'those.',
                'on': False, 'default': False, 'issues': ['humanitylabs-org/wizard-messenger#471']}])
            self.assertEqual(body['feedback'], {})

    def test_thumbs_up_or_down_stays_on_the_box(self):
        # Issue 202: Try new features records a thumbs up / down per switch, and that the owner turned it on.
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches/feedback', {'id': 'full-reactions', 'vote': 'up'}, h)
        self.assertEqual(status, 200)
        self.assertEqual(body['feedback'], {'full-reactions': {'tried': False, 'vote': 'up'}})
        self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, h)
        self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': False}, h)
        status, _, body = self.request('POST', '/api/view/switches/feedback', {'id': 'full-reactions', 'vote': None}, h)
        self.assertEqual(body['feedback'], {'full-reactions': {'tried': True}})
        self.assertEqual(self.request('GET', '/api/switches', headers=self.owner())[2]['feedback'], {'full-reactions': {'tried': True}})
        for bad in ({'id': 'full-reactions', 'vote': 'meh'}, {'id': 'full-reactions'}, {'id': 'full-reactions', 'vote': 'up', 'on': True}):
            self.assertEqual(self.request('POST', '/api/view/switches/feedback', bad, h)[0], 400, bad)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'nope', 'vote': 'up'}, h)[0], 404)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'full-reactions', 'vote': 'up'}, self.owner())[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches/feedback', {'id': 'full-reactions', 'vote': 'up'}, {'Origin': ORIGIN, **WRITE})[0], 401)
        self.assertEqual(self.request('GET', '/api/view/switches/feedback', headers=self.owner())[0], 405)

    def test_shared_section_votes_on_the_switches_path(self):
        # Issue 217 (wizard-os docs/APP_SWITCHES.md): the shared Try new features section posts {"id", "vote"} to the
        # switches path itself and reads `tried` / `vote` on each switch.
        h = {**self.owner(), **WRITE}
        for path in ('/api/view/switches', '/api/switches'):
            status, _, body = self.request('POST', path, {'id': 'full-reactions', 'vote': 'down'}, h)
            self.assertEqual(status, 200)
            warm = sample(body)
            self.assertEqual((warm['id'], warm['vote'], warm['tried'], warm['on']), ('full-reactions', 'down', False, False))
        self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, h)
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'vote': None}, h)
        self.assertEqual((sample(body)['vote'], sample(body)['tried']), (None, True))
        self.assertEqual(body['feedback'], {'full-reactions': {'tried': True}})
        for bad in ({'id': 'full-reactions', 'vote': 'meh'}, {'id': 'full-reactions', 'vote': 'up', 'on': True}):
            self.assertEqual(self.request('POST', '/api/view/switches', bad, h)[0], 400, bad)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'nope', 'vote': 'up'}, h)[0], 404)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'vote': 'up'}, self.owner())[0], 403)

    def test_owner_flips_it_and_every_reader_sees_it(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, h)
        self.assertEqual(status, 200)
        self.assertTrue(sample(body)['on'])
        self.assertTrue(sample(self.request('GET', '/api/switches', headers=self.owner())[2])['on'])
        # Messenger's own Settings sends its CSRF token as well; that is fine.
        status, _, body = self.request('POST', '/api/switches', {'id': 'full-reactions', 'on': False}, {**self.owner_headers(), **WRITE})
        self.assertEqual(status, 200)
        self.assertFalse(sample(body)['on'])

    def test_calls_switch_starts_and_stops_the_call_server(self):
        # Issue 445: flipping `calls` (Tracker Try it or Try new features) puts or removes calls/enabled, which
        # the recipe's livekit and call-auth containers wait for.
        import calls
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        data = Path(self.temp.name) / 'data'
        engine = test_web.FakeEngine(); engine.data = str(data)
        self.server = test_web.ViewServer(('127.0.0.1', 0), engine, TOKEN, [ORIGIN])
        self.server.static_root = Path(self.temp.name)
        self.thread = test_web.threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        marker = data / 'calls' / 'enabled'
        self.assertFalse(marker.exists())
        h = {**self.owner(), **WRITE}
        self.assertEqual(self.request('POST', '/api/switches', {'id': 'calls', 'on': True}, h)[0], 200)
        self.assertTrue(marker.exists())
        self.assertTrue(calls.running(data))
        self.assertEqual(self.request('POST', '/api/switches', {'id': 'calls', 'on': False}, h)[0], 200)
        self.assertFalse(marker.exists())

    def test_owner_only(self):
        status, _, body = self.request('GET', '/api/view/switches', headers={'Origin': ORIGIN})
        self.assertEqual(status, 401); self.assertIsInstance(body['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, {'Origin': ORIGIN, **WRITE})[0], 401)
        for auth in ({'Authorization': 'Bearer ' + TOKEN}, {**self.owner(), 'Authorization': 'Bearer ' + TOKEN}):
            status, _, body = self.request('GET', '/api/view/switches', headers=auth)
            self.assertEqual(status, 403); self.assertIsInstance(body['error'], str)
            self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, {**auth, **WRITE})[0], 403)
        self.assertFalse(self.server.switches.is_on('full-reactions'))

    def test_write_needs_origin_and_header(self):
        body = {'id': 'full-reactions', 'on': True}
        cookie = {'Cookie': self.owner()['Cookie'], **WRITE}
        self.assertEqual(self.request('POST', '/api/view/switches', body, cookie)[0], 403)  # no Origin
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**cookie, 'Origin': 'https://evil.example'})[0], 403)
        status, _, reply = self.request('POST', '/api/view/switches', body, self.owner())  # no X-Wizard-Switch
        self.assertEqual(status, 403); self.assertIsInstance(reply['error'], str)
        self.assertEqual(self.request('POST', '/api/view/switches', body, {**self.owner(), 'X-Wizard-Switch': '0'})[0], 403)
        self.assertFalse(self.server.switches.is_on('full-reactions'))

    def test_unknown_id_and_bad_body(self):
        h = {**self.owner(), **WRITE}
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'nope', 'on': True}, h)
        self.assertEqual(status, 404); self.assertIsInstance(body['error'], str)
        for bad in ({'id': 'full-reactions'}, {'id': 'full-reactions', 'on': 'yes'}, {'id': 7, 'on': True}, {'on': True},
                    {'id': 'full-reactions', 'on': True, 'extra': 1}):
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
        self.assertEqual(status, 200); self.assertFalse(sample(body)['on'])
        status, _, body = self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, headers=WRITE)
        self.assertEqual(status, 200); self.assertTrue(sample(body)['on'])
        self.assertTrue(self.server.switches.is_on('full-reactions'))

    def test_no_proof_a_reused_proof_or_a_bearer_is_refused(self):
        self.assertEqual(self.request('GET', '/api/view/switches', proof=False)[0], 403)
        from trusted_owner import PLATFORM_HEADER, sign_platform_request
        once = sign_platform_request(self.proof, 'messenger', 'POST', '/api/view/switches')
        h = {**WRITE, PLATFORM_HEADER: once}
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': True}, headers=h)[0], 200)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': False}, headers=h)[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': False},
                                      headers={**WRITE, 'Authorization': 'Bearer ' + TOKEN})[0], 403)
        self.assertEqual(self.request('POST', '/api/view/switches', {'id': 'full-reactions', 'on': False}, headers={})[0], 403)
        self.assertTrue(self.server.switches.is_on('full-reactions'))


class SwitchStorage(unittest.TestCase):
    def test_kept_on_the_box_and_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            SwitchStore(path).set('full-reactions', True)
            # Issue 202: turning a switch on also records that the owner tried it (Try new features feedback).
            self.assertEqual(json.loads(path.read_text()), {'switches': {'full-reactions': True}, 'feedback': {'full-reactions': {'tried': True}}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(SwitchStore(path).is_on('full-reactions'))
            SwitchStore(path).set('full-reactions', False)
            self.assertEqual(json.loads(path.read_text()), {'switches': {}, 'feedback': {'full-reactions': {'tried': True}}})

    def test_drafts_at_top_is_no_longer_a_switch(self):
        # Issue 150: Drafts at top was approved, so it is always on and leaves the list; a box that stored it on or
        # off before keeps working and the stale value is ignored.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"drafts-first": true, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('drafts-first', [s['id'] for s in store.listing()['switches']])
            self.assertTrue(store.is_on('full-reactions'))
            with self.assertRaises(UnknownSwitch):
                store.set('drafts-first', True)

    def test_transcript_paragraphs_is_no_longer_a_switch(self):
        # Issue 248: Transcripts in paragraphs was approved (switch-default), so it is always on; a stored value from
        # before is ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"transcript-paragraphs": false, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('transcript-paragraphs', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('transcript-paragraphs', True)
            store.set('photo-timings', True)
            self.assertNotIn('transcript-paragraphs', json.loads(path.read_text())['switches'])

    def test_add_contact_is_no_longer_a_switch(self):
        # Issue 399: Add contact on Telegram was approved (switch-default), so it is always on; a stored value and
        # feedback from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text(json.dumps({'switches': {'add-contact': False, 'full-reactions': True},
                                        'feedback': {'add-contact': {'tried': True, 'vote': 'up'}}}))
            store = SwitchStore(path)
            self.assertNotIn('add-contact', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('add-contact', store.listing()['feedback'])
            with self.assertRaises(UnknownSwitch):
                store.set('add-contact', True)
            store.set('photo-timings', True)
            saved = json.loads(path.read_text())
            self.assertEqual(saved['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('add-contact', saved.get('feedback', {}))

    def test_telegram_emoji_is_no_longer_a_switch(self):
        # Issue 349: the Telegram-style emoji panel was approved (switch-default), so it is always on; a stored value
        # from before is ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"telegram-emoji": true, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('telegram-emoji', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('telegram-emoji', False)
            store.set('photo-timings', True)
            self.assertNotIn('telegram-emoji', json.loads(path.read_text())['switches'])

    def test_a_removed_switch_is_ignored_and_cleared(self):
        # Issue 176: new-contact-drafts is on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"new-contact-drafts": false, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('new-contact-drafts', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('new-contact-drafts', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})

    def test_agent_chat_is_gone_and_its_stored_value_cleared(self):
        # Issue 265: the Agent chat is on for everyone now; a stored value and its feedback are dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-chat": false, "full-reactions": true}, '
                            '"feedback": {"agent-chat": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-chat', [s['id'] for s in store.listing()['switches']])
            with self.assertRaises(UnknownSwitch):
                store.set('agent-chat', True)
            store.set('photo-timings', True)
            stored = json.loads(path.read_text())
            self.assertEqual(stored['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('agent-chat', stored.get('feedback', {}))

    def test_agent_documents_is_gone_and_its_stored_value_cleared(self):
        # Issue 245: agent-documents is on for everyone now; a stored value and its feedback are dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-documents": true, "full-reactions": true}, '
                            '"feedback": {"agent-documents": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-documents', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('agent-documents'))
            with self.assertRaises(UnknownSwitch):
                store.set('agent-documents', False)
            store.set('photo-timings', True)
            raw = json.loads(path.read_text())
            self.assertEqual(raw['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('agent-documents', raw['feedback'])

    def test_agent_drafts_is_gone_and_its_stored_value_cleared(self):
        # Issue 178: agent-drafts is on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"agent-drafts": true, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('agent-drafts', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('agent-drafts'))
            with self.assertRaises(UnknownSwitch):
                store.set('agent-drafts', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})

    def test_line_photo_groups_is_gone_and_its_stored_value_cleared(self):
        # Issue 188: LINE photo groups are on for everyone now; a stored value from before is dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"line-photo-groups": true, "full-reactions": true}}')
            store = SwitchStore(path)
            self.assertNotIn('line-photo-groups', [s['id'] for s in store.listing()['switches']])
            self.assertFalse(store.is_on('line-photo-groups'))
            with self.assertRaises(UnknownSwitch):
                store.set('line-photo-groups', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})

    def test_on_device_translate_is_gone_and_its_stored_value_cleared(self):
        # Issue 199: Translate on this device is on for everyone now; a stored value from before is dropped on the next
        # write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"on-device-translate": false, "full-reactions": true}, '
                            '"feedback": {"on-device-translate": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('on-device-translate', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('on-device-translate', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('on-device-translate'))
            with self.assertRaises(UnknownSwitch):
                store.set('on-device-translate', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('on-device-translate', json.loads(path.read_text()).get('feedback', {}))

    def test_device_auto_translate_is_gone_and_its_stored_value_cleared(self):
        # Issue 204: Auto-translate on this device is on for everyone now; a stored value from before is dropped on the next
        # write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"device-auto-translate": false, "full-reactions": true}, '
                            '"feedback": {"device-auto-translate": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('device-auto-translate', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('device-auto-translate', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('device-auto-translate'))
            with self.assertRaises(UnknownSwitch):
                store.set('device-auto-translate', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('device-auto-translate', json.loads(path.read_text()).get('feedback', {}))

    def test_clean_settings_is_gone_and_its_stored_value_cleared(self):
        # Issue 202: Clean Settings is how Settings looks for everyone now; a stored value from before is dropped on the
        # next write, and its Try new features feedback no longer shows.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"clean-settings": true, "full-reactions": true}, '
                            '"feedback": {"clean-settings": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('clean-settings', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('clean-settings', store.listing().get('feedback', {}))
            self.assertFalse(store.is_on('clean-settings'))
            with self.assertRaises(UnknownSwitch):
                store.set('clean-settings', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('clean-settings', json.loads(path.read_text()).get('feedback', {}))

    def test_photo_file_names_is_gone_and_its_stored_value_cleared(self):
        # Issue 337: saved photos keep their own or a dated file name for everyone now; a stored value is dropped.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"photo-file-names": false, "full-reactions": true}, '
                            '"feedback": {"photo-file-names": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('photo-file-names', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('photo-file-names', store.listing().get('feedback', {}))
            with self.assertRaises(UnknownSwitch):
                store.set('photo-file-names', True)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('photo-file-names', json.loads(path.read_text()).get('feedback', {}))

    def test_list_draft_ready_is_gone_and_its_stored_value_cleared(self):
        # Issue 201: the chat-list draft item and the header Drafts toggle are on for everyone now.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"list-draft-ready": true, "full-reactions": true}, '
                            '"feedback": {"list-draft-ready": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('list-draft-ready', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('list-draft-ready', store.listing().get('feedback', {}))
            with self.assertRaises(UnknownSwitch):
                store.set('list-draft-ready', False)
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text())['switches'], {'full-reactions': True, 'photo-timings': True})
            self.assertNotIn('list-draft-ready', json.loads(path.read_text()).get('feedback', {}))

    def test_phone_notifications_is_gone_and_its_stored_value_cleared(self):
        # Issue 308: Messages on your phone was approved (switch-default), so it is always on; a stored value and its
        # feedback from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"phone-notifications": false, "full-reactions": true}, '
                            '"feedback": {"phone-notifications": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('phone-notifications', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('phone-notifications', store.listing()['feedback'])
            with self.assertRaises(UnknownSwitch):
                store.set('phone-notifications', True)
            store.set('photo-timings', True)
            saved = json.loads(path.read_text())
            self.assertNotIn('phone-notifications', saved['switches'])
            self.assertNotIn('phone-notifications', saved.get('feedback', {}))

    def test_row_tap_menu_is_gone_and_its_stored_value_cleared(self):
        # Issue 182: Tap beside a message for its menu was approved (switch-default), so it is always on; a stored
        # value and its feedback from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"row-tap-menu": false, "full-reactions": true}, '
                            '"feedback": {"row-tap-menu": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('row-tap-menu', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('row-tap-menu', store.listing()['feedback'])
            with self.assertRaises(UnknownSwitch):
                store.set('row-tap-menu', True)
            store.set('photo-timings', True)
            saved = json.loads(path.read_text())
            self.assertNotIn('row-tap-menu', saved['switches'])
            self.assertNotIn('row-tap-menu', saved.get('feedback', {}))

    def test_share_files_is_gone_and_its_stored_value_cleared(self):
        # Issue 314: Share files to Messenger was approved (switch-default), so it is always on; a stored value and
        # its feedback from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"share-files": false, "full-reactions": true}, '
                            '"feedback": {"share-files": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('share-files', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('share-files', store.listing()['feedback'])
            with self.assertRaises(UnknownSwitch):
                store.set('share-files', True)
            store.set('photo-timings', True)
            saved = json.loads(path.read_text())
            self.assertNotIn('share-files', saved['switches'])
            self.assertNotIn('share-files', saved.get('feedback', {}))
            self.assertTrue(saved['switches']['full-reactions'])

    def test_new_group_is_gone_and_its_stored_value_cleared(self):
        # Issue 397: New group was approved (switch-default), so it is always on; a stored value and its feedback
        # from before are ignored and dropped on the next write.
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text('{"switches": {"new-group": true, "calls": false}, '
                            '"feedback": {"new-group": {"tried": true, "vote": "up"}}}')
            store = SwitchStore(path)
            self.assertNotIn('new-group', [s['id'] for s in store.listing()['switches']])
            self.assertNotIn('new-group', store.listing()['feedback'])
            self.assertFalse(store.is_on('new-group'))
            with self.assertRaises(UnknownSwitch):
                store.set('new-group', True)
            store.set('photo-timings', True)
            saved = json.loads(path.read_text())
            self.assertNotIn('new-group', saved['switches'])
            self.assertNotIn('new-group', saved.get('feedback', {}))

    def test_feedback_survives_switch_writes(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            store = SwitchStore(path)
            store.vote('photo-timings', 'down')
            store.set('photo-timings', True)
            self.assertEqual(json.loads(path.read_text()), {'switches': {'photo-timings': True},
                                                            'feedback': {'photo-timings': {'tried': True, 'vote': 'down'}}})
            store.set('photo-timings', False)
            self.assertEqual(SwitchStore(path).listing()['feedback'], {'photo-timings': {'tried': True, 'vote': 'down'}})
            with self.assertRaises(UnknownSwitch):
                store.vote('gone', 'up')

    def test_a_damaged_file_reads_as_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            for raw in ('{', '[]', '{"switches": {"full-reactions": "1", "gone": true}}'):
                path.write_text(raw)
                self.assertFalse(SwitchStore(path).is_on('full-reactions'))
                self.assertEqual([s['id'] for s in SwitchStore(path).listing()['switches']], ['photo-timings', 'calls', 'full-reactions'])

    def test_the_photo_speed_switches_are_gone_and_their_stored_values_cleared(self):
        # Issue 468: Photos ready on arrival, Photos open instantly, Photos ready in Wizard's viewer and Background
        # photo download are on for everyone; stored values and feedback from before are ignored and dropped on the
        # next write. Photo timings stays a switch. Issue 451: the same for synapse-postgres.
        gone = ('photo-warm', 'photo-instant', 'viewer-placeholder', 'photo-prefetch', 'synapse-postgres')
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'switches.json'
            path.write_text(json.dumps({'switches': {**{g: False for g in gone}, 'photo-timings': True},
                                        'feedback': {g: {'tried': True, 'vote': 'up'} for g in gone}}))
            store = SwitchStore(path)
            listing = store.listing()
            self.assertFalse(set(gone) & {s['id'] for s in listing['switches']})
            self.assertFalse(set(gone) & set(listing['feedback']))
            self.assertTrue(store.is_on('photo-timings'))
            for g in gone:
                with self.assertRaises(UnknownSwitch):
                    store.set(g, True)
            store.set('full-reactions', True)
            saved = json.loads(path.read_text())
            self.assertEqual(saved['switches'], {'photo-timings': True, 'full-reactions': True})
            self.assertFalse(set(gone) & set(saved.get('feedback', {})))


if __name__ == '__main__':
    unittest.main()
