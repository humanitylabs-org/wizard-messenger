"""Issue 445 (switch calls): LiveKit and its token service idle until the switch is on; Synapse's call settings."""
import json
import os
import re
import stat
import tempfile
import unittest
from pathlib import Path

import calls
import unified_setup
from switches import SwitchStore

ROOT = Path(__file__).resolve().parents[1]


class CallsFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'data'

    def tearDown(self):
        self.tmp.cleanup()

    def test_setup_writes_owner_only_call_files_and_keeps_secrets(self):
        unified_setup.setup(self.root)
        folder = self.root / 'calls'
        for name in ('secrets.json', 'livekit-keys.yaml', 'livekit.yaml', calls.REGISTRATION):
            self.assertEqual(stat.S_IMODE((folder / name).stat().st_mode), 0o600, name)
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        keys = json.loads((folder / 'secrets.json').read_text())
        line = (folder / 'livekit-keys.yaml').read_text()
        self.assertEqual(line, 'messenger: %s\n' % keys['livekit_secret'])
        self.assertRegex(keys['livekit_secret'], r'^[0-9a-f]{64}$')
        unified_setup.setup(self.root)
        self.assertEqual(json.loads((folder / 'secrets.json').read_text()), keys)
        # Synapse reads its own copy of the registration, identical to the token service's.
        self.assertEqual((self.root / 'matrix' / calls.REGISTRATION).read_text(), (folder / calls.REGISTRATION).read_text())

    def test_synapse_gets_the_call_settings_and_keeps_its_own(self):
        unified_setup.setup(self.root)
        hs = json.loads((self.root / 'matrix' / 'homeserver.yaml').read_text())
        self.assertEqual(hs['app_service_config_files'][-1], '/data/' + calls.REGISTRATION)
        self.assertIn('/data/telegram-registration.yaml', hs['app_service_config_files'])
        for flag in ('msc4143_enabled', 'msc4222_enabled', 'msc4502_enabled', 'msc4512_enabled'):
            self.assertIs(hs['experimental_features'][flag], True)
        self.assertEqual(hs['max_event_delay_duration'], '24h')
        self.assertEqual(hs['matrix_rtc'], {'transports': [{'type': 'm.livekit', 'url': 'ws://livekit:7880'}]})
        # Nothing about registration or federation opens up.
        self.assertIs(hs['enable_registration'], False)
        self.assertEqual(hs['federation_domain_whitelist'], [])
        self.assertEqual(hs['listeners'][0]['resources'], [{'names': ['client'], 'compress': False}])
        reg = json.loads((self.root / 'matrix' / calls.REGISTRATION).read_text())
        self.assertIsNone(reg['url'])
        self.assertEqual(reg['io.element.msc4512.proxy_prefix'], 'rtc/livekit')
        self.assertEqual(reg['io.element.msc4512.proxy_url'], 'http://call-auth:8080')
        self.assertEqual(reg['namespaces']['users'], [{'exclusive': False, 'regex': '.*'}])

    def test_livekit_makes_no_room_by_itself(self):
        unified_setup.setup(self.root)
        lk = json.loads((self.root / 'calls' / 'livekit.yaml').read_text())
        self.assertIs(lk['room']['auto_create'], False)
        self.assertEqual(lk['key_file'], '/calls/livekit-keys.yaml')
        self.assertEqual(lk['webhook'], {'api_key': 'messenger', 'urls': ['http://call-auth:8080/sfu_webhook']})


class CallsSwitchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.marker = self.root / 'calls' / 'enabled'

    def tearDown(self):
        self.tmp.cleanup()

    def store(self):
        store = SwitchStore(self.root / 'switches.json')
        store.changed[calls.SWITCH] = lambda on: calls.set_running(self.root, on)
        return store

    def test_off_by_default_and_the_switch_starts_and_stops_the_call_server(self):
        store = self.store()
        self.assertFalse(calls.sync(self.root))
        self.assertFalse(self.marker.exists())
        store.set('calls', True)
        self.assertTrue(self.marker.exists())
        self.assertTrue(calls.running(self.root))
        store.set('calls', False)
        self.assertFalse(self.marker.exists())
        # Another switch never touches it.
        store.set('new-group', True)
        self.assertFalse(self.marker.exists())

    def test_start_follows_the_stored_switch(self):
        self.store().set('calls', True)
        self.marker.unlink()
        unified_setup.setup(self.root)
        self.assertTrue(self.marker.exists())
        (self.root / 'switches.json').write_text(json.dumps({'switches': {'calls': False}}))
        unified_setup.setup(self.root)
        self.assertFalse(self.marker.exists())
        (self.root / 'switches.json').write_text('not json')
        self.assertFalse(calls.sync(self.root))


class CallsRecipeTests(unittest.TestCase):
    def setUp(self):
        self.compose = (ROOT / 'runtipi' / 'docker-compose.yml').read_text()

    def service(self, name):
        match = re.search(r'\n  %s:\n(.*?)(?=\n  [a-z][a-z0-9-]*:\n)' % re.escape(name), self.compose, re.S)
        self.assertIsNotNone(match, name)
        return match.group(1)

    def test_call_services_wait_for_the_switch_and_publish_nothing(self):
        for name, program in (('livekit', '/livekit-server --config /calls/livekit.yaml'),
                              ('call-auth', '/usr/local/bin/lk-jwt-service')):
            block = self.service(name)
            self.assertIn('until [ -f /calls/enabled ]', block)
            self.assertIn(program, block)
            self.assertNotIn('ports:', block)
            self.assertNotIn('network_mode', block)
            self.assertIn('${APP_DATA_DIR}/data/calls:/calls:ro', block)
            self.assertIn('read_only: true', block)
            self.assertIn('cap_drop: [ALL]', block)
        self.assertIn('networks: [call-lane, call-egress]', self.service('livekit'))
        self.assertIn('networks: [call-lane, matrix-lane]', self.service('call-auth'))
        self.assertIn('  call-lane: {internal: true}\n', self.compose)

    def test_versions_are_pinned_by_digest(self):
        self.assertRegex(self.service('livekit'),
                         r'image: livekit/livekit-server:%s@sha256:[0-9a-f]{64}\n' % calls.VERSIONS['livekit'])
        messenger_image = re.search(r'\n  messenger:\n    image: (\S+)\n', self.compose).group(1)
        self.assertIn('image: %s\n' % messenger_image, self.service('call-auth'))
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertRegex(dockerfile, r'COPY --from=ghcr\.io/element-hq/lk-jwt-service:%s@sha256:[0-9a-f]{64} '
                                     r'/lk-jwt-service /usr/local/bin/lk-jwt-service\n' % calls.VERSIONS['lk-jwt-service'])
        for name in ('Dockerfile', 'Dockerfile.overlay'):
            self.assertIn(' calls.py ', (ROOT / name).read_text(), name)


if __name__ == '__main__':
    unittest.main()
