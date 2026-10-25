#!/usr/bin/env python3
"""Miguel's private Serve ingress. Kernel peer authentication precedes headers.
No TCP listener. No credential/enrollment logging. Host administrator is trusted.
"""
import argparse
import hashlib
import hmac
import http.client
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time

DOMAIN = 'wizard-messenger-owner-v1'
HOP = {'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'}

def tailscaled_peer(conn):
    pid, uid, gid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid != 0 or gid != 0 or pid <= 1:
        return False
    # Query the system manager, not a caller-owned PID file; follows daemon restart.
    expected = subprocess.check_output(['systemctl','show','tailscaled.service','--property=MainPID','--value'], timeout=3, text=True).strip()
    proc = Path('/proc') / str(pid)
    return str(pid) == expected and proc.stat().st_uid == 0 and (proc/'comm').read_text().strip() == 'tailscaled'

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=30)
        self.path = path
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)

class Ingress(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def verify_request(self, request, address):
        try:
            ok = tailscaled_peer(request)
        except (OSError, ValueError, subprocess.SubprocessError):
            ok = False
        if not ok:
            try: request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            except OSError: pass
        return ok

class Gateway(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def setup(self):
        super().setup()
        self.connection.settimeout(30)
    def deny(self, code, reason):
        self.close_connection = True
        raw = json.dumps({'ok':False,'error':{'code':reason}}).encode()
        self.send_response(code)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Connection','close')
        self.end_headers()
        self.wfile.write(raw)
    def handle_proxy(self):
        cfg = self.server.cfg
        # Serve overwrites Tailscale identity headers after TLS/WhoIs resolution.
        # Duplicates, anonymous and tagged/service identities must fail closed.
        def one(name):
            values = self.headers.get_all(name, [])
            return values[0] if len(values) == 1 else None
        host = one('Host')
        login = one('Tailscale-User-Login')
        if host not in cfg['hosts'] or login != cfg['owner_login']:
            return self.deny(403,'authenticated_owner_required')
        if self.headers.get_all('Authorization') is not None:
            return self.deny(403,'bearer_owner_handoff_denied')
        origin = one('Origin')
        if self.headers.get_all('Origin') and origin != 'https://' + host:
            return self.deny(403,'origin_forbidden')
        if self.command not in ('GET','HEAD') and origin != 'https://' + host:
            return self.deny(403,'origin_required')
        if len(self.headers.get_all('Sec-Fetch-Site', [])) > 1 or one('Sec-Fetch-Site') not in (None,'same-origin','none'):
            return self.deny(403,'cross_site_forbidden')
        raw_target = self.raw_requestline.split(b' ', 2)[1]
        if not raw_target.startswith(b'/') or raw_target.startswith(b'//') or not self.path.startswith('/') or self.path.startswith('//') or '#' in self.path or '\\' in self.path:
            return self.deny(400,'invalid_target')
        if self.headers.get_all('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1:
            return self.deny(400,'ambiguous_body')
        try: length = int(one('Content-Length') or '0')
        except ValueError: return self.deny(400,'invalid_length')
        if not 0 <= length <= 32*1024*1024:
            return self.deny(413,'body_too_large')
        # Consume exactly one request; never forward hop-by-hop or asserted identity.
        connection_tokens = {x.strip().lower() for x in (one('Connection') or '').split(',')}
        headers = {}
        for k,v in self.headers.items():
            low = k.lower()
            if low in HOP | connection_tokens or low.startswith(('tailscale-','x-messenger-','x-wizard-','cf-access-','x-forwarded-')) or low in {'forwarded','x-real-ip','remote-user','proxy'}:
                continue
            headers[k] = v
        timestamp, nonce = str(int(time.time())), secrets.token_hex(24)
        message = '\n'.join((DOMAIN,timestamp,nonce,self.command,self.path)).encode()
        headers['X-Messenger-Owner-Proof'] = '.'.join((timestamp,nonce,hmac.new(self.server.key,message,hashlib.sha256).hexdigest()))
        headers['Connection'] = 'close'
        body = self.rfile.read(length) if length else None
        if body is not None and len(body) != length:
            return self.deny(400,'truncated_body')
        backend = UnixHTTP(cfg['backend_socket'])
        try:
            backend.request(self.command,self.path,body=body,headers=headers)
            response = backend.getresponse()
            data = response.read(64*1024*1024+1)
            if len(data) > 64*1024*1024:
                raise ValueError('response_limit')
            self.send_response(response.status)
            for k,v in response.getheaders():
                if k.lower() not in HOP | {'content-length','server','date'}:
                    self.send_header(k,v)
            self.send_header('Content-Length',str(len(data)))
            self.send_header('Connection','close')
            self.end_headers()
            if self.command != 'HEAD': self.wfile.write(data)
            self.close_connection = True
        except (OSError, http.client.HTTPException, ValueError):
            self.deny(502,'messenger_unavailable')
        finally: backend.close()
    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = handle_proxy

def validate_layout(cfg):
    path = Path(cfg['socket'])
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Ingress socket parent must be owned by the gateway UID and mode 0700')
    # The permissive rootless backend socket must remain below this same private
    # host parent; reject symlink escapes before any listener is activated.
    backend = Path(cfg['backend_socket']).resolve()
    if not backend.is_relative_to(path.parent.resolve()) or backend == path.resolve():
        raise ValueError('Backend socket must be separate and below the private ingress parent')
    return path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    args=parser.parse_args()
    cfg=json.loads(Path(args.config).read_text())
    keypath=Path(cfg['proof_file'])
    fd=os.open(keypath,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        key=os.read(fd,33)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or len(key)!=32:
            raise ValueError('invalid_private_key')
    finally: os.close(fd)
    path=validate_layout(cfg)
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode): raise ValueError('not_a_socket')
        path.unlink()
    os.umask(0o077)
    server=Ingress(str(path),Gateway)
    server.cfg,server.key=cfg,key
    os.chmod(path,0o600)
    def stop(*_): threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    try: server.serve_forever()
    finally: server.server_close(); path.unlink(missing_ok=True)

if __name__=='__main__': main()
