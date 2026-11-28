"""Issue 481: every photo, video and file goes up from the phone once.

The composer saves each attachment to the chat's draft while it is attached. Send names those saved copies
(`draft_id` + `draft:<kind>:<attachment id>`) and the box turns them into send uploads from its own disk, so the phone
never uploads the same bytes a second time. The composer's own uploads run side by side (append=1).
"""
import tempfile
import time
import unittest
from unittest.mock import Mock

from drafts import Drafts
from engine import EngineError
from unified import UnifiedInbox

JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 200
PDF = b'%PDF-1.4\n' + b' ' * 100


class SendFromDraft(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = Mock()
        self.engine.send_media = Mock(side_effect=lambda group, p: {'message_ids': ['e' * 64], 'published': True,
                                                                     'attachments': [{'sha256': '0' * 64} for _ in p['paths']]})
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.puts, self.uploaded = [], []
        self.inbox.mx = Mock(side_effect=lambda path, method, content: (self.puts.append(content), {'event_id': '$e%d' % len(self.puts)})[1])
        self.inbox.matrix_upload = Mock(side_effect=lambda data, name, mime: (self.uploaded.append((data, name, mime)), {'content_uri': 'mxc://box/%d' % len(self.uploaded)})[1])
        self.inbox.owner = '@owner:test'
        self.alice = self.inbox.store.identity('telegram', '!alice', 'Alice')['person_id']
        self.bob = self.inbox.store.identity('messenger', 'groupbob', 'Bob')['person_id']
        self.drafts = Drafts(self.tmp.name)
        self.inbox.draft_file = self.drafts.attachment_file

    def draft(self, person, *files):
        d = self.drafts.dispatch('POST', [], {'person_id': person, 'identity_id': 'x', 'text': ''}, None, owner=True)['draft']
        for i, (data, name) in enumerate(files):
            d = self.drafts.dispatch('PUT', [d['id'], 'attachments'], {}, None, owner=True, raw=data,
                                     query={'revision': [str(d['revision'])], 'name': [name], 'key': ['u%08d' % i]})['draft']
        return d['id'], [a['id'] for a in d['attachments']]

    def test_album_is_sent_from_the_draft_copies(self):
        did, aids = self.draft(self.alice, (JPEG + b'1', 'a.jpg'), (JPEG + b'2', 'b.jpg'), (JPEG + b'3', 'c.jpg'), (JPEG + b'4', 'd.jpg'))
        result = self.inbox.send(self.alice, {'client_id': 'w481album', 'text': 'Trip', 'draft_id': did,
                                              'upload_ids': ['draft:image:' + a for a in aids], 'media': [{'w': 10, 'h': 10}] * 4})
        self.assertEqual(result['state'], 'sent')
        self.assertEqual([d for d, _, _ in self.uploaded], [JPEG + b'1', JPEG + b'2', JPEG + b'3', JPEG + b'4'], 'the box uploads each stored copy once, in order')
        self.assertEqual(len(self.puts), 1)
        self.assertEqual([g['url'] for g in self.puts[0]['org.wizard.gallery']], ['mxc://box/1', 'mxc://box/2', 'mxc://box/3', 'mxc://box/4'])
        self.assertFalse(self.inbox.uploads, 'send uploads are dropped after the send')
        # A retried send (same client id) answers with the sent message: no second post, no second upload.
        again = self.inbox.send(self.alice, {'client_id': 'w481album', 'text': 'Trip', 'draft_id': 'gone',
                                             'upload_ids': ['draft:image:' + a for a in aids], 'media': [{'w': 10, 'h': 10}] * 4})
        self.assertEqual(again['event_id'], result['event_id'])
        self.assertEqual((len(self.puts), len(self.uploaded)), (1, 4))

    def test_single_photo_video_and_file(self):
        did, aids = self.draft(self.alice, (JPEG, 'p.jpg'), (PDF, 'notes.pdf'))
        self.inbox.send(self.alice, {'client_id': 'w481photo1', 'text': '', 'draft_id': did, 'upload_id': 'draft:image:' + aids[0], 'media': {'w': 1, 'h': 1}})
        self.inbox.send(self.alice, {'client_id': 'w481file01', 'text': '', 'draft_id': did, 'upload_id': 'draft:file:' + aids[1]})
        self.assertEqual([p['msgtype'] for p in self.puts], ['m.image', 'm.file'])
        self.assertEqual(self.puts[1]['body'], 'notes.pdf', 'a file keeps its own name')
        self.assertEqual([d for d, _, _ in self.uploaded], [JPEG, PDF])

    def test_a_phone_upload_and_a_draft_copy_mix(self):
        did, aids = self.draft(self.alice, (JPEG + b'a', 'a.jpg'))
        phone = self.inbox.upload(self.alice, 'image', JPEG + b'b')['upload_id']
        self.inbox.send(self.alice, {'client_id': 'w481mixed1', 'text': '', 'draft_id': did,
                                     'upload_ids': ['draft:image:' + aids[0], phone], 'media': [{'w': 1, 'h': 1}] * 2})
        self.assertEqual(len(self.puts[0]['org.wizard.gallery']), 2)
        self.assertEqual(len(self.uploaded), 2)

    def test_wizard_chat_sends_the_draft_copy_from_the_outbox(self):
        did, aids = self.draft(self.bob, (JPEG, 'p.jpg'))
        self.inbox.send(self.bob, {'client_id': 'w481wizard', 'text': 'Hi', 'draft_id': did, 'upload_id': 'draft:image:' + aids[0], 'media': {'w': 1, 'h': 1}})
        paths = self.engine.send_media.call_args[0][1]['paths']
        self.assertEqual(len(paths), 1)
        self.assertIn('marmot-outbox', paths[0])
        self.assertFalse(self.uploaded, 'a Wizard-only chat never touches Synapse')

    def test_a_gone_or_foreign_draft_is_refused_and_leaves_nothing_behind(self):
        did, aids = self.draft(self.alice, (JPEG, 'p.jpg'))
        for payload in ({'draft_id': 'nope', 'upload_id': 'draft:image:' + aids[0]},
                        {'draft_id': did, 'upload_id': 'draft:image:' + '0' * 16},
                        {'upload_id': 'draft:image:' + aids[0]}):
            with self.assertRaises(EngineError) as ctx:
                self.inbox.send(self.alice, dict(payload, client_id='w481gone01', text=''))
            self.assertEqual((ctx.exception.code, ctx.exception.status), ('draft_attachment_gone', 409))
        # Another chat's draft is not this chat's copy.
        with self.assertRaises(EngineError) as ctx:
            self.inbox.send(self.bob, {'client_id': 'w481gone02', 'text': '', 'draft_id': did, 'upload_id': 'draft:image:' + aids[0]})
        self.assertEqual(ctx.exception.code, 'draft_attachment_gone')
        # Half an album taken, then the second copy is gone: the first upload is dropped again.
        did2, aids2 = self.draft(self.alice, (JPEG, 'p.jpg'))
        with self.assertRaises(EngineError):
            self.inbox.send(self.alice, {'client_id': 'w481gone03', 'text': '', 'draft_id': did2,
                                         'upload_ids': ['draft:image:' + aids2[0], 'draft:image:' + '1' * 16]})
        self.assertFalse(self.inbox.uploads)
        self.assertFalse(self.puts)

    def test_owner_appends_side_by_side_without_the_revision_fence(self):
        d = self.drafts.dispatch('POST', [], {'person_id': self.alice, 'identity_id': 'x', 'text': ''}, None, owner=True)['draft']
        for i in range(3):  # three uploads all started at revision 1
            self.drafts.dispatch('PUT', [d['id'], 'attachments'], {}, None, owner=True, raw=JPEG,
                                 query={'revision': ['1'], 'name': ['p%d.jpg' % i], 'key': ['u481par%d' % i], 'append': ['1']})
        row = self.drafts.get(d['id'])
        self.assertEqual((len(row['attachments']), row['revision']), (3, 4))
        # Without a key, or from an agent, append=1 changes nothing: the fence stays.
        with self.assertRaises(EngineError) as ctx:
            self.drafts.dispatch('PUT', [d['id'], 'attachments'], {}, None, owner=True, raw=JPEG, query={'revision': ['1'], 'append': ['1']})
        self.assertEqual(ctx.exception.code, 'draft_changed')
        with self.assertRaises(EngineError) as ctx:
            self.drafts.dispatch('PUT', [d['id'], 'attachments'], {}, None, owner=False, actor={'id': 'owner', 'name': 'x'}, raw=JPEG,
                                 query={'revision': ['1'], 'append': ['1'], 'key': ['u481agent']})
        self.assertEqual(ctx.exception.code, 'draft_changed')

    def test_a_send_without_draft_refs_is_unchanged(self):
        up = self.inbox.upload(self.alice, 'image', JPEG)['upload_id']
        self.inbox.send(self.alice, {'client_id': 'w481plain1', 'text': '', 'upload_id': up, 'media': {'w': 1, 'h': 1}})
        self.assertEqual(len(self.puts), 1)
        self.assertEqual(len(self.uploaded), 1)


if __name__ == '__main__':
    unittest.main()
