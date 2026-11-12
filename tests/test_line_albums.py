"""LINE photo groups (issue 187): one multi-photo LINE send shows as one album.

The patched LINE bridge (plumbing/line-own-read-sync.patch, photo_album.go) maps
LINE's own GID/GSEQ/GTOTAL metadata to org.wizard.line.album {id, index, count}
on every photo of the send. Nothing is guessed from timestamps.
"""
import tempfile
import unittest
from unittest.mock import Mock

from unified import UnifiedInbox

MARKER = 'org.wizard.line.album'


class LineAlbumTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.inbox = UnifiedInbox(self.tmp.name, Mock())
        self.inbox.mx = Mock(return_value={'event_id': '$receipt'})
        self.identity = self.inbox.store.identity('line', '!line:test', 'LINE friend')
        self.inbox.owner = '@owner:test'

    def event(self, key, index=0, count=3, gid='612345', stamp=1700000000000, marker=True):
        content = {'msgtype': 'm.image', 'body': 'image.jpg', 'url': 'mxc://line/' + key.strip('$'),
                   'info': {'mimetype': 'image/jpeg'}}
        if marker:
            content[MARKER] = {'id': gid, 'index': index, 'count': count}
        return {'type': 'm.room.message', 'event_id': key, 'sender': '@line_friend:test',
                'origin_server_ts': stamp, 'content': content}

    def put(self, event, identity=None):
        self.inbox.ingest(identity or self.identity, {}, event)
        return self.inbox.row(event['event_id'])

    def test_line_album_arrives_as_one_message_in_line_order(self):
        # Delivered out of order: the album still shows LINE's order.
        for key, index, stamp in [('$c', 2, 3), ('$a', 0, 1), ('$b', 1, 2)]:
            self.put(self.event(key, index, stamp=1700000000000 + stamp))
        row = self.inbox.row('$a')
        self.assertEqual(row['album'], 'line:612345')
        self.assertEqual((row['media']['album_index'], row['media']['album_count']), (0, 3))
        self.assertNotIn('mxc', row['media'])
        self.assertEqual([r['id'] for r in self.inbox.album_rows('$c')], ['$a', '$b', '$c'])

    def test_single_and_separate_sends_stay_separate(self):
        self.put(self.event('$one', marker=False))
        self.put(self.event('$two', marker=False, stamp=1700000000001))
        self.assertFalse(self.inbox.row('$one')['album'])
        self.assertEqual([r['id'] for r in self.inbox.album_rows('$two')], ['$two'])
        # Two different LINE sends seconds apart keep their own groups.
        self.put(self.event('$g1', 0, 2, gid='1'))
        self.put(self.event('$g2', 0, 2, gid='2', stamp=1700000002000))
        self.assertEqual([r['id'] for r in self.inbox.album_rows('$g1')], ['$g1'])

    def test_bad_marker_never_groups(self):
        for i, group in enumerate([None, [], {}, {'id': '', 'index': 0, 'count': 2},
                                   {'id': 'x' * 201, 'index': 0, 'count': 2}, {'id': 'g', 'index': 2, 'count': 2},
                                   {'id': 'g', 'index': 0, 'count': 1}, {'id': 'g', 'index': True, 'count': 2},
                                   {'id': 'g', 'index': '0', 'count': 2}]):
            ev = self.event('$bad%d' % i); ev['content'][MARKER] = group
            self.assertFalse(self.put(ev)['album'], group)

    def test_marker_counts_only_on_its_own_network(self):
        telegram = self.inbox.store.identity('telegram', '!tg:test', 'Telegram')
        self.assertFalse(self.put(self.event('$tg'), telegram)['album'])
        ev = self.event('$sig', marker=False)
        ev['content']['org.wizard.signal.album'] = {'id': 'g', 'index': 0, 'count': 2}
        self.assertFalse(self.put(ev)['album'])
        signal = self.inbox.store.identity('signal', '!sig:test', 'Signal')
        self.assertFalse(self.put(self.event('$line-on-signal'), signal)['album'])

    def test_deleted_part_keeps_its_place(self):
        for key, index in [('$a', 0), ('$b', 1), ('$c', 2)]:
            self.put(self.event(key, index))
        self.inbox.ingest(self.identity, {}, {'type': 'm.room.redaction', 'redacts': '$b'})
        row = self.inbox.row('$b')
        self.assertTrue(row['deleted'])
        self.assertEqual(row['media']['album_index'], 1)
        self.assertFalse(self.inbox.row('$a')['deleted'])


if __name__ == '__main__':
    unittest.main()
