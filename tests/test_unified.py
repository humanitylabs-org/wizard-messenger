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

    def test_auto_create_deduplicates_and_preserves_rename(self):
        a = self.store.identity('telegram', '!one', 'Alice')
        self.store.update(a['person_id'], {'display_name': 'Alice Thai', 'language': 'th'})
        b = self.store.identity('telegram', '!one', 'Upstream rename')
        self.assertEqual(a['id'], b['id'])
        self.assertEqual(self.store.people()[0]['display_name'], 'Alice Thai')
        self.assertEqual(len(self.store.people()), 1)

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
        self.assertEqual(len(self.store.people()), 2)
        self.assertEqual(self.store.messages(new['id'])[0]['original'], 'hi')
        self.assertIsNone(self.store.person(a['person_id'])['preferred_identity'])

    def test_group_labels_and_person_merge_rejection(self):
        group = self.store.identity('telegram', '!group', 'Family', 'group')
        person = self.store.identity('messenger', 'abc', 'Alice')
        self.store.labels(group['id'], ['Family', 'Family', 'Friends'])
        self.assertEqual(self.store.people('group')[0]['labels'], ['Family', 'Friends'])
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

    def test_disabling_translation_displays_original_without_deleting_cache(self):
        self.inbox.store.add_message('$thai', self.a, 'alice', False, 'สวัสดี', 10, 'Hello')
        message = self.inbox.timeline(self.a['person_id'])['messages'][0]
        self.assertIsNone(message['translated'])
        self.assertEqual(message['original'], 'สวัสดี')
        self.assertEqual(self.inbox.store.messages(self.a['person_id'])[0]['translated'], 'Hello')

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
