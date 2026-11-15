"""Issue 234: /healthz reports the installed version, the one the release sets."""
import http.client
import json
import os
import re
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

import server
from server import MessengerServer

ROOT = Path(__file__).resolve().parents[1]


def release_versions():
    config = json.loads((ROOT / 'runtipi/config.json').read_text())['version']
    card = re.search(r'^version:\s*(\S+)', (ROOT / 'wizard.md').read_text(), re.M).group(1)
    compose = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())
    env = compose['services']['messenger']['environment']['MESSENGER_VERSION']
    return config, card, env


class FakeEngine:
    def status(self): return {'state': 'setup_required'}


class HealthzVersionTests(unittest.TestCase):
    def test_release_files_agree(self):
        config, card, env = release_versions()
        self.assertEqual(card, config)
        self.assertEqual(env, config, 'bump MESSENGER_VERSION in runtipi/docker-compose.yml with the release')

    def healthz(self):
        srv = MessengerServer(('127.0.0.1', 0), FakeEngine(), 'unit-test-capability-' + 'x' * 40, [])
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            client = http.client.HTTPConnection('127.0.0.1', srv.server_port, timeout=3)
            client.request('GET', '/healthz')
            body = json.loads(client.getresponse().read())
            client.close()
            return body
        finally:
            srv.shutdown(); srv.server_close(); thread.join()

    def test_healthz_reports_the_installed_version(self):
        _, _, env = release_versions()
        with patch.dict(os.environ, {'MESSENGER_VERSION': env}):
            self.assertEqual(self.healthz()['version'], env)

    def test_without_the_env_it_reads_wizard_md(self):
        config, _, _ = release_versions()
        with patch.dict(os.environ, {'MESSENGER_VERSION': ''}):
            self.assertEqual(self.healthz()['version'], config)
            self.assertEqual(server.app_version(), config)

    def test_no_stale_hardcoded_version(self):
        self.assertNotIn('0.2.0-unified.16.', (ROOT / 'server.py').read_text())


if __name__ == '__main__':
    unittest.main()
