"""Reading a chat in the network's own app clears it in Messenger.

Synthetic Matrix events only. The bridges relay the owner's native reads as an m.receipt from the owner's
double-puppet user (or, without double puppeting, from the owner's own ghost); nothing here reads real chats.
"""
import json
import tempfile
import time
import unittest
from unittest.mock import Mock

from engine import EngineError
from unified import UnifiedInbox
import inbox_feed
from connectors import MATRIX_NETWORKS, ghost_mxid, own_ghost

OWNER = '@owner:messenger.internal'
NETWORKS = sorted(MATRIX_NETWORKS)


def receipt(event_id, user=OWNER, kind='m.read'):
    return {'type': 'm.receipt', 'content': {event_id: {kind: {user: {'ts': 1}}}}}


class NativeReadSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.addCleanup(lambda: self.inbox.store._conn and self.inbox.store._conn.close())
        self.store = self.inbox.store
        self.inbox.owner = OWNER
        self.inbox.mx = Mock(side_effect=EngineError('offline', 'synthetic', 502))
        self.t0 = int(time.time() * 1000) - 100000

    def chat(self, network, room, name):
        identity = self.store.identity(network, room, name)
        self.inbox.rooms[room] = {'network': network, 'label': name, 'names': {}}
        return identity

    def line(self, identity, event_id, offset, outgoing=False, **extra):
        self.store.add_message(event_id, identity, 'peer', outgoing, 'hello ' + event_id, self.t0 + offset, **extra)

    def unread(self, identity):
        return {p['id']: p['unread'] for p in self.store.people('person') + self.store.people('group')}.get(identity['person_id'], 0)

    def feed_titles(self):
        return sorted(i['title'] for i in inbox_feed.items(self.store)['items'])

    def badge(self):
        rows = self.store.people('person') + self.store.people('group')
        return len({p['id'] for p in rows if p.get('unread', 0) > 0 and not p['muted']})

    def last_read(self, identity):
        return self.store.person(identity['person_id'])['identities'][0]['last_read_ts']

    # -- the core contract ---------------------------------------------------------------------------------------

    def test_owner_receipt_clears_that_room_only_in_badge_feed_and_divider_mark(self):
        a, b = self.chat('line', '!a', 'Ann'), self.chat('line', '!b', 'Ben')
        for ident, tag in ((a, 'a'), (b, 'b')):
            self.line(ident, '$%s1' % tag, 0)
            self.line(ident, '$%s2' % tag, 1000)
        self.assertEqual((self.unread(a), self.unread(b), self.badge(), self.feed_titles()), (2, 2, 2, ['Ann', 'Ben']))
        before = self.store.seq
        self.inbox.ephemeral(a, [receipt('$a2')])
        self.assertEqual((self.unread(a), self.unread(b)), (0, 2))
        self.assertEqual((self.badge(), self.feed_titles()), (1, ['Ben']))
        self.assertEqual(self.last_read(a), self.t0 + 1000)  # the "N new messages" divider sits after this mark
        self.assertEqual(self.last_read(b), 0)
        self.assertGreater(self.store.seq, before)  # open clients and the inbox long poll wake up
        self.assertEqual(self.inbox.updates(before, 0)['people'][0]['id'], a['person_id'])

    def test_lines_after_the_one_read_stay_unread(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$1', 0)
        self.line(a, '$2', 1000)
        self.line(a, '$3', 2000)
        self.inbox.ephemeral(a, [receipt('$2')])
        self.assertEqual(self.unread(a), 1)
        self.assertEqual(self.last_read(a), self.t0 + 1000)
        self.inbox.ephemeral(a, [receipt('$3')])
        self.assertEqual(self.unread(a), 0)

    def test_receipt_never_moves_the_mark_backwards(self):
        a = self.chat('line', '!a', 'Ann')
        for i, tag in enumerate(('$1', '$2', '$3')):
            self.line(a, tag, i * 1000)
        self.inbox.ephemeral(a, [receipt('$3')])
        self.inbox.ephemeral(a, [receipt('$1')])  # a late, older receipt
        self.assertEqual(self.unread(a), 0)
        self.store.mark_unread(a['person_id'])  # the owner's explicit Mark as unread here
        self.assertEqual(self.unread(a), 1)
        self.inbox.ephemeral(a, [receipt('$1')])
        self.assertEqual(self.unread(a), 1)

    def test_private_receipts_count_too(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$1', 0)
        self.inbox.ephemeral(a, [receipt('$1', kind='m.read.private')])
        self.assertEqual(self.unread(a), 0)

    def test_a_peer_reading_our_lines_never_clears_our_unread(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$in', 0)
        self.line(a, '$out', 1000, outgoing=True)
        self.line(a, '$in2', 2000)
        peer = ghost_mxid('line', 'Upeer')
        self.inbox.ephemeral(a, [receipt('$out', user=peer)])
        self.assertEqual(self.unread(a), 1)
        self.assertEqual(self.store.person(a['person_id'])['identities'][0]['peer_read_ts'], self.t0 + 1000)

    def test_a_receipt_for_another_rooms_event_is_ignored(self):
        a, b = self.chat('line', '!a', 'Ann'), self.chat('line', '!b', 'Ben')
        self.line(a, '$a1', 0)
        self.line(b, '$b1', 0)
        self.inbox.ephemeral(a, [receipt('$b1')])
        self.assertEqual((self.unread(a), self.unread(b)), (1, 1))

    # -- who counts as the owner ------------------------------------------------------------------------------------

    def test_receipt_from_the_owners_own_ghost_counts_without_double_puppeting(self):
        for network in NETWORKS:
            room = '!' + network
            ident = self.chat(network, room, network.title())
            self.line(ident, '$' + network, 0)
            ghost = own_ghost(network, 'Uowner9')
            self.assertTrue(ghost, network)
            self.inbox.mine.add(ghost)
            self.inbox.ephemeral(ident, [receipt('$' + network, user=ghost)])
            self.assertEqual(self.unread(ident), 0, network)

    def test_unknown_ghost_is_a_peer_not_the_owner(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$1', 0)
        self.inbox.ephemeral(a, [receipt('$1', user=own_ghost('line', 'Usomeoneelse'))])
        self.assertEqual(self.unread(a), 1)

    # -- targets Messenger holds no row for ---------------------------------------------------------------------------

    def test_receipt_on_an_album_tile_or_source_event_counts(self):
        a = self.chat('signal', '!a', 'Ann')
        self.line(a, '$tile1', 0, album='signal:1', source_event='$whole')
        self.line(a, '$tile2', 10, album='signal:1', source_event='$whole')
        self.line(a, '$later', 5000)
        self.inbox.ephemeral(a, [receipt('$whole')])
        self.assertEqual(self.unread(a), 1)

    def test_receipt_on_an_event_we_never_stored_uses_its_server_time(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$1', 0)
        self.line(a, '$2', 1000)
        self.line(a, '$3', 3000)
        self.inbox.room = lambda address: '/rooms/' + address
        self.inbox.mx = Mock(return_value={'origin_server_ts': self.t0 + 1500})  # e.g. an edit of $2
        self.inbox.ephemeral(a, [receipt('$edit-of-2')])
        self.assertEqual(self.unread(a), 1)
        self.assertEqual(self.last_read(a), self.t0 + 1000)
        # A peer's receipt for an unknown event never asks the homeserver.
        self.inbox.mx.reset_mock()
        self.inbox.ephemeral(a, [receipt('$edit-of-2', user=ghost_mxid('line', 'Upeer'))])
        self.inbox.mx.assert_not_called()

    def test_unreachable_homeserver_leaves_the_chat_unread(self):
        a = self.chat('line', '!a', 'Ann')
        self.line(a, '$1', 0)
        self.inbox.room = lambda address: '/rooms/' + address
        self.inbox.ephemeral(a, [receipt('$unknown')])
        self.assertEqual(self.unread(a), 1)

    # -- numbers-only diagnostics -------------------------------------------------------------------------------------

    def test_status_counts_native_reads_per_network_without_content(self):
        a, b = self.chat('line', '!a', 'Ann'), self.chat('whatsapp', '!b', 'Ben')
        for ident in (a, b):
            self.line(ident, '$' + ident['network'] + '1', 0)
            self.line(ident, '$' + ident['network'] + '2', 1000)
        self.inbox.ephemeral(a, [receipt('$line2')])
        self.inbox.ephemeral(a, [receipt('$line1')])  # seen again, clears nothing
        status = self.inbox.dispatch('GET', '/api/unified/status', {})
        stats = status['read_sync']
        self.assertEqual(set(stats), {'line'})
        self.assertEqual((stats['line']['seen'], stats['line']['cleared']), (2, 1))
        self.assertAlmostEqual(stats['line']['last'], time.time(), delta=5)
        self.assertEqual(set(stats['line']), {'seen', 'cleared', 'last'})
        self.assertNotIn('Ann', json.dumps(status['read_sync']))


if __name__ == '__main__':
    unittest.main()
