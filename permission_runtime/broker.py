"""Fixed-route Messenger adapter. Trusted broker; never executes host commands.
Only this process receives the machine bearer; owner cookies/CSRF are never accepted.
"""
import http.client
import json
import os
from pathlib import Path
import re
import socketserver
import threading
from urllib.parse import urlsplit, quote

# name: (minimum mode, method, fixed route, required arguments, optional arguments)
OPS = {
 'people': (1, 'GET', '/api/unified/directory', (), ()),
 'person': (1, 'GET', '/api/unified/people/{id}', ('id',), ()),
 'drafts': (1, 'GET', '/api/drafts', (), ()),
 'draft': (1, 'GET', '/api/drafts/{id}', ('id',), ()),
 'create_draft': (2, 'POST', '/api/drafts', ('person_id','identity_id','text'), ()),
 'update_draft': (2, 'POST', '/api/drafts/{id}', ('id','revision','person_id','identity_id','text'), ()),
 'preview_draft': (3, 'POST', '/api/drafts/{id}/preview', ('id','revision'), ()),
 'send_draft': (3, 'POST', '/api/drafts/{id}/send', ('id','revision'), ('send_original',)),
 'react': (3, 'POST', '/api/unified/messages/{id}/react', ('id','key'), ()),
 'edit': (3, 'POST', '/api/unified/messages/{id}/edit', ('id','text'), ()),
 'delete_message': (3, 'POST', '/api/unified/messages/{id}/delete', ('id',), ('everyone',)),
 'typing': (3, 'POST', '/api/unified/people/{id}/typing', ('id','typing'), ()),
 'read_receipt': (3, 'POST', '/api/unified/people/{id}/read', ('id','timestamp'), ()),
}
MODES = {'no_access':0, 'read_only':1, 'draft_only':2, 'draft_and_send':3}
MAX = 65536

class Adapter:
    def __init__(self, config_file):
        self.config_file = Path(config_file)
        c = json.loads(self.config_file.read_text())
        u = urlsplit(c['origin'])
        if u.scheme not in ('http','https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
            raise ValueError('fixed origin required')
        # Plain HTTP is only for same-network/local deployment; use TLS otherwise.
        self.origin = u
        self.token = Path(c['token_file']).read_text().strip()
        if len(self.token) < 32: raise ValueError('invalid capability')
        self.lock = threading.Lock()

    def call(self, q):
        # Per-worker owner-configured ceiling AND live app policy on every call.
        # No operation on this socket can alter either policy.
        with self.lock:
            c = json.loads(self.config_file.read_text())
            level = MODES.get(c.get('mode'), 0)
            if not isinstance(q, dict) or set(q) != {'op','arguments'}: raise PermissionError('schema denied')
            op, a = q['op'], q['arguments']
            if not isinstance(op, str) or op not in OPS or not isinstance(a, dict): raise PermissionError('operation denied')
            need, method, path, required, optional = OPS[op]
            if level < need: raise PermissionError('owner worker policy denied')
            if not set(required) <= set(a) or set(a) - set(required) - set(optional): raise PermissionError('arguments denied')
            if 'id' in a:
                if not isinstance(a['id'], str) or not re.fullmatch(r'[A-Za-z0-9_!:@.$-]{1,300}', a['id']): raise ValueError('invalid id')
                path = path.replace('{id}', quote(a['id'], safe=''))
            if 'revision' in a and (type(a['revision']) is not int or a['revision'] < 1): raise ValueError('invalid revision')
            payload = {k:v for k,v in a.items() if k != 'id'}
            body = json.dumps(payload).encode() if method == 'POST' else None
            if body and len(body) > MAX: raise ValueError('request limit')
            u = self.origin
            conn = (http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection)(u.hostname, u.port, timeout=15)
            try:
                conn.request(method, path, body, {'Authorization':'Bearer '+self.token, 'Content-Type':'application/json'})
                resp = conn.getresponse()
                raw = resp.read(4*MAX+1)
                if len(raw) > 4*MAX: raise ValueError('response limit')
                data = json.loads(raw)
                if resp.status != 200 or data.get('ok') is not True:
                    # Never reflect backend error bodies/headers/credentials through socket.
                    raise PermissionError('Messenger rejected operation (%s)' % resp.status)
                return data['result']
            finally:
                conn.close()

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(20)
        try:
            raw = self.rfile.readline(MAX+1)
            if len(raw) > MAX or not raw.endswith(b'\n'): raise ValueError('request limit')
            result = {'ok':True, 'result':self.server.adapter.call(json.loads(raw))}
        except Exception:
            result = {'ok':False, 'error':'Operation denied or Messenger unavailable'}
        self.wfile.write(json.dumps(result).encode()+b'\n')

def serve(config, socket_path):
    adapter = Adapter(config)
    Path(socket_path).unlink(missing_ok=True)
    server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
    server.daemon_threads = True
    server.adapter = adapter
    os.chmod(socket_path, 0o666)  # Dedicated volume: only this worker receives it.
    server.serve_forever()

if __name__ == '__main__':
    import sys
    serve(sys.argv[1], sys.argv[2])
