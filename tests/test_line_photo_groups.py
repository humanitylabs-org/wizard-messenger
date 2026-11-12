"""Photos sent together to LINE (issue 188, switch line-photo-groups).

The LINE bridge reads no org.wizard.gallery, so a multi-photo send used to reach LINE as its first photo only. With
the switch on, each photo is its own Matrix image, sent in order and marked with org.wizard.line.album
{id, index, count}; the patched bridge (plumbing/line-own-read-sync.patch, photo_album.go) turns that into LINE's
GID/GSEQ/GTOTAL photo group.
"""
import tempfile
import time
import unittest
from unittest.mock import Mock

from engine import EngineError
from unified import UnifiedInbox

MARKER = 'org.wizard.line.album'


class LinePhotoGroupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = UnifiedInbox(self.tmp.name, Mock())
        self.puts = []

        def mx(path, method, content):
            self.puts.append((path, content))
            return {'event_id': '$e' + path.rsplit('/', 1)[1]}
        self.inbox.mx = Mock(side_effect=mx)
        self.inbox.owner = '@owner:test'
        self.line = self.inbox.store.identity('line', '!line-room', 'LINE friend')
        self.pid = self.line['person_id']
        # Words with LINE photos go as their own message (issue 186, tests/test_line_photo_text.py).
        self.payload = {'client_id': 'line_group_123', 'text': '', 'upload_ids': ['u0', 'u1', 'u2'],
                        'media': [{'w': 640, 'h': 480}] * 3}
        self.stage(self.pid)

    def stage(self, pid):
        for i in range(3):
            self.inbox.uploads['u%d' % i] = {'person_id': pid, 'kind': 'image', 'mime': 'image/jpeg',
                                           'filename': 'photo%d.jpg' % i, 'mxc': 'mxc://test/p%d' % i, 'bytes': b'x',
                                           'size': 1, 'expires': time.time() + 900}

    def switch(self, on):
        self.inbox.switches.set('line-photo-groups', on)

    def test_off_keeps_one_gallery_event(self):
        self.inbox.send(self.pid, self.payload)
        self.assertEqual(len(self.puts), 1)
        self.assertIn('org.wizard.gallery', self.puts[0][1])
        self.assertNotIn(MARKER, self.puts[0][1])

    def test_on_sends_each_photo_in_order_with_line_group_marker(self):
        self.switch(True)
        result = self.inbox.send(self.pid, self.payload)
        self.assertEqual([p.rsplit('/', 1)[1] for p, _ in self.puts],
                         ['line_group_123', 'line_group_123.p01', 'line_group_123.p02'])
        contents = [c for _, c in self.puts]
        self.assertEqual([c['url'] for c in contents], ['mxc://test/p0', 'mxc://test/p1', 'mxc://test/p2'])
        self.assertTrue(all(c['msgtype'] == 'm.image' and 'org.wizard.gallery' not in c for c in contents))
        group = contents[0][MARKER]['id']
        self.assertRegex(group, r'^[0-9]{1,19}$')
        self.assertEqual([c[MARKER] for c in contents], [{'id': group, 'index': i, 'count': 3} for i in range(3)])
        self.assertEqual(contents[0]['body'], 'photo0.jpg')
        self.assertEqual(contents[1]['body'], 'photo1.jpg')
        # Messenger shows the send as one album, in order.
        self.assertEqual([m['id'] for m in result['messages']], ['$eline_group_123', '$eline_group_123.p01', '$eline_group_123.p02'])
        self.assertEqual({m['album'] for m in result['messages']}, {'line:' + group})
        self.assertEqual([m['media']['album_index'] for m in result['messages']], [0, 1, 2])
        self.assertEqual([m['original'] for m in result['messages']], ['', '', ''])
        self.assertFalse(self.inbox.uploads)

    def test_retry_repeats_nothing_and_sync_echo_adds_no_rows(self):
        self.switch(True)
        first = self.inbox.send(self.pid, self.payload)
        for path, content in self.puts:
            self.inbox.ingest(self.line, {}, {'event_id': '$e' + path.rsplit('/', 1)[1], 'sender': self.inbox.owner,
                                              'type': 'm.room.message', 'content': content, 'origin_server_ts': 1000})
        self.assertEqual(len(self.inbox.store.messages(self.pid)), 3)
        again = self.inbox.send(self.pid, self.payload)
        self.assertEqual(len(self.puts), 3)
        self.assertEqual([m['id'] for m in again['messages']], [m['id'] for m in first['messages']])

    def test_same_send_gets_same_group_id(self):
        self.switch(True)
        self.inbox.send(self.pid, self.payload)
        group = self.puts[0][1][MARKER]['id']
        # A partial send (box restarted mid-way) is repeated with the same transactions and the same group.
        self.puts.clear()
        other = UnifiedInbox(tempfile.mkdtemp(dir=self.tmp.name), Mock())
        other.mx, other.owner = self.inbox.mx, self.inbox.owner
        other.switches.set('line-photo-groups', True)
        ident = other.store.identity('line', '!line-room', 'LINE friend')
        self.inbox = other
        self.stage(ident['person_id'])
        other.send(ident['person_id'], self.payload)
        self.assertEqual(self.puts[0][1][MARKER]['id'], group)

    def test_failed_photo_stores_nothing_until_resent(self):
        self.switch(True)
        calls = []

        def flaky(path, method, content):
            calls.append(path)
            if len(calls) == 2:
                raise EngineError('matrix_down', 'down', 502)
            return {'event_id': '$e' + path.rsplit('/', 1)[1]}
        self.inbox.mx = Mock(side_effect=flaky)
        with self.assertRaises(EngineError):
            self.inbox.send(self.pid, self.payload)
        self.assertEqual(self.inbox.store.messages(self.pid), [])
        self.assertEqual(len(self.inbox.send(self.pid, self.payload)['messages']), 3)

    def test_other_networks_and_single_photos_unchanged(self):
        self.switch(True)
        tg = self.inbox.store.identity('telegram', '!tg-room', 'Telegram friend')
        self.stage(tg['person_id'])
        self.inbox.send(tg['person_id'], dict(self.payload, client_id='telegram_group_1'))
        self.assertEqual(len(self.puts), 1)
        self.assertIn('org.wizard.gallery', self.puts[0][1])
        self.stage(self.pid)
        self.inbox.send(self.pid, {'client_id': 'line_single_1', 'upload_id': 'u0', 'text': ''})
        self.assertNotIn(MARKER, self.puts[-1][1])


if __name__ == '__main__':
    unittest.main()
