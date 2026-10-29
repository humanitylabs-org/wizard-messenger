"""Several selected photos are ONE transport event and ONE post, not N sends."""
import copy
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import Mock

from engine import EngineError
from unified import PeopleStore, UnifiedInbox


class PhotoAlbumTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = UnifiedInbox(self.tmp.name, Mock())
        self.inbox.mx = Mock(return_value={'event_id': '$album'})
        self.a = self.inbox.store.identity('telegram', '!album-room', 'Album fixture')
        self.pid = self.a['person_id']
        self.inbox.owner = '@owner:test'
        self.payload = {'client_id': 'album_test_123', 'text': 'One caption', 'upload_ids': ['u0', 'u1', 'u2'],
                        'media': [{'w': 640, 'h': 480}] * 3}
        for i in range(3):
            self.inbox.uploads['u%d' % i] = {'person_id': self.pid, 'kind': 'image', 'mime': 'image/jpeg',
                                           'filename': 'photo%d.jpg' % i, 'mxc': 'mxc://test/p%d' % i, 'bytes': b'fixture', 'size': 7,
                                           'expires': time.time() + 900}

    def send(self):
        return self.inbox.send(self.pid, self.payload)

    def test_three_photos_one_matrix_put_caption_and_retry(self):
        result = self.send()
        self.assertEqual(self.inbox.mx.call_count, 1)
        path, method, content = self.inbox.mx.call_args.args
        self.assertEqual(method, 'PUT')
        self.assertIn('/send/m.room.message/album_test_123', path)
        photos = content['org.wizard.gallery']
        self.assertEqual(len(photos), 3)
        self.assertEqual(content['url'], photos[0]['url'])
        self.assertEqual(photos[0]['body'], 'One caption')
        self.assertEqual(photos[1]['body'], photos[1]['filename'])
        self.assertEqual(photos[2]['info']['w'], 640)
        self.assertEqual(len(result['messages']), 3)
        self.assertEqual({m['album'] for m in result['messages']}, {'matrix:$album'})
        self.assertEqual([m['original'] for m in result['messages']], ['One caption', '', ''])
        self.assertEqual(self.send()['messages'], result['messages'])
        self.assertEqual(self.inbox.mx.call_count, 1)
        self.assertFalse(self.inbox.uploads)

    def test_sync_echo_and_restart_do_not_duplicate_rows(self):
        self.send()
        content = self.inbox.mx.call_args.args[2]
        self.inbox.ingest(self.a, {}, {'event_id': '$album', 'sender': self.inbox.owner,
                          'type': 'm.room.message', 'content': content, 'origin_server_ts': 1000})
        self.assertEqual(len(self.inbox.store.messages(self.pid)), 3)
        again = UnifiedInbox(self.tmp.name, Mock())
        again.mx = Mock()
        self.assertEqual(len(again.send(self.pid, self.payload)['messages']), 3)
        again.mx.assert_not_called()

    def test_sync_before_send_receipt_recovers_client_id(self):
        def echo(path, method, content):
            self.inbox.ingest(self.a, {}, {'event_id': '$album', 'sender': self.inbox.owner,
                'type': 'm.room.message', 'content': content, 'origin_server_ts': 1000})
            return {'event_id': '$album'}
        self.inbox.mx.side_effect = echo
        self.send()
        self.assertEqual(self.inbox.row('$album')['client_id'], self.payload['client_id'])
        self.send()
        self.assertEqual(self.inbox.mx.call_count, 1)

    def test_received_group_id_is_string_and_scoped_by_identity(self):
        for i in range(3):
            self.inbox.ingest(self.a, {}, {'event_id': '$in%d' % i, 'sender': '@alice:test', 'type': 'm.room.message',
                'origin_server_ts': 1000+i, 'content': {'msgtype': 'm.image', 'url': 'mxc://test/p%d' % i,
                  'body': 'p.jpg', 'filename': 'p.jpg', 'info': {'mimetype': 'image/jpeg'},
                  'fi.mau.telegram.grouped_id': '987654321012345678'}})
        rows = self.inbox.store.messages(self.pid)
        self.assertEqual({m['album'] for m in rows}, {'telegram:987654321012345678'})
        self.assertEqual(len(rows), 3)

    def test_equal_second_received_photos_keep_timeline_order_not_random_event_id(self):
        order = ['$z-first', '$a-second', '$m-third']
        for event_id in order:
            self.inbox.ingest(self.a, {}, {'event_id': event_id, 'sender': '@alice:test',
                'type': 'm.room.message', 'origin_server_ts': 1000,
                'content': {'msgtype': 'm.image', 'url': 'mxc://test/photo', 'body': 'p.jpg',
                            'filename': 'p.jpg', 'fi.mau.telegram.grouped_id': '1234'}})
        self.inbox.store.add_message('$b-neighbor', self.a, '@alice:test', False, 'After album', 1000)
        expected = order + ['$b-neighbor']
        self.assertEqual([m['id'] for m in self.inbox.store.messages(self.pid)], expected)
        self.assertEqual([m['id'] for m in self.inbox.album_rows(order[0])], order)
        self.inbox.store.bump(order[0])  # Updating a reaction/receipt must not reorder an album.
        rows = self.inbox.store.messages(self.pid)
        self.assertEqual([m['id'] for m in rows], expected)
        self.assertEqual([m['timeline_order'] for m in rows], sorted(m['timeline_order'] for m in rows))
        self.assertEqual(self.inbox.row(order[1])['timeline_order'], rows[1]['timeline_order'])

    def test_delete_album_once_locally_and_for_everyone(self):
        self.send()
        self.inbox.mx.reset_mock()
        result = self.inbox.delete('$album#photo:01', {'everyone': True})
        self.assertEqual(self.inbox.mx.call_count, 1)
        self.assertIn('/redact/%24album/', self.inbox.mx.call_args.args[0])
        self.assertEqual(len(result['messages']), 3)
        self.assertTrue(all(m['deleted'] for m in result['messages']))

    def test_remote_redaction_deletes_all_gallery_parts(self):
        self.send()
        self.inbox.ingest(self.a, {}, {'type': 'm.room.redaction', 'redacts': '$album'})
        self.assertTrue(all(m['deleted'] for m in self.inbox.store.messages(self.pid)))

    def test_reply_on_extra_photo_resolves_transport_event(self):
        self.send()
        self.assertEqual(self.inbox.reply_target(self.a, '$album#photo:02'), '$album')

    def test_single_photo_unchanged(self):
        result = self.inbox.send(self.pid, {'client_id': 'single_test_123', 'upload_id': 'u0', 'text': 'caption'})
        content = self.inbox.mx.call_args.args[2]
        self.assertEqual(content['msgtype'], 'm.image')
        self.assertNotIn('org.wizard.gallery', content)
        self.assertIsNone(result['message']['album'])
        self.assertEqual(len(self.inbox.store.messages(self.pid)), 1)

    def test_invalid_album_inputs_never_send(self):
        for bad in [[], ['u0'], ['u0'] * 3, 'u0', [1, 2], ['missing', 'u1'], ['u0', 'u1'] * 6]:
            with self.subTest(bad=bad), self.assertRaises(EngineError):
                self.inbox.send(self.pid, dict(self.payload, upload_ids=bad))
        self.inbox.mx.assert_not_called()

    def test_cross_person_expired_and_audio_rejected(self):
        for field, value in [('person_id', 'different'), ('expires', 1), ('kind', 'voice'), ('mime', 'image/gif')]:
            upload = self.inbox.uploads['u1']
            old = upload[field]
            upload[field] = value
            with self.subTest(field=field), self.assertRaises(EngineError):
                self.send()
            upload[field] = old
        self.inbox.mx.assert_not_called()

    def test_album_rows_are_atomic_on_bad_later_part(self):
        content = {'org.wizard.gallery': [
            {'url': 'mxc://test/one', 'body': 'one.jpg'},
            {'url': 'mxc://test/two', 'body': 'two.jpg'},
            {'body': 'invalid.jpg'}]}
        with self.assertRaises(EngineError):
            self.inbox.store_gallery('$broken', self.a, 'sender', False, content, 1000)
        self.assertEqual(self.inbox.store.messages(self.pid), [])

    def test_invalid_incoming_extension_keeps_photo_and_sync_alive(self):
        self.inbox.ingest(self.a, {}, {'type': 'm.room.message', 'event_id': '$bad-extension',
            'sender': 'sender', 'content': {'msgtype': 'm.image', 'url': 'mxc://test/one',
                'body': 'one.jpg', 'org.wizard.gallery': [None, None]}})
        rows = self.inbox.store.messages(self.pid)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]['album'])

    def test_concurrent_retry_sends_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.send(), range(2)))
        self.assertEqual(self.inbox.mx.call_count, 1)
        self.assertEqual(len(results[0]['messages']), 3)
        self.assertEqual(len(results[1]['messages']), 3)

    def test_old_database_migration_preserves_messages(self):
        self.inbox.store.add_message('$old', self.a, 'sender', False, 'keep me', 10)
        path = self.inbox.store.path
        with sqlite3.connect(path) as db:
            db.execute('ALTER TABLE message DROP COLUMN album')
            db.execute('ALTER TABLE message DROP COLUMN source_event')
        again = PeopleStore(path)
        old = again.message('$old')
        self.assertEqual(old['original'], 'keep me')
        self.assertIsNone(old['album'])
        self.assertIsNone(old['source_event'])
