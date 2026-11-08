"""Sign-ins use Messenger's own normal Chromium, private to Messenger, with a Paste step in the live view."""
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class SigninBrowserRecipeTests(unittest.TestCase):
    def setUp(self):
        self.recipe = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())

    def test_own_hardened_browser_service_reachable_only_from_messenger(self):
        browser = self.recipe['services']['signin-browser']
        self.assertIn('ghcr.io/humanitylabs-org/browser-engine:', browser['image'])
        self.assertIn('@sha256:', browser['image'])
        self.assertEqual(set(browser['networks']), {'signin-lane', 'signin-egress'})
        self.assertTrue(self.recipe['networks']['signin-lane']['internal'])
        self.assertNotIn('internal', self.recipe['networks']['signin-egress'])
        self.assertNotIn('ports', browser)
        self.assertTrue(browser['read_only'])
        self.assertEqual(browser['cap_drop'], ['ALL'])
        lane_members = [n for n, s in self.recipe['services'].items() if 'signin-lane' in s.get('networks', [])]
        self.assertEqual(sorted(lane_members), ['messenger', 'signin-browser'])
        env = self.recipe['services']['messenger']['environment']
        self.assertEqual(env['MESSENGER_BROWSER_DEVTOOLS'], 'http://signin-browser:9222')

    def test_no_dependence_on_the_shared_browser_app(self):
        manifest = (ROOT / 'wizard.md').read_text()
        self.assertRegex(manifest, r'(?m)^uses: \[\]$')
        self.assertNotIn('http://browser:9222', (ROOT / 'browser_signin.py').read_text())

    def test_window_is_a_desktop_identity_and_signed_out_on_close(self):
        source = (ROOT / 'browser_signin.py').read_text()
        self.assertIn("'mobile': False", source)
        self.assertNotIn('setTouchEmulationEnabled', source)
        self.assertIn('Storage.clearCookies', source)
        self.assertIn('Target.disposeBrowserContext', source)

    def test_live_view_has_a_paste_step(self):
        js = (ROOT / 'static/connectors.js').read_text()
        self.assertRegex(js, r"c-live-paste', 'Paste'")
        self.assertIn('clipboard.readText()', js)
        self.assertIn("send({type: 'text', text})", js)


if __name__ == '__main__':
    unittest.main()
