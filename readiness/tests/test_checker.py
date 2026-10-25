import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch
from readiness.check import probe, validate_endpoints


class ProbeTests(unittest.TestCase):
    def target(self, **kw):
        value = dict(id='fixture', base_url='http://127.0.0.1:9999', kind='health', disposable=True)
        value.update(kw)
        return value

    def test_rejects_nonlocal_ambiguous_or_non_disposable_before_network(self):
        urls = ['https://127.0.0.1:12', 'http://localhost:12', 'http://0.0.0.0:12',
                'http://192.168.1.1:12', 'http://example.com:12', 'http://127.0.0.1',
                'http://127.0.0.1:12/api', 'http://user:pass@127.0.0.1:12',
                'http://127.0.0.1:12?token=x', 'http://127.0.0.1:12#x', 'http://127.0.0.1:999999']
        with patch('readiness.check.http.client.HTTPConnection') as connection:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(ValueError): probe(self.target(base_url=url))
            with self.assertRaises(ValueError): probe(self.target(disposable=False))
            with self.assertRaises(ValueError): probe(self.target(kind='send'))
            connection.assert_not_called()
        with self.assertRaises(ValueError): validate_endpoints([self.target(), self.target()])
        with self.assertRaises(ValueError): validate_endpoints([dict(self.target(), proven=True)])

    def test_real_get_semantics_size_bounds_no_redirects_and_no_saved_body(self):
        state = {'status': 200, 'body': b'{"ok":true}'}
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                requests.append(self.path)
                self.send_response(state['status'])
                self.send_header('Location', 'https://example.com/do-not-contact')
                self.send_header('Content-Length', str(len(state['body'])))
                self.end_headers(); self.wfile.write(state['body'])
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        target = self.target(base_url='http://127.0.0.1:' + str(server.server_port))
        try:
            self.assertTrue(probe(target)['passed'])
            state['body'] = b'{"ok":false,"private":"must-not-record"}'
            result = probe(target)
            self.assertFalse(result['passed'])
            self.assertNotIn('must-not-record', json.dumps(result))
            state['status'] = 302
            self.assertFalse(probe(target)['passed'])
            state.update(status=200, body=b'{"ok":true}' + b' '*65536)
            self.assertFalse(probe(target)['passed'])
            state['body'] = b'{"versions":["v1.11"]}'
            self.assertTrue(probe(dict(target, kind='matrix_versions'))['passed'])
            state['body'] = b'{"versions":[]}'
            self.assertFalse(probe(dict(target, kind='matrix_versions'))['passed'])
            self.assertEqual(requests, ['/healthz']*4 + ['/_matrix/client/versions']*2)
        finally:
            server.shutdown(); server.server_close(); thread.join(2)


if __name__ == '__main__': unittest.main()
