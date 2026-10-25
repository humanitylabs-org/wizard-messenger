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
            self.tickets=data.get('tickets',{}) if data.get('version') == 2 else {}; self.sessions=data.get('sessions',{}) if data.get('version') == 2 else {}; self.credential=data.get('credential')
    def _save(self):
        if self.path:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            tmp=self.path.with_suffix('.tmp')
            with tmp.open('w') as f:
                os.chmod(tmp,0o600)
                json.dump({'version':2,'tickets':self.tickets,'sessions':self.sessions,'credential':self.credential},f)
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
            session={'csrf':secrets.token_urlsafe(32),'expires':time.time()+SESSION_SECONDS, 'setup_only': ticket is not None,
                     'owner_enrollment': bool(ticket is not None and isinstance(issued, dict) and issued.get('bootstrap'))}
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

# Machine keys are untrusted agent capabilities, never owner browser authority.
from drafts import Drafts

class ViewServer(MessengerServer):
    def __init__(self,address,engine,token,origins):
        super().__init__(address,engine,token,origins)
        engine=self.engine
        data=getattr(engine,'data',None)
        from remote_authority import RemoteAuthority, CachedDirectory
        self.remote_authority=RemoteAuthority.from_environment()
        self.remote_required=os.environ.get('MESSENGER_REMOTE_REQUIRED') == '1'
        if self.remote_required and not data:
            raise ValueError('remote-required needs persistent credential-free data')
        self.auth=BrowserAuth(Path(data)/'browser-auth.json' if data else None)
        from trusted_owner import TrustedOwner
        self.trusted_owner=TrustedOwner.from_environment(data)
        if self.trusted_owner.enabled and any(hmac.compare_digest(key,token.encode()) for key in (self.trusted_owner.proof_key,self.trusted_owner.wrap_key)):
            raise ValueError('Trusted owner keys must not reuse the machine API token')
        if self.trusted_owner.enabled and (self.remote_required or self.remote_authority.endpoint):
            raise ValueError('Trusted Wizard owner access is incompatible with remote authority')
        self.passkeys=Passkeys(Path(data)/'passkeys.json' if data else None)
        self.drafts=Drafts(data)
        # One transaction for provider proof, engine transition and verifier issuance.
        self.setup_lock=threading.Lock()
        self.public_path=os.environ.get('MESSENGER_PUBLIC_PATH','/')
        if not re.fullmatch(r'/(?:[a-zA-Z0-9_-]+/)*',self.public_path):
            raise ValueError('MESSENGER_PUBLIC_PATH must be an app path ending in /')
        self.cookie_secure=os.environ.get('MESSENGER_COOKIE_SECURE','1')!='0'
        self.static_root=Path(__file__).parent/'static'
        if self.remote_required:
            self.RequestHandlerClass=ViewHandler
            self.unified=CachedDirectory(data)
        elif os.environ.get('CONNECTORS_ENABLED') == '1':
            from connector_inbox import ConnectorInbox
            from connector_web import ConnectorViewHandler
            self.RequestHandlerClass = ConnectorViewHandler
            from connector_sender import LocalOwnerSender
            # Normal app only. Parent must authorize actor BEFORE this callback.
            # remote_required above takes precedence; never inject in strong mode.
            sender = LocalOwnerSender(matrix=os.environ.get('MATRIX_URL', 'http://matrix:8008')) if os.environ.get('MESSENGER_CONNECTOR_SENDER_MODE') == 'local-owner' else None
            self.unified = ConnectorInbox(data, engine, sender=sender) if data and os.environ.get('UNIFIED_ENABLED') == '1' else None
        else:
            self.RequestHandlerClass=ViewHandler
            self.unified = UnifiedInbox(data, engine) if data and os.environ.get('UNIFIED_ENABLED') == '1' else None
        self.push = None
        if os.environ.get('MESSENGER_PUSH_ENABLED') == '1':
            from push_notifications.runtime import PushRuntime
            self.push = PushRuntime(data, self.unified, self.public_path)
            self.push.start()
        if self.unified:
            self.unified.start()

    def server_close(self):
        if getattr(self, 'push', None):
            self.push.close()
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
    def _trusted_owner(self):
        # Verify once per HTTP request, never per TCP connection.
        if not getattr(self, '_trusted_owner_verified', False):
            self.service.trusted_owner.require(self)
            self._trusted_owner_verified=True
    def _authorize(self):
        if urlsplit(self.path).path=='/mcp' and self.command=='POST':
            # Standard Wizard gateway currently has no per-app auth-header channel.
            # This RPC endpoint has only public identity/status tools; the base
            # dispatcher rejects every private read, send and signer capability.
            self._origin()
            return
        if self.headers.get('Authorization'):
            return super()._authorize()
        if self.service.trusted_owner.enabled:
            self._trusted_owner()
        self._origin(required=self.command in ['POST','DELETE','PUT','PATCH'])
        session=self._session()
        if session is None: raise EngineError('unauthorized','Open Messenger from Wizard to reconnect',401)
        if session.get('setup_only') and urlsplit(self.path).path == '/api/setup':
            if not session.get('owner_enrollment') or self.service.auth.credential:
                raise EngineError('owner_unlock_required', 'Use an independently issued owner enrollment link or unlock with your passphrase', 403)
        if session.get('setup_only') and urlsplit(self.path).path not in ('/api/setup', '/api/status', '/api/identity', '/api/view/session'):
            raise EngineError('owner_unlock_required', 'Finish setup or unlock with your passphrase first', 403)
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
        if urlsplit(self.path).path == '/push-service-worker.js':
            self.send_header('Service-Worker-Allowed', self.service.public_path)
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
        self._trusted_owner_verified=False
        path=urlsplit(self.path).path
        if self.service.remote_required or bool(self.service.remote_authority.endpoint):
            from remote_authority import remote_required_gate
            remote_required_gate(method, path)
        self._agent_gate(method,path)
        if self.service.trusted_owner.enabled and self.headers.get('Authorization') and path in ('/api/view/session','/api/view/unlock','/api/view/trusted-owner'):
            raise EngineError('owner_only','Owner browser access is required',403)
        if self.service.trusted_owner.enabled and not self.headers.get('Authorization') and path.startswith('/api/'):
            self._trusted_owner()
        if path=='/api/view/trusted-owner' and method=='GET':
            self._trusted_owner()
            return 200,{'ok':True,'result':{'enabled':True,'remembered':self.service.trusted_owner.path.exists()}}
        if path.startswith('/api/view/push'):
            # Bearers (including Full access) never possess notification authority.
            if self.headers.get('Authorization'):
                raise EngineError('owner_only', 'Only the owner can manage notifications', 403)
            self._authorize()
            push = self.service.push
            if method == 'GET' and path == '/api/view/push':
                return 200, {'ok': True, 'result': push.config() if push else {'enabled': False}}
            if push is None:
                raise EngineError('not_configured', 'Notifications are not configured', 503)
            if method == 'POST' and path in ('/api/view/push/subscribe', '/api/view/push/unsubscribe'):
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise EngineError('invalid_request', 'JSON required', 400)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                except ValueError:
                    length = 0
                if not 0 < length <= 8192:
                    raise EngineError('too_large', 'Invalid subscription size', 413)
                from push_notifications import OwnerAPI
                from push_notifications.runtime import OWNER
                try:
                    result = OwnerAPI(push.store, lambda _: OWNER).handle(self, path.rsplit('/', 1)[1], self._body())
                except (ValueError, TypeError, PermissionError):
                    raise EngineError('invalid_subscription', 'Invalid notification subscription', 400) from None
                return 200, {'ok': True, 'result': result}
            raise EngineError('not_found', 'No such notification route', 404)
        if path == '/api/view/authority':
            if self.headers.get('Authorization'):
                raise EngineError('owner_only', 'Independent review configuration is owner-only', 403)
            self._authorize()
            if method != 'GET': raise EngineError('not_found', 'No such authority route', 404)
            state = self.service.remote_authority.state()
            state['required'] = self.service.remote_required or bool(self.service.remote_authority.endpoint)
            return 200, {'ok': True, 'result': state}
        if path == '/api/view/telegram/application':
            # Initial app keys are private owner settings, not agent capabilities.
            if self.headers.get('Authorization'):
                raise EngineError('owner_only', 'Only the owner can set up Telegram from Messenger.', 403)
            self._authorize()
            if self.service.remote_required or self.service.remote_authority.endpoint:
                raise EngineError('owner_only', 'Configure Telegram on the trusted owner service.', 403)
            if method != 'POST':
                raise EngineError('not_found', 'No such Telegram setup route', 404)
            data = getattr(self.service.engine, 'data', None)
            if not data or self.service.unified is None:
                raise EngineError('telegram_plumbing_unavailable', 'Telegram is not installed on this Messenger.', 503)
            from telegram_application import configure_application
            body = self._body()
            with self.service.setup_lock:
                result = configure_application(data, body)
            return 200, {'ok': True, 'result': result}
        if path=='/api/view/agent-access':
            # Owner-only: a browser session with CSRF, never the machine key.
            if self.headers.get('Authorization'): raise EngineError('owner_only','Only the owner can change agent access, from the Messenger view',403)
            self._authorize()
            if method=='GET': return 200,{'ok':True,'result':self.service.agent_access.state()}
            if method=='POST': return 200,{'ok':True,'result':self.service.agent_access.configure(self._body())}
            raise EngineError('not_found','No such view route',404)
        if path == '/api/drafts' or path.startswith('/api/drafts/'):
            self._authorize()
            if self.service.unified is None:
                raise EngineError('not_configured', 'Unified inbox is not enabled', 503)
            suffix = path.split('/')[3:]
            result = self.service.drafts.dispatch(method, suffix, self._body() if method in ('POST', 'DELETE') else {},
                self.service.unified, owner=not bool(self.headers.get('Authorization')),
                authority=self.service.remote_authority,
                remote_required=self.service.remote_required or bool(self.service.remote_authority.endpoint),
                can_send=bool(self.headers.get('Authorization')) and self.service.agent_access.effective_mode() == 'draft_and_send')
            return 200, {'ok': True, 'result': result}
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
            super()._authorize(); self._body()
            bootstrap=False  # Machine callers cannot issue owner enrollment authority.
            return 200,{'ok':True,'result':{'ticket':self.service.auth.ticket(bootstrap),'expires_in':7*24*3600 if bootstrap else 300}}
        if path.startswith('/api/view/passkey'):
            return self._passkey(method,path)
        if path=='/api/view/unlock' and method=='POST':
            self._origin(required=True); body=self._body(); password=body.get('vault_password')
            if body.get('remember_wizard') is True:
                self._trusted_owner()
            with self.service.setup_lock:
                self.service.auth.verify_password(password,rate_limit=True)
                status=self.service.engine.setup({'action':'unlock','vault_password':password})
                if body.get('remember_wizard') is True:
                    self.service.trusted_owner.remember(password,self.service.auth.credential)
            token,session=self.service.auth.create(); self.pending_cookie=self._cookie(token)
            return 200,{'ok':True,'result':{'authenticated':True,'csrf_token':session['csrf'],'status':status}}
        if path=='/api/view/session':
            if method=='POST':
                self._origin(required=True)
                ticket=self._body().get('ticket')
                if not isinstance(ticket,str) or not ticket:
                    raise EngineError('invalid_view_ticket','Open Messenger from Wizard again',401)
                if self.service.engine.status().get('account_configured',False) or self.service.auth.credential:
                    raise EngineError('session_unlock_required', 'Enter your passphrase to open Messenger', 401)
                token,session=self.service.auth.create(ticket,allow_bootstrap=True)
                self.pending_cookie=self._cookie(token)
            elif method=='GET':
                if self.service.trusted_owner.enabled and self._session() is None:
                    # Never create an identity, redeem enrollment or change its passphrase.
                    self._trusted_owner()
                    with self.service.setup_lock:
                        if not self.service.auth.credential:
                            raise EngineError('setup_link_required','Finish the existing Messenger enrollment first',401)
                        password=self.service.trusted_owner.password(self.service.auth.credential)
                        if password is None:
                            raise EngineError('session_unlock_required','Unlock once with your existing passphrase and choose Remember this Wizard',401)
                        self.service.auth.verify_password(password)
                        if self.service.engine.status().get('state')!='ready':
                            self.service.engine.setup({'action':'unlock','vault_password':password})
                        token,session=self.service.auth.create()
                        self.pending_cookie=self._cookie(token)
                    return 200,{'ok':True,'result':{'authenticated':True,'csrf_token':session['csrf']}}
                if self.service.trusted_owner.enabled and self.service.engine.status().get('state')!='ready':
                    with self.service.setup_lock:
                        password=self.service.trusted_owner.password(self.service.auth.credential)
                        if password is None:
                            raise EngineError('session_unlock_required','Unlock with your existing passphrase',401)
                        self.service.auth.verify_password(password)
                        self.service.engine.setup({'action':'unlock','vault_password':password})
                if not self.headers.get('Authorization') and self._session() is None:
                    if self.service.auth.credential:
                        raise EngineError('session_unlock_required','Enter your passphrase to open Messenger',401)
                    if not self.service.engine.status().get('account_configured',False):
                        # First open from the Wizard launcher: only the owner's setup link can start setup.
                        raise EngineError('setup_link_required','Ask your Wizard for your Messenger setup link',401)
                self._authorize()
                session=self._session()
                if session is None:
                    raise EngineError('session_unlock_required', 'Enter your passphrase to open Messenger', 401)
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
                with self.service.setup_lock:
                    if self.service.trusted_owner.enabled:
                        self.service.trusted_owner.forget()
                        with self.service.auth.lock:
                            self.service.auth.sessions.clear()
                            self.service.auth._save()
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
            # Setup-link cookies never become unlocked owner sessions. The owner
            # must prove the newly established passphrase through /view/unlock.
            return 200,{'ok':True,'result':result}
        if path=='/api/identity' and method=='GET':
            self._authorize(); result=self.service.engine.identity()
            if result.get('identity'):
                identity=result['identity']
                identity['nprofile']=messenger_addresses.nprofile_encode(identity['account_id'],self.service.engine.relays)
            return 200,{'ok':True,'result':result}
        return super()._dispatch(method)
    def do_GET(self):
        self._trusted_owner_verified=False
        path=urlsplit(self.path).path
        if path == '/push-service-worker.js':
            self.pending_cookie = None
            if self.service.push is None:
                return self._reply(404, {'ok': False})
            return self._headers(200, self.service.push.script(), 'application/javascript; charset=utf-8')
        allowed={'/':'index.html','/index.html':'index.html','/app.css':'app.css','/app.js':'app.js','/unified.js':'unified.js','/unified.css':'unified.css','/qr.js':'qr.js','/connectors.js':'connectors.js','/favicon.svg':'favicon.svg','/icon.png':'icon.png','/icon-192.png':'icon-192.png','/api/spec':'../API-contract.json'}
        if path not in allowed: return self._handle('GET')
        self.pending_cookie=None
        try:
            if path=='/api/spec': self._authorize()
            # A gateway/agent bearer can load public HTML, but NEVER mint an owner cookie.
            if path in ['/','/index.html'] and self.headers.get('Authorization'):
                if not hmac.compare_digest(self.headers['Authorization'].encode(), ('Bearer '+self.service.token).encode()):
                    raise EngineError('unauthorized', 'Invalid capability', 401)
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

def provision_owner_enrollment(service):
    """Trusted local operator hook, deliberately not reachable through HTTP/MCP.

    Enable only for first-run startup. The link is a secret: retrieve it through
    owner-controlled local provisioning, never through the agent bearer API.
    """
    if service.auth.credential or service.engine.status().get('account_configured', False):
        raise ValueError('Owner enrollment is only available before account setup')
    if service.auth.path is None:
        raise ValueError('Owner enrollment requires persistent private data')
    ticket = service.auth.ticket(bootstrap=True)
    target = service.auth.path.parent / 'owner-enrollment.json'
    # Exclusive creation prevents overwriting an owner-provisioned link or symlink.
    with open(target, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump({'fragment': '#ticket=' + ticket, 'expires_in': 7*24*3600}, output)
        output.flush(); os.fsync(output.fileno())
    return target


if __name__=='__main__':
    os.umask(0o077)
    from remote_authority import OfflineEngine
    engine=(OfflineEngine if os.environ.get('MESSENGER_REMOTE_REQUIRED') == '1' else MarmotEngine)(os.environ.get('MESSENGER_DATA','/data'))
    server=ViewServer(('0.0.0.0',int(os.environ.get('MESSENGER_PORT','8765'))),engine,os.environ.get('MESSENGER_API_TOKEN',''),[x for x in os.environ.get('MESSENGER_ALLOWED_ORIGINS','').split(',') if x])
    if (os.environ.get('MESSENGER_PROVISION_OWNER_ENROLLMENT') == '1'
            and not server.auth.credential
            and not server.engine.status().get('account_configured', False)
            and server.auth.path is not None
            and not (server.auth.path.parent / 'owner-enrollment.json').exists()):
        provision_owner_enrollment(server)
    def stop(*_): threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    try: server.serve_forever()
    finally: server.server_close(); engine.lock()
