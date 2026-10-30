"""Offline regression fixtures; no provider accounts or credentials used."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connectors import Connectors
from connector_sender import LocalOwnerSender
from engine import EngineError


class LoginRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'connectors.json').write_text(json.dumps({'line': {'enabled': True, 'url': 'http://line:29322'}}))
        (self.root / 'connector-secrets.json').write_text(json.dumps({'line': {'provisioning': 'synthetic-test-only'}}))
        self.writer = Mock()
        self.controller = Connectors(self.root, writer=self.writer)
        self.step = {'login_id': 'process', 'step_id': 'qr', 'type': 'display_and_wait', 'txn_id': 'bls_first'}
        self.controller.remember('line', self.step)

    def call(self, action, payload):
        return self.controller.dispatch('POST', ['line', action], payload)

    def test_short_polls_submit_once_and_wait_past_old_transport_limit(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        captured = []
        def writer(**kw):
            captured.append(dict(kw['body']))
            entered.set()
            self.assertTrue(release.wait(5))
            return {**self.step, 'step_id': 'pin', 'txn_id': 'bls_second', 'display_and_wait': {'type': 'code', 'data': '123456'}}
        self.writer.side_effect = writer
        with patch('connectors.STEP_RESPONSE_WAIT', 0):
            result = self.call('step', {**self.step, 'fields': {'password': 'synthetic-secret'}})
            self.assertEqual(result['type'], 'pending')
            self.assertTrue(entered.wait(2))
            for _ in range(3):
                self.assertEqual(self.call('step', self.step)['type'], 'pending')
            self.assertEqual(self.writer.call_count, 1)
            self.assertEqual(self.writer.call_args.kwargs['timeout'], 620)
            self.assertEqual(captured, [{'password': 'synthetic-secret'}])
            self.assertNotIn('synthetic-secret', repr(self.controller.pending))
            job = self.controller._jobs['line']
            release.set(); self.assertTrue(job['done'].wait(2))
            pin = self.call('step', self.step)
            self.assertEqual(pin['step_id'], 'pin')
            self.assertFalse(self.controller._jobs)
            with self.assertRaises(EngineError): self.call('step', self.step)
            self.assertEqual(self.writer.call_count, 1)

    def test_cancel_invalidates_before_io_and_late_worker_cannot_resurrect(self):
        release = threading.Event()
        self.addCleanup(release.set)
        def writer(**kw):
            if '/login/step/' in kw['path']:
                release.wait(5)
                return {**self.step, 'step_id': 'late'}
            self.assertNotIn('line', self.controller.pending)
            return {}
        self.writer.side_effect = writer
        with patch('connectors.STEP_RESPONSE_WAIT', 0):
            self.call('step', self.step)
            job = self.controller._jobs['line']
            self.call('cancel', {'login_id': 'process'})
            replacement = {**self.step, 'login_id': 'new-process'}
            self.controller.remember('line', replacement)
            release.set(); self.assertTrue(job['done'].wait(2))
            self.assertEqual(self.controller.pending['line'][1][0], 'new-process')
            self.assertFalse(self.controller._jobs)
            with self.assertRaises(EngineError): self.call('cancel', {'login_id': 'process'})

    def test_challenges_redact_executable_payload_and_remain_cancellable(self):
        # cookies is a supported step (browser / cURL sign-in) but still never exposes scripts or URLs.
        result = self.controller.remember('line', {**self.step, 'type': 'cookies', 'cookies': {'url': 'https://example.invalid/signin', 'extract_js': 'secret', 'wait_for_url_pattern': 'secret', 'fields': []}})
        self.assertEqual(result['type'], 'cookies')
        self.assertNotIn('secret', repr(result))
        for kind in ('client_http', 'webauthn'):
            with self.subTest(kind=kind):
                result = self.controller.remember('line', {**self.step, 'type': kind, kind: {'url': 'https://example.invalid/secret', 'extract_js': 'secret'}})
                self.assertEqual(result['type'], 'challenge')
                self.assertNotIn('secret', repr(result))
                with self.assertRaises(EngineError) as exc: self.call('step', {**self.step, 'type': kind})
                self.assertEqual(exc.exception.code, 'unsupported_login_challenge')
                self.writer.return_value = {}
                self.call('cancel', {'login_id': 'process'})

    def test_expiry_is_explicit_and_no_upstream_submission(self):
        self.controller.pending['line'] = (0, ('process', 'qr', 'display_and_wait'), 'bls_first')
        with self.assertRaises(EngineError) as exc: self.call('step', self.step)
        self.assertEqual(exc.exception.code, 'login_expired')
        self.writer.assert_not_called()

    def test_fatal_error_not_replayed_and_no_exception_traceback_cached(self):
        self.writer.side_effect = EngineError('login_cancelled', 'Login cancelled', 409)
        for _ in range(2):
            with self.assertRaises(EngineError) as exc: self.call('step', self.step)
            self.assertEqual(exc.exception.code, 'login_cancelled')
        self.assertEqual(self.writer.call_count, 1)
        self.assertIsInstance(self.controller._jobs['line']['error'], tuple)

    def test_refresh_start_cleans_previous_process_before_replacing(self):
        self.writer.side_effect = [{}, {**self.step, 'login_id': 'replacement'}]
        result = self.call('start', {'flow': 'dev.highest.matrix.line.qr_login'})
        self.assertEqual(result['login_id'], 'replacement')
        self.assertIn('/login/cancel/process?', self.writer.call_args_list[0].kwargs['path'])
        self.assertEqual(self.writer.call_count, 2)


class LoginTransportTests(unittest.TestCase):
    def setUp(self):
        self.sender = LocalOwnerSender()
        self.path = '/_matrix/provision/v3/login/step/process/credentials/user_input?user_id=%40owner%3Amessenger.internal'

    def invoke(self):
        return self.sender(network='slack', base='http://slack:29335', path=self.path, method='POST', body={}, timeout=620)

    def test_safe_error_codes_not_raw_provider_text(self):
        for code, expected in [('FI.MAU.BRIDGE.LOGIN_CANCELLED', 'login_cancelled'), ('FI.MAU.BRIDGE.LOGIN_TIMED_OUT', 'login_expired'), ('FI.MAU.SLACK.RATE_LIMITED', 'login_rate_limited'), ('FI.MAU.SLACK.BROWSER_REQUIRED', 'login_challenge_required'), ('FI.MAU.META_UNSUPPORTED_WEB_CHECKPOINT', 'login_challenge_required'), ('DEV.HIGHEST.LINE.NO_KEYCHAIN', 'login_keys_unavailable'), ('unknown', 'login_failed')]:
            with self.subTest(code=code):
                error = HTTPError('http://private.invalid', 400, 'private', {}, io.BytesIO(json.dumps({'errcode': code, 'error': 'secret-provider-url-and-password'}).encode()))
                with patch.object(self.sender.opener, 'open', side_effect=error):
                    with self.assertRaises(EngineError) as exc: self.invoke()
                self.assertEqual(exc.exception.code, expected)
                self.assertNotIn('secret-provider', str(exc.exception))

    def test_timeout_classification_and_long_step_bound(self):
        with patch.object(self.sender.opener, 'open', side_effect=TimeoutError()) as opened:
            with self.assertRaises(EngineError) as exc: self.invoke()
            self.assertEqual(exc.exception.code, 'login_transport_timeout')
            self.assertEqual(opened.call_args.kwargs['timeout'], 620)
            self.assertIn('not proof', str(exc.exception))


if __name__ == '__main__': unittest.main()
