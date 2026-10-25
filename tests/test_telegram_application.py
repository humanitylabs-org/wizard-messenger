"""Synthetic owner HTTP + persistent first-time Telegram app configuration tests."""
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

from engine import EngineError
from telegram_application import application_values, configure_application, load_application
from unified_setup import setup
from test_agent_permissions import HTTPFixture

PAYLOAD = {'api_id': '123456', 'api_hash': 'a' * 32}  # synthetic, never used against Telegram
ROUTE = '/api/view/telegram/application'


class ApplicationFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        with patch.dict(os.environ, {}, clear=True):
            setup(self.root)
        (self.root / 'unified' / 'connectors.json').write_text(json.dumps({'telegram': {'enabled': False}, 'whatsapp': {'enabled': True, 'url': 'http://whatsapp:29318'}}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_configures_once_preserves_other_networks_and_survives_installer_rerun(self):
        keys = (self.root / 'unified' / 'secrets.json').read_bytes()
        before = json.loads((self.root / 'unified' / 'connectors.json').read_text())['whatsapp']
        self.assertEqual(configure_application(self.root, PAYLOAD), {'configured': True})
        self.assertEqual(load_application(self.root), PAYLOAD)
        self.assertEqual(json.loads((self.root / 'telegram' / 'config.yaml').read_text())['network']['api_id'], 123456)
        self.assertTrue((self.root / 'telegram' / 'configured').exists())
        conf = json.loads((self.root / 'unified' / 'connectors.json').read_text())
        self.assertEqual(conf['whatsapp'], before)
        self.assertTrue(conf['telegram']['enabled'])
        for n in ['telegram/config.yaml', 'telegram/application.json', 'telegram/configured', 'unified/configuration.json', 'unified/connectors.json']:
            self.assertEqual(stat.S_IMODE((self.root / n).stat().st_mode), 0o600)
        with self.assertRaises(EngineError) as e:
            configure_application(self.root, {**PAYLOAD, 'api_hash': 'b' * 32})
        self.assertEqual(e.exception.code, 'telegram_already_configured')
        with patch.dict(os.environ, {}, clear=True):
            setup(self.root)
        self.assertEqual((self.root / 'unified' / 'secrets.json').read_bytes(), keys)
        self.assertEqual(load_application(self.root), PAYLOAD)
        self.assertTrue(json.loads((self.root / 'unified' / 'configuration.json').read_text())['telegram_configured'])
        self.assertEqual(json.loads((self.root / 'telegram' / 'config.yaml').read_text())['network']['api_hash'], PAYLOAD['api_hash'])

    def test_each_interrupted_write_is_retryable_with_same_keys_only(self):
        import telegram_application as module
        original = module._write_private
        for fail_at in range(1, 6):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                with patch.dict(os.environ, {}, clear=True):
                    setup(root)
                (root / 'unified' / 'connectors.json').write_text(json.dumps({'telegram': {'enabled': False}}))
                count = [0]
                def faulty(path, value):
                    count[0] += 1
                    if count[0] == fail_at:
                        raise OSError('synthetic disk interruption')
                    return original(path, value)
                with patch.object(module, '_write_private', side_effect=faulty):
                    with self.assertRaises(EngineError) as e:
                        configure_application(root, PAYLOAD)
                self.assertEqual(e.exception.code, 'telegram_setup_interrupted')
                self.assertFalse((root / 'telegram' / 'configured').exists())
                if (root / 'telegram' / 'application.json').exists():
                    with self.assertRaises(EngineError) as mismatch:
                        configure_application(root, {**PAYLOAD, 'api_hash': 'b' * 32})
                    self.assertEqual(mismatch.exception.code, 'telegram_already_configured')
                self.assertEqual(configure_application(root, PAYLOAD), {'configured': True})
                self.assertTrue(json.loads((root / 'unified' / 'connectors.json').read_text())['telegram']['enabled'])
                self.assertTrue((root / 'telegram' / 'configured').exists())
                with patch.object(module, '_write_private') as never:
                    self.assertEqual(configure_application(root, PAYLOAD), {'configured': True})
                    never.assert_not_called()

    def test_full_installer_and_connector_init_recover_a_partial_configuration(self):
        import telegram_application as module
        from connector_setup import setup_connectors
        setup_connectors(self.root, ['whatsapp', 'line'])
        before = (self.root / 'unified' / 'connector-secrets.json').read_bytes()
        original = module._write_private
        count = [0]
        def faulty(path, value):
            count[0] += 1
            if count[0] == 3:
                raise OSError('synthetic disk interruption')
            return original(path, value)
        with patch.object(module, '_write_private', side_effect=faulty):
            with self.assertRaises(EngineError):
                configure_application(self.root, PAYLOAD)
        with patch.dict(os.environ, {}, clear=True):
            setup(self.root)
            setup_connectors(self.root, ['whatsapp', 'line'])
        conf = json.loads((self.root / 'unified' / 'connectors.json').read_text())
        self.assertTrue(conf['telegram']['enabled'])
        self.assertTrue(conf['whatsapp']['enabled'])
        self.assertTrue(conf['line']['enabled'])
        self.assertEqual((self.root / 'unified' / 'connector-secrets.json').read_bytes(), before)
        self.assertTrue((self.root / 'telegram' / 'configured').exists())

    def test_invalid_inputs_never_echo_secrets_or_publish_marker(self):
        for payload in [None, [], {}, {**PAYLOAD, 'extra': 1}, {'api_id': True, 'api_hash': 'b' * 32},
                        {'api_id': '123\n', 'api_hash': 'b' * 32}, {'api_id': '2147483648', 'api_hash': 'b' * 32},
                        {'api_id': '０１', 'api_hash': 'b' * 32}, {'api_id': '123', 'api_hash': 'not-a-hash-secret'},
                        {'api_id': '123', 'api_hash': 'a' * 31 + '\n'}]:
            with self.subTest(payload_type=type(payload).__name__):
                with self.assertRaises(EngineError) as e:
                    configure_application(self.root, payload)
                self.assertNotIn('not-a-hash-secret', str(e.exception))
                self.assertFalse((self.root / 'telegram' / 'configured').exists())
                self.assertFalse((self.root / 'telegram' / 'application.json').exists())


class ApplicationHTTP(HTTPFixture):
    def setUp(self):
        super().setUp()
        self.data_root = Path(self.temp.name) / 'account-data'
        with patch.dict(os.environ, {}, clear=True):
            setup(self.data_root)
        (self.data_root / 'unified' / 'connectors.json').write_text(json.dumps({'telegram': {'enabled': False}}))
        self.server.engine.data = self.data_root
        self.server.unified = Mock()

    def test_owner_only_csrf_and_origin_and_no_secret_readback(self):
        owner = self.owner_headers()
        for mode in ('no_access', 'read_only', 'draft_only', 'draft_and_send'):
            self.policy(mode)
            for headers in [self.bearer, {**self.bearer, **owner}]:
                self.assertEqual(self.request('POST', ROUTE, PAYLOAD, headers)[0], 403)
        for headers in [{}, {'Cookie': owner['Cookie']}, {**owner, 'X-Messenger-CSRF': 'bad'}, {**owner, 'Origin': 'https://evil.invalid'}]:
            self.assertIn(self.request('POST', ROUTE, PAYLOAD, headers)[0], (401, 403))
        status, _, data = self.request('POST', ROUTE, PAYLOAD, owner)
        self.assertEqual(status, 200, data)
        self.assertEqual(data['result'], {'configured': True})
        self.assertNotIn(PAYLOAD['api_hash'], json.dumps(data))
        self.assertEqual(self.request('GET', ROUTE, headers=owner)[0], 404)
        self.assertEqual(self.request('POST', ROUTE, PAYLOAD, owner)[0], 200, 'same-key retry is idempotent')
        self.assertEqual(self.request('POST', ROUTE, {**PAYLOAD, 'api_hash': 'b' * 32}, owner)[0], 409)

    def test_setup_only_session_and_remote_required_fail_closed(self):
        ticket = self.server.auth.ticket(bootstrap=True)
        token, session = self.server.auth.create(ticket, allow_bootstrap=True)
        owner = {'Cookie': 'wizard_messenger_session=' + token, 'Origin': 'https://wizard.example.com', 'X-Messenger-CSRF': session['csrf']}
        self.assertEqual(self.request('POST', ROUTE, PAYLOAD, owner)[0], 403)
        owner = self.owner_headers()
        self.server.remote_required = True
        self.assertEqual(self.request('POST', ROUTE, PAYLOAD, owner)[0], 403)
        self.assertFalse((self.data_root / 'telegram' / 'application.json').exists())
