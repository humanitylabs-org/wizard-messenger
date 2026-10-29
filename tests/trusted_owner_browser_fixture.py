"""Real HTTP gateway/browser fixture. Never mounts or reads owner data.
The synthetic outer auth cookie is fixture-only, not Wizard production auth.
"""
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from unittest.mock import patch
from test_trusted_owner import SyntheticEngine, PASSWORD, TOKEN
from web import ViewServer
from trusted_owner import HEADER, sign_request


class BrowserEngine(SyntheticEngine):
    def identity(self):
        return {'identity': {'account_id': '1' * 64, 'display_name': 'Synthetic owner'}}
    def dms(self): return {'dms': []}
    def invites(self): return {'invites': []}

class SyntheticInbox:
    def close(self): pass
    def dispatch(self, method, path, body, query, raw):
        if path.startswith('/api/unified/updates'):
            time.sleep(.2)
            return {'seq': 1, 'events': []}
        key = path.rsplit('/', 1)[-1]
        return {key: [], 'providers': [], 'seq': 1}


def run():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp); data = root / 'data'; data.mkdir()
        keys = {name: secrets.token_bytes(32) for name in ('proof', 'wrap')}
        for name, key in keys.items():
            (root/name).write_bytes(key); (root/name).chmod(0o600)
        env = {'MESSENGER_TRUST_WIZARD_OWNER': '1', 'MESSENGER_OWNER_PROOF_KEY_FILE': str(root/'proof'),
               'MESSENGER_OWNER_WRAP_KEY_FILE': str(root/'wrap'), 'MESSENGER_COOKIE_SECURE': '0',
               'CONNECTORS_ENABLED': '0', 'UNIFIED_ENABLED': '0', 'MESSENGER_REMOTE_REQUIRED': '0'}
        live = {}; outer = secrets.token_urlsafe(32)
        def start():
            server = ViewServer(('127.0.0.1', 0), BrowserEngine(data), TOKEN, [live['origin']])
            server.unified = SyntheticInbox()
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            live.update(server=server, thread=thread)
        def stop():
            live['server'].shutdown(); live['server'].server_close(); live['thread'].join()
        class Gateway(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def handle_request(self):
                if self.path == '/fixture/login' and self.command == 'POST':
                    self.send_response(200); self.send_header('Set-Cookie', 'fixture_owner='+outer+'; HttpOnly; SameSite=Strict; Path=/'); self.end_headers(); return
                cookie = SimpleCookie(); cookie.load(self.headers.get('Cookie',''))
                if cookie.get('fixture_owner') is None or cookie['fixture_owner'].value != outer:
                    self.send_response(401); self.end_headers(); self.wfile.write(b'Fixture outer Wizard sign-in required'); return
                if self.path == '/fixture/restart' and self.command == 'POST':
                    stop(); start(); self.send_response(200); self.end_headers(); return
                headers = {k:v for k,v in self.headers.items() if k.lower() not in (HEADER.lower(), 'authorization', 'connection')}
                if self.headers.get('Authorization'):
                    self.send_response(403); self.end_headers(); return
                headers[HEADER] = sign_request(keys['proof'], self.command, self.path)
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length) if length else None
                conn = http.client.HTTPConnection('127.0.0.1', live['server'].server_port, timeout=10)
                conn.request(self.command, self.path, body, headers); response = conn.getresponse(); payload = response.read()
                self.send_response(response.status)
                for key,value in response.getheaders():
                    if key.lower() not in ('connection','server','date'): self.send_header(key,value)
                self.end_headers()
                try: self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError): pass
                finally: conn.close()
            do_GET = handle_request
            do_POST = handle_request
        gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
        live['origin'] = 'http://127.0.0.1:' + str(gateway.server_port)
        with patch.dict(os.environ, env):
            start(); live['server'].auth.remember_password(PASSWORD)
            thread = threading.Thread(target=gateway.serve_forever, daemon=True); thread.start()
            try:
                browser_env = dict(os.environ, FIXTURE_URL=live['origin'], FIXTURE_BACKEND='http://127.0.0.1:'+str(live['server'].server_port))
                subprocess.run(['node', 'tests/trusted_owner_browser.cjs'], env=browser_env, check=True)
            finally:
                ports = (gateway.server_port, live['server'].server_port)
                gateway.shutdown(); gateway.server_close(); thread.join(); stop()
                for port in ports:
                    try:
                        connection = socket.create_connection(('127.0.0.1', port), timeout=.2)
                    except OSError:
                        continue
                    connection.close()
                    raise AssertionError('Fixture listener survived cleanup')


if __name__ == '__main__': run()
