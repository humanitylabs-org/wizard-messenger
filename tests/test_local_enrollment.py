"""Owner-local first-run provisioning through the real loopback HTTP boundary."""
import json
from pathlib import Path
import stat

from web import BrowserAuth, provision_owner_enrollment
from test_agent_permissions import HTTPFixture
import test_web as fixtures


class LocalEnrollment(HTTPFixture):
    def test_local_link_survives_auth_reload_and_completes_owner_first_run(self):
        self.server.auth = BrowserAuth(Path(self.temp.name) / 'private' / 'browser-auth.json')
        target = provision_owner_enrollment(self.server)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        fragment = json.loads(target.read_text())['fragment']
        self.assertTrue(fragment.startswith('#ticket='))
        ticket = fragment.removeprefix('#ticket=')
        # Restart persistence, without starting any provider or pairing an account.
        self.server.auth = BrowserAuth(self.server.auth.path)
        status, headers, data = self.request('POST', '/api/view/session', {'ticket': ticket}, {'Origin': fixtures.ORIGIN})
        self.assertEqual(status, 200, data)
        owner = {'Cookie': headers['Set-Cookie'].split(';')[0], 'Origin': fixtures.ORIGIN,
                 'X-Messenger-CSRF': data['result']['csrf_token']}
        password = 'local-provisioning-fixture-password'
        self.assertEqual(self.request('POST', '/api/setup', {'action': 'create', 'vault_password': password}, owner)[0], 200)
        self.assertEqual(self.request('GET', '/api/view/agent-access', headers=owner)[0], 403)
        status, headers, data = self.request('POST', '/api/view/unlock', {'vault_password': password}, {'Origin': fixtures.ORIGIN})
        self.assertEqual(status, 200, data)
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('GET', '/api/view/agent-access', headers={'Cookie': cookie})[0], 200)
        with self.assertRaises(ValueError):
            provision_owner_enrollment(self.server)
        # Configured-account bearer cannot mint owner sessions, even with the valid owner cookie.
        h = {'Authorization': 'Bearer ' + fixtures.TOKEN, 'Cookie': cookie, 'Origin': fixtures.ORIGIN}
        self.assertEqual(self.request('POST', '/api/view/session', {'ticket': ticket}, h)[0], 403)
        self.assertEqual(self.request('GET', '/owner-enrollment.json', headers=h)[0], 403)
        self.assertEqual(self.request('GET', '/owner-enrollment.json', headers={'Cookie': cookie})[0], 404)

    def test_provisioning_does_not_overwrite_existing_local_artifact(self):
        self.server.auth = BrowserAuth(Path(self.temp.name) / 'private' / 'browser-auth.json')
        target = provision_owner_enrollment(self.server)
        before = target.read_bytes()
        with self.assertRaises(FileExistsError):
            provision_owner_enrollment(self.server)
        self.assertEqual(target.read_bytes(), before)
