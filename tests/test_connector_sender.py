"""Normal owner sender exact-route tests; not strong-mode evidence."""
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connector_sender import LocalOwnerSender
from engine import EngineError


class SenderTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                calls.append((self.path, self.command))
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if self.path.startswith('/_matrix/provision/v3/login/cancel/redirect'):
                    self.send_response(307)
                    self.send_header('Location', '/unapproved-secret-target')
                    self.end_headers()
                    return
                out = json.dumps({'ok': True, 'bytes': len(body)}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(out)))
                self.end_headers()
                self.wfile.write(out)
            do_PUT = do_POST
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = 'http://127.0.0.1:' + str(self.server.server_port)
        self.sender = LocalOwnerSender(self.base, bases={'slack': self.base, 'signal': self.base})

    def invoke(self, path, network='matrix', method='POST', **kw):
        return self.sender(network=network, base=self.base, path=path, method=method, body=kw.pop('body', {}), **kw)

    def test_real_loopback_fixed_routes_json_and_binary(self):
        self.assertTrue(self.invoke('/_matrix/provision/v3/login/start/email?user_id=%40owner%3Amessenger.internal', network='slack')['ok'])
        self.assertTrue(self.invoke('/_matrix/client/v3/rooms/%21test%3Amessenger.internal/send/m.room.message/client000', method='PUT')['ok'])
        self.assertEqual(self.invoke('/_matrix/media/v3/upload?filename=photo.png', body=b'test', content_type='image/png')['bytes'], 4)
        self.assertEqual(len(self.calls), 3)

    def test_james_any_file_fixed_upload_name_and_strict_mime(self):
        for mime in ('application/pdf', 'application/zip', 'application/octet-stream', 'image/svg+xml'):
            with self.subTest(mime=mime):
                self.assertEqual(self.invoke('/_matrix/media/v3/upload?filename=attachment', body=b'data', content_type=mime)['bytes'], 4)
        self.assertEqual(len(self.calls), 4)

    def test_james_file_upload_does_not_open_arbitrary_names_or_content_types(self):
        for name in ('report.pdf', 'attachment.pdf', 'attachment/evil', 'attachment%2Epdf', 'attachment&other=x', 'attachment&filename=attachment', ''):
            with self.subTest(name=name), self.assertRaises(EngineError) as err:
                self.invoke('/_matrix/media/v3/upload?filename=' + name, body=b'data', content_type='application/pdf')
            self.assertEqual(err.exception.code, 'sender_route_denied')
        for mime in (None, '', 'application/PDF', 'application/pdf; charset=utf-8', 'application/pdf\r\nX-Evil: yes', 'application/pdf\n',
                     'application/' + 'a' * 81, 'text/with space', 'application', 'app1/pdf', '*/*'):
            with self.subTest(mime=mime), self.assertRaises(EngineError):
                self.invoke('/_matrix/media/v3/upload?filename=attachment', body=b'data', content_type=mime)
        for name in ('photo.jpg', 'voice-message.ogg'):
            with self.subTest(name=name), self.assertRaises(EngineError):
                self.invoke('/_matrix/media/v3/upload?filename=' + name, body=b'data', content_type='application/pdf')
        with self.assertRaises(EngineError):
            self.invoke('/_matrix/media/v3/upload?filename=attachment', body={'not': 'bytes'}, content_type='application/pdf')
        self.assertFalse(self.calls)

    def test_james_connector_inbox_uses_neutral_file_upload(self):
        import tempfile
        from unittest.mock import Mock
        from connector_inbox import ConnectorInbox
        sender = Mock(return_value={'content_uri': 'mxc://messenger.internal/file'})
        with tempfile.TemporaryDirectory() as root:
            inbox = ConnectorInbox(root, Mock(), sender=sender)
            inbox.store.put('matrix_token', 'test-token')
            peer = inbox.store.identity('telegram', '!peer', 'Peer')
            up = inbox.upload(peer['person_id'], 'file', b'%PDF-1.7\ndata', '../../report.pdf')
            sender.assert_called_once_with(network='matrix', base=inbox.matrix, path='/_matrix/media/v3/upload?filename=attachment',
                                           method='POST', body=b'%PDF-1.7\ndata', token='test-token', content_type='application/pdf', timeout=60)
            self.assertEqual(up['name'], 'report.pdf')

    def test_no_generic_forwarding_or_arbitrary_admin(self):
        for path in ['/evil', '/rooms/a/receipt/m.read/b', '/_synapse/admin/v1/users', '/_matrix/client/v3/createRoom', '/_matrix/client/v3/rooms/a/state/m.room.power_levels', '/_matrix/client/v3/rooms/a/send/m.room.message/x?user_id=other', '//other/evil', '/_matrix/client/v3/rooms/%2e%2e/send/m.room.message/x']:
            with self.assertRaises(EngineError): self.invoke(path)
        with self.assertRaises(EngineError): self.invoke('/_synapse/admin/v1/register', body={'username': 'another', 'admin': True})
        with self.assertRaises(EngineError): self.sender(network='matrix', base='http://example.com', path='/_matrix/client/v3/login', method='POST', body={})
        with self.assertRaises(EngineError): self.invoke('/_matrix/provision/v3/logout/all?user_id=%40other%3Amessenger.internal', network='slack')
        self.assertFalse(self.calls)

    def test_redirect_never_forwards_credentials(self):
        with self.assertRaises(EngineError): self.invoke('/_matrix/provision/v3/login/cancel/redirect?user_id=%40owner%3Amessenger.internal', network='slack', token='synthetic-private-token')
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn('/unapproved-secret-target', self.calls[0][0])


if __name__ == '__main__': unittest.main()
