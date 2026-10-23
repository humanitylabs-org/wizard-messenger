import time
import json
import os
from pathlib import Path
import tempfile
import time
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
            # Opening never waits on the model: the line is queued and arrives via the change feed.
            first = self.inbox.timeline(self.a['person_id'])
            self.assertTrue(first['translating'])
            self.assertEqual(request.call_count, 0)
            self.inbox.translate_pending()
            message = self.inbox.timeline(self.a['person_id'])['messages'][0]
            self.assertEqual((message['translated'], message['original']), ('Hello', 'สวัสดี'))
            self.inbox.timeline(self.a['person_id'])
            self.inbox.translate_pending()
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

    def test_chat_list_cost_follows_chats_not_messages(self):
        store = PeopleStore(Path(self.tmp.name) / 'speed.db')
        ids = [store.identity('telegram', '!p%d' % n, 'P%d' % n) for n in range(100)]
        with store.db() as db:
            db.executemany('INSERT INTO message(id,identity_id,sender,outgoing,original,translated,timestamp) VALUES (?,?,?,?,?,?,?)', [('e%d' % n, ids[n % 100]['id'], 'x', 0, 'hi', None, n) for n in range(30000)])
        started = time.perf_counter(); chats = store.people()
        self.assertLess(time.perf_counter() - started, 0.25)
        self.assertEqual(len(chats), 100)
        self.assertEqual(chats[0]['last']['timestamp'], 29999)
        self.assertEqual([c['last']['timestamp'] for c in chats], sorted((c['last']['timestamp'] for c in chats), reverse=True))

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
        self.assertTrue(config['double_puppet']['secrets']['messenger.internal'].startswith('as_token:'))
        home = json.loads((Path(self.tmp.name) / 'matrix' / 'homeserver.yaml').read_text())
        self.assertIn('/data/doublepuppet-registration.yaml', home['app_service_config_files'])
        reg = json.loads((Path(self.tmp.name) / 'matrix' / 'doublepuppet-registration.yaml').read_text())
        self.assertIsNone(reg['url'])
        self.assertEqual(reg['namespaces']['users'], [{'exclusive': False, 'regex': '@owner:messenger\\.internal'}])

    def test_left_telegram_room_is_forgotten(self):
        self.store = PeopleStore(Path(self.tmp.name) / 'forget.db')
        gone = self.store.identity('telegram', '!gone', 'Old')
        self.store.add_message('$g', gone, 'x', False, 'hi', 1)
        self.assertTrue(self.store.forget('telegram', '!gone'))
        self.assertEqual(self.store.people(chats=False), [])
        self.assertFalse(self.store.forget('telegram', '!gone'))

    def test_disconnect_cleans_bridged_copies(self):
        import yaml
        import unified_setup
        with patch.dict('os.environ', {'TELEGRAM_API_ID': '12345', 'TELEGRAM_API_HASH': 'a' * 32}):
            unified_setup.setup(self.tmp.name)
        config = yaml.safe_load((Path(self.tmp.name) / 'telegram' / 'config.yaml').read_text())
        self.assertTrue(config['bridge']['cleanup_on_logout']['enabled'])
        self.assertEqual(config['bridge']['cleanup_on_logout']['manual']['private'], 'delete')

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


class SignalMvpTests(unittest.TestCase):
    """Speed + chat features: change feed, one-call send, relations, media proxy."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.a = self.inbox.store.identity('telegram', '!a', 'Alice')
        self.pid = self.a['person_id']
        self.inbox.matrix_token = lambda: 'x'
        self.inbox.rooms['!a'] = {'telegram': True, 'kind': 'person', 'label': 'Alice', 'names': {'@telegram_1:messenger.internal': 'Alice'}}

    def event(self, eid, content, etype='m.room.message', sender='@telegram_1:messenger.internal', ts=1000, **extra):
        return dict({'event_id': eid, 'type': etype, 'sender': sender, 'origin_server_ts': ts, 'content': content}, **extra)

    def ingest(self, *events):
        for e in events:
            self.inbox.ingest(self.a, self.inbox.rooms['!a'], e)

    def test_list_routes_never_touch_marmot_engine(self):
        self.engine.reset_mock()
        self.inbox.dispatch('GET', '/api/unified/people', {})
        self.inbox.dispatch('GET', '/api/unified/groups', {})
        self.inbox.dispatch('GET', '/api/unified/directory', {})
        self.inbox.dispatch('POST', '/api/unified/sync', {})
        self.engine.dms.assert_not_called()
        self.engine.identity.assert_not_called()

    def test_updates_feed_returns_new_rows_and_wakes_waiters(self):
        seq = self.inbox.store.seq
        self.assertEqual(self.inbox.updates(seq, 0)['messages'], {})
        import threading
        result = {}
        t = threading.Thread(target=lambda: result.update(self.inbox.updates(seq, 5)))
        t.start()
        time.sleep(0.2)
        started = time.time()
        self.ingest(self.event('$1', {'msgtype': 'm.text', 'body': 'hi'}))
        t.join(3)
        self.assertLess(time.time() - started, 1.5)
        self.assertEqual([m['original'] for m in result['messages'][self.pid]], ['hi'])
        self.assertEqual(result['people'][0]['unread'], 1)
        self.assertGreater(result['seq'], seq)

    def test_one_call_send_is_idempotent_by_client_id(self):
        self.inbox.mx = Mock(return_value={'event_id': '$sent'})
        body = {'text': 'hello', 'client_id': 'c-1234567890'}
        first = self.inbox.dispatch('POST', '/api/unified/people/%s/send' % self.pid, body)
        again = self.inbox.dispatch('POST', '/api/unified/people/%s/send' % self.pid, body)
        self.assertEqual(self.inbox.mx.call_count, 1)
        self.assertEqual(first['message']['id'], again['message']['id'])
        self.assertIn('/send/m.room.message/c-1234567890', self.inbox.mx.call_args.args[0])
        self.assertEqual(first['message']['client_id'], 'c-1234567890')

    def test_translated_chats_still_require_review(self):
        self.inbox.store.update(self.pid, {'language': 'th'})
        self.inbox.mx = Mock()
        with self.assertRaises(EngineError) as err:
            self.inbox.send(self.pid, {'text': 'hello', 'client_id': 'c-1234567890'})
        self.assertEqual(err.exception.code, 'review_required')
        self.inbox.mx.assert_not_called()

    def lines(self):
        with self.inbox.store.db() as db:
            return {r[0]: bool(r[1]) for r in db.execute('SELECT id,outgoing FROM message')}

    def test_lines_written_in_the_telegram_app_are_mine(self):
        me = '@telegram_42:messenger.internal'
        self.inbox.rooms['!a']['names'][me] = 'Alex'
        with self.inbox.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', ('!a', json.dumps(self.inbox.rooms['!a'])))
        self.ingest(self.event('$old', {'msgtype': 'm.text', 'body': 'sent from my phone'}, sender=me, ts=500),
                    self.event('$in', {'msgtype': 'm.text', 'body': 'hello'}, ts=400))
        self.assertEqual(self.lines(), {'$in': False, '$old': False})
        with patch.object(self.inbox, 'telegram_configured', return_value=True), patch.object(self.inbox, 'provision', return_value={'logins': [{'id': '42'}]}):
            self.inbox.learn_me()
        self.assertEqual(self.lines(), {'$in': False, '$old': True})
        chat = self.inbox.store.people()[0]
        self.assertEqual(chat['unread'], 0)
        self.ingest(self.event('$new', {'msgtype': 'm.text', 'body': 'again'}, sender=me, ts=900),
                    self.event('$r', {'msgtype': 'm.text', 'body': 'reply'}, ts=1000))
        self.assertTrue(self.lines()['$new'])
        self.assertEqual(self.inbox.store.people()[0]['unread'], 1)
        # Reading the chat in the Telegram app clears it here.
        self.inbox.ephemeral(self.a, [{'type': 'm.receipt', 'content': {'$r': {'m.read': {self.inbox.owner: {'ts': 1}}}}}])
        self.assertEqual(self.inbox.store.people()[0]['unread'], 0)
        # Survives a restart without asking the bridge again.
        self.assertIn(me, UnifiedInbox(self.tmp.name, self.engine).mine)

    def test_reply_reaction_edit_redaction_ingest(self):
        self.ingest(self.event('$q', {'msgtype': 'm.text', 'body': 'question?'}))
        self.ingest(self.event('$r', {'msgtype': 'm.text', 'body': '> <@x> question?\n\nanswer', 'm.relates_to': {'m.in_reply_to': {'event_id': '$q'}}}, sender='@owner:messenger.internal', ts=2000))
        self.ingest(self.event('$re', {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': '$q', 'key': '👍'}}, etype='m.reaction'))
        self.ingest(self.event('$ed', {'msgtype': 'm.text', 'body': '* question!', 'm.new_content': {'msgtype': 'm.text', 'body': 'question!'}, 'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$q'}}))
        rows = {m['id']: m for m in self.inbox.timeline(self.pid)['messages']}
        self.assertEqual(rows['$r']['original'], 'answer')
        self.assertEqual(rows['$r']['reply']['text'], 'question!')
        self.assertEqual(rows['$q']['reactions'], [{'key': '👍', 'count': 1, 'mine': False}])
        self.assertTrue(rows['$q']['edited'])
        self.ingest(self.event('$x', {}, etype='m.room.redaction', redacts='$re'))
        self.ingest(self.event('$y', {}, etype='m.room.redaction', redacts='$q'))
        rows = {m['id']: m for m in self.inbox.timeline(self.pid)['messages']}
        self.assertEqual(rows['$q']['reactions'], [])
        self.assertTrue(rows['$q']['deleted'])
        self.assertEqual(rows['$q']['original'], '')

    def test_react_replaces_own_reaction(self):
        self.ingest(self.event('$q', {'msgtype': 'm.text', 'body': 'hi'}))
        self.inbox.mx = Mock(side_effect=[{'event_id': '$r1'}, {}, {'event_id': '$r2'}, {}])
        self.inbox.react('$q', {'key': '👍'})
        out = self.inbox.react('$q', {'key': '❤️'})
        self.assertEqual(out['message']['reactions'], [{'key': '❤️', 'count': 1, 'mine': True}])
        self.assertIn('/redact/%24r1/', self.inbox.mx.call_args_list[1].args[0])
        self.inbox.react('$q', {'key': '❤️'})  # tapping the same one again removes it
        self.assertEqual(self.inbox.row('$q')['reactions'], [])
        # a late sync echo of the removed reaction must not resurrect it
        self.ingest(self.event('$r2', {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': '$q', 'key': '❤️'}}, etype='m.reaction', sender='@owner:messenger.internal'))
        self.assertEqual(self.inbox.row('$q')['reactions'], [])

    def test_media_rows_hide_mxc_and_upgrade_label_rows(self):
        self.inbox.store.add_message('$img', self.a, 'Alice', False, '[Photo] look', 5)
        self.ingest(self.event('$img', {'msgtype': 'm.image', 'body': 'look', 'filename': 'a.jpg', 'url': 'mxc://messenger.internal/abc',
                                        'info': {'mimetype': 'image/jpeg', 'w': 800, 'h': 600, 'size': 1234}}, ts=5))
        row = self.inbox.timeline(self.pid)['messages'][0]
        self.assertEqual((row['msgtype'], row['original']), ('m.image', 'look'))
        self.assertEqual(row['media']['w'], 800)
        self.assertNotIn('mxc', json.dumps(self.inbox.timeline(self.pid)))
        self.assertNotIn('mxc', json.dumps(self.inbox.updates(0, 0)))

    def test_voice_note_ingest(self):
        self.ingest(self.event('$v', {'msgtype': 'm.audio', 'body': 'Voice message', 'url': 'mxc://messenger.internal/v',
                                      'info': {'mimetype': 'audio/ogg', 'duration': 4200}, 'org.matrix.msc3245.voice': {},
                                      'org.matrix.msc1767.audio': {'duration': 4200, 'waveform': [0, 512, 1024, 256]}}))
        row = self.inbox.timeline(self.pid)['messages'][0]
        self.assertTrue(row['media']['voice'])
        self.assertEqual(row['media']['waveform'], [0, 50, 100, 25])
        self.assertEqual(self.inbox.store.people()[0]['last']['voice'], True)

    def test_media_proxy_caches_and_serves_safe_types_only(self):
        self.ingest(self.event('$svg', {'msgtype': 'm.file', 'body': 'x.svg', 'url': 'mxc://messenger.internal/svg', 'info': {'mimetype': 'image/svg+xml'}}))
        self.ingest(self.event('$jpg', {'msgtype': 'm.image', 'body': 'p.jpg', 'url': 'mxc://messenger.internal/jpg', 'info': {'mimetype': 'image/jpeg'}}))
        class Resp:
            def __init__(self, data): self.data, self.headers = data, {'Content-Type': 'image/svg+xml'}
            def read(self, n=-1):
                d, self.data = self.data, b''
                return d
            def __enter__(self): return self
            def __exit__(self, *a): pass
        with patch('unified.urlopen', return_value=Resp(b'<svg onload=alert(1)>')) as op:
            blob = self.inbox.dispatch('GET', '/api/unified/media/$svg', {})
            self.assertFalse(blob.inline)
            self.assertEqual(blob.mime, 'application/octet-stream')
        with patch('unified.urlopen', return_value=Resp(b'\xff\xd8\xff\xe0jpegdata')) as op:
            blob = self.inbox.dispatch('GET', '/api/unified/media/$jpg', {}, {'kind': ['full']})
            self.assertEqual((blob.mime, blob.inline), ('image/jpeg', True))
            self.inbox.dispatch('GET', '/api/unified/media/$jpg', {}, {'kind': ['full']})
            self.assertEqual(op.call_count, 1)  # second read from the private cache
            self.assertNotIn('access_token', op.call_args.args[0].full_url)

    def test_upload_sniffs_type_and_sends_voice_note(self):
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def read(self, *a): return b'{"content_uri": "mxc://messenger.internal/up"}'
        with self.assertRaises(EngineError):
            self.inbox.upload(self.pid, 'image', b'<html>not an image</html>')
        with patch('unified.urlopen', return_value=Resp()):
            up = self.inbox.upload(self.pid, 'voice', b'OggS' + b'\0' * 100)
        self.inbox.mx = Mock(return_value={'event_id': '$voice'})
        out = self.inbox.send(self.pid, {'upload_id': up['upload_id'], 'client_id': 'v-1234567890', 'media': {'duration': 3000, 'waveform': [1, 2, 3]}})
        content = self.inbox.mx.call_args.args[2]
        self.assertEqual(content['msgtype'], 'm.audio')
        self.assertIn('org.matrix.msc3245.voice', content)
        self.assertEqual(content['info']['duration'], 3000)
        self.assertTrue(out['message']['media']['voice'])

    def test_read_marks_chat_read_and_posts_receipt(self):
        self.ingest(self.event('$1', {'msgtype': 'm.text', 'body': 'a'}, ts=10), self.event('$2', {'msgtype': 'm.text', 'body': 'b'}, ts=20))
        self.assertEqual(self.inbox.store.people()[0]['unread'], 2)
        self.inbox.mx = Mock(return_value={})
        self.inbox.read(self.pid, {'timestamp': 20})
        self.assertEqual(self.inbox.store.people()[0]['unread'], 0)
        time.sleep(0.2)
        self.assertIn('/receipt/m.read/%242', self.inbox.mx.call_args.args[0])

    def test_bridge_error_notice_marks_send_failed_not_a_chat_line(self):
        self.inbox.store.add_message('$mine', self.a, '@owner:messenger.internal', True, 'yo', 50000)
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': 'Failed to bridge'}, sender='@telegrambot:messenger.internal', ts=51000))
        rows = self.inbox.timeline(self.pid)['messages']
        self.assertEqual([r['id'] for r in rows], ['$mine'])
        self.assertTrue(rows[0]['failed'])

    def test_peer_read_receipt_and_typing(self):
        self.inbox.store.add_message('$mine', self.a, '@owner:messenger.internal', True, 'yo', 50)
        self.inbox.ephemeral(dict(self.a), [{'type': 'm.receipt', 'content': {'$mine': {'m.read': {'@telegram_1:messenger.internal': {'ts': 60}}}}},
                                            {'type': 'm.typing', 'content': {'user_ids': ['@telegram_1:messenger.internal']}}])
        self.assertEqual(self.inbox.store.people()[0]['peer_read_ts'], 50)
        self.assertEqual(self.inbox.timeline(self.pid)['typing'], ['Alice'])


if __name__ == '__main__': unittest.main()
