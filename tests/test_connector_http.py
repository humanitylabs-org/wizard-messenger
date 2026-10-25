"""Real loopback HTTP boundary with dormant, credential-free provider config."""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from web import ViewServer
from connector_web import ConnectorViewHandler
from connector_inbox import ConnectorInbox
from unified_setup import setup
from connector_setup import setup_connectors


class ConnectorHTTP(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        root = Path(self.tmp.name)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}): setup(root)
        setup_connectors(root)
        engine = Mock()
        engine.data = root
        engine.status.return_value = {'state': 'setup_required', 'account_configured': False}
        self.inbox = ConnectorInbox(root, engine)
        with patch.dict(os.environ, {'UNIFIED_ENABLED': '0'}):
            self.server = ViewServer(('127.0.0.1', 0), engine, 'a' * 48, ['https://wizard.example.com'])
        self.server.RequestHandlerClass = ConnectorViewHandler
        self.server.unified = self.inbox
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.inbox.store._conn.close(); self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        headers = dict(headers or {})
        if body is not None:
            headers['Content-Type'] = 'application/json'; body = json.dumps(body)
        conn.request(method, path, body, headers)
        response = conn.getresponse(); data = response.read(); headers = dict(response.getheaders()); conn.close()
        return response.status, headers, json.loads(data)

    def test_unauthenticated_health_dormant_and_owner_only_even_with_agent_grant(self):
        with patch('connector_inbox.http', side_effect=AssertionError('No external traffic')), patch('connectors.http', side_effect=AssertionError('No external traffic')):
            status, _, health = self.request('GET', '/healthz')
            self.assertEqual(status, 200)
            self.assertFalse(self.inbox.connectors.health()['account_authentication_attempted'])
            self.assertFalse(self.inbox.worker)
            self.server.agent_access.configure({'mode': 'full_access', 'minutes': 60})
            for path in ('/api/unified/connectors', '/api/unified/connectors/signal/status', '/api/unified/telegram/status'):
                status, _, body = self.request('GET', path, headers={'Authorization': 'Bearer ' + 'a' * 48})
                self.assertEqual((status, body['error']['code']), (403, 'owner_required'))
            # A bearer-issued ticket deliberately cannot establish owner authority.
            # Set up a synthetic, independently authenticated owner session here.
            token, owner_session = self.server.auth.create()
            cookie = 'wizard_messenger_session=' + token
            status, headers, result = self.request('GET', '/api/unified/connectors', headers={'Cookie': cookie})
            self.assertEqual(status, 200)
            self.assertIn('no-store', headers.get('Cache-Control', ''))
            self.assertEqual({p['state'] for p in result['result']['providers']}, {'not_configured', 'unsupported'})
            status, _, _ = self.request('POST', '/api/unified/connectors/signal/start', {'flow': 'qr'}, {'Cookie': cookie, 'Origin': 'https://wizard.example.com'})
            self.assertEqual(status, 403)  # CSRF required before provider dispatch.


if __name__ == '__main__': unittest.main()
