"""New linking routes must never broaden the existing machine-key message grant."""
import threading
import unittest
from unittest.mock import Mock
from web import ViewServer
from connector_web import ConnectorViewHandler
from tests import test_web as webtests
TOKEN, ORIGIN = webtests.TOKEN, webtests.ORIGIN

class ConnectorBoundary(unittest.TestCase):
    request = webtests.ViewBoundary.request
    ticket = webtests.ViewBoundary.ticket
    session = webtests.ViewBoundary.session
    def setUp(self):
        self.server = ViewServer(('127.0.0.1', 0), webtests.FakeEngine(), TOKEN, [ORIGIN])
        self.server.RequestHandlerClass = ConnectorViewHandler
        self.inbox = Mock()
        self.inbox.dispatch.return_value = {'providers': []}
        self.server.unified = self.inbox
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def test_machine_key_cannot_link_even_with_message_grant(self):
        for granted in (False, True):
            if granted: self.server.agent_access.configure({'mode': 'draft_and_send', 'minutes': 60})
            for network in ('telegram', 'whatsapp', 'signal'):
                paths = ['/api/unified/connectors/' + network, '/api/unified/telegram'] if network == 'telegram' else ['/api/unified/connectors/' + network]
                for prefix in paths:
                    for action in ('enable', 'start', 'step', 'cancel', 'disconnect'):
                        with self.subTest(granted=granted, prefix=prefix, action=action):
                            status, _, body = self.request('POST', prefix + '/' + action, {}, {'Authorization':'Bearer ' + TOKEN})
                            self.assertEqual(status, 403)
                            self.assertEqual(body['error']['code'], 'owner_required')
                    self.assertEqual(self.request('GET', prefix + '/status', headers={'Authorization':'Bearer ' + TOKEN})[0], 403)
            self.assertEqual(self.request('GET', '/api/unified/connectors', headers={'Authorization':'Bearer '+TOKEN})[0],403)
        self.inbox.dispatch.assert_not_called()
    def test_owner_session_csrf_origin_and_no_store(self):
        cookie, csrf = self.session()
        path = '/api/unified/connectors/signal/start'
        self.assertEqual(self.request('POST', path, {}, {'Cookie':cookie,'Origin':ORIGIN})[0],403)
        self.assertEqual(self.request('POST', path, {}, {'Cookie':cookie,'Origin':'https://wrong.example','X-Messenger-CSRF':csrf})[0],403)
        self.inbox.dispatch.assert_not_called()
        status, headers, _ = self.request('POST', path, {'flow':'qr'}, {'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})
        self.assertEqual(status,200); self.assertEqual(headers['Cache-Control'],'no-store')
        self.inbox.dispatch.assert_called_once_with('POST',path,{'flow':'qr'},{},None)
    def test_machine_header_cannot_bypass_csrf_using_a_cookie(self):
        cookie, _ = self.session()
        self.server.agent_access.configure({'mode': 'draft_and_send', 'minutes': 60})
        for method in ('GET', 'POST'):
            path = '/api/unified/connectors/signal/' + ('status' if method == 'GET' else 'start')
            status, _, body = self.request(method, path, None if method == 'GET' else {}, {'Cookie':cookie,'Authorization':'Bearer ' + TOKEN})
            self.assertEqual(status,403); self.assertEqual(body['error']['code'],'owner_required')
        self.inbox.dispatch.assert_not_called()

    def test_no_cookie_can_never_read_login_qr(self):
        self.assertEqual(self.request('GET','/api/unified/connectors/signal/status')[0],403)
        self.inbox.dispatch.assert_not_called()

if __name__ == '__main__': unittest.main()
