"""Loopback-only TLS preview gateway fixture, not a Wizard/WAM installation.
Serve the real shared app-client script; bootstrap only the HTML through the
app capability, exactly as an authenticated owner gateway would.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import os
from pathlib import Path
import ssl

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def proxy(self):
        if self.path == '/wizard-os-home/core/app-client.js':
            data = Path('/shared-core/app-client.js').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data); return
        size = int(self.headers.get('Content-Length', '0'))
        if size > 131072:
            self.send_error(413); return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'connection', 'authorization', 'transfer-encoding')}
        if self.command == 'GET' and self.path in ('/', '/index.html'):
            headers['Authorization'] = 'Bearer ' + os.environ['MESSENGER_API_TOKEN']
        connection = http.client.HTTPConnection('messenger', 8765, timeout=100)
        try:
            connection.request(self.command, self.path, self.rfile.read(size) if size else None, headers)
            response = connection.getresponse(); data = response.read()
            self.send_response(response.status)
            for k, v in response.getheaders():
                if k.lower() not in ('connection', 'transfer-encoding', 'server', 'date'):
                    self.send_header(k, v)
            self.end_headers(); self.wfile.write(data)
        finally: connection.close()
    do_GET = proxy
    do_POST = proxy
    do_DELETE = proxy

if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', 8767), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('/certs/cert.pem', '/certs/key.pem')
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
