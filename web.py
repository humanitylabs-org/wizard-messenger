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
from urllib.parse import urlsplit
from typing import cast
from engine import EngineError, MarmotEngine, vault_password
from server import Handler, MessengerServer
import messenger_addresses

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
            session={'csrf':secrets.token_urlsafe(32),'expires':time.time()+12*3600}
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
    def remember_password(self,password):
        with self.lock:
            if self.credential: return
            salt=secrets.token_hex(16)
            self.credential={'salt':salt,'digest':self._digest(password,salt)}
            self._save()

class ViewServer(MessengerServer):
    def __init__(self,address,engine,token,origins):
        super().__init__(address,engine,token,origins)
        data=getattr(engine,'data',None)
        self.auth=BrowserAuth(Path(data)/'browser-auth.json' if data else None)
        # One transaction for provider proof, engine transition and verifier issuance.
        self.setup_lock=threading.Lock()
        self.public_path=os.environ.get('MESSENGER_PUBLIC_PATH','/')
        if not re.fullmatch(r'/(?:[a-zA-Z0-9_-]+/)*',self.public_path):
            raise ValueError('MESSENGER_PUBLIC_PATH must be an app path ending in /')
        self.cookie_secure=os.environ.get('MESSENGER_COOKIE_SECURE','1')!='0'
        self.static_root=Path(__file__).parent/'static'
        self.RequestHandlerClass=ViewHandler

class ViewHandler(Handler):
    @property
    def service(self) -> ViewServer:
        return cast(ViewServer,self.server)
    def _origin(self,required=False):
        origin=self.headers.get('Origin')
        if (required and origin is None) or (origin is not None and origin not in self.service.origins) or self.headers.get('Sec-Fetch-Site')=='cross-site':
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
        return 'wizard_messenger_session='+token+'; Path='+self.service.public_path+'; Max-Age=43200; HttpOnly; SameSite=Strict'+secure
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
    def _dispatch(self,method):
        self.pending_cookie=None
        path=urlsplit(self.path).path
        if path=='/api/view/ticket' and method=='POST':
            # Only a trusted API caller/proxy can mint an initial browser capability.
            super()._authorize(); payload=self._body()
            bootstrap=payload.get('bootstrap') is True and not self.service.engine.status().get('account_configured',False)
            return 200,{'ok':True,'result':{'ticket':self.service.auth.ticket(bootstrap),'expires_in':7*24*3600 if bootstrap else 300}}
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
                if not self.headers.get('Authorization') and self._session() is None and self.service.auth.credential:
                    raise EngineError('session_unlock_required','Enter your passphrase to open Messenger',401)
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
        allowed={'/':'index.html','/index.html':'index.html','/app.css':'app.css','/app.js':'app.js','/favicon.svg':'favicon.svg','/icon.png':'icon.png','/api/spec':'../API-contract.json'}
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
            csp="default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'"
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
