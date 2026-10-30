"""Isolated fixtures only; positive peer mocking is NOT live tailscaled proof."""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import struct
import tempfile
import threading
import unittest
from unittest.mock import patch
from tools.owner_ingress import Ingress, Gateway, UnixHTTP, tailscaled_peer, validate_layout
from owner_unix import OwnerUnixServer
from http.server import BaseHTTPRequestHandler

class Capture(BaseHTTPRequestHandler):
    def log_message(self,format,*args): pass
    def do_GET(self):
        raw=json.dumps({'method':self.command,'path':self.path,'headers':dict(self.headers)}).encode()
        self.send_response(200); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    do_POST=do_GET

class PeerTests(unittest.TestCase):
    def test_private_parent_and_backend_escape_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            cfg={'socket':str(root/'gateway.sock'),'backend_socket':str(root/'backend'/'app.sock')}
            self.assertEqual(validate_layout(cfg),root/'gateway.sock')
            root.chmod(0o755)
            with self.assertRaises(ValueError):validate_layout(cfg)
            root.chmod(0o700)
            cfg['backend_socket']=str(root.parent/'escaped.sock')
            with self.assertRaises(ValueError):validate_layout(cfg)
            (root/'escape').symlink_to(root.parent,target_is_directory=True)
            cfg['backend_socket']=str(root/'escape'/'escaped.sock')
            with self.assertRaises(ValueError):validate_layout(cfg)
    def test_actual_nonroot_peer_rejected(self):
        a,b=socket.socketpair()
        try: self.assertFalse(tailscaled_peer(a))
        finally: a.close();b.close()
    def test_root_other_pid_rejected(self):
        class Peer:
            def getsockopt(self,*_): return struct.pack('3i',999999,0,0)
        with patch('tools.owner_ingress.subprocess.check_output',return_value='927\n'):
            self.assertFalse(tailscaled_peer(Peer()))
    def test_root_nonzero_gid_rejected(self):
        class Peer:
            def getsockopt(self,*_): return struct.pack('3i',927,0,1000)
        self.assertFalse(tailscaled_peer(Peer()))

class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.key=secrets.token_bytes(32)
        self.backend=socketserver.ThreadingUnixStreamServer(str(self.root/'b.sock'),Capture)
        self.gateway=Ingress(str(self.root/'g.sock'),Gateway)
        self.gateway.cfg={'hosts':['wizard.example:8444','wizard.example:8796'],'owner_login':'fixture@owner.invalid','backend_socket':str(self.root/'b.sock')}
        self.gateway.key=self.key
        for s in (self.backend,self.gateway): threading.Thread(target=s.serve_forever,daemon=True).start()
    def tearDown(self):
        for s in (self.gateway,self.backend): s.shutdown();s.server_close()
        self.temp.cleanup()
    def request(self,method='GET',path='/api/view/session?exact=%2F&a=2',headers=None,peer=True):
        h={'Host':'wizard.example:8444','Tailscale-User-Login':'fixture@owner.invalid',**(headers or {})}
        with patch('tools.owner_ingress.tailscaled_peer',return_value=peer):
            c=UnixHTTP(str(self.root/'g.sock'));c.request(method,path,headers=h);r=c.getresponse();raw=r.read();code=r.status;c.close()
        return code,json.loads(raw) if raw else None
    def test_exact_query_proof_and_identity_scrubbing(self):
        code,data=self.request(headers={'X-Messenger-Owner-Proof':'forged','Tailscale-User-Name':'asserted','X-Wizard-Owner':'yes','CF-Access-Jwt-Assertion':'fake','X-Forwarded-User':'fake'})
        self.assertEqual(code,200)
        headers=data['headers'];value=headers.pop('X-Messenger-Owner-Proof');timestamp,nonce,signature=value.split('.')
        expected=hmac.new(self.key,'\n'.join(('wizard-messenger-owner-v1',timestamp,nonce,'GET',data['path'])).encode(),hashlib.sha256).hexdigest()
        self.assertEqual(signature,expected)
        self.assertFalse(any(k.lower().startswith(('tailscale-','x-wizard-','cf-access-','x-forwarded-')) for k in headers))
    def test_unix_serve_authority_is_restored_and_scrubbed(self):
        code,data=self.request(headers={'Host':'localhost','X-Forwarded-Host':'wizard.example:8444'})
        self.assertEqual(code,200)
        self.assertEqual(data['headers']['Host'],'wizard.example:8444')
        self.assertNotIn('X-Forwarded-Host',data['headers'])
        self.assertEqual(self.request(headers={'Host':'localhost','X-Forwarded-Host':'evil.invalid'})[0],403)
        self.assertEqual(self.request(headers={'Host':'localhost'})[0],403)
    def test_anonymous_other_owner_tagged_service_rejected(self):
        for who in ('','stranger@example.invalid','tag:agent'):
            with self.subTest(who=who):self.assertEqual(self.request(headers={'Tailscale-User-Login':who})[0],403)
    def test_bearer_empty_or_present_rejected(self):
        for bearer in ('','Bearer fixture'):
            self.assertEqual(self.request(headers={'Authorization':bearer})[0],403)
    def test_host_origin_and_cross_site_rejected(self):
        for h in ({'Host':'evil.invalid'},{'Origin':'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}):
            self.assertEqual(self.request(headers=h)[0],403)
        self.assertEqual(self.request('POST')[0],403)
        self.assertEqual(self.request('POST',headers={'Origin':'https://wizard.example:8444'})[0],200)
    def test_kernel_peer_denied_before_headers(self):
        self.assertEqual(self.request(peer=False)[0],403)
    def test_ambiguous_framing_and_target(self):
        self.assertEqual(self.request(headers={'Transfer-Encoding':'chunked'})[0],400)
        self.assertEqual(self.request(path='//evil.invalid/')[0],400)
    def test_unix_owner_hop_shares_authority(self):
        class Owner:
            RequestHandlerClass=Capture
        owner=Owner();owner.auth=object();owner.trusted_owner=object();owner.setup_lock=threading.Lock()
        server=OwnerUnixServer(str(self.root/'owner.sock'),owner)
        try:
            self.assertIs(server.auth,owner.auth);self.assertIs(server.trusted_owner,owner.trusted_owner);self.assertIs(server.setup_lock,owner.setup_lock)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            c=UnixHTTP(str(self.root/'owner.sock'));c.request('GET','/healthz');r=c.getresponse();r.read();self.assertEqual(r.status,200);c.close()
            server.shutdown()
        finally:server.server_close()

if __name__=='__main__':unittest.main()
