"""Trusted-Wizard restart drill: real ViewServer behind a signing fixture gateway that can restart Messenger,
answer 502 while it is down, refuse a burst with transient 502s, and forget every session. Synthetic data only.
Run: PYTHONPATH=.:tests PLAYWRIGHT_MODULE=... python3 tests/trusted_restart_fixture.py
The outer cookie is fixture-only, not Wizard production auth."""
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit, parse_qs
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
            time.sleep(1)
            return {'seq': 1, 'events': []}
        key = path.rsplit('/', 1)[-1]
        if key == 'people':
            now = int(time.time() * 1000)
            return {'people': [{'id': 'ana', 'display_name': 'Ana Restart', 'identities': [{'id': 'i-ana', 'network': 'whatsapp', 'kind': 'person'}],
                                'labels': [], 'unread': 0, 'last': {'text': 'still here?', 'original': 'still here?', 'timestamp': now, 'outgoing': False}}], 'seq': 1}
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
        live = {'down_until': 0, 'flaky': {}, 'log': []}; outer = secrets.token_urlsafe(32); lock = threading.Lock()
        def start():
            server = ViewServer(('127.0.0.1', 0), BrowserEngine(data), TOKEN, [live['origin']])
            server.unified = SyntheticInbox()
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            live.update(server=server, thread=thread)
        def stop():
            live['server'].shutdown(); live['server'].server_close(); live['thread'].join()
        class Gateway(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, status, body=b'', ctype='text/plain'):
                self.send_response(status); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            def handle_request(self):
                url = urlsplit(self.path); q = parse_qs(url.query)
                if url.path == '/fixture/login' and self.command == 'POST':
                    self.send_response(200); self.send_header('Set-Cookie', 'fixture_owner='+outer+'; HttpOnly; SameSite=Strict; Path=/'); self.send_header('Content-Length', '0'); self.end_headers(); return
                if url.path.startswith('/fixture/'):
                    if url.path == '/fixture/restart':
                        # Messenger goes away (502 from the gateway) and comes back with a locked vault; sessions persist on disk.
                        down = float(q.get('down', ['3'])[0])
                        with lock: live['down_until'] = time.time() + down; stop()
                        def back():
                            time.sleep(down)
                            with lock: start()
                        threading.Thread(target=back, daemon=True).start()
                    elif url.path == '/fixture/flaky':
                        with lock: live['flaky'] = {k: int(v[0]) for k, v in q.items()}
                    elif url.path == '/fixture/forget-sessions':
                        with lock:
                            live['server'].auth.sessions.clear(); live['server'].auth._save()
                    elif url.path == '/fixture/log':
                        return self.reply(200, json.dumps(live['log']).encode(), 'application/json')
                    return self.reply(200, b'ok')
                cookie = SimpleCookie(); cookie.load(self.headers.get('Cookie', ''))
                if cookie.get('fixture_owner') is None or cookie['fixture_owner'].value != outer:
                    return self.reply(401, b'Fixture outer Wizard sign-in required')
                live['log'].append([round(time.time(), 2), self.command, url.path])
                if url.path.startswith('/api/'):
                    with lock:
                        if time.time() < live['down_until']: return self.reply(502)
                        for key, left in live['flaky'].items():
                            if left > 0 and url.path.startswith('/api/' + key):
                                live['flaky'][key] = left - 1; return self.reply(502 if left % 2 else 503)
                if self.headers.get('Authorization'):
                    return self.reply(403)
                headers = {k: v for k, v in self.headers.items() if k.lower() not in (HEADER.lower(), 'authorization', 'connection')}
                headers[HEADER] = sign_request(keys['proof'], self.command, self.path)
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length) if length else None
                try:
                    with lock: port = live['server'].server_port
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
                    conn.request(self.command, self.path, body, headers); response = conn.getresponse(); payload = response.read()
                except OSError:
                    return self.reply(502)
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ('connection', 'server', 'date'): self.send_header(key, value)
                self.end_headers()
                try: self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError): pass
                finally: conn.close()
            do_GET = handle_request
            do_POST = handle_request
            do_DELETE = handle_request
        gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
        live['origin'] = 'http://127.0.0.1:' + str(gateway.server_port)
        with patch.dict(os.environ, env):
            start()
            server = live['server']; server.auth.remember_password(PASSWORD)
            server.engine.setup({'action': 'unlock', 'vault_password': PASSWORD})
            server.trusted_owner.remember(PASSWORD, server.auth.credential)  # "Remember this Wizard", done once before
            thread = threading.Thread(target=gateway.serve_forever, daemon=True); thread.start()
            try:
                browser_env = dict(os.environ, FIXTURE_URL=live['origin'])
                code = subprocess.run(['node', 'tests/trusted_restart_browser.cjs'], env=browser_env).returncode
            finally:
                gateway.shutdown(); gateway.server_close(); thread.join()
                with lock: stop()
        sys.exit(code)


if __name__ == '__main__': run()
