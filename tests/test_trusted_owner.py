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
from trusted_owner import TrustedOwner, HEADER, sign_request

ORIGIN = 'https://wizard.example.com'
TOKEN = 'synthetic-machine-token-' + 'a' * 40
PASSWORD = 'synthetic-only-vault-passphrase'


class SyntheticEngine:
    relays = []
    def __init__(self, data):
        self.data = Path(data); self.ready = False; self.calls = []
    def status(self):
        return {'state': 'ready' if self.ready else 'locked', 'account_configured': True}
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
        self.unlock(); self.server.trusted_owner.path.chmod(0o644)
        self.assertEqual(self.request('GET', '/api/view/session')[0], 401)
        self.assertTrue(self.server.trusted_owner.path.exists())
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


if __name__ == '__main__': unittest.main()
