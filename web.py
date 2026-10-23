"""Container-owned browser view/session bridge. No host service or root-key access."""
from __future__ import annotations
import hashlib
import hmac
from http.cookies import SimpleCookie
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import threading
import time
from urllib.parse import urlsplit, parse_qs
from typing import cast
from engine import EngineError, MarmotEngine, vault_password
from server import Handler, MessengerServer
import messenger_addresses
from unified import UnifiedInbox, Blob, UPLOAD_MAX
from passkey import Passkeys, PasskeyError

# A phone that opened Messenger stays signed in for 30 days (Lock signs out at once).
SESSION_SECONDS=30*24*3600

class BrowserAuth:
    def __init__(self,path=None):
        self.lock=threading.Lock(); self.tickets={}; self.sessions={}; self.credential=None
        self.path=Path(path) if path else None; self.login_attempts=[]
        if self.path and self.path.exists():
            data=json.loads(self.path.read_text())
            self.tickets=data.get('tickets',{}); self.sessions=data.get('sessions',{}); self.credential=data.get('credential')
    def _save(self):
        if self.path:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            tmp=self.path.with_suffix('.tmp')
            with tmp.open('w') as f:
                os.chmod(tmp,0o600)
                json.dump({'tickets':self.tickets,'sessions':self.sessions,'credential':self.credential},f)
                f.flush(); os.fsync(f.fileno())
            os.replace(tmp,self.path)
    def _clean(self):
        now=time.time()
        self.tickets={k:v for k,v in self.tickets.items() if (v['expires'] if isinstance(v,dict) else v)>now}
        self.sessions={k:v for k,v in self.sessions.items() if v['expires']>now}
    def ticket(self,bootstrap=False):
        with self.lock:
            self._clean()
            if len(self.tickets)>=256: raise EngineError('session_limit','Please try opening Messenger again shortly',429)
            token=secrets.token_urlsafe(32)
            self.tickets[hashlib.sha256(token.encode()).hexdigest()]={'expires':time.time()+(7*24*3600 if bootstrap else 300),'bootstrap':bootstrap}
            self._save()
            return token
    def create(self,ticket=None,allow_bootstrap=False):
        with self.lock:
            self._clean()
            if ticket is not None:
                if not isinstance(ticket,str) or len(ticket)>128:
                    raise EngineError('invalid_view_ticket','Open Messenger from Wizard again',401)
                key=hashlib.sha256(ticket.encode()).hexdigest()
                issued=self.tickets.pop(key,None)
                if issued is None or (isinstance(issued,dict) and issued.get('bootstrap') and not allow_bootstrap):
                    self._save()
                    raise EngineError('invalid_view_ticket','Open Messenger from Wizard again',401)
            if len(self.sessions)>=256: raise EngineError('session_limit','Please try again shortly',429)
            token=secrets.token_urlsafe(32)
            session={'csrf':secrets.token_urlsafe(32),'expires':time.time()+SESSION_SECONDS}
            self.sessions[hashlib.sha256(token.encode()).hexdigest()]=session
            self._save()
            return token,session
    def lookup(self,token):
        with self.lock:
            self._clean()
            if not isinstance(token,str) or len(token)>128: return None
            return self.sessions.get(hashlib.sha256(token.encode()).hexdigest())
    @staticmethod
    def _digest(password,salt):
        try: vault_password(password)
        except EngineError: raise EngineError('vault_unlock_failed','That passphrase is not right',401) from None
        return hashlib.scrypt(password.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1,dklen=32).hex()
    def verify_password(self,password,rate_limit=False):
        with self.lock:
            if rate_limit:
                now=time.monotonic(); self.login_attempts=[t for t in self.login_attempts if now-t<60]
                if len(self.login_attempts)>=6:
                    raise EngineError('login_rate_limited','Please wait a minute before trying again',429)
                self.login_attempts.append(now)
            if not self.credential:
                raise EngineError('initial_setup_required','Open Messenger from Wizard to create your address',401)
            digest=self._digest(password,self.credential['salt'])
            if not hmac.compare_digest(digest,self.credential['digest']):
                raise EngineError('vault_unlock_failed','That passphrase is not right',401)
            if rate_limit: self.login_attempts=[]
    def verify_rate(self):
        with self.lock:
            now=time.monotonic(); self.login_attempts=[t for t in self.login_attempts if now-t<60]
            if len(self.login_attempts)>=6:
                raise EngineError('login_rate_limited','Please wait a minute before trying again',429)
            self.login_attempts.append(now)
    def remember_password(self,password):
        with self.lock:
            if self.credential: return
            salt=secrets.token_hex(16)
            self.credential={'salt':salt,'digest':self._digest(password,salt)}
            self._save()

# Agent boundary: the app's machine key (MESSENGER_API_TOKEN) is held by the Wizard host, so
# any agent on the box can find it. It may open the owner's view and read status, but it never
# reads or sends message content unless the owner turns on a time-limited grant from the view.
# Every machine-key call outside the open set is logged (route shape only, never content).
BEARER_OPEN = {
    ('GET', '/healthz'), ('GET', '/api/status'), ('GET', '/api/identity'), ('POST', '/api/view/ticket'),
    ('GET', '/api/unified/status'), ('GET', '/api/unified/telegram/status'), ('POST', '/api/resolve-contact'),
    # Passphrase-proved setup/unlock or lock; returns state, never message content.
    ('POST', '/api/setup'),
}
AGENT_GRANT_MAX_MINUTES = 24 * 60

ROUTE_WORDS = {'api', 'dms', 'messages', 'contacts', 'invites', 'retry', 'accept', 'decline', 'setup', 'unified', 'people',
               'groups', 'labels', 'merge', 'unmerge', 'preview', 'send', 'translate', 'sync', 'telegram', 'status', 'start',
               'step', 'disconnect', 'cancel', 'view', 'session', 'identity', 'resolve-contact', 'mcp', 'spec',
               'updates', 'media', 'upload', 'read', 'typing', 'react', 'edit', 'delete', 'directory'}

def route_shape(path):
    # Log the route's shape only: every id, address or unknown segment becomes :id.
    return '/' + '/'.join(p if p in ROUTE_WORDS else ':id' for p in path.split('/') if p)

class AgentAccess:
    def __init__(self, root=None):
        self.lock = threading.Lock(); self.root = Path(root) if root else None; self.until = 0.0; self.memory_log = []
        if self.root and (self.root / 'agent-access.json').exists():
            try: self.until = float(json.loads((self.root / 'agent-access.json').read_text()).get('until', 0))
            except (ValueError, OSError): self.until = 0.0
    def active(self):
        return self.until > time.time()
    def state(self, limit=50):
        return {'enabled': self.active(), 'until': int(self.until * 1000) if self.active() else None, 'log': self.recent(limit)}
    def grant(self, minutes):
        if not isinstance(minutes, int) or isinstance(minutes, bool) or not 0 <= minutes <= AGENT_GRANT_MAX_MINUTES:
            raise EngineError('invalid_grant', 'Choose off, 1 hour or 24 hours', 400)
        with self.lock:
            self.until = time.time() + minutes * 60 if minutes else 0.0
            if self.root:
                tmp = self.root / 'agent-access.tmp'
                with tmp.open('w') as f:
                    os.chmod(tmp, 0o600); json.dump({'until': self.until}, f)
                os.replace(tmp, self.root / 'agent-access.json')
        self.record('OWNER', '/agent-access', 'granted' if minutes else 'revoked')
        return self.state()
    def record(self, method, route, outcome):
        entry = {'t': int(time.time() * 1000), 'method': method, 'route': route, 'outcome': outcome}
        with self.lock:
            if not self.root:
                self.memory_log = (self.memory_log + [entry])[-500:]; return
            path = self.root / 'agent-access-log.jsonl'
            lines = path.read_text().splitlines()[-499:] if path.exists() else []
            lines.append(json.dumps(entry))
            tmp = self.root / 'agent-access-log.tmp'
            with tmp.open('w') as f:
                os.chmod(tmp, 0o600); f.write('\n'.join(lines) + '\n')
            os.replace(tmp, path)
    def recent(self, limit=50):
        with self.lock:
            if not self.root: return list(reversed(self.memory_log[-limit:]))
            path = self.root / 'agent-access-log.jsonl'
            if not path.exists(): return []
            return [json.loads(l) for l in reversed(path.read_text().splitlines()[-limit:]) if l.strip()]

class ViewServer(MessengerServer):
    def __init__(self,address,engine,token,origins):
        super().__init__(address,engine,token,origins)
        data=getattr(engine,'data',None)
        self.auth=BrowserAuth(Path(data)/'browser-auth.json' if data else None)
        self.passkeys=Passkeys(Path(data)/'passkeys.json' if data else None)
        self.agent_access=AgentAccess(data)
        # One transaction for provider proof, engine transition and verifier issuance.
        self.setup_lock=threading.Lock()
        self.public_path=os.environ.get('MESSENGER_PUBLIC_PATH','/')
        if not re.fullmatch(r'/(?:[a-zA-Z0-9_-]+/)*',self.public_path):
            raise ValueError('MESSENGER_PUBLIC_PATH must be an app path ending in /')
        self.cookie_secure=os.environ.get('MESSENGER_COOKIE_SECURE','1')!='0'
        self.static_root=Path(__file__).parent/'static'
        self.RequestHandlerClass=ViewHandler
        self.unified = UnifiedInbox(data, engine) if data and os.environ.get('UNIFIED_ENABLED') == '1' else None
        if self.unified:
            self.unified.start()

    def server_close(self):
        if getattr(self, 'unified', None):
            self.unified.close()
        super().server_close()

class ViewHandler(Handler):
    @property
    def service(self) -> ViewServer:
        return cast(ViewServer,self.server)
    def _origin(self,required=False):
        origin=self.headers.get('Origin')
        if (required and origin is None) or (origin is not None and not self._origin_allowed(origin)) or self.headers.get('Sec-Fetch-Site')=='cross-site':
            raise EngineError('origin_forbidden','This browser origin is not allowed',403)
    def _session(self):
        try:
            cookies=SimpleCookie(); cookies.load(self.headers.get('Cookie',''))
            token=cookies['wizard_messenger_session'].value
        except (KeyError,ValueError): return None
        return self.service.auth.lookup(token)
    def _authorize(self):
        if urlsplit(self.path).path=='/mcp' and self.command=='POST':
            # Standard Wizard gateway currently has no per-app auth-header channel.
            # This RPC endpoint has only public identity/status tools; the base
            # dispatcher rejects every private read, send and signer capability.
            self._origin()
            return
        if self.headers.get('Authorization'):
            return super()._authorize()
        self._origin(required=self.command in ['POST','DELETE','PUT','PATCH'])
        session=self._session()
        if session is None: raise EngineError('unauthorized','Open Messenger from Wizard to reconnect',401)
        if self.command in ['POST','DELETE','PUT','PATCH']:
            supplied=self.headers.get('X-Messenger-CSRF','')
            if not hmac.compare_digest(supplied.encode(),session['csrf'].encode()):
                raise EngineError('csrf_forbidden','Reopen Messenger before trying again',403)
    def _cookie(self,token):
        secure='; Secure' if self.service.cookie_secure else ''
        return 'wizard_messenger_session='+token+'; Path='+self.service.public_path+'; Max-Age='+str(SESSION_SECONDS)+'; HttpOnly; SameSite=Strict'+secure
    def _headers(self,status,body,mime,csp=None):
        self.send_response(status)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',csp or "default-src 'none'; frame-ancestors 'self'")
        cookie=getattr(self,'pending_cookie',None)
        if cookie: self.send_header('Set-Cookie',cookie)
        self.end_headers()
        self.wfile.write(body)
    def _reply(self,status,data):
        body=json.dumps(data,ensure_ascii=False).encode()
        self._headers(status,body,'application/json; charset=utf-8')
    def _raw_body(self):
        # Owner media upload: raw bytes, size-capped before reading; the type is sniffed server-side.
        if self.headers.get('Transfer-Encoding'):
            raise EngineError('invalid_request','Chunked bodies are not supported',400)
        try: length=int(self.headers.get('Content-Length','0'))
        except ValueError: raise EngineError('invalid_length','Invalid body length',400) from None
        if not 0 < length <= UPLOAD_MAX:
            raise EngineError('too_large','Files up to 25 MB can be sent',413)
        self.connection.settimeout(120)
        data=b''
        while len(data)<length:
            chunk=self.rfile.read(min(1<<20,length-len(data)))
            if not chunk: raise EngineError('invalid_length','Upload was interrupted',400)
            data+=chunk
        return data
    def _blob(self,blob):
        # Media: private cache, Range for audio/video seeking, inline only for safe types.
        size=blob.path.stat().st_size
        start,end,status=0,size-1,200
        rng=re.fullmatch(r'bytes=(\d*)-(\d*)',self.headers.get('Range','').strip())
        if rng and size:
            a,b=rng.groups()
            if a: start=int(a); end=min(int(b),size-1) if b else size-1
            elif b: start=max(0,size-int(b))
            if start>end or start>=size:
                self.send_response(416); self.send_header('Content-Range','bytes */%d'%size); self.send_header('Content-Length','0'); self.end_headers(); return None
            status=206
        self.send_response(status)
        self.send_header('Content-Type',blob.mime)
        self.send_header('Content-Length',str(end-start+1))
        self.send_header('Accept-Ranges','bytes')
        if status==206: self.send_header('Content-Range','bytes %d-%d/%d'%(start,end,size))
        self.send_header('Cache-Control','private, max-age=86400, immutable')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'none'; sandbox")
        safe=re.sub(r'[^A-Za-z0-9._-]','_',blob.filename or 'file')[:80]
        self.send_header('Content-Disposition',('inline' if blob.inline else 'attachment')+'; filename="'+safe+'"')
        self.end_headers()
        with blob.path.open('rb') as f:
            f.seek(start); left=end-start+1
            while left>0:
                chunk=f.read(min(65536,left))
                if not chunk: break
                self.wfile.write(chunk); left-=len(chunk)
        return None
    def _agent_gate(self,method,path):
        # Machine-key callers only; a bad key still fails in _authorize as before.
        if not self.headers.get('Authorization') or (method,path) in BEARER_OPEN: return
        if not hmac.compare_digest(self.headers.get('Authorization','').encode(),('Bearer '+self.service.token).encode()): return
        if path in ('/api/setup','/api/view/session') and not self.service.engine.status().get('account_configured',False): return
        route=route_shape(path)
        if not self.service.agent_access.active():
            self.service.agent_access.record(method,route,'blocked')
            raise EngineError('agent_access_off','Agent access to messages is off. The owner can allow it for a limited time in Messenger → Connected accounts.',403)
        self.service.agent_access.record(method,route,'allowed')
    def _passkey(self,method,path):
        # Fingerprint/face unlock: opens a browser session only; never the encrypted vault.
        if self.headers.get('Authorization'): raise EngineError('owner_only','Fingerprint unlock is set up from the Messenger screen',403)
        self._origin(required=method!='GET')
        origin=self.headers.get('Origin') or ''; rp=urlsplit(origin).hostname or ''
        keys=self.service.passkeys
        try:
            if path=='/api/view/passkey' and method=='GET': return 200,{'ok':True,'result':keys.state()}
            if path=='/api/view/passkey/unlock-options' and method=='POST': return 200,{'ok':True,'result':keys.unlock_options(rp)}
            if path=='/api/view/passkey/unlock' and method=='POST':
                with self.service.setup_lock:
                    self.service.auth.verify_rate()
                    keys.unlock(self._body(),rp,origin)
                    if self.service.engine.status().get('state')!='ready':
                        # Locked vault (restart or Lock): only the passphrase reopens it.
                        raise EngineError('passkey_vault_locked','Type your passphrase once: Messenger restarted or was locked.',401)
                token,session=self.service.auth.create(); self.pending_cookie=self._cookie(token)
                return 200,{'ok':True,'result':{'authenticated':True,'csrf_token':session['csrf'],'status':self.service.engine.status()}}
            self._authorize()
            if self._session() is None: raise EngineError('owner_only','Fingerprint unlock is set up from the Messenger screen',403)
            if path=='/api/view/passkey/register-options' and method=='POST': return 200,{'ok':True,'result':keys.register_options(rp)}
            if path=='/api/view/passkey/register' and method=='POST':
                body=self._body(); return 200,{'ok':True,'result':keys.register(body,rp,origin,body.get('label',''))}
            if path=='/api/view/passkey/clear' and method=='POST': return 200,{'ok':True,'result':keys.clear()}
            if path=='/api/view/passkey/wrap' and method=='POST':
                body=self._body(); return 200,{'ok':True,'result':keys.set_wrap(body.get('id'),body.get('wrap'))}
        except PasskeyError as error:
            code=str(error)
            raise EngineError('passkey_'+code,{'none':'Fingerprint unlock is not set up','expired':'That took too long. Try again.'}.get(code,'Fingerprint unlock did not work. Use your passphrase.'),401 if path.endswith('/unlock') else 400) from None
        raise EngineError('not_found','No such view route',404)
    def _dispatch(self,method):
        self.pending_cookie=None
        path=urlsplit(self.path).path
        self._agent_gate(method,path)
        if path=='/api/view/agent-access':
            # Owner-only: a browser session with CSRF, never the machine key.
            if self.headers.get('Authorization'): raise EngineError('owner_only','Only the owner can change agent access, from the Messenger view',403)
            self._authorize()
            if method=='GET': return 200,{'ok':True,'result':self.service.agent_access.state()}
            if method=='POST': return 200,{'ok':True,'result':self.service.agent_access.grant(self._body().get('minutes'))}
            raise EngineError('not_found','No such view route',404)
        if path.startswith('/api/unified/'):
            self._authorize()
            if self.service.unified is None:
                raise EngineError('not_configured','Unified inbox is not enabled',503)
            raw = self._raw_body() if method == 'PUT' else None
            if method == 'GET' and path.startswith('/api/unified/updates'):
                # Long-poll: the socket must outlive the hold.
                self.connection.settimeout(60)
            result = self.service.unified.dispatch(method,path,self._body() if method == 'POST' else {},parse_qs(urlsplit(self.path).query),raw)
            if isinstance(result, Blob):
                self._blob(result); return None, None
            return 200, {'ok':True,'result':result}
        if path=='/api/view/ticket' and method=='POST':
            # Only a trusted API caller/proxy can mint an initial browser capability.
            super()._authorize(); payload=self._body()
            bootstrap=payload.get('bootstrap') is True and not self.service.engine.status().get('account_configured',False)
            return 200,{'ok':True,'result':{'ticket':self.service.auth.ticket(bootstrap),'expires_in':7*24*3600 if bootstrap else 300}}
        if path.startswith('/api/view/passkey'):
            return self._passkey(method,path)
        if path=='/api/view/unlock' and method=='POST':
            self._origin(required=True); password=self._body().get('vault_password')
            with self.service.setup_lock:
                self.service.auth.verify_password(password,rate_limit=True)
                status=self.service.engine.setup({'action':'unlock','vault_password':password})
            token,session=self.service.auth.create(); self.pending_cookie=self._cookie(token)
            return 200,{'ok':True,'result':{'authenticated':True,'csrf_token':session['csrf'],'status':status}}
        if path=='/api/view/session':
            if method=='POST':
                self._origin(required=True)
                ticket=self._body().get('ticket')
                if not isinstance(ticket,str) or not ticket:
                    raise EngineError('invalid_view_ticket','Open Messenger from Wizard again',401)
                token,session=self.service.auth.create(ticket,allow_bootstrap=not self.service.engine.status().get('account_configured',False))
                self.pending_cookie=self._cookie(token)
            elif method=='GET':
                if not self.headers.get('Authorization') and self._session() is None:
                    if self.service.auth.credential:
                        raise EngineError('session_unlock_required','Enter your passphrase to open Messenger',401)
                    if not self.service.engine.status().get('account_configured',False):
                        # First open from the Wizard launcher: only the owner's setup link can start setup.
                        raise EngineError('setup_link_required','Ask your Wizard for your Messenger setup link',401)
                self._authorize()
                session=self._session()
                if session is None:
                    super()._authorize()
                    token,session=self.service.auth.create(); self.pending_cookie=self._cookie(token)
            else: raise EngineError('not_found','No such view route',404)
            return 200,{'ok':True,'result':{'authenticated':True,'csrf_token':session['csrf']}}
        if path=='/api/resolve-contact' and method=='POST':
            self._authorize()
            return 200,{'ok':True,'result':messenger_addresses.resolve(self._body().get('address'))}
        if path=='/api/setup' and method=='POST':
            self._authorize(); payload=self._body()
            if payload.get('action')=='import':
                raise EngineError('unsupported_action','Use a new dedicated Messenger address in this release',400)
            action=payload.get('action'); password=payload.get('vault_password')
            if action=='lock':
                # Locking never proves or records a passphrase.
                return 200,{'ok':True,'result':self.service.engine.setup({'action':'lock'})}
            # Validate before any provider, account or verifier side effect.
            vault_password(password)
            with self.service.setup_lock:
                if self.service.auth.credential:
                    self.service.auth.verify_password(password)
                before=self.service.engine.status().get('state')
                try:
                    result,proved=self.service.engine.setup_with_proof(payload)
                except EngineError:
                    # Serialized: a fresh transition to ready inside this lock was this password's unlock.
                    if before!='ready' and self.service.engine.status().get('state')=='ready':
                        self.service.auth.remember_password(password)
                    raise
                if proved:
                    self.service.auth.remember_password(password)
                elif not self.service.auth.credential:
                    raise EngineError('relock_required','Lock and unlock Messenger once to confirm its passphrase',409)
            return 200,{'ok':True,'result':result}
        if path=='/api/identity' and method=='GET':
            self._authorize(); result=self.service.engine.identity()
            if result.get('identity'):
                identity=result['identity']
                identity['nprofile']=messenger_addresses.nprofile_encode(identity['account_id'],self.service.engine.relays)
            return 200,{'ok':True,'result':result}
        return super()._dispatch(method)
    def do_GET(self):
        path=urlsplit(self.path).path
        allowed={'/':'index.html','/index.html':'index.html','/app.css':'app.css','/app.js':'app.js','/unified.js':'unified.js','/unified.css':'unified.css','/qr.js':'qr.js','/favicon.svg':'favicon.svg','/icon.png':'icon.png','/icon-192.png':'icon-192.png','/api/spec':'../API-contract.json'}
        if path not in allowed: return self._handle('GET')
        self.pending_cookie=None
        try:
            if path=='/api/spec': self._authorize()
            # The stock gateway may authenticate the HTML request server-side.
            # In that case silently mint a separate HttpOnly browser session.
            if path in ['/','/index.html'] and self.headers.get('Authorization'):
                super()._authorize(); token,_=self.service.auth.create(); self.pending_cookie=self._cookie(token)
            source=self.service.static_root/allowed[path]
            if not source.is_file(): raise EngineError('not_found','Messenger view is not available',404)
            body=source.read_bytes()
            mime=mimetypes.guess_type(source.name)[0] or 'application/octet-stream'
            if mime.startswith('text/') or mime in ['application/javascript','application/json']: mime+='; charset=utf-8'
            csp="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
            self._headers(200,body,mime,csp)
        except EngineError as e: self._reply(e.status,{'ok':False,'error':{'code':e.code,'message':e.message}})
        except (BrokenPipeError,ConnectionResetError): pass
        except OSError: self._reply(500,{'ok':False,'error':{'code':'view_unavailable','message':'Could not load Messenger'}})

if __name__=='__main__':
    os.umask(0o077)
    engine=MarmotEngine(os.environ.get('MESSENGER_DATA','/data'))
    server=ViewServer(('0.0.0.0',int(os.environ.get('MESSENGER_PORT','8765'))),engine,os.environ.get('MESSENGER_API_TOKEN',''),[x for x in os.environ.get('MESSENGER_ALLOWED_ORIGINS','').split(',') if x])
    def stop(*_): threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    try: server.serve_forever()
    finally: server.server_close(); engine.lock()
