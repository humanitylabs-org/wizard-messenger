"""Sending videos (issue 402).

A video picked with + -> "Photo or video" used to go out as a paperclip file on every network: the box only took
image / voice / file uploads and sent `m.file`. Now a video upload is its own kind and the send is one `m.video` with
mimetype, size, w, h, duration and the first frame the phone drew as `thumbnail_url` / `thumbnail_info`; the stored row
is an `m.video` that the existing video bubble draws and plays. LINE refuses words on a video, so they follow as their
own text. Wizard chats store a video as `m.video` too. "File" still sends a video as a file.
"""
import hashlib
import json
import struct
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock

import test_connector_sender
from engine import EngineError
from unified import UnifiedInbox

JPEG = b'\xff\xd8\xff\xe0' + b'\0' * 64


def box(kind, payload):
    return struct.pack('>I', 8 + len(payload)) + kind + payload


MP4 = box(b'ftyp', b'isom\0\0\x02\0isomiso2avc1mp41') + box(b'mdat', b'\0' * 128)
MOV = box(b'ftyp', b'qt  \0\0\x02\0qt  ') + box(b'mdat', b'\0' * 64)
WEBM = b'\x1a\x45\xdf\xa3' + b'\0' * 64


class VideoSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.addCleanup(self.inbox.stop.set)
        self.inbox.owner = '@owner:test'
        self.puts, self.uploaded = [], []

        def mx(path, method='GET', content=None, timeout=15):
            self.puts.append((path.rsplit('/', 1)[1], content))
            return {'event_id': '$e%d' % len(self.puts)}

        def matrix_upload(data, filename, mime):
            self.uploaded.append((filename, mime, len(data)))
            return {'content_uri': 'mxc://test/u%d' % len(self.uploaded)}
        self.inbox.mx = Mock(side_effect=mx)
        self.inbox.matrix_upload = matrix_upload

    def person(self, network):
        return self.inbox.store.identity(network, '!' + network, network.title() + ' friend')['person_id']

    def send_video(self, pid, text='', client_id='video_send_1', data=MP4, name='1000191908.mp4'):
        video = self.inbox.upload(pid, 'video', data, name)
        thumb = self.inbox.upload(pid, 'image', JPEG)
        out = self.inbox.send(pid, {'client_id': client_id, 'text': text, 'upload_id': video['upload_id'], 'thumb_upload_id': thumb['upload_id'],
                                    'media': {'w': 720, 'h': 1280, 'duration': 4200, 'thumb_w': 450, 'thumb_h': 800}})
        return video, thumb, out

    def test_a_video_goes_as_a_video_with_its_first_frame_on_every_bridged_network(self):
        for network in ('telegram', 'whatsapp', 'signal', 'instagram', 'line'):
            with self.subTest(network=network):
                self.puts.clear(); self.uploaded.clear()
                pid = self.person(network)
                video, thumb, out = self.send_video(pid, client_id='video_' + network)
                self.assertEqual(video['mime'], 'video/mp4')
                self.assertEqual([u[:2] for u in self.uploaded], [('video.mp4', 'video/mp4'), ('photo.jpg', 'image/jpeg')],
                                 'fixed upload names: the owner\'s file name stays out of the upload URL')
                (txn, content), = self.puts
                self.assertEqual(txn, 'video_' + network)
                self.assertEqual(content['msgtype'], 'm.video')
                self.assertEqual((content['body'], content['filename']), ('1000191908.mp4', '1000191908.mp4'))
                self.assertEqual(content['info'], {'mimetype': 'video/mp4', 'size': len(MP4), 'w': 720, 'h': 1280, 'duration': 4200,
                                                   'thumbnail_url': 'mxc://test/u2', 'thumbnail_info': {'mimetype': 'image/jpeg', 'size': len(JPEG), 'w': 450, 'h': 800}})
                row = out['message']
                self.assertEqual(row['msgtype'], 'm.video')
                self.assertEqual({k: row['media'][k] for k in ('mime', 'w', 'h', 'duration', 'thumb')},
                                 {'mime': 'video/mp4', 'w': 720, 'h': 1280, 'duration': 4200, 'thumb': True})
                # The bubble's thumbnail route serves the frame the phone drew, not the video.
                stored = self.inbox.store.message(row['id'])
                self.assertEqual(json.loads(stored['media'])['thumb'] if isinstance(stored['media'], str) else stored['media']['thumb'], 'mxc://test/u2')
                self.assertNotIn(video['upload_id'], self.inbox.uploads)
                self.assertNotIn(thumb['upload_id'], self.inbox.uploads, 'the thumbnail upload is let go with the send')

    def test_words_ride_on_the_video_except_on_line(self):
        pid = self.person('telegram')
        self.send_video(pid, text='From the beach')
        (_, content), = self.puts
        self.assertEqual((content['msgtype'], content['body']), ('m.video', 'From the beach'))
        self.puts.clear()
        line = self.person('line')
        _, _, out = self.send_video(line, text='From the beach', client_id='line_video_1')
        self.assertEqual([t for t, _ in self.puts], ['line_video_1', 'line_video_1.caption'])
        self.assertEqual(self.puts[0][1]['body'], '1000191908.mp4', 'no words on a LINE video')
        self.assertEqual(self.puts[1][1], {'msgtype': 'm.text', 'body': 'From the beach'})
        self.assertEqual([r['msgtype'] for r in out['messages']], ['m.video', 'm.text'])

    def test_a_retried_send_never_sends_twice(self):
        pid = self.person('signal')
        _, _, first = self.send_video(pid)
        again = self.inbox.send(pid, {'client_id': 'video_send_1', 'upload_id': 'gone'})
        self.assertEqual(again['event_id'], first['event_id'])
        self.assertEqual(len(self.puts), 1)

    def test_without_a_frame_it_is_still_a_video(self):
        pid = self.person('whatsapp')
        video = self.inbox.upload(pid, 'video', MP4, 'clip.mp4')
        out = self.inbox.send(pid, {'client_id': 'video_nothumb', 'upload_id': video['upload_id'], 'thumb_upload_id': 'not-an-upload', 'media': {'duration': 1000}})
        (_, content), = self.puts
        self.assertEqual(content['msgtype'], 'm.video')
        self.assertNotIn('thumbnail_url', content['info'])
        self.assertEqual(out['message']['msgtype'], 'm.video')

    def test_another_chats_upload_is_never_used_as_the_frame(self):
        pid, other = self.person('telegram'), self.person('signal')
        video = self.inbox.upload(pid, 'video', MP4, 'clip.mp4')
        foreign = self.inbox.upload(other, 'image', JPEG)
        self.inbox.send(pid, {'client_id': 'video_foreign', 'upload_id': video['upload_id'], 'thumb_upload_id': foreign['upload_id']})
        self.assertNotIn('thumbnail_url', self.puts[0][1]['info'])

    def test_video_types(self):
        pid = self.person('telegram')
        self.assertEqual(self.inbox.upload(pid, 'video', MOV, 'IMG_0001.MOV')['mime'], 'video/quicktime')
        self.assertEqual(self.inbox.upload(pid, 'video', WEBM, 'screen.webm')['mime'], 'video/webm')
        self.assertEqual([u[:2] for u in self.uploaded], [('video.mov', 'video/quicktime'), ('video.webm', 'video/webm')])
        named = [u['filename'] for u in self.inbox.uploads.values()]
        self.assertEqual(named, ['IMG_0001.mov', 'screen.webm'])
        for data in (JPEG, b'%PDF-1.7 x', b'plain'):
            with self.assertRaises(EngineError) as err:
                self.inbox.upload(pid, 'video', data, 'x.mp4')
            self.assertEqual(err.exception.status, 415)

    def test_too_big_says_videos(self):
        pid = self.person('telegram')
        with self.assertRaises(EngineError) as err:
            self.inbox.upload(pid, 'video', MP4 + b'\0' * (25 * 1024 * 1024), 'big.mp4')
        self.assertEqual((err.exception.status, str(err.exception.message) if hasattr(err.exception, 'message') else str(err.exception)),
                         (413, 'Videos up to 25 MB can be sent'))

    def test_file_still_sends_a_video_as_a_file(self):
        pid = self.person('telegram')
        up = self.inbox.upload(pid, 'file', MP4, 'clip.mp4')
        out = self.inbox.send(pid, {'client_id': 'video_as_file', 'upload_id': up['upload_id']})
        self.assertEqual(self.puts[0][1]['msgtype'], 'm.file')
        self.assertEqual(out['message']['msgtype'], 'm.file')

    def test_wizard_chat_video_is_a_video_both_ways(self):
        group = 'ab' * 16
        pid = self.inbox.store.identity('messenger', group, 'Ana')['person_id']
        sent = []

        def send_media(g, payload):
            sent.append([Path(p).name for p in payload['paths']])
            return {'message_ids': ['c' * 64], 'published': 1,
                    'attachments': [{'sha256': hashlib.sha256(Path(p).read_bytes()).hexdigest()} for p in payload['paths']]}
        self.engine.send_media.side_effect = send_media
        video = self.inbox.upload(pid, 'video', MP4, 'clip.mp4')
        thumb = self.inbox.upload(pid, 'image', JPEG)
        out = self.inbox.send(pid, {'client_id': 'wizard_video', 'upload_id': video['upload_id'], 'thumb_upload_id': thumb['upload_id'],
                                    'media': {'w': 720, 'h': 1280, 'duration': 4200}})
        self.assertEqual(sent, [['clip.mp4']], 'the video file goes, not the frame')
        self.assertEqual(out['message']['msgtype'], 'm.video')
        self.assertEqual({k: out['message']['media'].get(k) for k in ('mime', 'w', 'h', 'duration')}, {'mime': 'video/mp4', 'w': 720, 'h': 1280, 'duration': 4200})
        self.assertFalse(list((Path(self.tmp.name) / 'unified' / 'marmot-outbox').iterdir()), 'both private copies are let go')
        # A video received in a Wizard chat is a video too; a file stays a file.
        identity = self.inbox.store.identity('messenger', group, 'Ana')
        self.inbox.store_marmot('d' * 64, identity, 'ana', False, '', int(time.time() * 1000), [{'sha256': 'e' * 64, 'mime': 'video/mp4', 'filename': 'v.mp4'}])
        self.inbox.store_marmot('f' * 64, identity, 'ana', False, '', int(time.time() * 1000), [{'sha256': '1' * 64, 'mime': 'video/mp4', 'filename': 'v.mp4', 'video': False}])
        self.assertEqual(self.inbox.store.message('messenger:' + 'd' * 64)['msgtype'], 'm.video')
        self.assertEqual(self.inbox.store.message('messenger:' + 'f' * 64)['msgtype'], 'm.file')


class SenderAllowsVideoUploads(test_connector_sender.SenderTests):
    """The real owner sender on a loopback homeserver: a video goes up only with a fixed video name and a video type."""
    def test_video_upload_names_and_types(self):
        for name, mime in (('video.mp4', 'video/mp4'), ('video.mov', 'video/quicktime'), ('video.webm', 'video/webm')):
            with self.subTest(name=name):
                self.assertEqual(self.invoke('/_matrix/media/v3/upload?filename=' + name, body=b'data', content_type=mime)['bytes'], 4)
        for name, mime in (('clip.mp4', 'video/mp4'), ('video.mp4', 'application/pdf'), ('video.mp4', 'text/html')):
            with self.subTest(name=name, mime=mime), self.assertRaises(EngineError):
                self.invoke('/_matrix/media/v3/upload?filename=' + name, body=b'data', content_type=mime)
        self.assertEqual(len(self.calls), 3)


if __name__ == '__main__':
    unittest.main()
