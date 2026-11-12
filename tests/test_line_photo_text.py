"""Photos plus text to LINE (issue 186).

The LINE bridge rejects a photo that carries a caption (beeper/line declares Caption: CapLevelRejected), so a send of
photos with words used to fail as a whole: nothing arrived and Messenger showed no failure. Now the photos go
without words and the words follow as their own text message (transaction <client_id>.caption), the way LINE itself
sends them. Photos with no text send on every network.
"""
import tempfile
import time
import unittest
from unittest.mock import Mock

from engine import EngineError
from unified import UnifiedInbox


class LinePhotoTextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = UnifiedInbox(self.tmp.name, Mock())
        self.puts = []
        self.fail_at = None

        def mx(path, method, content):
            self.puts.append((path.rsplit('/', 1)[1], content))
            if self.fail_at is not None and len(self.puts) == self.fail_at:
                raise EngineError('matrix_down', 'down', 502)
            return {'event_id': '$e' + path.rsplit('/', 1)[1]}
        self.inbox.mx = Mock(side_effect=mx)
        self.inbox.owner = '@owner:test'
        self.line = self.inbox.store.identity('line', '!line-room', 'LINE friend')
        self.pid = self.line['person_id']

    def stage(self, pid, n=2):
        for i in range(n):
            self.inbox.uploads['u%d' % i] = {'person_id': pid, 'kind': 'image', 'mime': 'image/jpeg',
                                           'filename': 'photo%d.jpg' % i, 'mxc': 'mxc://test/p%d' % i, 'bytes': b'x',
                                           'size': 1, 'expires': time.time() + 900}

    def album(self, text, client_id='line_send_1'):
        return {'client_id': client_id, 'text': text, 'upload_ids': ['u0', 'u1'], 'media': [{'w': 640, 'h': 480}] * 2}

    def assert_photos_then_text(self, result, photo_txns, client_id='line_send_1'):
        self.assertEqual([t for t, _ in self.puts], photo_txns + [client_id + '.caption'])
        photos = [c for _, c in self.puts[:-1]]
        self.assertTrue(all(c['msgtype'] == 'm.image' and c['body'] == c['filename'] for c in photos), 'no words on a LINE photo')
        self.assertEqual(self.puts[-1][1], {'msgtype': 'm.text', 'body': 'Two from the trip'})
        rows = result['messages']
        self.assertEqual([r['msgtype'] for r in rows], ['m.image'] * 2 + ['m.text'])
        self.assertEqual([r['original'] for r in rows], ['', '', 'Two from the trip'])
        self.assertEqual(rows[-1]['client_id'], client_id + '.caption')
        self.assertEqual(result['state'], 'sent')
        # The thread shows the photos, then the text.
        stored = self.inbox.store.messages(self.pid)
        self.assertEqual([m['msgtype'] for m in stored], ['m.image', 'm.image', 'm.text'])
        self.assertFalse(self.inbox.uploads)

    def test_album_with_text_switch_off(self):
        self.stage(self.pid)
        result = self.inbox.send(self.pid, self.album('Two from the trip'))
        self.assert_photos_then_text(result, ['line_send_1'])
        self.assertEqual(len(self.puts[0][1]['org.wizard.gallery']), 2)
        self.assertTrue(all(i['body'] == i['filename'] for i in self.puts[0][1]['org.wizard.gallery']))

    def test_album_with_text_switch_on(self):
        self.inbox.switches.set('line-photo-groups', True)
        self.stage(self.pid)
        result = self.inbox.send(self.pid, self.album('Two from the trip'))
        self.assert_photos_then_text(result, ['line_send_1', 'line_send_1.p01'])

    def test_one_photo_with_text(self):
        self.stage(self.pid, 1)
        result = self.inbox.send(self.pid, {'client_id': 'line_send_1', 'text': 'Two from the trip', 'upload_id': 'u0'})
        self.assertEqual([t for t, _ in self.puts], ['line_send_1', 'line_send_1.caption'])
        self.assertEqual(self.puts[0][1]['body'], 'photo0.jpg')
        self.assertEqual([r['original'] for r in result['messages']], ['', 'Two from the trip'])

    def test_reply_stays_on_the_photos(self):
        self.inbox.store.add_message('$older', self.line, 'LINE friend', False, 'hi', 1000)
        self.stage(self.pid, 1)
        self.inbox.send(self.pid, {'client_id': 'line_send_1', 'text': 'Two from the trip', 'upload_id': 'u0', 'reply_to': '$older'})
        self.assertEqual(self.puts[0][1]['m.relates_to'], {'m.in_reply_to': {'event_id': '$older'}})
        self.assertNotIn('m.relates_to', self.puts[1][1])

    def test_photos_without_text_send_on_every_network(self):
        for network in ('line', 'telegram', 'whatsapp', 'signal', 'instagram'):
            with self.subTest(network=network):
                self.puts.clear()
                ident = self.inbox.store.identity(network, '!room-' + network, network + ' friend')
                self.stage(ident['person_id'])
                result = self.inbox.send(ident['person_id'], self.album('', client_id='photos_' + network))
                self.assertEqual(result['state'], 'sent')
                self.assertEqual(len(self.puts), 1, 'one photo send, no text message')
                self.assertEqual([r['msgtype'] for r in result['messages']], ['m.image', 'm.image'])

    def test_other_networks_keep_the_caption_on_the_photos(self):
        for network in ('telegram', 'whatsapp', 'signal'):
            with self.subTest(network=network):
                self.puts.clear()
                ident = self.inbox.store.identity(network, '!room-' + network, network + ' friend')
                self.stage(ident['person_id'])
                self.inbox.send(ident['person_id'], self.album('Two from the trip', client_id='caption_' + network))
                self.assertEqual(len(self.puts), 1)
                self.assertEqual(self.puts[0][1]['body'], 'Two from the trip')

    def test_text_failure_then_retry_sends_only_what_is_missing(self):
        self.inbox.switches.set('line-photo-groups', True)
        self.stage(self.pid)
        self.fail_at = 3  # photo, photo, then the text fails
        with self.assertRaises(EngineError):
            self.inbox.send(self.pid, self.album('Two from the trip'))
        self.assertEqual(self.inbox.store.messages(self.pid), [], 'nothing shows as sent while a part failed')
        self.fail_at = None
        self.stage(self.pid)  # the view uploads again for its Retry
        result = self.inbox.send(self.pid, self.album('Two from the trip'))
        # Same transaction ids: the homeserver answers the photos from its transaction cache, nothing goes twice.
        self.assertEqual([t for t, _ in self.puts[3:]], ['line_send_1', 'line_send_1.p01', 'line_send_1.caption'])
        self.assertEqual([r['original'] for r in result['messages']], ['', '', 'Two from the trip'])

    def test_repeat_after_success_returns_the_text_too(self):
        self.stage(self.pid)
        first = self.inbox.send(self.pid, self.album('Two from the trip'))
        again = self.inbox.send(self.pid, self.album('Two from the trip'))
        self.assertEqual(len(self.puts), 2, 'nothing sent twice')
        self.assertEqual([r['id'] for r in again['messages']], [r['id'] for r in first['messages']])

    def test_sync_echo_adds_no_rows(self):
        self.inbox.switches.set('line-photo-groups', True)
        self.stage(self.pid)
        self.inbox.send(self.pid, self.album('Two from the trip'))
        for txn, content in self.puts:
            self.inbox.ingest(self.line, {}, {'event_id': '$e' + txn, 'sender': self.inbox.owner, 'type': 'm.room.message',
                                              'content': content, 'origin_server_ts': 1000})
        self.assertEqual(len(self.inbox.store.messages(self.pid)), 3)


if __name__ == '__main__':
    unittest.main()
