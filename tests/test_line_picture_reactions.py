"""Issue 184: LINE's own reactions arrive as pictures (an mxc:// reaction key) and must never show that address."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import unified
from unified import Blob, UnifiedInbox, message_parts

# icon_1003.png from beeper/line pkg/connector/assets at the pinned commit (MIT, plumbing/line-upstream-LICENSE).
LIKE_ICON = Path(__file__).with_name('fixtures') / 'line-reaction-like.png'
LIKE = 'mxc://messenger.internal/SJnEsQhAbCdEfGhIjKlMnOpQ'
PAID = 'mxc://messenger.internal/CqjbgUWzYxWvUtSrQpOnMlKj'


class LinePictureReactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.a = self.inbox.store.identity('line', '!g', 'Engineers Anonymous')
        self.pid = self.a['person_id']
        self.inbox.matrix_token = lambda: 'x'
        self.inbox.rooms['!g'] = {'line': True, 'kind': 'group', 'label': 'Engineers Anonymous', 'names': {'@line_mike:messenger.internal': 'Mike'}}
        self.fetched = []
        other = Path(self.tmp.name) / 'paid.png'
        other.write_bytes(b'\x89PNG not one of the six icons')

        def blob(mxc, mime, name, **_):
            self.fetched.append(mxc)
            return Blob(LIKE_ICON if mxc == LIKE else other, 'image/png', name)
        self.inbox.media_blob = blob
        self.ingest({'event_id': '$photo', 'type': 'm.room.message', 'sender': '@line_mike:messenger.internal', 'origin_server_ts': 1000,
                     'content': {'msgtype': 'm.image', 'body': 'image.jpg', 'url': 'mxc://messenger.internal/photo1'}})

    def ingest(self, event):
        self.inbox.ingest(self.a, self.inbox.rooms['!g'], event)

    def react(self, eid, key, sender='@line_mike:messenger.internal'):
        self.ingest({'event_id': eid, 'type': 'm.reaction', 'sender': sender, 'origin_server_ts': 2000,
                     'content': {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': '$photo', 'key': key}}})

    def photo(self):
        return next(m for m in self.inbox.timeline(self.pid)['messages'] if m['id'] == '$photo')

    def test_line_like_icon_shows_as_thumbs_up_and_is_fetched_once(self):
        self.react('$r1', LIKE)
        self.react('$r2', LIKE, sender='@line_ana:messenger.internal')
        photo = self.photo()
        self.assertEqual([(r['key'], r['count']) for r in photo['reactions']], [('\U0001F44D', 2)])
        self.assertEqual(self.fetched, [LIKE])
        self.assertNotIn('mxc://', repr(photo))

    def test_unknown_picture_reaction_shows_a_neutral_emoji_not_its_address(self):
        self.react('$r1', PAID)
        photo = self.photo()
        self.assertEqual([r['key'] for r in photo['reactions']], [unified.IMAGE_REACTION])
        self.assertNotIn('mxc://', repr(photo))
        self.assertEqual(photo['original'], '')

    def test_rows_already_stored_with_a_cut_address_display_clean(self):
        # Before the fix the key was stored cut to 32 characters, exactly as in the report.
        with self.inbox.store.db() as db:
            db.execute('INSERT INTO reaction VALUES (?,?,?,?,?)', ('$old1', '$photo', '@line_mike:messenger.internal', LIKE[:32], 0))
            db.execute('INSERT INTO reaction VALUES (?,?,?,?,?)', ('$old2', '$photo', '@line_ana:messenger.internal', PAID[:32], 0))
        self.assertEqual(LIKE[:32], 'mxc://messenger.internal/SJnEsQh')
        self.assertEqual(sorted(r['key'] for r in self.photo()['reactions']), sorted([unified.IMAGE_REACTION]))
        # Once the same icon is seen in full, older rows with that address show the real emoji too.
        self.react('$r1', LIKE)
        keys = {r['key']: r['count'] for r in self.photo()['reactions']}
        self.assertEqual(keys, {'\U0001F44D': 2, unified.IMAGE_REACTION: 1})

    def test_real_reactions_and_captions_are_unchanged(self):
        self.react('$r1', '\u2764\uFE0F')
        self.assertEqual([r['key'] for r in self.photo()['reactions']], ['\u2764\uFE0F'])
        self.assertEqual(self.fetched, [])
        caption = {'type': 'm.room.message', 'content': {'msgtype': 'm.image', 'body': 'Basic life support training', 'filename': 'image.jpg', 'url': 'mxc://s/a'}}
        self.assertEqual(message_parts(caption)[1], 'Basic life support training')

    def test_a_caption_that_is_only_internal_addresses_is_dropped(self):
        event = {'type': 'm.room.message', 'content': {'msgtype': 'm.image', 'body': 'mxc://messenger.internal/SJnEsQh mxc://messenger.internal/CqjbgUW',
                                                        'filename': 'image.jpg', 'url': 'mxc://messenger.internal/photo1'}}
        self.assertEqual(message_parts(event)[1], '')


if __name__ == '__main__':
    unittest.main()
