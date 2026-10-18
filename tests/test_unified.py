import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from engine import EngineError
from unified import PeopleStore, Translator, UnifiedInbox
from unified_setup import setup
from translation import translate


class PeopleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = PeopleStore(Path(self.tmp.name) / 'people.db')

    def test_chats_list_newest_first_and_hides_silent_contacts(self):
        old = self.store.identity('telegram', '!old', 'Zed')
        new = self.store.identity('telegram', '!new', 'Amy')
        self.store.identity('telegram', '!quiet', 'Bob')
        self.store.add_message('$1', old, 'zed', False, 'old news', 100)
        self.store.add_message('$2', new, 'me', True, 'fresh', 200)
        chats = self.store.people()
        self.assertEqual([p['display_name'] for p in chats], ['Amy', 'Zed'])
        self.assertEqual(chats[0]['last'], {'text': 'fresh', 'outgoing': True, 'sender': 'me', 'timestamp': 200})
        self.assertEqual([p['display_name'] for p in self.store.people(chats=False)], ['Amy', 'Bob', 'Zed'])

    def test_auto_create_deduplicates_and_preserves_rename(self):
        a = self.store.identity('telegram', '!one', 'Alice')
        self.store.update(a['person_id'], {'display_name': 'Alice Thai', 'language': 'th'})
        b = self.store.identity('telegram', '!one', 'Upstream rename')
        self.assertEqual(a['id'], b['id'])
        self.assertEqual(self.store.people(chats=False)[0]['display_name'], 'Alice Thai')
        self.assertEqual(len(self.store.people(chats=False)), 1)

    def test_merge_unmerge_keeps_messages_and_last_used_route(self):
        a = self.store.identity('telegram', '!one', 'Alice')
        b = self.store.identity('messenger', 'abc', 'Alice 2')
        self.store.add_message('a', a, 'alice', False, 'hello', 100)
        self.store.add_message('b', b, 'alice', False, 'hi', 200)
        merged = self.store.merge(a['person_id'], b['person_id'])
        self.assertEqual(merged['identities'][0]['id'], b['id'])
        self.assertEqual([m['network'] for m in self.store.messages(a['person_id'])], ['telegram', 'messenger'])
        self.store.update(a['person_id'], {'preferred_identity': b['id']})
        new = self.store.unmerge(a['person_id'], b['id'])
        self.assertEqual(len(self.store.people(chats=False)), 2)
        self.assertEqual(self.store.messages(new['id'])[0]['original'], 'hi')
        self.assertIsNone(self.store.person(a['person_id'])['preferred_identity'])

    def test_group_labels_and_person_merge_rejection(self):
        group = self.store.identity('telegram', '!group', 'Family', 'group')
        person = self.store.identity('messenger', 'abc', 'Alice')
        self.store.labels(group['id'], ['Family', 'Family', 'Friends'])
        self.assertEqual(self.store.people('group', chats=False)[0]['labels'], ['Family', 'Friends'])
        with self.assertRaises(EngineError): self.store.merge(person['person_id'], group['person_id'])
        with self.assertRaises(EngineError): self.store.labels(person['id'], ['Family'])

    def test_identity_cannot_be_assigned_to_unrelated_person(self):
        a = self.store.identity('telegram', '!a', 'A')
        b = self.store.identity('telegram', '!b', 'B')
        with self.assertRaises(EngineError): self.store.update(a['person_id'], {'preferred_identity': b['id']})

    def test_persist_and_dedupe(self):
        a = self.store.identity('telegram', '!a', 'A')
        for _ in range(2): self.store.add_message('$same', a, 'a', False, 'hello', 100)
        again = PeopleStore(self.store.path)
        self.assertEqual(len(again.messages(a['person_id'])), 1)


class UnifiedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.a = self.inbox.store.identity('telegram', '!a', 'Alice')

    def test_dormant_status_does_not_contact_telegram(self):
        with patch('unified.http') as request:
            self.assertEqual(self.inbox.telegram_status()['state'], 'not_configured')
            with self.assertRaises(EngineError) as err: self.inbox.provision('/login/start/qr', 'POST', {})
            self.assertEqual(err.exception.code, 'telegram_not_configured')
            request.assert_not_called()

    def test_telegram_code_step_survives_leaving_the_app(self):
        code_step = {'login_id': 'L1', 'type': 'user_input', 'step_id': 'fi.mau.telegram.code',
                     'user_input': {'fields': [{'id': 'code', 'type': 'code', 'name': 'Code'}]}}
        responses = {'/login/start/phone': {'login_id': 'L1', 'type': 'user_input', 'step_id': 'fi.mau.telegram.phone', 'user_input': {'fields': []}},
                     '/login/step/L1/fi.mau.telegram.phone/user_input': code_step,
                     '/whoami': {'logins': [], 'login_flows': [{'id': 'phone'}]}}
        self.inbox.telegram_configured = lambda: True
        self.inbox.matrix_token = lambda: 'x'
        self.inbox.provision = lambda path, method='GET', body=None: responses[path]
        self.inbox.dispatch('POST', '/api/unified/telegram/start', {'flow': 'phone'})
        self.inbox.dispatch('POST', '/api/unified/telegram/step', {'login_id': 'L1', 'step_id': 'fi.mau.telegram.phone', 'type': 'user_input', 'fields': {'phone_number': '+15550000000'}})
        status = self.inbox.dispatch('GET', '/api/unified/telegram/status', {})
        self.assertEqual(status['pending_login'], code_step)
        self.assertNotIn('+1555', json.dumps(status))
        responses['/login/cancel/L1'] = {}
        self.inbox.dispatch('POST', '/api/unified/telegram/cancel', {'login_id': 'L1'})
        self.assertIsNone(self.inbox.dispatch('GET', '/api/unified/telegram/status', {})['pending_login'])

    def test_pending_telegram_login_expires(self):
        self.inbox.remember_login({'login_id': 'L2', 'type': 'user_input'})
        self.inbox._pending_login['at'] -= self.inbox.PENDING_LOGIN_SECONDS + 1
        self.assertIsNone(self.inbox.pending_login())

    def test_translation_failure_allows_explicit_original_only(self):
        self.inbox.store.update(self.a['person_id'], {'language': 'th'})
        preview = self.inbox.preview(self.a['person_id'], {'text': 'Hello'})
        self.assertTrue(preview['error'])
        with self.assertRaises(EngineError): self.inbox.confirm(self.a['person_id'], {'preview_id': preview['id']})
        self.inbox.mx = Mock(return_value={'event_id': '$out'})
        result = self.inbox.confirm(self.a['person_id'], {'preview_id': preview['id'], 'send_original': True})
        self.assertEqual(result['event_id'], '$out')
        self.assertEqual(self.inbox.mx.call_args.args[2]['body'], 'Hello')
        self.inbox.confirm(self.a['person_id'], {'preview_id': preview['id'], 'send_original': True})
        self.assertEqual(self.inbox.mx.call_count, 1)

    def test_confirm_uses_server_preview_not_client_translation(self):
        self.inbox.store.update(self.a['person_id'], {'language': 'th'})
        self.inbox.translator.translate = Mock(return_value=('สวัสดี', None))
        preview = self.inbox.preview(self.a['person_id'], {'text': 'Hello'})
        self.inbox.mx = Mock(return_value={'event_id': '$out'})
        self.inbox.confirm(self.a['person_id'], {'preview_id': preview['id'], 'translated': 'tampered'})
        self.assertEqual(self.inbox.mx.call_args.args[2]['body'], 'สวัสดี')
        message = self.inbox.store.messages(self.a['person_id'])[0]
        self.assertEqual((message['original'], message['translated']), ('สวัสดี', 'Hello'))

    def test_ambiguous_retry_preserves_transaction_id_and_payload(self):
        p = self.inbox.preview(self.a['person_id'], {'text': 'Hello'})
        self.inbox.mx = Mock(side_effect=EngineError('timeout', 'Timeout', 503))
        with self.assertRaises(EngineError): self.inbox.confirm(self.a['person_id'], {'preview_id': p['id']})
        with self.assertRaises(EngineError): self.inbox.confirm(self.a['person_id'], {'preview_id': p['id'], 'send_original': True})
        self.inbox.mx.side_effect = None
        self.inbox.mx.return_value = {'event_id': '$out'}
        self.inbox.confirm(self.a['person_id'], {'preview_id': p['id']})
        self.assertEqual(self.inbox.mx.call_args_list[0], self.inbox.mx.call_args_list[1])

    def test_translation_cache_and_incoming_original(self):
        root = Path(self.tmp.name) / 'unified'
        (root / 'secrets.json').write_text(json.dumps({'translation_token': 'test'}))
        with patch('unified.http', return_value={'text': 'Hello', 'error': None}) as request:
            self.inbox.store.update(self.a['person_id'], {'language': 'th'})
            self.inbox.store.add_message('$thai', self.a, 'alice', False, 'สวัสดี', 10)
            message = self.inbox.timeline(self.a['person_id'])['messages'][0]
            self.assertEqual((message['translated'], message['original']), ('Hello', 'สวัสดี'))
            self.inbox.timeline(self.a['person_id'])
            self.assertEqual(request.call_count, 1)

    def test_without_auto_translate_cache_is_kept_for_the_tap_toggle(self):
        # The view shows the original by default and uses the cache only when the owner taps Translate.
        self.inbox.store.add_message('$thai', self.a, 'alice', False, 'สวัสดี', 10, 'Hello')
        message = self.inbox.timeline(self.a['person_id'])['messages'][0]
        self.assertEqual(message['translated'], 'Hello')
        self.assertIsNone(message['translation_error'])
        self.assertEqual(message['original'], 'สวัสดี')
        self.assertEqual(self.inbox.store.messages(self.a['person_id'])[0]['translated'], 'Hello')

    def test_tap_translate_calls_model_once_and_only_for_incoming(self):
        from unittest.mock import Mock
        self.inbox.store.add_message('$in', self.a, 'alice', False, 'สวัสดีครับ', 11)
        self.inbox.store.add_message('$out', self.a, 'me', True, 'Hi there', 12)
        self.inbox.translator.translate = Mock(return_value=('Hello', None))
        first = self.inbox.dispatch('POST', '/api/unified/messages/$in/translate', {})
        second = self.inbox.dispatch('POST', '/api/unified/messages/$in/translate', {})
        self.assertEqual((first['translated'], second['translated']), ('Hello', 'Hello'))
        self.assertEqual(self.inbox.translator.translate.call_count, 1)
        with self.assertRaises(Exception):
            self.inbox.dispatch('POST', '/api/unified/messages/$out/translate', {})

    def test_english_people_trigger_no_model_calls(self):
        from unittest.mock import Mock
        self.inbox.store.add_message('$en', self.a, 'alice', False, 'See you at 7', 13)
        self.inbox.translator.translate = Mock(return_value=('x', None))
        self.inbox.timeline(self.a['person_id'])
        preview = self.inbox.preview(self.a['person_id'], {'text': 'Sounds good'})
        self.assertEqual(preview['translated'], 'Sounds good')
        self.inbox.translator.translate.assert_not_called()

    def test_media_and_notices_become_readable_lines(self):
        from unified import message_text
        ev = lambda t, c: {'type': t, 'content': c}
        self.assertEqual(message_text(ev('m.room.message', {'msgtype': 'm.text', 'body': 'hi'})), 'hi')
        self.assertEqual(message_text(ev('m.room.message', {'msgtype': 'm.image', 'body': 'IMG_1.jpg', 'filename': 'IMG_1.jpg'})), '[Photo]')
        self.assertEqual(message_text(ev('m.room.message', {'msgtype': 'm.image', 'body': 'look', 'filename': 'IMG_1.jpg'})), '[Photo] look')
        self.assertEqual(message_text(ev('m.room.message', {'msgtype': 'm.file', 'body': 'deck.pdf'})), '[File] deck.pdf')
        self.assertEqual(message_text(ev('m.room.message', {'msgtype': 'm.emote', 'body': 'waves'})), '* waves')
        self.assertEqual(message_text(ev('m.sticker', {'body': '😀'})), '[Sticker] 😀')
        self.assertIsNone(message_text(ev('m.room.message', {'msgtype': 'm.text', 'body': 'x', 'm.relates_to': {'rel_type': 'm.replace'}})))
        self.assertIsNone(message_text(ev('m.reaction', {})))

    def test_setup_turns_on_recent_history_for_fifty_chats(self):
        import yaml
        import unified_setup
        with patch.dict('os.environ', {'TELEGRAM_API_ID': '12345', 'TELEGRAM_API_HASH': 'a' * 32}):
            unified_setup.setup(self.tmp.name)
        config = yaml.safe_load((Path(self.tmp.name) / 'telegram' / 'config.yaml').read_text())
        self.assertEqual((config['backfill']['enabled'], config['backfill']['max_initial_messages']), (True, 50))
        self.assertEqual(config['network']['sync']['login_sync_limit'], 50)
        self.assertFalse(config['backfill']['queue']['enabled'])

    def test_tinfoil_missing_key_is_honest(self):
        with patch.dict(os.environ, {'TINFOIL_API_KEY': ''}):
            result = translate('Hello', 'th')
            self.assertEqual(result['text'], 'Hello')
            self.assertIn('not configured', result['error'])

    def test_setup_secrets_stable_and_no_federation(self):
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(self.tmp.name)
            first = json.loads((Path(self.tmp.name) / 'unified/secrets.json').read_text())
            setup(self.tmp.name)
        self.assertEqual(first, json.loads((Path(self.tmp.name) / 'unified/secrets.json').read_text()))
        config = json.loads((Path(self.tmp.name) / 'matrix/homeserver.yaml').read_text())
        self.assertFalse(config['enable_registration'])
        self.assertEqual(config['federation_domain_whitelist'], [])
        self.assertEqual(config['listeners'][0]['resources'][0]['names'], ['client'])


if __name__ == '__main__': unittest.main()
