"""Offline contracts only: synthetic fixtures are never live-account evidence."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import EngineError
from unified_setup import setup
from connector_setup import setup_connectors
from connectors import Connectors, MATRIX_NETWORKS, room_network
from connector_inbox import ConnectorInbox


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(self.root)
        self.reader = Mock(side_effect=AssertionError('Unexpected network I/O'))

    def test_default_dormant_no_network_no_secrets_exposed(self):
        setup_connectors(self.root)
        providers = Connectors(self.root / 'unified', reader=self.reader)
        self.assertEqual(providers.health()['providers']['signal'], 'not_configured')
        self.assertFalse(providers.health()['account_authentication_attempted'])
        statuses = providers.dispatch('GET', [], {})['providers']
        self.assertEqual(len(statuses), 7)
        self.assertEqual({s['state'] for s in statuses}, {'not_configured', 'unsupported'})
        self.reader.assert_not_called()
        for name in ('whatsapp', 'signal', 'slack'):
            self.assertFalse((self.root / name / 'configured').exists())
            with self.assertRaises(EngineError):
                providers.dispatch('POST', [name, 'start'], {'flow': 'qr'})

    def test_configuration_idempotent_unique_credentials_telegram_unchanged(self):
        old = (self.root / 'telegram' / 'config.yaml').read_bytes()
        setup_connectors(self.root, ('whatsapp', 'signal', 'slack'))
        secrets_path = self.root / 'unified' / 'connector-secrets.json'
        private = secrets_path.read_bytes()
        setup_connectors(self.root, ('whatsapp', 'signal', 'slack'))
        self.assertEqual(private, secrets_path.read_bytes())
        self.assertEqual(old, (self.root / 'telegram' / 'config.yaml').read_bytes())
        keys = json.loads(private)
        self.assertEqual(len({keys[n]['provisioning'] for n in keys}), 4)
        for name in ('whatsapp', 'signal', 'slack'):
            conf = json.loads((self.root / name / 'config.yaml').read_text())
            self.assertEqual(conf['bridge']['permissions']['*'], 'block')
            self.assertFalse(conf['encryption']['default'])
            self.assertFalse(conf['matrix']['federate_rooms'])
            self.assertFalse(conf['provisioning']['allow_matrix_auth'])
            self.assertEqual(secrets_path.stat().st_mode & 0o777, 0o600)
            reg = json.loads((self.root / 'matrix' / (name + '-registration.yaml')).read_text())
            self.assertEqual(reg['as_token'], conf['appservice']['as_token'])
        setup_connectors(self.root)
        matrix = json.loads((self.root / 'matrix' / 'homeserver.yaml').read_text())
        self.assertEqual(len(matrix['app_service_config_files']), 2)
        self.assertFalse((self.root / 'signal' / 'configured').exists())

    def test_invalid_network_rejected(self):
        with self.assertRaises(ValueError): setup_connectors(self.root, ('unknown',))

    def test_missing_writer_never_attempts_login(self):
        setup_connectors(self.root, ('signal',))
        p = Connectors(self.root / 'unified', reader=self.reader)
        with self.assertRaises(EngineError) as exc:
            p.dispatch('POST', ['signal', 'start'], {'flow': 'qr'})
        self.assertEqual(exc.exception.code, 'sender_required')
        self.reader.assert_not_called()

    def test_official_login_contract_and_memory_only_state(self):
        setup_connectors(self.root, ('whatsapp',))
        writer = Mock(return_value={'login_id': 'abc123', 'type': 'display_and_wait', 'step_id': 'fi.mau.whatsapp.login.qr', 'display_and_wait': {'type': 'qr', 'data': 'synthetic-qr'}, 'secret_extra': 'do-not-return'})
        p = Connectors(self.root / 'unified', reader=self.reader, writer=writer)
        result = p.dispatch('POST', ['whatsapp', 'start'], {'flow': 'qr'})
        self.assertNotIn('secret_extra', result)
        self.assertTrue(writer.call_args.kwargs['path'].startswith('/_matrix/provision/v3/login/start/qr?user_id='))
        self.assertNotIn('synthetic-qr', repr(p.pending))
        writer.return_value = {'type': 'complete', 'complete': {'access_token': 'not-returned'}}
        result = p.dispatch('POST', ['whatsapp', 'step'], {'login_id': 'abc123', 'step_id': 'fi.mau.whatsapp.login.qr', 'type': 'display_and_wait', 'fields': {}})
        self.assertNotIn('complete', result)
        self.assertFalse(p.pending)
        self.reader.assert_not_called()

    def test_cross_provider_path_and_expired_steps_rejected(self):
        setup_connectors(self.root, ('signal', 'whatsapp'))
        writer = Mock(return_value={'login_id': 'abc123', 'type': 'display_and_wait', 'step_id': 'fi.mau.signal.login.qr'})
        p = Connectors(self.root / 'unified', writer=writer)
        p.dispatch('POST', ['signal', 'start'], {'flow': 'qr'})
        payload = {'login_id': '../evil', 'type': 'display_and_wait', 'step_id': 'fi.mau.signal.login.qr'}
        for name in ('signal', 'whatsapp'):
            with self.assertRaises(EngineError): p.dispatch('POST', [name, 'step'], payload)
        p.pending['signal'] = (0, ('abc123', 'fi.mau.signal.login.qr', 'display_and_wait'))
        payload['login_id'] = 'abc123'
        with self.assertRaises(EngineError): p.dispatch('POST', ['signal', 'step'], payload)
        self.assertEqual(writer.call_count, 1)

    def test_connected_requires_actual_remote_connected_state(self):
        setup_connectors(self.root, ('signal',))
        reader = Mock(return_value={'logins': [{'id': 'synthetic', 'state': {'state_event': 'BAD_CREDENTIALS'}}], 'login_flows': [{'id': 'qr'}, {'id': 'made-up'}]})
        p = Connectors(self.root / 'unified', reader=reader)
        self.assertEqual(p.status('signal')['state'], 'degraded')
        reader.return_value['logins'][0]['state']['state_event'] = 'CONNECTED'
        status = p.status('signal')
        self.assertEqual(status['state'], 'connected')
        self.assertFalse(status['capabilities']['live_parity_verified'])
        self.assertEqual(status['flows'], [{'id': 'qr', 'name': 'qr'}])

    def test_slack_personal_flow_not_bot_app(self):
        setup_connectors(self.root, ('slack',))
        writer = Mock()
        p = Connectors(self.root / 'unified', writer=writer)
        for flow in ('app', 'token', 'qr'):
            with self.assertRaises(EngineError): p.dispatch('POST', ['slack', 'start'], {'flow': flow})
        writer.assert_not_called()

    def test_unsupported_honest(self):
        p = Connectors(self.root / 'unified')
        for name in ('kakaotalk',):
            self.assertEqual(p.status(name)['state'], 'unsupported')
            with self.assertRaises(EngineError) as exc: p.dispatch('POST', [name, 'start'], {'flow': 'qr'})
            self.assertEqual(exc.exception.code, 'unsupported_network')

    def test_metadata_allowlist_and_ambiguous_rejection(self):
        event = lambda network: {'type': 'm.bridge', 'content': {'protocol': {'id': network}}}
        for name in MATRIX_NETWORKS: self.assertEqual(room_network([event(name)]), name)
        self.assertIsNone(room_network([event('unknown')]))
        self.assertIsNone(room_network([event('signal'), event('telegram')]))

    def inbox(self, sender=None):
        engine = Mock()
        engine.status.return_value = {'state': 'dormant'}
        inbox = ConnectorInbox(self.root, engine, sender)
        self.addCleanup(inbox.close)
        self.addCleanup(inbox.store._conn.close)
        inbox.store.put('matrix_token', 'synthetic-read-token')
        return inbox

    def test_ingest_and_sender_routing_all_matrix_networks(self):
        writer = Mock(side_effect=lambda **kw: {'event_id': '$synthetic-' + kw['path'].split('/')[-1]})
        inbox = self.inbox(writer)
        for index, name in enumerate(sorted(MATRIX_NETWORKS)):
            identity = inbox.store.identity(name, '!room-' + name + ':messenger.internal', name)
            inbox.ingest(identity, {}, {'type': 'm.room.message', 'event_id': '$incoming-' + name, 'sender': '@peer:messenger.internal', 'origin_server_ts': 1, 'content': {'msgtype': 'm.text', 'body': 'synthetic'}})
            self.assertEqual(inbox.store.messages(identity['person_id'])[0]['network'], name)
            result = inbox.send(identity['person_id'], {'client_id': 'client00' + str(index), 'text': 'offline test'})
            self.assertEqual(result['state'], 'sent')
            self.assertEqual(writer.call_args.kwargs['network'], 'matrix')
            self.assertEqual(writer.call_args.kwargs['method'], 'PUT')
        inbox.engine.send.assert_not_called()

    def test_no_writer_blocks_text_media_typing_edit_delete_reaction(self):
        inbox = self.inbox()
        identity = inbox.store.identity('signal', '!room:messenger.internal', 'Synthetic')
        pid = identity['person_id']
        inbox.store.add_message('$test', identity, inbox.owner, True, 'test', 1)
        operations = [lambda: inbox.send(pid, {'client_id': 'client000', 'text': 'test'}),
                      lambda: inbox.upload(pid, 'image', b'\x89PNG\r\n\x1a\n' + b'0' * 16),
                      lambda: inbox.set_typing(pid, {'typing': True}),
                      lambda: inbox.edit('$test', {'text': 'changed'}),
                      lambda: inbox.delete('$test', {'everyone': True}),
                      lambda: inbox.react('$test', {'key': 'x'})]
        with patch('connector_inbox.urlopen', side_effect=AssertionError('Network forbidden')):
            for operation in operations:
                with self.assertRaises(EngineError) as exc: operation()
                self.assertEqual(exc.exception.code, 'sender_required')
        inbox.engine.send.assert_not_called()

    def test_upload_routes_binary_through_sender(self):
        writer = Mock(return_value={'content_uri': 'mxc://messenger.internal/synthetic'})
        inbox = self.inbox(writer)
        identity = inbox.store.identity('whatsapp', '!room:messenger.internal', 'Synthetic')
        data = b'\x89PNG\r\n\x1a\n' + b'0' * 16
        inbox.upload(identity['person_id'], 'image', data)
        self.assertEqual(writer.call_args.kwargs['body'], data)
        self.assertEqual(writer.call_args.kwargs['content_type'], 'image/png')

    def test_matrix_read_cannot_bootstrap_owner(self):
        inbox = self.inbox()
        inbox.store.put('matrix_token', '')
        with patch('connector_inbox.http', side_effect=AssertionError('Network forbidden')):
            with self.assertRaises(EngineError) as exc: inbox.mx('/sync')
        self.assertEqual(exc.exception.code, 'owner_bootstrap_required')

    def test_room_meta_network_and_trusted_invites(self):
        setup_connectors(self.root, ('signal',))
        inbox = self.inbox()
        self.assertTrue(inbox.trusted_inviter('@signal_uuid:messenger.internal'))
        self.assertFalse(inbox.trusted_inviter('@signal_uuid:evil.example'))
        self.assertFalse(inbox.trusted_inviter('@whatsapp_123:messenger.internal'))
        for name in MATRIX_NETWORKS:
            state = [{'type': 'm.bridge', 'content': {'protocol': {'id': name}, 'com.beeper.room_type.v2': 'dm'}}]
            with patch.object(inbox, 'mx', return_value=state):
                self.assertEqual(inbox.room_meta('!' + name, {})['network'], name)

    def test_sync_ingests_every_supported_network_without_account_credentials(self):
        inbox = self.inbox()
        joined = {('!room-' + n): {'timeline': {'events': [{'type': 'm.room.message', 'event_id': '$' + n, 'sender': '@peer:messenger.internal', 'content': {'msgtype': 'm.text', 'body': 'synthetic ' + n}}]}} for n in MATRIX_NETWORKS}
        def matrix(path, *args, **kwargs):
            if path.startswith('/sync?'):
                return {'next_batch': 'offline-next', 'rooms': {'join': joined}}
            if path.endswith('/state'):
                network = next(n for n in MATRIX_NETWORKS if ('room-' + n) in path)
                return [{'type': 'm.bridge', 'content': {'protocol': {'id': network}, 'com.beeper.room_type.v2': 'dm'}}]
            raise AssertionError('Unexpected Matrix request ' + path)
        with patch.object(inbox, 'mx', side_effect=matrix):
            self.assertEqual(inbox.sync()['state'], 'ready')
        self.assertEqual({i['network'] for p in inbox.store.people() for i in p['identities']}, set(MATRIX_NETWORKS))

    def test_transaction_id_forwarding_and_stale_rejection(self):
        setup_connectors(self.root, ('signal',))
        writer = Mock(return_value={'login_id': 'abc', 'step_id': 'qr', 'txn_id': 'bls_current', 'type': 'display_and_wait'})
        p = Connectors(self.root / 'unified', writer=writer)
        p.dispatch('POST', ['signal', 'start'], {'flow': 'qr'})
        payload = {'login_id': 'abc', 'step_id': 'qr', 'type': 'display_and_wait'}
        with self.assertRaises(EngineError): p.dispatch('POST', ['signal', 'step'], payload)
        payload['txn_id'] = 'bls_current'
        writer.return_value = {'type': 'complete'}
        p.dispatch('POST', ['signal', 'step'], payload)
        self.assertIn('&txn_id=bls_current', writer.call_args.kwargs['path'])

    def test_templates_and_digest_provenance(self):
        root = Path(__file__).resolve().parents[1]
        proof = json.loads((root / 'plumbing/connectors-provenance.json').read_text())
        for name, evidence in proof.items():
            raw = (root / 'plumbing' / (name + '-template.json')).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), evidence['template_sha256'])
            if name == 'line':
                self.assertEqual(len(evidence['source_commit']), 40)
                self.assertEqual(evidence['license'], 'MIT')
            else:
                self.assertIn('@sha256:', evidence['image'])
                self.assertEqual({m['platform']['architecture'] for m in evidence['manifest']['manifests']}, {'amd64', 'arm64'})


if __name__ == '__main__': unittest.main()
