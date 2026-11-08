"""The patched Signal bridge (native albums) is published by bridges.yml like LINE and Dots."""
import hashlib
import json
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class SignalBridgePublishTests(unittest.TestCase):
    def setUp(self):
        self.wf = yaml.safe_load((ROOT / '.github/workflows/bridges.yml').read_text())
        self.prov = json.loads((ROOT / 'plumbing/connectors-provenance.json').read_text())['signal']

    def test_workflow_pins_match_provenance(self):
        env = self.wf['env']
        self.assertEqual(env['SIGNAL_COMMIT'], self.prov['upstream_commit'])
        self.assertIn(env['SIGNAL_COMMIT'], (ROOT / self.prov['recipe']).read_text())
        patch = (ROOT / self.prov['patch']).read_bytes()
        self.assertEqual(hashlib.sha256(patch).hexdigest(), self.prov['patch_sha256'])
        self.assertEqual(self.prov['published_image']['repository'],
                         'ghcr.io/humanitylabs-org/wizard-signal-bridge')

    def test_workflow_builds_smoke_tests_and_publishes_signal_on_both_arches(self):
        on = self.wf[True] if True in self.wf else self.wf['on']
        for event in ('push', 'pull_request'):
            self.assertIn('plumbing/signal-bridge/**', on[event]['paths'])
        build = self.wf['jobs']['build']
        self.assertEqual({m['arch'] for m in build['strategy']['matrix']['include']}, {'amd64', 'arm64'})
        steps = {s.get('name'): s for s in build['steps']}
        sig = steps['Build Signal bridge (native albums)']['run']
        self.assertIn('-f plumbing/signal-bridge/Dockerfile', sig)
        self.assertIn('wizard-signal-bridge:sha-$GITHUB_SHA-${{ matrix.arch }}', sig)
        self.assertIn('/usr/bin/mautrix-signal "$img" --version', sig)
        self.assertIn('binary.sha256', sig)
        push = steps['Push per-architecture images']
        self.assertIn('docker push "$SIGNAL"', push['run'])
        self.assertEqual(push['if'], "github.event_name != 'pull_request'")
        publish = self.wf['jobs']['publish']
        self.assertEqual(publish['if'], "github.event_name != 'pull_request'")
        self.assertIn('wizard-signal-bridge $SIGNAL_TAG', publish['steps'][-1]['run'])

    def test_store_recipe_stays_on_upstream_until_digest_is_pinned(self):
        # Switch: the public recipe only moves to the published image once its digest is recorded.
        signal = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())['services']['signal']
        digest = self.prov['published_image']['digest']
        if digest is None:
            self.assertEqual(signal['image'], self.prov['upstream_image'])
        else:
            self.assertIn('ghcr.io/humanitylabs-org/wizard-signal-bridge:', signal['image'])
            self.assertTrue(signal['image'].endswith('@' + digest))
        self.assertNotIn('pull_policy', signal)


if __name__ == '__main__':
    unittest.main()
