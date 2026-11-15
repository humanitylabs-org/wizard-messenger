"""Issue 251: Translate (and the other Tinfoil fallbacks) use the connected Wizard Tinfoil app.

Before the fix, the translation worker only knew an install-form TINFOIL_API_KEY, so a box whose Tinfoil app was
connected still answered "Tinfoil not configured". These tests run the real worker function (no key) and a fake
Tinfoil app gateway that checks the bearer the way wizard-tinfoil does.
"""
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

import tinfoil_link
import translation
from unified import UnifiedInbox

TOKEN = 'messenger-box-token-' + 'x' * 40


class FakeTinfoil:
    """The wizard-tinfoil box gateway: /v1/models and /v1/chat/completions behind a per-app bearer."""

    def __init__(self):
        self.tokens = {TOKEN}
        self.models = ['gemma4-31b', 'glm-5-3']
        self.calls = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def reply(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def authed(self):
                auth = self.headers.get('Authorization', '')
                if not any(auth == 'Bearer ' + t for t in fake.tokens) or self.headers.get('Origin'):
                    self.reply(401, {'error': 'Local gateway credential required.'})
                    return False
                return True

            def do_GET(self):
                if self.path == '/v1/models' and self.authed():
                    self.reply(200, {'object': 'list', 'data': [{'id': m} for m in fake.models]})

            def do_POST(self):
                if self.path != '/v1/chat/completions' or not self.authed():
                    return
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fake.calls.append(body)
                if body.get('model') not in fake.models:
                    return self.reply(400, {'error': 'Choose a connected Tinfoil model and supply messages.'})
                self.reply(200, {'choices': [{'message': {'content': 'Hello (via Tinfoil app)'}}]})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = 'http://127.0.0.1:%d' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def worker(base, path, method, body, token, timeout):
    """The real translation worker functions with no install-form key, as on a normal App Store install."""
    with patch.dict(os.environ, {'TINFOIL_API_KEY': ''}):
        if path == '/translate':
            return translation.translate(body['text'], body['language'])
        return translation.complete(body['model'], body['system'], body['user'])


class TinfoilAppLinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = FakeTinfoil()
        self.addCleanup(self.app.close)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.inbox.tinfoil = self.inbox.translator.link = tinfoil_link.TinfoilLink(self.inbox.root, app=self.app.url)
        (self.inbox.root / 'secrets.json').write_text(json.dumps({'translation_token': 'test'}))
        a = self.inbox.store.identity('line', '!a', 'Somchai')
        self.person = a['person_id']
        self.inbox.store.add_message('$th', a, 'somchai', False, 'สวัสดีครับ', 11)
        patcher = patch('unified.http', side_effect=worker)
        self.http = patcher.start()
        self.addCleanup(patcher.stop)

    def link(self, models=('gemma4-31b', 'nope')):
        return self.inbox.dispatch('POST', '/api/unified/tinfoil', {'token': TOKEN, 'models': list(models), 'recommended': ['glm-5-3']})

    def test_before_linking_translate_says_tinfoil_is_not_connected_and_how_to_fix_it(self):
        self.assertEqual(self.inbox.dispatch('GET', '/api/unified/tinfoil', {}), {'linked': False, 'removed': False})
        r = self.inbox.dispatch('POST', '/api/unified/messages/$th/translate', {})
        self.assertIsNone(r['translated'])
        self.assertEqual(r['tinfoil'], 'not_connected')
        self.assertIn('Tinfoil app', r['error'])
        self.assertNotIn('not configured', r['error'])
        self.assertEqual(self.app.calls, [])

    def test_once_linked_translate_goes_through_the_tinfoil_app_without_any_key_in_messenger(self):
        self.assertEqual(self.link(), {'linked': True, 'removed': False})
        saved = self.inbox.root / tinfoil_link.LINK_FILE
        self.assertEqual(stat.S_IMODE(saved.stat().st_mode), 0o600)
        self.assertEqual(json.loads(saved.read_text())['models'], ['gemma4-31b'])
        r = self.inbox.dispatch('POST', '/api/unified/messages/$th/translate', {})
        self.assertEqual((r['translated'], r['error']), ('Hello (via Tinfoil app)', None))
        self.assertNotIn('tinfoil', r)
        sent = self.app.calls[0]
        self.assertEqual(sent['model'], 'gemma4-31b')
        self.assertFalse(sent['stream'])
        self.assertEqual(sent['messages'][1]['content'], 'สวัสดีครับ')
        # Cached like any translation: a second tap never calls Tinfoil again.
        self.inbox.store.update(self.person, {})
        self.inbox.dispatch('POST', '/api/unified/messages/$th/translate', {})
        self.assertEqual(len(self.app.calls), 1)

    def test_the_send_preview_uses_the_tinfoil_app_too(self):
        self.inbox.store.update(self.person, {'language': 'th'})
        before = self.inbox.preview(self.person, {'text': 'Hello'})
        self.assertEqual(before['tinfoil'], 'not_connected')
        self.link()
        after = self.inbox.preview(self.person, {'text': 'Hello'})
        self.assertEqual((after['translated'], after['error']), ('Hello (via Tinfoil app)', None))
        self.assertNotIn('tinfoil', after)

    def test_catch_me_up_completion_falls_back_to_the_tinfoil_app(self):
        with self.assertRaises(ValueError):
            self.inbox.catchup_complete('glm-5-3', 'sys', 'user')
        self.link(models=())  # no list from the page: every model the token can list
        self.assertEqual(self.inbox.catchup_complete('glm-5-3', 'sys', 'user'), 'Hello (via Tinfoil app)')
        self.assertEqual(self.app.calls[-1]['model'], 'glm-5-3')

    def test_an_install_form_key_still_wins(self):
        self.link()
        self.http.side_effect = lambda *a: {'text': 'Hello (install key)', 'error': None}
        r = self.inbox.dispatch('POST', '/api/unified/messages/$th/translate', {})
        self.assertEqual(r['translated'], 'Hello (install key)')
        self.assertEqual(self.app.calls, [])

    def test_removed_on_the_tinfoil_page_drops_the_link_and_says_so(self):
        self.link()
        self.app.tokens.clear()
        r = self.inbox.dispatch('POST', '/api/unified/messages/$th/translate', {})
        self.assertEqual(r['tinfoil'], 'not_connected')
        self.assertEqual(self.inbox.dispatch('GET', '/api/unified/tinfoil', {}), {'linked': False, 'removed': True})
        self.assertNotIn(TOKEN, (self.inbox.root / tinfoil_link.LINK_FILE).read_text())

    def test_a_token_tinfoil_does_not_accept_is_never_kept(self):
        with self.assertRaises(Exception):
            self.inbox.dispatch('POST', '/api/unified/tinfoil', {'token': 'w' * 40})
        with self.assertRaises(Exception):
            self.inbox.dispatch('POST', '/api/unified/tinfoil', {'token': 'short'})
        self.assertFalse((self.inbox.root / tinfoil_link.LINK_FILE).exists())

    def test_linking_requeues_auto_translations_that_failed_for_want_of_tinfoil(self):
        self.inbox.tq_seen.add('$th')
        self.link()
        self.assertNotIn('$th', self.inbox.tq_seen)


if __name__ == '__main__':
    unittest.main()
