"""Source + synthetic readiness regressions; never load owner data or start login."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

import yaml
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connectors import Connectors
from engine import EngineError

ROOT = Path(__file__).resolve().parents[1]


class WorkerAdmissionTests(unittest.TestCase):
    def test_manifest_runtime_installs_both_workers_not_only_optional_overlay(self):
        main = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())
        optional = yaml.safe_load((ROOT / 'runtipi/connectors.compose.yml').read_text())
        for name, binary, port in [('slack', 'mautrix-slack', 29335), ('instagram', 'mautrix-meta', 29330)]:
            with self.subTest(network=name):
                service = main['services'][name]
                other = optional['services'][name]
                for field in ('image', 'user', 'entrypoint', 'command', 'volumes', 'networks', 'healthcheck', 'depends_on', 'read_only', 'cap_drop', 'security_opt', 'restart'):
                    self.assertEqual(service[field], other[field], field)
                self.assertIn('@sha256:', service['image'])
                self.assertEqual(service['command'], ['until [ -f /data/configured ]; do sleep 2; done; exec /usr/bin/' + binary + ' -c /data/config.yaml'])
                self.assertIn(str(port) + '/_matrix/mau/live', service['healthcheck']['test'][1])
                self.assertNotIn('ports', service)
                self.assertNotIn('profiles', service)
                self.assertIn('connector-init', service['depends_on'])
                self.assertIn('matrix', service['depends_on'])
        self.assertTrue(main['networks']['matrix-lane']['internal'])

    def test_owner_status_distinguishes_dormant_ready_and_unreachable_without_auth(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as tmp:
            root = Path(tmp)
            configs = {n: {'enabled': False, 'url': 'http://' + n + ':' + str(p)} for n, p in [('slack', 29335), ('instagram', 29330)]}
            (root / 'connectors.json').write_text(json.dumps(configs))
            (root / 'connector-secrets.json').write_text(json.dumps({n: {'provisioning': 'synthetic-test-only'} for n in configs}))
            reader = Mock(return_value={'logins': [], 'login_flows': [{'id': 'email'}, {'id': 'android'}, {'id': 'bot-only'}]})
            writer = Mock(side_effect=AssertionError('Readiness must never start login'))
            controller = Connectors(root, reader=reader, writer=writer)
            for name in configs:
                self.assertEqual(controller.status(name)['state'], 'not_configured')
            reader.assert_not_called()
            for name in configs:
                configs[name]['enabled'] = True
            (root / 'connectors.json').write_text(json.dumps(configs))
            for name, flow in [('slack', 'email'), ('instagram', 'android')]:
                status = controller.dispatch('GET', [name, 'status'], {})
                self.assertEqual(status['state'], 'disconnected')
                self.assertTrue(status['capabilities']['bridge_live'])
                self.assertFalse(status['capabilities']['account_connected'])
                self.assertFalse(status['capabilities']['live_parity_verified'])
                self.assertEqual(status['flows'], [{'id': flow, 'name': flow}])
                self.assertEqual(reader.call_args.args[1].split('?')[0], '/_matrix/provision/v3/whoami')
                self.assertEqual(reader.call_args.args[-1], 15)
            reader.side_effect = EngineError('upstream_error', 'synthetic-secret-not-for-output', 504)
            for name in configs:
                status = controller.status(name)
                self.assertEqual(status['state'], 'unavailable')
                self.assertFalse(status['capabilities']['bridge_live'])
                self.assertFalse(status['capabilities']['account_connected'])
                self.assertNotIn('synthetic-secret', json.dumps(status))
            writer.assert_not_called()


if __name__ == '__main__':
    unittest.main()
