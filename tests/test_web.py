import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from engine import EngineError
from web import ViewServer
from web import BrowserAuth
import messenger_addresses as addresses

TOKEN='a'*48
ORIGIN='https://wizard.example.com'
KEY='1'*64

class FakeEngine:
    relays=['wss://relay.example.com']
    def __init__(self): self.ready=False; self.calls=0; self.unlocks=0; self.delay=None
    def status(self): return {'state':'ready' if self.ready else 'setup_required','account_configured':self.ready}
    def setup(self,data): return self.setup_with_proof(data)[0]
    def setup_with_proof(self,data):
        self.calls+=1
        if data.get('action')=='lock': self.ready=False; return self.status(),False
        proved=False
        if not self.ready:
            if self.delay: self.delay()
            self.ready=True; self.unlocks+=1; proved=True
        return self.status(),proved
    def identity(self): return {'identity':{'account_id':KEY,'npub':addresses.npub_encode(KEY)}}
    def contacts(self): return {'contacts':[]}
    def lock(self): pass

class ViewBoundary(unittest.TestCase):
    def setUp(self):
        self.server=ViewServer(('127.0.0.1',0),FakeEngine(),TOKEN,[ORIGIN])
        self.temp=tempfile.TemporaryDirectory()
        self.server.static_root=Path(self.temp.name)
        (self.server.static_root/'index.html').write_text('<h1>Messenger</h1>')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()
    def request(self,method,path,body=None,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        h=dict(headers or {})
        if body is not None: h['Content-Type']='application/json'; body=json.dumps(body)
        conn.request(method,path,body,headers=h); response=conn.getresponse()
        result=response.read(); status=response.status; result_headers=dict(response.getheaders()); conn.close()
        return status,result_headers,json.loads(result) if result_headers.get('Content-Type','').startswith('application/json') else result
    def ticket(self):
        s,_,d=self.request('POST','/api/view/ticket',{}, {'Authorization':'Bearer '+TOKEN})
        self.assertEqual(s,200); return d['result']['ticket']
    def session(self):
        s,h,d=self.request('POST','/api/view/session',{'ticket':self.ticket()},{'Origin':ORIGIN})
        self.assertEqual(s,200)
        self.assertIn('HttpOnly',h['Set-Cookie']); self.assertIn('SameSite=Strict',h['Set-Cookie']); self.assertIn('Secure',h['Set-Cookie'])
        return h['Set-Cookie'].split(';')[0],d['result']['csrf_token']
    def test_unified_routes_keep_owner_cookie_csrf_and_origin_boundary(self):
        from unittest.mock import Mock
        unified = Mock()
        unified.dispatch.return_value = {'people': []}
        self.server.unified = unified
        status, _, _ = self.request('GET', '/api/unified/people')
        self.assertEqual(status, 401)
        unified.dispatch.assert_not_called()
        cookie, csrf = self.session()
        status, _, _ = self.request('POST', '/api/unified/people/id/merge', {'source_id': 'x'}, {'Cookie': cookie, 'Origin': ORIGIN})
        self.assertEqual(status, 403)
        unified.dispatch.assert_not_called()
        status, _, body = self.request('GET', '/api/unified/people', headers={'Cookie': cookie})
        self.assertEqual(status, 200)
        self.assertEqual(body['result'], {'people': []})
        status, _, _ = self.request('POST', '/api/unified/sync', {}, {'Cookie': cookie, 'Origin': ORIGIN, 'X-Messenger-CSRF': csrf})
        self.assertEqual(status, 200)
        unified.dispatch.assert_called_with('POST', '/api/unified/sync', {})

    def test_machine_key_cannot_read_or_send_messages_without_owner_grant(self):
        bearer={'Authorization':'Bearer '+TOKEN}
        for method,path,body in [('GET','/api/dms',None),('GET','/api/contacts',None),('POST','/api/dms/abc/messages',{'text':'x'}),('GET','/api/unified/people',None),('POST','/api/unified/people/p1/send',{})]:
            s,_,d=self.request(method,path,body,bearer)
            self.assertEqual((path,s,d['error']['code']),(path,403,'agent_access_off'))
        self.assertEqual(self.request('GET','/api/status',headers=bearer)[0],200)
        self.assertEqual(self.request('POST','/api/view/ticket',{},bearer)[0],200)
        log=self.server.agent_access.recent()
        self.assertTrue(log and all(e['outcome']=='blocked' for e in log))
        self.assertNotIn('abc',json.dumps(log))
    def test_only_owner_session_can_grant_and_grant_expires_to_off(self):
        bearer={'Authorization':'Bearer '+TOKEN}
        self.assertEqual(self.request('POST','/api/view/agent-access',{'minutes':60},bearer)[0],403)
        cookie,csrf=self.session()
        self.assertEqual(self.request('POST','/api/view/agent-access',{'minutes':60},{'Cookie':cookie,'Origin':ORIGIN})[0],403)
        self.assertEqual(self.request('POST','/api/view/agent-access',{'minutes':99999},{'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})[0],400)
        s,_,d=self.request('POST','/api/view/agent-access',{'minutes':60},{'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})
        self.assertEqual(s,200); self.assertTrue(d['result']['enabled'])
        self.assertNotEqual(self.request('GET','/api/dms',headers=bearer)[0],403)
        self.assertEqual(self.server.agent_access.recent()[0]['outcome'],'allowed')
        self.server.agent_access.until=0
        self.assertEqual(self.request('GET','/api/dms',headers=bearer)[0],403)
        s,_,d=self.request('GET','/api/view/agent-access',headers={'Cookie':cookie})
        self.assertEqual(s,200); self.assertFalse(d['result']['enabled'])
    def test_owner_cookie_reads_are_not_gated_or_logged(self):
        cookie,_=self.session()
        self.assertNotEqual(self.request('GET','/api/dms',headers={'Cookie':cookie})[0],403)
        self.assertEqual(self.server.agent_access.recent(),[])
    def test_static_contains_no_api_capability(self):
        s,h,b=self.request('GET','/')
        self.assertEqual(s,200); self.assertNotIn(TOKEN.encode(),b); self.assertNotIn('Set-Cookie',h)
        self.assertIn("frame-ancestors 'self'",h['Content-Security-Policy'])
    def test_session_cannot_be_created_without_ticket(self):
        for body in [{},{'ticket':None},{'ticket':''},{'ticket':'unknown'}]:
            self.assertEqual(self.request('POST','/api/view/session',body,{'Origin':ORIGIN})[0],401)
    def test_tickets_require_api_authority_and_are_one_use(self):
        self.assertEqual(self.request('POST','/api/view/ticket',{})[0],401)
        ticket=self.ticket()
        self.assertEqual(self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':ORIGIN})[0],200)
        self.assertEqual(self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':ORIGIN})[0],401)
    def test_ticket_exchange_requires_allowed_origin(self):
        ticket=self.ticket()
        self.assertEqual(self.request('POST','/api/view/session',{'ticket':ticket})[0],403)
        self.assertEqual(self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':'https://evil.example'})[0],403)
    def test_cookie_status_and_identity(self):
        cookie,csrf=self.session()
        self.assertEqual(self.request('GET','/api/status',headers={'Cookie':cookie})[0],200)
        s,_,d=self.request('GET','/api/view/session',headers={'Cookie':cookie})
        self.assertEqual(s,200); self.assertEqual(d['result']['csrf_token'],csrf)
        s,_,d=self.request('GET','/api/identity',headers={'Cookie':cookie})
        self.assertEqual(s,200); self.assertEqual(addresses.decode_address(d['result']['identity']['nprofile'])['pubkey'],KEY)
    def test_cookie_write_requires_csrf_and_origin(self):
        cookie,csrf=self.session()
        self.assertEqual(self.request('POST','/api/setup',{}, {'Cookie':cookie,'Origin':ORIGIN})[0],403)
        self.assertEqual(self.request('POST','/api/setup',{}, {'Cookie':cookie,'X-Messenger-CSRF':csrf})[0],403)
        self.assertEqual(self.request('POST','/api/setup',{'action':'lock'}, {'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})[0],200)
    def test_bad_bearer_does_not_fall_back_to_cookie(self):
        cookie,_=self.session()
        self.assertEqual(self.request('GET','/api/status',headers={'Cookie':cookie,'Authorization':'Bearer bad'})[0],401)
    def test_cookie_cannot_mint_tickets(self):
        cookie,csrf=self.session()
        self.assertEqual(self.request('POST','/api/view/ticket',{}, {'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})[0],401)
    def test_cross_site_and_traversal_rejected(self):
        cookie,_=self.session()
        self.assertEqual(self.request('GET','/api/status',headers={'Cookie':cookie,'Sec-Fetch-Site':'cross-site'})[0],403)
        for path in ['/../engine.py','/%2e%2e/engine.py','/engine.py']:
            self.assertNotEqual(self.request('GET',path)[0],200)
    def test_gateway_html_bootstraps_cookie_without_exposing_token(self):
        s,h,b=self.request('GET','/',headers={'Authorization':'Bearer '+TOKEN})
        self.assertEqual(s,200); self.assertIn('Set-Cookie',h); self.assertNotIn(TOKEN.encode(),b)
    def test_resolve_contact_uses_same_boundary(self):
        cookie,csrf=self.session()
        s,_,d=self.request('POST','/api/resolve-contact',{'address':addresses.npub_encode(KEY)},{'Cookie':cookie,'Origin':ORIGIN,'X-Messenger-CSRF':csrf})
        self.assertEqual(s,200); self.assertEqual(d['result']['pubkey'],KEY)
    def test_standard_mcp_needs_no_capability_but_cannot_read_or_send_messages(self):
        s,_,d=self.request('POST','/mcp',{'jsonrpc':'2.0','id':1,'method':'tools/list'})
        self.assertEqual(s,200)
        self.assertEqual({t['name'] for t in d['result']['tools']},{'messenger_status','messenger_public_identity'})
        s,_,d=self.request('POST','/mcp',{'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'messenger_send','arguments':{}}})
        self.assertEqual(s,200); self.assertIn('error',d)
        self.assertEqual(self.request('GET','/api/dms')[0],401)
    def test_first_open_without_setup_link_says_so_and_grants_nothing(self):
        s,h,d=self.request('GET','/api/view/session')
        self.assertEqual(s,401); self.assertEqual(d['error']['code'],'setup_link_required'); self.assertNotIn('Set-Cookie',h)
        self.assertEqual(self.request('GET','/api/identity')[0],401)
    def test_existing_account_can_sign_in_without_install_ticket(self):
        password='test-fixture-passphrase-123'
        self.assertEqual(self.request('POST','/api/setup',{'action':'create','vault_password':password},{'Authorization':'Bearer '+TOKEN})[0],200)
        s,_,d=self.request('GET','/api/view/session')
        self.assertEqual(s,401); self.assertEqual(d['error']['code'],'session_unlock_required')
        self.assertEqual(self.request('POST','/api/view/unlock',{'vault_password':'wrong-fixture-passphrase'},{'Origin':ORIGIN})[0],401)
        s,h,d=self.request('POST','/api/view/unlock',{'vault_password':password},{'Origin':ORIGIN})
        self.assertEqual(s,200); self.assertIn('HttpOnly',h['Set-Cookie']); self.assertIn('csrf_token',d['result'])
    def test_signup_and_import_do_not_have_anonymous_bypasses(self):
        self.assertEqual(self.request('POST','/api/view/unlock',{'vault_password':'some-test-fixture-passphrase'},{'Origin':ORIGIN})[0],401)
        self.assertEqual(self.request('POST','/api/setup',{'action':'create','vault_password':'some-test-fixture-passphrase'},{'Origin':ORIGIN})[0],401)
        self.assertEqual(self.request('POST','/api/setup',{'action':'import'},{'Authorization':'Bearer '+TOKEN})[0],400)
    def test_owner_verifier_does_not_change_when_provider_is_unlocked(self):
        password='test-fixture-passphrase-123'
        self.server.auth.remember_password(password)
        self.assertEqual(self.request('POST','/api/setup',{'action':'unlock','vault_password':'a-different-test-passphrase'},{'Authorization':'Bearer '+TOKEN})[0],401)
        self.server.auth.verify_password(password)
    def test_lock_with_password_never_records_a_verifier(self):
        s,_,_=self.request('POST','/api/setup',{'action':'lock','vault_password':'chosen-but-never-provider-proved'},{'Authorization':'Bearer '+TOKEN})
        self.assertEqual(s,200); self.assertIsNone(self.server.auth.credential)
        self.assertEqual(self.request('POST','/api/view/unlock',{'vault_password':'chosen-but-never-provider-proved'},{'Origin':ORIGIN})[0],401)
    def test_invalid_password_is_rejected_before_any_engine_side_effect(self):
        s,_,d=self.request('POST','/api/setup',{'action':'create','vault_password':'line-one-passphrase\nline-two'},{'Authorization':'Bearer '+TOKEN})
        self.assertEqual(s,400); self.assertEqual(d['error']['code'],'invalid_vault_password')
        self.assertEqual(self.server.engine.calls,0); self.assertIsNone(self.server.auth.credential)
    def test_concurrent_initial_setup_records_only_the_proved_password(self):
        gate=threading.Event(); started=threading.Event()
        def delay(): started.set(); gate.wait(3)
        self.server.engine.delay=delay
        results={}
        def setup(name,password):
            results[name]=self.request('POST','/api/setup',{'action':'create','vault_password':password},{'Authorization':'Bearer '+TOKEN})[0]
        a=threading.Thread(target=setup,args=('a','proved-first-passphrase-123')); a.start(); started.wait(3)
        b=threading.Thread(target=setup,args=('b','unproved-second-passphrase')); b.start()
        gate.set(); a.join(5); b.join(5)
        self.assertEqual(results,{'a':200,'b':401}); self.assertEqual(self.server.engine.unlocks,1)
        self.server.auth.verify_password('proved-first-passphrase-123')
        with self.assertRaises(EngineError): self.server.auth.verify_password('unproved-second-passphrase')

class PersistentBrowserAuth(unittest.TestCase):
    def test_long_bootstrap_ticket_cannot_open_a_configured_account(self):
        auth=BrowserAuth(); ticket=auth.ticket(bootstrap=True)
        with self.assertRaises(EngineError): auth.create(ticket)
        ticket=auth.ticket(bootstrap=True)
        cookie,session=auth.create(ticket,allow_bootstrap=True)
        self.assertIsNotNone(auth.lookup(cookie))
    def test_restart_preserves_hashes_without_password_or_cookie_plaintext(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'auth.json'; auth=BrowserAuth(path)
            password='test-fixture-passphrase-123'; auth.remember_password(password)
            ticket=auth.ticket(); cookie,session=auth.create(ticket)
            raw=path.read_text()
            self.assertNotIn(password,raw); self.assertNotIn(cookie,raw); self.assertNotIn(ticket,raw)
            reloaded=BrowserAuth(path); reloaded.verify_password(password)
            self.assertEqual(reloaded.lookup(cookie)['csrf'],session['csrf'])
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
    def test_guessing_is_rate_limited(self):
        auth=BrowserAuth(); auth.remember_password('test-fixture-passphrase-123')
        for _ in range(6):
            with self.assertRaises(EngineError) as exc: auth.verify_password('a-different-test-passphrase',True)
            self.assertEqual(exc.exception.code,'vault_unlock_failed')
        with self.assertRaises(EngineError) as exc: auth.verify_password('test-fixture-passphrase-123',True)
        self.assertEqual(exc.exception.code,'login_rate_limited')

class AddressCodec(unittest.TestCase):
    def test_npub_round_trip_and_nprofile_hints(self):
        code=addresses.npub_encode(KEY)
        self.assertEqual(addresses.decode_address(code)['pubkey'],KEY)
        profile=addresses.nprofile_encode(KEY,['wss://relay.example.com'])
        self.assertEqual(addresses.decode_address(profile),{'pubkey':KEY,'npub':code,'relays':['wss://relay.example.com']})
    def test_bad_checksum_and_secret_inputs_rejected(self):
        code=addresses.npub_encode(KEY)
        for value in [code[:-1]+'x','nsec1anything',' '+code,code.upper(),'https://example.com/','A'*64]:
            with self.assertRaises(EngineError): addresses.resolve(value)
    def test_nip05_private_dns_never_connects(self):
        answers=[(2,1,6,'',('127.0.0.1',443))]
        with patch('socket.getaddrinfo',return_value=answers),patch('socket.socket') as sock:
            with self.assertRaises(EngineError) as exc: addresses.resolve('user@example.com')
            self.assertEqual(exc.exception.code,'address_lookup_forbidden'); sock.assert_not_called()
    def test_nip05_mixed_public_private_answers_rejected(self):
        answers=[(2,1,6,'',('1.1.1.1',443)),(2,1,6,'',('169.254.169.254',443))]
        with patch('socket.getaddrinfo',return_value=answers):
            with self.assertRaises(EngineError): addresses.resolve('user@example.com')
    def test_nip05_does_not_follow_redirects(self):
        with patch('messenger_addresses.PinnedHTTPS') as http:
            response=http.return_value.getresponse.return_value; response.status=302
            with self.assertRaises(EngineError) as exc: addresses.resolve('user@example.com')
            self.assertEqual(exc.exception.code,'address_not_found')
            http.return_value.request.assert_called_once()
    def test_nip05_existing_mapping(self):
        with patch('messenger_addresses.PinnedHTTPS') as http:
            response=http.return_value.getresponse.return_value; response.status=200
            response.read.return_value=json.dumps({'names':{'user':KEY},'relays':{KEY:['wss://relay.example.com']}}).encode()
            result=addresses.resolve('user@example.com')
            self.assertTrue(result['nip05_verified']); self.assertEqual(result['pubkey'],KEY)

if __name__=='__main__': unittest.main()
