"""Draft attachments over MCP (Draft-only and up). Agents still cannot send.

Real loopback handlers, fake provider I/O (Matrix and the Marmot engine are mocks).
No accounts, networks or real messages are ever touched.
"""
import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import test_web as fixtures
import test_agent_keys as base

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 64
PDF = b'%PDF-1.4\n' + b'x' * 64


class AgentSend(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers
    agent = base.AgentKeyHTTP.agent
    level = base.AgentKeyHTTP.level
    mcp = base.AgentKeyHTTP.mcp

    def setUp(self):
        base.AgentKeyHTTP.setUp(self)
        self.files = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'MESSENGER_AGENT_FILES_DIR': self.files.name,
                                           'MESSENGER_AGENT_FILES_HOST_DIR': '/host/media/Messenger/Attachments'})
        self.env.start()
        self.inbox.matrix_upload = Mock(return_value={'content_uri': 'mxc://messenger.internal/up1'})
        self.inbox.mx = Mock(return_value={'event_id': '$sent1'})

    def tearDown(self):
        self.env.stop()
        self.files.cleanup()
        fixtures.ViewBoundary.tearDown(self)

    def attach(self, args, key='draft_only'):
        return self.mcp('messenger_attach_to_draft', args, self.keys[key])

    def draft(self):
        made, error = self.mcp('messenger_create_draft', {'chat_id': self.alice['person_id'], 'text': 'Hi'}, self.keys['draft_only'])
        self.assertFalse(error, made)
        return made['draft']

    # ---- there is still no way for any agent key to send ----
    def test_no_send_tool_at_any_level(self):
        for level in ('no_access', 'read_only', 'draft_only', 'draft_and_send'):
            names = {t['name'] for t in self.mcp(None, headers=self.keys[level], method='tools/list')['tools']}
            self.assertFalse(any('send' in n for n in names), (level, names))
            self.assertTrue({'messenger_attach_to_draft', 'messenger_remove_draft_attachment'} <= names, level)
            body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                    'params': {'name': 'messenger_send_message', 'arguments': {'chat_id': self.alice['person_id'], 'text': 'x'}}}
            data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.keys[level]})[2]
            self.assertIn('error', data, level)
        self.inbox.mx.assert_not_called(); self.inbox.matrix_upload.assert_not_called()

    def test_attachment_schema_is_advertised(self):
        tools = {t['name']: t for t in self.mcp(None, headers=self.keys['draft_only'], method='tools/list')['tools']}
        for name in ('messenger_create_draft', 'messenger_update_draft', 'messenger_attach_to_draft'):
            self.assertEqual(tools[name]['inputSchema']['properties']['attachments']['type'], 'array', name)

    # ---- attachments ----
    def test_base64_and_shared_folder_files_attach_without_sending(self):
        Path(self.files.name, 'docs').mkdir()
        Path(self.files.name, 'docs', 'plan.pdf').write_bytes(PDF)
        draft = self.draft()
        items = [{'base64': base64.b64encode(PNG).decode(), 'name': 'pic.png'}, {'path': 'docs/plan.pdf'},
                 {'path': '/host/media/Messenger/Attachments/docs/plan.pdf', 'name': 'Plan v2.pdf'}]
        data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': items})
        self.assertFalse(error, data)
        self.assertEqual([(a['name'], a['mime'], a['bytes']) for a in data['draft']['attachments']],
                         [('pic.png', 'image/png', len(PNG)), ('plan.pdf', 'application/pdf', len(PDF)), ('Plan v2.pdf', 'application/pdf', len(PDF))])
        self.assertEqual(data['draft']['revision'], draft['revision'] + 3)
        # The owner's view serves the exact bytes back.
        att = data['draft']['attachments'][0]
        status, _, body = self.request('GET', '/api/drafts/%s/attachments/%s' % (draft['id'], att['id']), headers={'Cookie': self.owner['Cookie']})
        self.assertEqual(status, 200)
        self.inbox.mx.assert_not_called(); self.inbox.matrix_upload.assert_not_called()

    def test_paths_outside_the_shared_folder_are_refused_before_any_write(self):
        outside = tempfile.NamedTemporaryFile(delete=False); outside.write(PDF); outside.close()
        self.addCleanup(os.unlink, outside.name)
        os.symlink(outside.name, Path(self.files.name, 'link.pdf'))
        Path(self.files.name, 'dir').mkdir()
        draft = self.draft()
        for path in ('../x.pdf', outside.name, '/etc/passwd', 'link.pdf', 'dir', 'missing.pdf', '/host/media/Messenger/Attachments/../x', ''):
            data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': [{'path': path}]})
            self.assertTrue(error, path); self.assertEqual(data['error']['code'], 'invalid_attachment', (path, data))
        self.assertEqual(self.mcp('messenger_list_drafts', {}, self.keys['read_only'])[0]['drafts'][0]['attachments'], [])

    def test_attachment_shape_and_size_are_checked(self):
        draft = self.draft()
        for att in ({}, {'path': 'a', 'base64': 'AA=='}, {'base64': '!!notbase64!!', 'name': 'x'}, {'base64': ''},
                    {'base64': 'AA==', 'name': 'x', 'evil': 1}, 'str', {'base64': 'AA==', 'name': 5}):
            data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': [att]})
            self.assertTrue(error, att); self.assertIn(data['error']['code'], ('invalid_attachment', 'invalid_arguments'), att)
        for bad in ([], [{'base64': 'AA=='}] * 11, 'x'):
            data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': bad})
            self.assertTrue(error); self.assertEqual(data['error']['code'], 'invalid_arguments')
        with patch('agent_tools.ATTACH_MAX', 10):
            data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'],
                                       'attachments': [{'base64': base64.b64encode(PDF).decode(), 'name': 'big.pdf'}]})
            self.assertTrue(error); self.assertEqual(data['error']['code'], 'too_large')

    def test_create_with_bad_attachment_writes_no_draft(self):
        data, error = self.mcp('messenger_create_draft', {'chat_id': self.alice['person_id'], 'text': 'x',
                                                          'attachments': [{'path': '../etc/passwd'}]}, self.keys['draft_only'])
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'invalid_attachment')
        self.assertEqual(self.mcp('messenger_list_drafts', {}, self.keys['read_only'])[0]['drafts'], [])

    def test_stale_revision_and_other_agents_drafts_are_refused(self):
        draft = self.draft()
        att = [{'base64': base64.b64encode(PNG).decode(), 'name': 'p.png'}]
        data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'] - 1, 'attachments': att})
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'draft_changed')
        data, error = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': att}, 'draft_and_send')
        self.assertTrue(error); self.assertEqual(data['error']['code'], 'not_your_draft')

    def test_owner_sends_agent_attachments_only_from_the_chat(self):
        draft = self.draft()
        att = [{'base64': base64.b64encode(PNG).decode(), 'name': 'p.png'}]
        data, _ = self.attach({'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': att})
        # Even a Draft-and-send key cannot send it: drafts with attachments are sent from the owner's chat composer.
        status, _, body = self.request('POST', '/api/drafts/%s/send' % draft['id'], {'revision': data['draft']['revision']}, self.keys['draft_and_send'])
        self.assertNotEqual(status, 200, body)
        self.inbox.mx.assert_not_called()

    def test_large_mcp_bodies_only_for_agent_keys(self):
        big = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'pad': 'x' * 100000}
        self.assertEqual(self.request('POST', '/mcp', big, {'Origin': fixtures.ORIGIN})[0], 413)
        self.assertEqual(self.request('POST', '/mcp', big, {'Origin': fixtures.ORIGIN, **self.keys['draft_only']})[0], 200)

    # ---- drafts with attachments (Draft-only and up, like the HTTP route) ----
    def test_draft_attachments_create_attach_remove(self):
        drafter = self.keys['draft_only']
        att = {'base64': base64.b64encode(PNG).decode(), 'name': 'pic.png'}
        made, error = self.mcp('messenger_create_draft', {'chat_id': self.alice['person_id'], 'text': 'See photo', 'attachments': [att]}, drafter)
        self.assertFalse(error, made)
        draft = made['draft']
        self.assertEqual([(a['name'], a['mime']) for a in draft['attachments']], [('pic.png', 'image/png')])
        Path(self.files.name, 'plan.pdf').write_bytes(PDF)
        more, error = self.mcp('messenger_attach_to_draft', {'draft_id': draft['id'], 'revision': draft['revision'], 'attachments': [{'path': 'plan.pdf'}]}, drafter)
        self.assertFalse(error, more)
        self.assertEqual([a['mime'] for a in more['draft']['attachments']], ['image/png', 'application/pdf'])
        updated, error = self.mcp('messenger_update_draft', {'draft_id': draft['id'], 'revision': more['draft']['revision'], 'text': 'See both',
                                                            'attachments': [att]}, drafter)
        self.assertFalse(error, updated); self.assertEqual(len(updated['draft']['attachments']), 3)
        gone, error = self.mcp('messenger_remove_draft_attachment', {'draft_id': draft['id'], 'revision': updated['draft']['revision'],
                                                                     'attachment_id': updated['draft']['attachments'][0]['id']}, drafter)
        self.assertFalse(error, gone); self.assertEqual(len(gone['draft']['attachments']), 2)
        denied, error = self.mcp('messenger_attach_to_draft', {'draft_id': draft['id'], 'revision': gone['draft']['revision'], 'attachments': [att]}, self.keys['read_only'])
        self.assertTrue(error); self.assertEqual(denied['error']['code'], 'agent_permission_denied')
        self.inbox.mx.assert_not_called(); self.inbox.matrix_upload.assert_not_called()


if __name__ == '__main__':
    unittest.main()
