"""Photos and files in private Wizard-to-Wizard (Marmot) chats: engine adapter + unified inbox.

The engine side is exercised against a fake wnd RPC that answers with the JSON shapes recorded from the
pinned wn 0.12.0 (122bd90) two-account staging run: `media upload --send` and the timeline `media.imeta`.
"""
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from engine import EngineError, MarmotEngine, timeline_attachments
from unified import UnifiedInbox

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 64
GROUP = 'ab' * 16
MID = 'c' * 64


def imeta(data, name, mime):
    return ['imeta', 'v encrypted-media-v2', 'locator blossom-v1 https://cdn.example/' + 'd' * 64 + '.bin',
            'ciphertext_sha256 ' + 'd' * 64, 'plaintext_sha256 ' + hashlib.sha256(data).hexdigest(), 'nonce 00', 'm ' + mime, 'filename ' + name]


class AttachmentParsing(unittest.TestCase):
    def test_imeta_display_fields_only(self):
        rows = timeline_attachments({'media': {'imeta': [imeta(PNG, 'photo.png', 'image/png'), ['imeta', 'plaintext_sha256 nothex'], 'junk',
                                                         imeta(b'x', 'notes.txt', 'Text/Plain; x')]}})
        self.assertEqual([r['filename'] for r in rows], ['photo.png', 'notes.txt'])
        self.assertEqual(rows[0], {'sha256': hashlib.sha256(PNG).hexdigest(), 'mime': 'image/png', 'filename': 'photo.png'})
        self.assertEqual(rows[1]['mime'], 'application/octet-stream')  # malformed type never passes through
        self.assertNotIn('locator', json.dumps(rows))

    def test_deleted_message_has_no_attachments(self):
        from engine import timeline_row
        m = {'message_id': MID, 'group_id': GROUP, 'from': 'a', 'direction': 'received', 'deleted': True, 'media': {'imeta': [imeta(PNG, 'p.png', 'image/png')]}}
        self.assertEqual(timeline_row(m, 'b')['attachments'], [])


class EngineSendMedia(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with patch.dict('os.environ', {'XDG_RUNTIME_DIR': self.tmp.name + '/run'}):
            self.engine = MarmotEngine(self.tmp.name)
        self.engine._require_ready = lambda: None
        self.engine._dm_members = lambda g: []
        self.file = Path(self.tmp.name) / 'photo.png'
        self.file.write_bytes(PNG)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def rpc(self, reply):
        def fake(request, timeout=90):
            self.calls.append((request, timeout))
            return json.dumps(reply() if callable(reply) else reply)
        self.engine._rpc = fake

    def ok(self):
        return {'ok': True, 'result': {'attachments': [{'media': {'plaintext_sha256': hashlib.sha256(PNG).hexdigest(), 'media_type': 'image/png', 'file_name': 'photo.png'}}],
                                       'sent': {'message_ids': [MID], 'published': 1}}}

    def test_one_upload_command_with_send_and_default_server(self):
        self.rpc(self.ok())
        out = self.engine.send_media(GROUP, {'paths': [str(self.file)], 'text': 'look', 'request_id': 'r' * 20})
        (request, timeout), = self.calls
        upload = request['Execute']['cli']['command']['Media']['command']['Upload']
        self.assertEqual(upload, {'group': GROUP, 'file_paths': [str(self.file)], 'send': True, 'message': 'look', 'media_type': None, 'server': None})
        self.assertGreaterEqual(timeout, 300)
        self.assertEqual(out['message_ids'], [MID])
        self.assertEqual(out['attachments'][0]['filename'], 'photo.png')
        # Idempotent replay: no second upload or publish.
        self.assertTrue(self.engine.send_media(GROUP, {'paths': [str(self.file)], 'text': 'look', 'request_id': 'r' * 20})['replayed'])
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(EngineError) as err:
            self.engine.send_media(GROUP, {'paths': [str(self.file)], 'text': 'other', 'request_id': 'r' * 20})
        self.assertEqual(err.exception.code, 'request_id_conflict')

    def test_blob_failure_releases_intent_but_ambiguous_failure_does_not(self):
        self.rpc({'ok': False, 'error': {'code': 'command_failed', 'message': 'blob store request failed: HTTP 503'}})
        with self.assertRaises(EngineError) as err:
            self.engine.send_media(GROUP, {'paths': [str(self.file)], 'request_id': 'b' * 20})
        self.assertEqual(err.exception.code, 'media_upload_failed')
        self.rpc(self.ok())
        self.assertEqual(self.engine.send_media(GROUP, {'paths': [str(self.file)], 'request_id': 'b' * 20})['message_ids'], [MID])
        self.rpc({'ok': False, 'error': {'code': 'publish_failed', 'message': 'relay'}})
        with self.assertRaises(EngineError):
            self.engine.send_media(GROUP, {'paths': [str(self.file)], 'request_id': 'p' * 20})
        with self.assertRaises(EngineError) as err:
            self.engine.send_media(GROUP, {'paths': [str(self.file)], 'request_id': 'p' * 20})
        self.assertEqual(err.exception.code, 'send_outcome_unknown')

    def test_rejects_missing_paths_and_bad_hash(self):
        for paths in ([], [self.tmp.name + '/missing'], ['x'] * 11, 'x'):
            with self.assertRaises(EngineError):
                self.engine.send_media(GROUP, {'paths': paths, 'request_id': 'q' * 20})
        with self.assertRaises(EngineError) as err:
            self.engine.media_download(GROUP, '../etc', '/tmp/x')
        self.assertEqual(err.exception.status, 404)

    def test_status_advertises_attachments(self):
        status = self.engine.status()
        self.assertIn('attachments', status['capabilities'])
        self.assertNotIn('attachments', status['unsupported'])


class InboxWizardMedia(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.peer = self.inbox.store.identity('messenger', GROUP, 'Ana')
        self.pid = self.peer['person_id']
        self.sent = []

        def send_media(group, payload):
            self.sent.append((group, payload, [Path(p).read_bytes() for p in payload['paths']], [Path(p).name for p in payload['paths']]))
            return {'message_ids': [MID], 'published': 1, 'attachments': [
                {'sha256': hashlib.sha256(Path(p).read_bytes()).hexdigest(), 'mime': 'image/png', 'filename': Path(p).name} for p in payload['paths']]}
        self.engine.send_media.side_effect = send_media

    def tearDown(self):
        self.inbox.stop.set()
        self.tmp.cleanup()

    def test_photo_send_keeps_private_copy_until_sent_and_never_touches_synapse(self):
        with patch.object(self.inbox, 'matrix_upload') as synapse:
            up = self.inbox.upload(self.pid, 'image', PNG)
        synapse.assert_not_called()
        path = Path(self.inbox.uploads[up['upload_id']]['path'])
        self.assertEqual(path.read_bytes(), PNG)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        out = self.inbox.send(self.pid, {'upload_id': up['upload_id'], 'client_id': 'wizphoto-1234', 'text': 'hello', 'media': {'w': 64, 'h': 48}})
        group, payload, data, names = self.sent[0]
        self.assertEqual((group, payload['text'], data, names), (GROUP, 'hello', [PNG], ['photo.png']))
        self.assertEqual(out['event_id'], 'messenger:' + MID)
        self.assertEqual(out['message']['msgtype'], 'm.image')
        self.assertEqual(out['message']['original'], 'hello')
        self.assertEqual({k: out['message']['media'][k] for k in ('mime', 'w', 'h', 'thumb')}, {'mime': 'image/png', 'w': 64, 'h': 48, 'thumb': True})
        self.assertNotIn('marmot', out['message']['media'])  # group/hash stay server-side
        self.assertFalse(path.exists())
        self.assertNotIn(up['upload_id'], self.inbox.uploads)
        # The same tap again (retry) returns the stored row, no second send.
        self.assertEqual(self.inbox.send(self.pid, {'upload_id': up['upload_id'], 'client_id': 'wizphoto-1234'})['event_id'], out['event_id'])
        self.assertEqual(len(self.sent), 1)

    def test_file_and_album(self):
        up = self.inbox.upload(self.pid, 'file', b'%PDF-1.7\nx', 'Q3 report.pdf')
        out = self.inbox.send(self.pid, {'upload_id': up['upload_id'], 'client_id': 'wizfile-12345'})
        self.assertEqual(self.sent[-1][3], ['Q3 report.pdf'])
        self.assertEqual((out['message']['msgtype'], out['message']['media']['filename']), ('m.file', 'Q3 report.pdf'))
        ups = [self.inbox.upload(self.pid, 'image', PNG)['upload_id'] for _ in range(3)]
        out = self.inbox.send(self.pid, {'upload_ids': ups, 'client_id': 'wizalbum-12345', 'text': 'trip'})
        self.assertEqual(len(self.sent[-1][1]['paths']), 3)  # one kind-9 message carrying three imeta tags
        self.assertEqual([m['id'] for m in out['messages']], ['messenger:' + MID] + ['messenger:%s#photo:%02d' % (MID, i) for i in (1, 2)])
        self.assertEqual({m['album'] for m in out['messages']}, {'marmot:' + MID})

    def test_received_media_mirrors_and_downloads_through_engine(self):
        self.engine.status.return_value = {'state': 'ready'}
        self.engine.messages.return_value = {'messages': [
            {'message_id': MID, 'author': 'peer', 'direction': 'received', 'text': 'from ana', 'created_at': 1793376700,
             'attachments': [{'sha256': hashlib.sha256(PNG).hexdigest(), 'mime': 'image/png', 'filename': 'photo.png'}]},
            {'message_id': 'e' * 64, 'author': 'peer', 'direction': 'received', 'text': '', 'created_at': 1793376701,
             'attachments': [{'sha256': hashlib.sha256(b'<html>').hexdigest(), 'mime': 'image/png', 'filename': 'evil.png'}]}]}
        self.inbox.import_marmot(self.peer)
        rows = {m['id']: m for m in self.inbox.timeline(self.pid)['messages']}
        self.assertEqual(rows['messenger:' + MID]['msgtype'], 'm.image')
        self.assertEqual(rows['messenger:' + MID]['original'], 'from ana')

        def download(group, digest, output):
            data = PNG if digest == hashlib.sha256(PNG).hexdigest() else b'<html>'
            Path(output).write_bytes(data)
            return {'size': len(data)}
        self.engine.media_download.side_effect = download
        blob = self.inbox.media('messenger:' + MID, 'thumb')
        self.assertEqual((blob.mime, blob.inline, blob.path.read_bytes()), ('image/png', True, PNG))
        self.inbox.media('messenger:' + MID, 'full')
        self.assertEqual(self.engine.media_download.call_count, 1)  # private cache
        # Declared image/png but the bytes are HTML: served as a download, never inline.
        blob = self.inbox.media('messenger:' + 'e' * 64, 'full')
        self.assertEqual((blob.mime, blob.inline), ('application/octet-stream', False))

    def test_download_hash_mismatch_is_refused(self):
        self.inbox.store_marmot(MID, self.peer, 'peer', False, '', int(time.time() * 1000),
                                [{'sha256': hashlib.sha256(PNG).hexdigest(), 'mime': 'image/png', 'filename': 'p.png'}])
        self.engine.media_download.side_effect = lambda g, d, o: Path(o).write_bytes(b'tampered')
        from engine import EngineError as E
        with self.assertRaises(E) as err:
            self.inbox.media('messenger:' + MID, 'full')
        self.assertEqual(err.exception.code, 'upstream_unavailable')
        self.assertEqual([p for p in (Path(self.tmp.name) / 'unified' / 'media-cache').iterdir() if not p.name.endswith('.type')], [])

    def test_voice_notes_stay_unsupported_and_expired_uploads_are_pruned(self):
        with self.assertRaises(EngineError) as err:
            self.inbox.upload(self.pid, 'voice', b'OggS' + b'\0' * 10)
        self.assertEqual(err.exception.code, 'media_unsupported')
        up = self.inbox.upload(self.pid, 'image', PNG)
        folder = Path(self.inbox.uploads[up['upload_id']]['path']).parent
        self.inbox.uploads[up['upload_id']]['expires'] = time.time() - 1
        self.inbox.prune_uploads()
        self.assertFalse(folder.exists())


if __name__ == '__main__':
    unittest.main()
