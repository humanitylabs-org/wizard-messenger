"""Server-side composer drafts, attachments and draft-only authority (no provider send)."""
import os
import tempfile
import unittest
from pathlib import Path

from drafts import Drafts
from engine import EngineError
from permissions import AgentAccess, capability_for


class ServerDrafts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ds = Drafts(self.tmp.name)
        self.owner = {'person_id': 'alice', 'identity_id': 'telegram', 'text': 'Owner starts'}
        self.agent = {'id': 'agent:oscar', 'name': 'Oscar'}

    def do(self, method, suffix=(), body=None, owner=True, actor=None, raw=None, query=None):
        return self.ds.dispatch(method, list(suffix), body or {}, None, owner=owner,
                                actor=actor, raw=raw, query=query)

    def test_owner_composer_edit_agent_append_and_revision_conflict(self):
        d = self.do('POST', body=self.owner)['draft']
        updated = self.do('POST', (d['id'],), dict(self.owner, revision=1, text='Owner starts; agent finishes'),
                          owner=False, actor=self.agent)['draft']
        self.assertEqual(updated['revision'], 2)
        with self.assertRaises(EngineError) as ctx:
            self.do('POST', body=self.owner)
        self.assertEqual(ctx.exception.code, 'draft_exists')
        self.assertEqual(updated['updated_by']['name'], 'Oscar')
        with self.assertRaises(EngineError) as ctx:
            self.do('POST', (d['id'],), dict(self.owner, revision=1, text='Stale browser overwrite'))
        self.assertEqual(ctx.exception.code, 'draft_changed')
        self.assertEqual(self.do('GET', (d['id'],))['draft']['text'], 'Owner starts; agent finishes')
        with self.assertRaises(EngineError) as ctx:
            self.do('DELETE', (d['id'],), {'revision': 2}, owner=False, actor=self.agent)
        self.assertEqual(ctx.exception.code, 'not_your_draft')

    def test_attachment_persist_read_remove_and_limit(self):
        d = self.do('POST', body=self.owner)['draft']
        aid = d['id']
        result = self.do('PUT', (aid, 'attachments'), owner=False, actor=self.agent,
                         raw=b'\x89PNG\r\n\x1a\nimage', query={'revision': ['1'], 'mime': ['image/png'], 'name': ['screen.png']})['draft']
        self.assertEqual(result['revision'], 2)
        a = result['attachments'][0]
        blob = self.do('GET', (aid, 'attachments', a['id']))
        self.assertEqual(blob.path.read_bytes(), b'\x89PNG\r\n\x1a\nimage')
        self.assertEqual(Drafts(self.tmp.name).get(aid)['attachments'], [a])
        self.assertEqual(blob.path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(EngineError) as ctx:
            self.do('PUT', (aid, 'attachments'), raw=b'stale', query={'revision': ['1']})
        self.assertEqual(ctx.exception.code, 'draft_changed')
        with self.assertRaises(EngineError) as ctx:
            self.do('POST', (aid, 'preview'), {'revision': 2})
        self.assertEqual(ctx.exception.code, 'draft_has_attachments')
        self.do('DELETE', (aid, 'attachments', a['id']), {'revision': 2})
        self.assertFalse(blob.path.exists())
        self.do('DELETE', (aid,), {'revision': 3})
        self.assertFalse((Path(self.tmp.name) / 'draft-files' / aid).exists())

    def test_spoofed_image_is_download_only_and_storage_budget(self):
        from unittest.mock import patch
        d = self.do('POST', body=self.owner)['draft']
        r = self.do('PUT', (d['id'], 'attachments'), raw=b'not an image',
                    query={'revision': ['1'], 'mime': ['image/png']})['draft']
        self.assertEqual(r['attachments'][0]['mime'], 'application/octet-stream')
        with patch('drafts.STORAGE_MAX', 20):
            with self.assertRaises(EngineError) as ctx:
                self.do('PUT', (d['id'], 'attachments'), raw=b'1234567890123',
                        query={'revision': ['2'], 'mime': ['image/png']})
            self.assertEqual(ctx.exception.code, 'draft_storage_full')

    def test_draft_only_route_denies_send_and_non_draft_writes(self):
        policy = AgentAccess(self.tmp.name)
        for method, path in [('PUT', '/api/drafts/id/attachments'),
                             ('DELETE', '/api/drafts/id/attachments/file')]:
            self.assertEqual(capability_for(method, path), 'draft')
            self.assertTrue(policy.permits(method, path, 'draft_only'))
        for method, path in [('POST', '/api/drafts/id/send'), ('POST', '/api/drafts/id/preview'),
                             ('POST', '/api/unified/people/id/send')]:
            self.assertFalse(policy.permits(method, path, 'draft_only'))


if __name__ == '__main__': unittest.main()
