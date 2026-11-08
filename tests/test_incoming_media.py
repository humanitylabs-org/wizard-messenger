"""Incoming message display: WhatsApp decrypt-retry edits that carry media, GIF/animated-sticker flags,
@mention pills and media the bridge could not deliver (expired on WhatsApp)."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import inbox_feed
import unified
from unified import UnifiedInbox, message_parts, unavailable_media, substitute_mentions, mention_pills

GHOST = '@whatsapp_lid-111:messenger.internal'
OTHER = '@whatsapp_316123:messenger.internal'
WAITING = 'Decrypting message from WhatsApp failed, waiting for sender to re-send... ([learn more](https://faq.whatsapp.com/1))'


def photo(url='mxc://messenger.internal/abc', body='image.jpg', **extra):
    return dict({'msgtype': 'm.image', 'body': body, 'url': url, 'info': {'mimetype': 'image/jpeg', 'w': 640, 'h': 480, 'size': 1000}}, **extra)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.inbox.matrix_token = lambda: 'x'
        self.g = self.inbox.store.identity('whatsapp', '!g', 'Family', 'group')
        self.meta = {'network': 'whatsapp', 'kind': 'group', 'label': 'Family',
                     'names': {GHOST: 'Ana (WA)', OTHER: '+31 6 1234 5678 (WA)', '@owner:messenger.internal': 'Miguel'}}
        self.inbox.rooms['!g'] = self.meta

    def event(self, eid, content, sender=GHOST, etype='m.room.message', ts=1000):
        return {'event_id': eid, 'type': etype, 'sender': sender, 'origin_server_ts': ts, 'content': content}

    def ingest(self, *events):
        for e in events:
            self.inbox.ingest(self.g, self.meta, e)

    def rows(self):
        return {m['id']: m for m in self.inbox.store.messages(self.g['person_id'])}


class EditToMediaTests(Base):
    def test_decrypt_retry_edit_turns_placeholder_into_photo(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING, 'fi.mau.whatsapp.undecryptable': True}, ts=int(time.time() * 1000)))
        self.assertEqual(self.rows()['$n']['unavailable'], 'waiting')
        self.ingest(self.event('$e', {'msgtype': 'm.image', 'body': '* look', 'm.new_content': photo(body='look', filename='image.jpg'),
                                      'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}))
        row = self.rows()['$n']
        self.assertEqual(row['msgtype'], 'm.image')
        self.assertEqual(row['original'], 'look')
        self.assertEqual((row['media']['w'], row['media']['thumb']), (640, True))
        self.assertNotIn('unavailable', row)
        self.assertFalse(row['edited'])  # the bridge finishing delivery is not an edit by the sender
        # The media endpoint serves the new picture.
        with patch.object(self.inbox, 'media_blob', return_value=('blob', 'image/jpeg')) as blob:
            self.inbox.media('$n', 'full')
        self.assertEqual(blob.call_args.args[0], 'mxc://messenger.internal/abc')
        # The chat list shows a photo, not the bridge sentence.
        last = self.inbox.store.people('group')[0]['last']
        self.assertEqual((last['msgtype'], last['text']), ('m.image', 'look'))

    def test_edit_from_someone_else_is_ignored(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        with patch.object(self.inbox, 'mx', return_value={'event_id': '$n', 'sender': GHOST}) as mx:
            self.ingest(self.event('$e', {'msgtype': 'm.image', 'body': '* x', 'm.new_content': photo(),
                                          'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}, sender=OTHER))
        self.assertEqual(self.rows()['$n']['msgtype'], 'm.text')
        self.assertIn('/rooms/%21g/event/%24n', mx.call_args.args[0])  # settled by the original's mxid, not names

    def test_edit_after_ghost_rename_applies(self):
        # Stored as "Ana (WA)"; the bridge later renames the ghost to "Ana Lopez". The author is the same mxid.
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        self.meta['names'][GHOST] = 'Ana Lopez'
        with patch.object(self.inbox, 'mx', return_value={'event_id': '$n', 'sender': GHOST}) as mx:
            self.ingest(self.event('$e', {'msgtype': 'm.image', 'body': '* look', 'm.new_content': photo(body='look', filename='image.jpg'),
                                          'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}))
        self.assertEqual(mx.call_count, 1)
        self.assertEqual((self.rows()['$n']['msgtype'], self.rows()['$n']['original']), ('m.image', 'look'))
        # A text edit after a rename takes the same path.
        self.ingest(self.event('$t', {'msgtype': 'm.text', 'body': 'helo'}))
        self.meta['names'][GHOST] = 'Ana'
        with patch.object(self.inbox, 'mx', return_value={'event_id': '$t', 'sender': GHOST}):
            self.ingest(self.event('$te', {'msgtype': 'm.text', 'body': '* hello', 'm.new_content': {'msgtype': 'm.text', 'body': 'hello'},
                                           'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$t'}}))
        self.assertEqual((self.rows()['$t']['original'], self.rows()['$t']['edited']), ('hello', True))

    def test_edit_rejected_when_original_unreadable_or_other_author(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        self.meta['names'][GHOST] = 'Ana'
        with patch.object(self.inbox, 'mx', side_effect=unified.EngineError('matrix_unavailable', 'down', 502)):
            self.ingest(self.event('$e', {'msgtype': 'm.image', 'body': '* x', 'm.new_content': photo(),
                                          'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}))
        self.assertEqual(self.rows()['$n']['msgtype'], 'm.text')
        # Two members wearing the stored name: the original's mxid decides, and it is not this sender.
        self.meta['names'][GHOST] = self.meta['names'][OTHER] = 'Ana (WA)'
        with patch.object(self.inbox, 'mx', return_value={'event_id': '$n', 'sender': GHOST}):
            self.ingest(self.event('$e2', {'msgtype': 'm.image', 'body': '* x', 'm.new_content': photo(),
                                           'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}, sender=OTHER))
        self.assertEqual(self.rows()['$n']['msgtype'], 'm.text')

    def test_old_never_resent_row_reads_could_not_decrypt(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}, ts=1000))
        self.assertEqual((self.rows()['$n']['unavailable'], self.rows()['$n']['original']), ('undecryptable', ''))
        self.assertEqual(self.inbox.store.people('group')[0]['last']['unavailable'], 'undecryptable')
        self.assertEqual(unified.unavailable_label('undecryptable'), "🔒 Message couldn't be decrypted")
        row = {'original': WAITING, 'media': None, 'msgtype': 'm.text', 'kind': 'person', 'sender': 'Ana', 'timestamp': 1000}
        self.assertEqual(inbox_feed.preview(row), "🔒 Message couldn't be decrypted")
        row['timestamp'] = int(time.time() * 1000)
        self.assertEqual(inbox_feed.preview(row), '⏳ Waiting for this message')

    def test_gif_and_file_edits_and_caption_edit(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        gif = {'msgtype': 'm.video', 'body': 'video.mp4', 'url': 'mxc://messenger.internal/gif',
               'info': {'mimetype': 'video/mp4', 'fi.mau.gif': True, 'fi.mau.loop': True, 'fi.mau.autoplay': True, 'fi.mau.no_audio': True}}
        self.ingest(self.event('$e', {'msgtype': 'm.video', 'body': '* video.mp4', 'm.new_content': gif, 'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$n'}}))
        row = self.rows()['$n']
        self.assertEqual((row['msgtype'], row['media']['gif']), ('m.video', True))
        self.assertEqual(self.inbox.store.people('group')[0]['last'].get('gif'), True)
        # A later caption edit of the same media is a real edit and keeps the media.
        self.ingest(self.event('$p', photo(body='first', filename='image.jpg')))
        self.ingest(self.event('$c', {'msgtype': 'm.image', 'body': '* second', 'm.new_content': photo(body='second', filename='image.jpg'),
                                      'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$p'}}))
        row = self.rows()['$p']
        self.assertEqual((row['msgtype'], row['original'], row['edited']), ('m.image', 'second', True))
        # A text-only caption edit on a photo keeps the photo.
        self.ingest(self.event('$c2', {'msgtype': 'm.text', 'body': '* third', 'm.new_content': {'msgtype': 'm.text', 'body': 'third'},
                                       'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$p'}}))
        row = self.rows()['$p']
        self.assertEqual((row['msgtype'], row['original'], row['media']['mime']), ('m.image', 'third', 'image/jpeg'))

    def test_text_edits_still_work(self):
        self.ingest(self.event('$t', {'msgtype': 'm.text', 'body': 'helo'}))
        self.ingest(self.event('$e', {'msgtype': 'm.text', 'body': '* hello', 'm.new_content': {'msgtype': 'm.text', 'body': 'hello'},
                                      'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$t'}}))
        row = self.rows()['$t']
        self.assertEqual((row['original'], row['edited']), ('hello', True))

    def test_repair_applies_latest_edit_to_stuck_rows_once(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        chunk = {'chunk': [
            {'event_id': '$old', 'sender': GHOST, 'origin_server_ts': 2000, 'content': {'m.new_content': {'msgtype': 'm.text', 'body': 'Failed to bridge photo, please view it on the WhatsApp app'}}},
            {'event_id': '$new', 'sender': GHOST, 'origin_server_ts': 3000, 'content': {'m.new_content': photo(body='caption', filename='image.jpg')}},
        ]}
        with patch('unified.http', return_value=chunk) as http:
            self.inbox.repair_rows()
            self.inbox.repair_rows()
        self.assertEqual(http.call_count, 1)
        self.assertIn('/_matrix/client/v1/rooms/%21g/relations/%24n/m.replace', http.call_args.args[1])
        row = self.rows()['$n']
        self.assertEqual((row['msgtype'], row['original']), ('m.image', 'caption'))
        self.assertEqual(self.inbox.store.get('repair_waiting_v2'), '1')

    def test_repair_v2_applies_edits_after_ghost_rename_even_when_v1_ran(self):
        self.ingest(self.event('$n', {'msgtype': 'm.notice', 'body': WAITING}))
        self.inbox.store.put('repair_waiting_v1', '1')  # 16.16 ran its repair and dropped this row's edit
        self.meta['names'][GHOST] = 'Ana'
        chunk = {'chunk': [{'event_id': '$new', 'sender': GHOST, 'origin_server_ts': 3000, 'content': {'m.new_content': photo(body='', filename='image.jpg')}}]}
        with patch('unified.http', return_value=chunk), patch.object(self.inbox, 'mx', return_value={'event_id': '$n', 'sender': GHOST}), \
             patch.object(self.inbox, 'room_meta', return_value=self.meta):
            self.inbox.repair_rows()
        self.assertEqual(self.rows()['$n']['msgtype'], 'm.image')
        self.assertEqual(self.inbox.store.get('repair_waiting_v2'), '1')


class GifTests(Base):
    def test_gif_and_animated_sticker_flags(self):
        wa = {'msgtype': 'm.video', 'body': '', 'url': 'mxc://x/a', 'info': {'mimetype': 'video/mp4', 'fi.mau.gif': True, 'fi.mau.loop': True, 'fi.mau.no_audio': True}}
        self.assertTrue(message_parts({'type': 'm.room.message', 'content': wa})[2]['gif'])
        tg = {'msgtype': 'm.video', 'body': 'sticker.webm', 'url': 'mxc://x/b', 'info': {'mimetype': 'video/webm', 'thumbnail_url': 'mxc://x/t',
              'fi.mau.bridged_sticker': True, 'fi.mau.telegram.animated_sticker': True, 'fi.mau.gif': True}}
        media = message_parts({'type': 'm.room.message', 'content': tg})[2]
        self.assertTrue(media['sticker'])
        self.assertNotIn('gif', media)
        plain = {'msgtype': 'm.video', 'body': 'clip.mp4', 'url': 'mxc://x/c', 'info': {'mimetype': 'video/mp4', 'duration': 4000}}
        media = message_parts({'type': 'm.room.message', 'content': plain})[2]
        self.assertNotIn('gif', media)
        self.assertEqual(media['duration'], 4000)
        self.ingest(self.event('$g', wa), self.event('$s', tg))
        rows = self.rows()
        self.assertTrue(rows['$g']['media']['gif'])
        self.assertTrue(rows['$s']['media']['sticker'])
        self.assertEqual(unified.media_label('m.video', {'gif': True}), 'GIF')
        self.assertEqual(unified.media_label('m.video', {'sticker': True}), 'Sticker')
        self.assertEqual(unified.media_label('m.image', {'mime': 'image/gif'}), 'GIF')

    def test_static_gif_thumb_serves_the_animation(self):
        self.ingest(self.event('$i', {'msgtype': 'm.image', 'body': 'a.gif', 'url': 'mxc://messenger.internal/gif1', 'info': {'mimetype': 'image/gif', 'size': 5000}}))
        with patch.object(self.inbox, 'media_blob', return_value=('blob', 'image/gif')) as blob:
            self.inbox.media('$i', 'thumb')
        self.assertEqual(blob.call_args.kwargs.get('thumb', False), False)
        self.assertEqual(blob.call_args.kwargs.get('raw_thumb', False), False)
        self.ingest(self.event('$j', photo(url='mxc://messenger.internal/jpg')))
        with patch.object(self.inbox, 'media_blob', return_value=('blob', 'image/jpeg')) as blob:
            self.inbox.media('$j', 'thumb')
        self.assertTrue(blob.call_args.kwargs['thumb'])

    def test_reparse_backfills_gif_flag_and_mentions(self):
        old = {'msgtype': 'm.video', 'body': '', 'url': 'mxc://x/a', 'info': {'mimetype': 'video/mp4'}}
        self.ingest(self.event('$g', old))
        self.inbox.store.add_message('$m', self.g, 'Ana (WA)', False, 'hi +31 6 1234 5678 (WA) !!', 1500)
        events = {
            '$g': self.event('$g', dict(old, info={'mimetype': 'video/mp4', 'fi.mau.gif': True})),
            '$m': self.event('$m', {'msgtype': 'm.text', 'body': 'hi +31 6 1234 5678 (WA) !!', 'format': 'org.matrix.custom.html',
                                    'formatted_body': 'hi <a href="https://matrix.to/#/%s">+31 6 1234 5678 (WA)</a> !!' % OTHER,
                                    'm.mentions': {'user_ids': [OTHER]}}, ts=1500),
        }
        self.inbox.mx = Mock(side_effect=lambda path, *a, **k: events[unified.unquote(path.rsplit('/', 1)[1])])
        self.inbox.repair_rows()
        rows = self.rows()
        self.assertTrue(rows['$g']['media']['gif'])
        self.assertEqual(rows['$m']['original'], 'hi @+31 6 1234 5678 !!')
        self.assertNotIn('(WA)', rows['$m']['original'])
        self.assertEqual(self.inbox.store.get('repair_reparse_v1'), '1')


class MentionTests(Base):
    def html(self, body, formatted, users):
        return {'msgtype': 'm.text', 'body': body, 'format': 'org.matrix.custom.html', 'formatted_body': formatted, 'm.mentions': {'user_ids': users}}

    def test_whatsapp_pill_becomes_best_known_name(self):
        # A one-to-one chat with that person is named, so their mention shows that name instead of the number.
        dm = self.inbox.store.identity('whatsapp', '!dm', 'Bram')
        with self.inbox.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', ('!dm', json.dumps({'network': 'whatsapp', 'kind': 'person', 'label': 'Bram', 'names': {OTHER: '+31 6 1234 5678 (WA)'}})))
        self.assertTrue(dm)
        self.ingest(self.event('$m', self.html('welcome +31 6 1234 5678 (WA) and Ana (WA)!!',
                                               'welcome <a href="https://matrix.to/#/%s">+31 6 1234 5678 (WA)</a> and <a href="https://matrix.to/#/%s">Ana (WA)</a>!!' % (OTHER, GHOST),
                                               [OTHER, GHOST])))
        row = self.rows()['$m']
        self.assertEqual(row['original'], 'welcome @Bram and @Ana!!')
        self.assertEqual([m['text'] for m in row['mentions']], ['@Bram', '@Ana'])
        self.assertEqual({k: row['mentions'][0][k] for k in ('text', 'net', 'acc')}, {'text': '@Bram', 'net': 'whatsapp', 'acc': '316123'})
        self.assertEqual(row['mentions'][0]['id'], OTHER)
        self.assertIsNone(row['media'])  # mentions never make a text line look like an attachment

    def test_owner_mention_is_marked_and_uses_his_name(self):
        self.inbox.store.remember_own_names('whatsapp', ['Miguel Ortiz', '+34600000000'])
        self.ingest(self.event('$m', self.html('hey Miguel (WA) look', 'hey <a href="https://matrix.to/#/%40owner%3Amessenger.internal">Miguel (WA)</a> look',
                                               ['@owner:messenger.internal'])))
        row = self.rows()['$m']
        self.assertEqual(row['original'], 'hey @Miguel Ortiz look')
        self.assertEqual([{k: m[k] for k in ('text', 'me')} for m in row['mentions']], [{'text': '@Miguel Ortiz', 'me': True}])
        self.assertEqual(row['mentions'][0]['id'], '@owner:messenger.internal')

    def test_telegram_username_pill_keeps_username(self):
        t = self.inbox.store.identity('telegram', '!t', 'Devs', 'group')
        meta = {'network': 'telegram', 'kind': 'group', 'names': {'@telegram_9:messenger.internal': 'Zoe'}}
        self.inbox.ingest(t, meta, self.event('$t', self.html('ping @zoe_dev now', 'ping <a href="https://matrix.to/#/@telegram_9:messenger.internal">@zoe_dev</a> now',
                                                             ['@telegram_9:messenger.internal']), sender='@telegram_8:messenger.internal'))
        row = {m['id']: m for m in self.inbox.store.messages(t['person_id'])}['$t']
        self.assertEqual(row['original'], 'ping @zoe_dev now')
        self.assertEqual(row['mentions'][0]['text'], '@zoe_dev')

    def test_mentions_without_pills_and_bad_html_are_safe(self):
        self.ingest(self.event('$a', {'msgtype': 'm.text', 'body': 'Ana (WA) hi', 'm.mentions': {'user_ids': [GHOST]}}))
        self.assertEqual(self.rows()['$a']['original'], '@Ana hi')
        self.ingest(self.event('$b', {'msgtype': 'm.text', 'body': 'plain', 'formatted_body': '<a href="https://matrix.to/#/!room:x">room</a>'}))
        self.assertEqual(self.rows()['$b']['mentions'], [])
        self.assertEqual(mention_pills({'formatted_body': 5}), [])
        self.assertEqual(substitute_mentions('abc', [('@u:x', 'zzz')], lambda u, t: ('N', {})), ('abc', []))

    def test_edit_recomputes_mentions(self):
        self.ingest(self.event('$m', {'msgtype': 'm.text', 'body': 'hi'}))
        new = self.html('hi Ana (WA)', 'hi <a href="https://matrix.to/#/%s">Ana (WA)</a>' % GHOST, [GHOST])
        self.ingest(self.event('$e', {'msgtype': 'm.text', 'body': '* hi', 'm.new_content': new, 'm.relates_to': {'rel_type': 'm.replace', 'event_id': '$m'}}))
        row = self.rows()['$m']
        self.assertEqual((row['original'], row['mentions'][0]['text']), ('hi @Ana', '@Ana'))


class LinePhotoTests(Base):
    """LINE's bridge sends a photo as a bare m.image (url and body "image.jpg", no info block, so no mimetype).
    The picture route used to answer 404 "No preview" for it, so every LINE photo read "Photo unavailable"."""
    JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 60
    LINE = 'mxc://messenger.internal/linephoto1'

    def setUp(self):
        super().setUp()
        self.l = self.inbox.store.identity('line', '!l', 'Ann', 'person')
        self.lmeta = {'network': 'line', 'kind': 'person', 'label': 'Ann', 'names': {}}
        self.inbox.rooms['!l'] = self.lmeta
        self.inbox.ingest(self.l, self.lmeta, self.event('$p', {'msgtype': 'm.image', 'body': 'image.jpg', 'url': self.LINE}, sender='@line_u1:messenger.internal'))

    def test_line_photo_row_is_a_picture_with_a_thumbnail(self):
        row = {m['id']: m for m in self.inbox.store.messages(self.l['person_id'])}['$p']
        self.assertEqual(row['msgtype'], 'm.image')
        self.assertTrue(row['media']['thumb'])
        self.assertNotIn('mxc', row['media'])

    def test_line_photo_thumbnail_and_full_routes_serve(self):
        with patch.object(self.inbox, 'media_blob', return_value=('blob', 'image/jpeg')) as blob:
            self.assertEqual(self.inbox.media('$p', 'thumb'), ('blob', 'image/jpeg'))
            self.inbox.media('$p', None)
        self.assertEqual(blob.call_args_list[0].args[0], self.LINE)
        self.assertTrue(blob.call_args_list[0].kwargs['thumb'])

    def test_line_photo_bytes_come_through_the_media_proxy(self):
        class Reply:
            headers = {'Content-Type': 'image/jpeg'}
            def __init__(self): self.data = JPEG
            def read(self, n): data, self.data = self.data[:n], self.data[n:]; return data
            def __enter__(self): return self
            def __exit__(self, *a): return False
        JPEG = self.JPEG
        self.inbox.matrix = 'http://matrix:8008'
        with patch.object(unified, 'urlopen', return_value=Reply()) as fetch:
            blob = self.inbox.media('$p', 'thumb')
        self.assertIn('/_matrix/client/v1/media/thumbnail/messenger.internal/linephoto1', fetch.call_args.args[0].full_url)
        self.assertEqual((blob.mime, blob.path.read_bytes()), ('image/jpeg', self.JPEG))

    def test_files_and_voice_without_a_mimetype_are_still_not_pictures(self):
        self.assertFalse(unified.is_picture('m.file', {}))
        self.assertFalse(unified.is_picture('m.audio', {}))
        self.assertFalse(unified.is_picture('m.image', {'mime': 'application/pdf'}))
        self.assertTrue(unified.is_picture('m.image', {}))
        self.assertTrue(unified.is_picture('m.file', {'mime': 'image/png'}))


class UnavailableMediaTests(Base):
    def test_expired_whatsapp_media_is_a_placeholder_everywhere(self):
        self.assertEqual(unavailable_media('Failed to bridge photo, please view it on the WhatsApp app'), ('photo', ''))
        self.assertEqual(unavailable_media('Failed to bridge voice message, please view it on the WhatsApp app'), ('voice', ''))
        self.assertEqual(unavailable_media('Failed to bridge video attachment, please view it on the WhatsApp app\n\nso funny'), ('video', 'so funny'))
        self.assertEqual(unavailable_media('Failed to bridge media after re-requesting it from your phone: media no longer available on phone\n\n'), ('media', ''))
        self.assertIsNone(unavailable_media('Failed to bridge the gap, he said'))
        self.assertIsNone(unavailable_media('hello'))
        self.ingest(self.event('$x', {'msgtype': 'm.notice', 'body': 'Failed to bridge sticker, please view it on the WhatsApp app', 'fi.mau.whatsapp.failed_media': {}}))
        self.ingest(self.event('$y', {'msgtype': 'm.notice', 'body': 'Failed to bridge photo, please view it on the WhatsApp app\n\nour trip'}, ts=2000))
        rows = self.rows()
        self.assertEqual((rows['$x']['unavailable'], rows['$x']['original']), ('sticker', ''))
        self.assertEqual((rows['$y']['unavailable'], rows['$y']['original']), ('photo', 'our trip'))
        last = self.inbox.store.people('group')[0]['last']
        self.assertEqual((last['unavailable'], last['text']), ('photo', 'our trip'))
        with self.inbox.store.db() as db:
            row = db.execute("SELECT 'group' AS kind, original, msgtype, media, sender FROM message WHERE id='$y'").fetchone()
        self.assertEqual(inbox_feed.preview(row), 'Ana (WA): 📷 Photo not available · our trip')
        # Reply quotes use the same words.
        self.ingest(self.event('$r', {'msgtype': 'm.text', 'body': 'nice', 'm.relates_to': {'m.in_reply_to': {'event_id': '$y'}}}, ts=3000))
        self.assertEqual(self.rows()['$r']['reply']['text'], '📷 Photo not available · our trip')


class StatusBroadcastTests(Base):
    """WhatsApp status posts land in the Status Broadcast chat as the bridge's decrypt notice: the bridge almost
    never receives them, so they read as a status update to view on the phone, never "still sending"."""
    def setUp(self):
        super().setUp()
        self.s = self.inbox.store.identity('whatsapp', '!s', 'WhatsApp Status Broadcast', 'group')
        self.smeta = {'network': 'whatsapp', 'kind': 'group', 'label': 'WhatsApp Status Broadcast', 'channel_id': 'status@broadcast',
                      'names': {GHOST: 'Eric'}}
        self.inbox.rooms['!s'] = self.smeta
        with self.inbox.store.db() as db:
            db.execute('INSERT INTO room_meta VALUES (?,?)', ('!s', json.dumps(self.smeta)))

    def test_mapping(self):
        now = int(time.time() * 1000)
        self.assertEqual(unavailable_media(WAITING, now, status=True), ('status', ''))
        self.assertEqual(unavailable_media(WAITING, 1000, status=True), ('status', ''))
        self.assertEqual(unavailable_media(WAITING, now), ('waiting', ''))
        self.assertEqual(unavailable_media(WAITING, 1000), ('undecryptable', ''))
        # Media in the status chat keeps its "not available" wording.
        self.assertEqual(unavailable_media('Failed to bridge photo, please view it on the WhatsApp app', now, status=True), ('photo', ''))
        self.assertEqual(unified.unavailable_label('status'), '🟢 Status update')

    def test_status_chat_is_recognised_by_portal_id_then_title(self):
        is_status = unified.is_status_chat
        self.assertTrue(is_status('whatsapp', {'channel_id': 'status@broadcast', 'label': 'Renamed'}))
        self.assertFalse(is_status('whatsapp', {'channel_id': '123@s.whatsapp.net', 'label': 'WhatsApp Status Broadcast'}))
        self.assertTrue(is_status('whatsapp', {'label': 'WhatsApp Status Broadcast'}))  # older cached meta: title fallback
        self.assertTrue(is_status('whatsapp', None, 'WhatsApp Status Broadcast'))
        self.assertFalse(is_status('telegram', {'label': 'WhatsApp Status Broadcast'}))
        self.assertFalse(is_status('whatsapp', {'label': 'Family'}))

    def test_status_placeholder_everywhere_and_other_chats_unchanged(self):
        now = int(time.time() * 1000)
        self.inbox.ingest(self.s, self.smeta, self.event('$st', {'msgtype': 'm.notice', 'body': WAITING}, ts=now))
        self.inbox.ingest(self.s, self.smeta, self.event('$old', {'msgtype': 'm.notice', 'body': WAITING}, ts=1000))
        self.ingest(self.event('$w', {'msgtype': 'm.notice', 'body': WAITING}, ts=now))
        rows = {m['id']: m for m in self.inbox.store.messages(self.s['person_id'])}
        self.assertEqual((rows['$st']['unavailable'], rows['$st']['original']), ('status', ''))
        self.assertEqual(rows['$old']['unavailable'], 'status')
        self.assertEqual(self.rows()['$w']['unavailable'], 'waiting')
        people = {p['id']: p for p in self.inbox.store.people('group')}
        self.assertEqual(people[self.s['person_id']]['last']['unavailable'], 'status')
        self.assertEqual(people[self.g['person_id']]['last']['unavailable'], 'waiting')
        feed = {i['key']: i['text'] for i in inbox_feed.items(self.inbox.store)['items']}
        self.assertTrue(feed['chat:' + self.s['person_id']].endswith('Eric: 🟢 Status update'), feed)
        self.assertTrue(feed['chat:' + self.g['person_id']].endswith('⏳ Waiting for this message'), feed)
        import agent_tools
        handler = Mock(); handler.service.unified = self.inbox
        thread = agent_tools.read_thread(handler, None, {'chat_id': self.s['person_id']})
        self.assertEqual({m['id']: m.get('unavailable_media') for m in thread['messages']}, {'$st': 'status', '$old': 'status'})
        thread = agent_tools.read_thread(handler, None, {'chat_id': self.g['person_id']})
        self.assertEqual([m.get('unavailable_media') for m in thread['messages']], ['waiting'])

    def test_title_fallback_without_portal_id(self):
        with self.inbox.store.db() as db:
            db.execute('DELETE FROM room_meta WHERE room=?', ('!s',))
        self.inbox.ingest(self.s, self.smeta, self.event('$st', {'msgtype': 'm.notice', 'body': WAITING}, ts=int(time.time() * 1000)))
        rows = {m['id']: m for m in self.inbox.store.messages(self.s['person_id'])}
        self.assertEqual(rows['$st']['unavailable'], 'status')


if __name__ == '__main__':
    unittest.main()
