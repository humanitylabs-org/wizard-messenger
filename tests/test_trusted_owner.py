"""Synthetic data only: local trust, remember/restart, and security regressions."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from engine import EngineError
from web import ViewServer
from trusted_owner import TrustedOwner, HEADER, PLATFORM_HEADER, sign_request, sign_platform_request

ORIGIN = 'https://wizard.example.com'
TOKEN = 'synthetic-machine-token-' + 'a' * 40
PASSWORD = 'synthetic-only-vault-passphrase'


class SyntheticEngine:
    relays = []
    def __init__(self, data):
        self.data = Path(data); self.ready = False; self.calls = []; self.configured = True
    def status(self):
        if not self.configured: return {'state': 'setup_required', 'account_configured': False}
        return {'state': 'ready' if self.ready else 'locked', 'account_configured': True}
    def setup_with_proof(self, body):
        if body['action'] == 'create' and not self.configured:
            self.calls.append('create'); self.configured = True; self.ready = True
            return self.status(), True
        return self.setup(body), False
    def setup(self, body):
        self.calls.append(body['action'])
        if body['action'] == 'lock': self.ready = False
        elif body['action'] == 'unlock' and body['vault_password'] == PASSWORD: self.ready = True
        else: raise EngineError('vault_unlock_failed', 'Invalid passphrase', 401)
        return self.status()
    def identity(self): return {'identity': None}
    def contacts(self): return {'contacts': []}
    def lock(self): pass


class TrustedOwnerHTTP(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.data = self.root / 'data'; self.data.mkdir()
        self.proof = secrets.token_bytes(32); self.wrap = secrets.token_bytes(32)
        for name, key in [('proof', self.proof), ('wrap', self.wrap)]:
            path = self.root / name; path.write_bytes(key); path.chmod(0o600)
        self.env = patch.dict(os.environ, {'MESSENGER_TRUST_WIZARD_OWNER': '1',
            'MESSENGER_OWNER_PROOF_KEY_FILE': str(self.root / 'proof'),
            'MESSENGER_OWNER_WRAP_KEY_FILE': str(self.root / 'wrap'),
            'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0',
            'UNIFIED_ENABLED': '0', 'MESSENGER_REMOTE_AUTHORITY_URL': ''})
        self.env.start(); self.start()
        self.server.auth.remember_password(PASSWORD)
    def start(self):
        self.engine = SyntheticEngine(self.data)
        self.server = ViewServer(('127.0.0.1', 0), self.engine, TOKEN, [ORIGIN])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def stop(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def tearDown(self):
        self.stop(); self.env.stop(); self.temp.cleanup()
    def request(self, method, target, body=None, *, proof=True, headers=None):
        h = {'Origin': ORIGIN, **(headers or {})}
        if proof and HEADER not in h: h[HEADER] = sign_request(self.proof, method, target)
        if body is not None: h['Content-Type'] = 'application/json'
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request(method, target, json.dumps(body) if body is not None else None, h)
        r = c.getresponse(); raw = r.read(); result = (r.status, dict(r.getheaders()), json.loads(raw)); c.close()
        return result
    def unlock(self, remember=True):
        return self.request('POST', '/api/view/unlock', {'vault_password': PASSWORD, 'remember_wizard': remember})
    def test_first_unlock_remember_reload_restart_no_cookie_and_lock_forgets(self):
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
        status, headers, body = self.unlock(); self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie']); self.assertIn('Secure', headers['Set-Cookie'])
        envelope = self.server.trusted_owner.path
        self.assertNotIn(PASSWORD.encode(), envelope.read_bytes()); self.assertEqual(envelope.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.request('GET', '/api/view/session')[0], 200)
        self.stop(); self.start()
        self.assertFalse(self.engine.ready)
        status, headers, body = self.request('GET', '/api/view/session'); self.assertEqual(status, 200)
        self.assertTrue(self.engine.ready); self.assertEqual(self.engine.calls, ['unlock'])
        cookie = headers['Set-Cookie'].split(';')[0]
        status, _, _ = self.request('POST', '/api/setup', {'action': 'lock'}, headers={'Cookie': cookie, 'X-Messenger-CSRF': body['result']['csrf_token']})
        self.assertEqual(status, 200); self.assertFalse(envelope.exists()); self.assertFalse(self.engine.ready)
        self.assertEqual(self.request('GET', '/api/view/session', headers={'Cookie': cookie})[0], 401)
    def test_nonremembered_unlock_does_not_persist(self):
        self.assertEqual(self.unlock(False)[0], 200)
        self.assertFalse(self.server.trusted_owner.path.exists())
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
    def test_wrong_password_cannot_enroll(self):
        self.assertEqual(self.request('POST', '/api/view/unlock', {'vault_password': 'wrong-synthetic-password', 'remember_wizard': True})[0], 401)
        self.assertFalse(self.server.trusted_owner.path.exists()); self.assertFalse(self.engine.ready)
    def test_spoofed_headers_missing_proof_and_machine_key_fail(self):
        self.unlock()
        for headers in ({}, {'X-Wizard-Owner': 'true', 'Tailscale-User-Login': 'owner@example.com', 'X-Forwarded-For': '127.0.0.1'}, {HEADER: TOKEN}):
            self.assertEqual(self.request('GET', '/api/view/session', proof=False, headers=headers)[0], 403)
        for mode in ('no_access', 'read_only', 'draft_only', 'draft_and_send'):
            self.server.agent_access.mode = mode
            for path in ('/api/view/session', '/api/view/trusted-owner', '/api/view/unlock'):
                self.assertEqual(self.request('POST' if path.endswith('unlock') else 'GET', path, {} if path.endswith('unlock') else None, headers={'Authorization': 'Bearer ' + TOKEN})[0], 403)
        self.server.agent_access.mode = 'no_access'
        self.assertEqual(self.request('GET', '/api/contacts', headers={'Authorization': 'Bearer ' + TOKEN})[0], 403)
    def test_cookie_alone_is_not_outer_wizard_auth(self):
        _, headers, _ = self.unlock()
        cookie = headers['Set-Cookie'].split(';')[0]
        for path in ('/api/view/session', '/api/contacts', '/api/view/agent-access', '/api/spec'):
            self.assertEqual(self.request('GET', path, proof=False, headers={'Cookie': cookie})[0], 403)
    def test_replay_stale_wrong_method_path_and_origin(self):
        proof = sign_request(self.proof, 'GET', '/api/view/trusted-owner')
        self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={HEADER: proof})[0], 200)
        self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={HEADER: proof})[0], 403)
        for proof in (sign_request(self.proof, 'POST', '/api/view/trusted-owner'),
                      sign_request(self.proof, 'GET', '/wrong'),
                      sign_request(self.proof, 'GET', '/api/view/trusted-owner', now=time.time()-60),
                      sign_request(secrets.token_bytes(32), 'GET', '/api/view/trusted-owner')):
            self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={HEADER: proof})[0], 403)
        self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={'Origin': 'https://evil.example'})[0], 403)
    def test_csrf_and_setup_only_boundaries_unchanged(self):
        _, headers, _ = self.unlock(); cookie = headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('POST', '/api/view/agent-access', {'mode': 'read_only', 'minutes': 10}, headers={'Cookie': cookie})[0], 403)
        token, session = self.server.auth.create(self.server.auth.ticket(True), allow_bootstrap=True)
        self.assertEqual(self.request('GET', '/api/contacts', headers={'Cookie': 'wizard_messenger_session=' + token})[0], 403)
    def test_tamper_changed_verifier_or_key_never_resets_account(self):
        self.unlock(); original = self.server.trusted_owner.path.read_bytes()
        for mutation in ('tamper', 'verifier', 'wrap'):
            self.server.trusted_owner.path.write_bytes(original)
            credential = dict(self.server.auth.credential)
            if mutation == 'tamper': self.server.trusted_owner.path.write_text('{"version": 99}')
            if mutation == 'verifier': self.server.auth.credential = {'salt': '11'*16, 'digest': '22'*32}
            if mutation == 'wrap':
                from cryptography.hazmat.primitives.ciphers.aead import AESGCM
                self.server.trusted_owner.cipher = AESGCM(secrets.token_bytes(32))
            self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
            self.server.auth.credential = credential
        self.assertTrue(self.server.trusted_owner.path.exists())
    def test_bad_key_permissions_and_same_keys_fail_closed(self):
        (self.root / 'proof').chmod(0o644)
        with self.assertRaises(ValueError): TrustedOwner.from_environment(self.data)
        (self.root / 'proof').chmod(0o600)
        (self.root / 'wrap').write_bytes(self.proof)
        with self.assertRaises(ValueError): TrustedOwner.from_environment(self.data)
    def test_disabled_default_keeps_existing_password_flow(self):
        self.stop()
        with patch.dict(os.environ, {'MESSENGER_TRUST_WIZARD_OWNER': '0'}):
            self.start()
        self.assertFalse(self.server.trusted_owner.enabled)
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
        self.assertEqual(self.request('POST', '/api/view/unlock', {'vault_password': PASSWORD})[0], 200)
        self.assertEqual(self.unlock()[0], 403)
        self.assertFalse((self.data/'trusted-owner-unlock.json').exists())
    def test_keys_in_data_symlink_or_overpermissive_envelope_fail_closed(self):
        (self.data/'key').write_bytes(self.proof); (self.data/'key').chmod(0o600)
        with self.assertRaises(ValueError):
            TrustedOwner(self.data, enabled=True, proof_file=self.data/'key', wrap_file=self.root/'wrap')
        (self.root/'link').symlink_to(self.root/'proof')
        with self.assertRaises(OSError):
            TrustedOwner(self.data, enabled=True, proof_file=self.root/'link', wrap_file=self.root/'wrap')
        # App Manager backups widen app-data modes while Messenger runs: our own envelope is tightened back
        # and still opens (it is encrypted under the out-of-data wrap key), instead of locking the owner out.
        self.unlock(); self.server.trusted_owner.path.chmod(0o777)
        self.assertEqual(self.server.trusted_owner.password(self.server.auth.credential) is not None, True)
        self.assertEqual(self.server.trusted_owner.path.stat().st_mode & 0o777, 0o600)
    def test_origin_missing_and_cross_site_cannot_enroll(self):
        for headers in ({'Origin': ''}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request('POST', '/api/view/unlock', {'vault_password': PASSWORD, 'remember_wizard': True}, headers=headers)[0], 403)
        self.assertFalse(self.server.trusted_owner.path.exists())
    def test_reused_proof_on_keepalive_spec_is_rechecked(self):
        _, headers, _ = self.unlock()
        cookie = headers['Set-Cookie'].split(';')[0]
        h = {'Origin': ORIGIN, 'Cookie': cookie, HEADER: sign_request(self.proof, 'GET', '/api/spec')}
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        for expected in (200, 403):
            c.request('GET', '/api/spec', headers=h); response = c.getresponse(); response.read()
            self.assertEqual(response.status, expected)
        c.close()
    def test_remember_write_interruption_does_not_modify_identity_or_old_envelope(self):
        self.unlock(); before = self.server.trusted_owner.path.read_bytes()
        credential = dict(self.server.auth.credential)
        with patch('trusted_owner.os.replace', side_effect=OSError('synthetic interruption')):
            self.assertEqual(self.unlock()[0], 500)
        self.assertEqual(self.server.trusted_owner.path.read_bytes(), before)
        self.assertEqual(self.server.auth.credential, credential)
        self.assertEqual(self.unlock()[0], 200)
        self.assertEqual(list(self.data.glob('.trusted-owner-*')), [])
    def test_remote_authority_and_machine_key_reuse_are_rejected(self):
        from types import SimpleNamespace
        cases = (
            ({'MESSENGER_REMOTE_REQUIRED': '1'}, None, TOKEN),
            ({}, SimpleNamespace(endpoint='https://synthetic-authority.example'), TOKEN),
            ({}, None, 'k' * 32),
        )
        for environment, remote, token in cases:
            if token == 'k' * 32:
                (self.root/'proof').write_bytes(token.encode())
            instance = ViewServer.__new__(ViewServer)
            try:
                with patch.dict(os.environ, environment):
                    if remote:
                        with patch('remote_authority.RemoteAuthority.from_environment', return_value=remote):
                            with self.assertRaises(ValueError):
                                instance.__init__(('127.0.0.1', 0), SyntheticEngine(self.data), token, [ORIGIN])
                    else:
                        with self.assertRaises(ValueError):
                            instance.__init__(('127.0.0.1', 0), SyntheticEngine(self.data), token, [ORIGIN])
            finally:
                instance.server_close()
    def test_no_enrollment_ticket_or_identity_mutation(self):
        self.server.auth.credential = None; self.server.auth._save()
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
        self.assertEqual(self.server.auth.tickets, {}); self.assertEqual(self.engine.calls, [])


    def test_fresh_install_opens_straight_into_keyless_setup(self):
        # Issue 148: a fresh App Store install has no setup link. The owner edge's proof opens first setup.
        self.server.auth.credential = None; self.server.auth._save()
        self.engine.ready = False; self.engine.configured = False
        s, h, d = self.request('GET', '/api/view/session')
        self.assertEqual(s, 200); self.assertIn('Set-Cookie', h)
        self.assertEqual(self.server.auth.tickets, {}); self.assertEqual(self.engine.calls, [])
        cookie = h['Set-Cookie'].split(';')[0]; csrf = d['result']['csrf_token']
        owner = {'Cookie': cookie, 'X-Messenger-CSRF': csrf}
        # A reload while still in setup keeps the same setup-only session (no endless "Opening").
        self.assertEqual(self.request('GET', '/api/view/session', headers={'Cookie': cookie})[0], 200)
        self.assertEqual(self.request('GET', '/api/status', headers={'Cookie': cookie})[2]['result']['state'], 'setup_required')
        # Setup-only: nothing else opens until the address exists and is proven.
        self.assertEqual(self.request('GET', '/api/dms', headers={'Cookie': cookie})[0], 403)
        # Without the owner edge's proof there is no session at all.
        self.assertEqual(self.request('GET', '/api/view/session', proof=False)[0], 403)
        s, _, d = self.request('POST', '/api/setup', {'action': 'create', 'vault_password': PASSWORD}, headers=owner)
        self.assertEqual(s, 200, d); self.assertEqual(self.engine.calls, ['create'])
        self.assertEqual(self.unlock()[0], 200)
        # From here on it is a normal remembered trusted Wizard; first setup can't be repeated.
        self.assertEqual(self.request('POST', '/api/setup', {'action': 'create', 'vault_password': PASSWORD}, headers=owner)[0], 403)
        s, _, d = self.request('GET', '/api/view/session')
        self.assertEqual(s, 200); self.assertTrue(d['result']['authenticated'])


class PlatformOwnerProof(TrustedOwnerHTTP):
    """Keys provisioned by the App Manager (WIZARD_OWNER_*, no MESSENGER_TRUST_WIZARD_OWNER line) and requests
    signed by the platform owner edge (wizard-os spec/OWNER_PROOF.md). Every inherited test runs this way too."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.data = self.root / 'data'; self.data.mkdir()
        self.proof = secrets.token_bytes(32); self.wrap = secrets.token_bytes(32)
        for name, key in [('proof', self.proof), ('wrap', self.wrap)]:
            path = self.root / name; path.write_bytes(key); path.chmod(0o600)
        clean = {k: v for k, v in os.environ.items() if not k.startswith(('MESSENGER_TRUST', 'MESSENGER_OWNER_'))}
        self.env = patch.dict(os.environ, {**clean,
            'WIZARD_OWNER_PROOF_KEY_FILE': str(self.root / 'proof'),
            'WIZARD_OWNER_WRAP_KEY_FILE': str(self.root / 'wrap'), 'WIZARD_OWNER_PROOF_APP': 'messenger',
            'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0',
            'UNIFIED_ENABLED': '0', 'MESSENGER_REMOTE_AUTHORITY_URL': ''}, clear=True)
        self.env.start(); self.start()
        self.server.auth.remember_password(PASSWORD)
    def request(self, method, target, body=None, *, proof=True, headers=None):
        h = dict(headers or {})
        # Inherited tests pass legacy-format proofs explicitly; re-sign those the platform way.
        if HEADER in h:
            legacy = h.pop(HEADER)
            if legacy == sign_request(self.proof, method, target, now=int(legacy.split('.')[0]) if legacy.split('.')[0].isdigit() else 0, nonce=legacy.split('.')[1] if legacy.count('.') == 2 else None):
                h[PLATFORM_HEADER] = sign_platform_request(self.proof, 'messenger', method, target,
                                                           now=int(legacy.split('.')[0]), nonce=legacy.split('.')[1])
            else:
                h[PLATFORM_HEADER] = legacy
        elif proof and PLATFORM_HEADER not in h:
            h[PLATFORM_HEADER] = sign_platform_request(self.proof, 'messenger', method, target)
        return super().request(method, target, body, proof=False, headers=h)
    def test_platform_keys_alone_turn_trusted_owner_on(self):
        self.assertTrue(self.server.trusted_owner.enabled)
        self.assertEqual(self.request('GET', '/api/view/trusted-owner')[0], 200)
    def test_platform_proof_is_bound_to_this_app(self):
        for other in ('contacts', 'messenger2'):
            proof = sign_platform_request(self.proof, other, 'GET', '/api/view/trusted-owner')
            self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={PLATFORM_HEADER: proof})[0], 403)
    def test_platform_proof_cannot_be_replayed(self):
        proof = sign_platform_request(self.proof, 'messenger', 'GET', '/api/view/trusted-owner')
        self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={PLATFORM_HEADER: proof})[0], 200)
        self.assertEqual(self.request('GET', '/api/view/trusted-owner', headers={PLATFORM_HEADER: proof})[0], 403)
    def test_legacy_domain_under_the_platform_header_is_refused(self):
        proof = sign_request(self.proof, 'GET', '/api/view/trusted-owner')
        h = {'Origin': ORIGIN, PLATFORM_HEADER: proof}
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request('GET', '/api/view/trusted-owner', None, h); self.assertEqual(c.getresponse().status, 403); c.close()
    def test_both_proof_kinds_at_once_fail_closed(self):
        h = {'Origin': ORIGIN, PLATFORM_HEADER: sign_platform_request(self.proof, 'messenger', 'GET', '/api/view/trusted-owner'),
             HEADER: sign_request(self.proof, 'GET', '/api/view/trusted-owner')}
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request('GET', '/api/view/trusted-owner', None, h); self.assertEqual(c.getresponse().status, 403); c.close()
    def test_explicit_opt_out_wins_over_provisioned_keys(self):
        self.stop()
        with patch.dict(os.environ, {'MESSENGER_TRUST_WIZARD_OWNER': '0'}):
            self.start()
        self.assertFalse(self.server.trusted_owner.enabled)
    def test_bad_key_permissions_and_same_keys_fail_closed(self):
        super().test_bad_key_permissions_and_same_keys_fail_closed()
    def test_disabled_default_keeps_existing_password_flow(self):
        # Without any key file and without the flag, the passphrase flow is unchanged.
        self.stop()
        with patch.dict(os.environ, {'WIZARD_OWNER_PROOF_KEY_FILE': '', 'WIZARD_OWNER_WRAP_KEY_FILE': ''}):
            self.start()
        self.assertFalse(self.server.trusted_owner.enabled)
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)


class PlatformVector(unittest.TestCase):
    def test_known_vector_matches_the_app_manager_signer(self):
        # Same bytes as wizard-app-manager tests/test_owner_proof.py test_known_vector_for_other_language_verifiers.
        value = sign_platform_request(bytes(range(32)), 'messenger', 'GET', '/api/status', now=1700000000, nonce='ab' * 24)
        self.assertEqual(value, '1700000000.' + 'ab' * 24 + '.ecf2e5886a06c458496949d2f61e88e8893ea19846121298b2d3374159e28da3')


class LegacyIngressStillWorks(unittest.TestCase):
    def test_hand_built_ingress_environment_is_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); (root / 'data').mkdir()
            for name in ('p', 'w'):
                (root / name).write_bytes(secrets.token_bytes(32)); (root / name).chmod(0o600)
            with patch.dict(os.environ, {'MESSENGER_TRUST_WIZARD_OWNER': '1', 'MESSENGER_OWNER_PROOF_KEY_FILE': str(root / 'p'),
                                         'MESSENGER_OWNER_WRAP_KEY_FILE': str(root / 'w')}, clear=True):
                t = TrustedOwner.from_environment(root / 'data')
            self.assertTrue(t.enabled); self.assertEqual(t.app_id, 'messenger')
            self.assertEqual(t.proof_key, (root / 'p').read_bytes())


class RecipeNeedsNoOwnerGrant(unittest.TestCase):
    """wizard-os DECISIONS #107: accepting an app's host access is an owner-device action no agent can trigger, so a
    Messenger recipe that asked for any would stop every install and update at an owner prompt. Static check of the
    same things wizard-app-manager `network.host_access` flags (synthetic: reads only the recipe in this repo)."""

    def test_the_recipe_asks_for_no_host_access(self):
        import yaml
        compose = yaml.safe_load((Path(__file__).resolve().parents[1] / 'runtipi' / 'docker-compose.yml').read_text())
        safe_caps = {'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL', 'FSETID', 'NET_BIND_SERVICE'}
        for name, service in compose['services'].items():
            self.assertNotIn(service.get('privileged'), (True, 'true'), name)
            self.assertNotIn(service.get('network_mode'), ('host',), name)
            for key in ('pid', 'ipc', 'uts', 'userns_mode', 'cgroup', 'devices', 'volumes_from'):
                self.assertFalse(service.get(key), (name, key))
            self.assertFalse(set(service.get('cap_add') or []) - safe_caps, name)
            for option in service.get('security_opt') or []:
                self.assertIn(str(option).replace('=', ':'), ('no-new-privileges', 'no-new-privileges:true'), name)
            for volume in service.get('volumes') or []:
                source = volume if isinstance(volume, str) else str(volume.get('source', ''))
                source = source.split(':')[0]
                self.assertTrue(source.startswith('${APP_DATA_DIR}/'), (name, volume))
                self.assertNotIn('..', source, name)
                self.assertNotIn('sock', source, name)


if __name__ == '__main__': unittest.main()
