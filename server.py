"""Wizard Messenger's authenticated container HTTP/JSON boundary (API only)."""
from __future__ import annotations
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import os
import signal
import threading
from typing import cast
from urllib.parse import parse_qs, urlsplit
from engine import EngineError, MarmotEngine
from permissions import AgentAccess, PUBLIC, route_shape
from agent_keys import AgentKeys, LABELS as LEVEL_LABELS
from wizard_agents import GatewayGrant, WizardAgents
import agent_tools

MAX_BODY=65536
AGENT_MCP_MAX_BODY=36*1024*1024  # one 25 MiB file as base64 plus JSON
MCP_TOOLS=[
    {'name':'messenger_status','description':'Dedicated messaging vault status; no messages, contacts or secrets','inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
    {'name':'messenger_public_identity','description':'Current public messaging identity only; never private keys or message bodies','inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
]

class MessengerServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self, address, engine, token, origins):
        self.remote_required = os.environ.get('MESSENGER_REMOTE_REQUIRED') == '1'
        if self.remote_required:
            from remote_authority import OfflineEngine
            engine = OfflineEngine(getattr(engine, 'data', None))
        if not isinstance(token,str) or len(token)<32:
            raise ValueError('MESSENGER_API_TOKEN must contain at least 32 characters')
        self.engine, self.token, self.origins=engine, token, frozenset(origins)
        self.agent_access = AgentAccess(getattr(engine, 'data', None))
        # Per-agent keys, each with its own owner-chosen level (agent_keys.py).
        self.agent_keys = AgentKeys(getattr(engine, 'data', None))
        # The Wizard's own agents, reached through the Agent Service gateway with its app grant key (wizard_agents.py).
        self.wizard_agents = WizardAgents(getattr(engine, 'data', None))
        self.gateway_grant = GatewayGrant(os.environ.get('WIZARD_GRANTS_FILE') or None)
        super().__init__(address,Handler)

class Handler(BaseHTTPRequestHandler):
    @property
    def service(self) -> MessengerServer:
        return cast(MessengerServer, self.server)
    def _origin_allowed(self,origin):
        # Configured origins, or the page's own address (the Wizard gateway keeps Host), like other Wizard apps.
        if origin in self.service.origins: return True
        u=urlsplit(origin or '')
        return u.scheme in ('http','https') and bool(u.netloc) and u.netloc==self.headers.get('Host') and not (u.path or u.query or u.fragment)
    protocol_version='HTTP/1.1'
    server_version='WizardMessenger'
    def log_message(self,format,*args):
        pass # URLs, credentials, message bodies and upstream errors never enter access logs.
    def setup(self):
        super().setup()
        self.connection.settimeout(15)
    def _reply(self,status,data):
        body=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)
    def _caller(self):
        """None without credentials; ('machine', None) for the app's machine key (global level);
        ('agent', row) for a per-agent key or a Wizard agent named by the gateway (its own level).
        Unknown bearers are refused."""
        if self.service.gateway_grant.matches(self.headers.get('X-Wizard-Grant')):
            # The Wizard gateway (its app grant key, wizard_agents.py) may name the agent it speaks for, on /mcp
            # only; each agent has the owner's level for it. Elsewhere a request carrying it is refused, even
            # beside an owner cookie, so the gateway's credential can never ride along an owner action.
            if urlsplit(self.path).path != '/mcp':
                raise EngineError('unauthorized', 'A Messenger API capability is required', 401)
            row = self.service.wizard_agents.caller(self.headers.get('X-Wizard-Agent'), self.headers.get('X-Wizard-Agent-Label'))
            if row is None:
                return ('agent', {'id': 'wizard-gateway', 'name': 'Wizard gateway', 'level': 'no_access', 'kind': 'gateway'})
            return ('agent', {'id': 'wizard-' + row['id'], 'name': row['label'], 'level': row['level'], 'kind': 'wizard'})
        authorization = self.headers.get('Authorization')
        if not authorization:
            # A bare call names nobody: the app port is also reachable on the tailnet (Serve), so the Wizard gateway
            # proves itself with its app grant key instead (wizard_agents.py).
            return None
        if hmac.compare_digest(authorization.encode(), ('Bearer ' + self.service.token).encode()):
            return ('machine', None)
        agent = self.service.agent_keys.lookup(authorization)
        if agent is not None:
            return ('agent', agent)
        raise EngineError('unauthorized', 'A Messenger API capability is required', 401)
    def _caller_mode(self, caller):
        return caller[1]['level'] if caller and caller[0] == 'agent' else self.service.agent_access.effective_mode()
    def _authorize(self, machine_only=False):
        caller = self._caller()
        if caller is None or (machine_only and caller[0] != 'machine'):
            raise EngineError('unauthorized','A Messenger API capability is required',401)
        origin=self.headers.get('Origin')
        if origin is not None and not self._origin_allowed(origin):
            raise EngineError('origin_forbidden','This browser origin is not allowed',403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise EngineError('origin_forbidden','Cross-site requests are not permitted',403)
        self._agent_gate(self.command, urlsplit(self.path).path)
    def _agent_gate(self, method, path):
        caller = self._caller()
        if caller is None: return
        if (method, path) in PUBLIC:
            # Launcher tickets are for the trusted machine caller only, never an agent key.
            if caller[0] == 'agent' and path == '/api/view/ticket':
                raise EngineError('agent_permission_denied', 'This action is not allowed for agent keys.', 403)
            return
        mode = caller[1]['level'] if caller[0] == 'agent' else None
        allowed = self.service.agent_access.permits(method, path, mode)
        self.service.agent_access.record(method, route_shape(path), 'allowed' if allowed else 'blocked',
                                         caller[1]['name'] if caller[0] == 'agent' else None)
        if not allowed:
            code = 'agent_access_off' if self._caller_mode(caller) == 'no_access' else 'agent_permission_denied'
            raise EngineError(code, 'This action is not allowed by the owner’s Messenger agent policy.', 403)
    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise EngineError('invalid_request','Chunked bodies are not supported',400)
        if self.headers.get('Content-Type','').split(';')[0].strip() != 'application/json':
            raise EngineError('invalid_content_type','Use application/json',415)
        try: length=int(self.headers.get('Content-Length','0'))
        except ValueError: raise EngineError('invalid_length','Invalid body length',400) from None
        limit=MAX_BODY
        if urlsplit(self.path).path=='/mcp' and (self.headers.get('Authorization') or self.headers.get('X-Wizard-Grant')):
            # Draft attachments arrive as base64 inside the JSON: only a valid per-agent key or the gateway gets the larger cap.
            try: caller=self._caller()
            except EngineError: caller=None
            if caller and caller[0]=='agent': limit=AGENT_MCP_MAX_BODY
        if not 0 < length <= limit:
            raise EngineError('invalid_length','JSON body must be between 1 and %d bytes'%limit,413)
        self.connection.settimeout(15 if limit==MAX_BODY else 120)
        try: payload=json.loads(self.rfile.read(length))
        except (ValueError,OSError): raise EngineError('invalid_json','Invalid JSON body',400) from None
        if not isinstance(payload,dict): raise EngineError('invalid_json','Use a JSON object',400)
        return payload
    def _mcp(self,payload):
        request_id=payload.get('id')
        method=payload.get('method')
        if payload.get('jsonrpc') != '2.0':
            return 400,{'jsonrpc':'2.0','id':request_id,'error':{'code':-32600,'message':'Invalid request'}}
        if method == 'initialize':
            result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'wizard-messenger','version':'0.2.0-unified.15.11'}}
        elif method == 'notifications/initialized':
            return 200,{'jsonrpc':'2.0','id':request_id,'result':{}}
        elif method == 'tools/list': result={'tools':MCP_TOOLS+(agent_tools.TOOLS if agent_tools.offered(self) else [])}
        elif method == 'tools/call':
            params=payload.get('params') or {}
            if params.get('name') in agent_tools.NAMES:
                return 200,{'jsonrpc':'2.0','id':request_id,'result':agent_tools.call(self, params.get('name'), params.get('arguments'))}
            if params.get('arguments') not in [None,{}]:
                return 200,{'jsonrpc':'2.0','id':request_id,'error':{'code':-32602,'message':'No arguments are accepted'}}
            if params.get('name') == 'messenger_status': data=self.service.engine.status()
            elif params.get('name') == 'messenger_public_identity':
                try: data=self.service.engine.identity()
                except EngineError: data={'identity':None,'state':self.service.engine.status()['state']}
            else: return 200,{'jsonrpc':'2.0','id':request_id,'error':{'code':-32601,'message':'Unknown tool'}}
            result={'content':[{'type':'text','text':json.dumps(data)}]}
        else: return 200,{'jsonrpc':'2.0','id':request_id,'error':{'code':-32601,'message':'Unknown method'}}
        return 200,{'jsonrpc':'2.0','id':request_id,'result':result}
    def _dispatch(self,method):
        parsed=urlsplit(self.path)
        path=parsed.path
        if self.service.remote_required:
            from remote_authority import remote_required_gate
            remote_required_gate(method, path)
        if method=='GET' and path=='/healthz':
            return 200,{'ok':True,'service':'wizard-messenger','version':'0.2.0-unified.15.11'}
        self._authorize()
        engine=self.service.engine
        if path=='/mcp' and method=='POST': return self._mcp(self._body())
        if method=='GET':
            if path in ['/api/status','/api/setup']: result=engine.status()
            elif path=='/api/identity': result=engine.identity()
            elif path=='/api/contacts': result=engine.contacts()
            elif path=='/api/invites': result=engine.invites()
            elif path=='/api/dms': result=engine.dms()
            elif path.startswith('/api/dms/') and path.endswith('/messages'):
                parts=path.split('/')
                if len(parts)!=5: raise EngineError('not_found','No such API route',404)
                query=parse_qs(parsed.query)
                try: limit=int(query.get('limit',['100'])[0]); before=int(query['before'][0]) if 'before' in query else None
                except ValueError: raise EngineError('invalid_cursor','Invalid message query',400) from None
                result=engine.messages(parts[3],limit,before,query.get('before_message_id',[None])[0])
            else: raise EngineError('not_found','No such API route',404)
        elif method=='POST':
            payload=self._body()
            if path=='/api/setup': result=engine.setup(payload)
            elif path=='/api/contacts': result=engine.save_contact(payload)
            elif path=='/api/dms': result=engine.create_dm(payload)
            elif path.startswith('/api/invites/'):
                parts=path.split('/')
                if len(parts)!=5: raise EngineError('not_found','No such API route',404)
                result=engine.invite_action(parts[3],parts[4])
            elif path.startswith('/api/dms/') and path.endswith('/messages'):
                parts=path.split('/')
                if len(parts)!=5: raise EngineError('not_found','No such API route',404)
                result=engine.send(parts[3],payload)
            elif path.startswith('/api/dms/') and re.fullmatch(r'/api/dms/[^/]+/messages/[0-9a-f]{64}/(?:edit|delete|react)',path):
                parts=path.split('/')
                payload={**payload,'message_id':parts[5]}
                result={'edit':engine.edit,'delete':engine.delete,'react':engine.react}[parts[6]](parts[3],payload)
            elif path.startswith('/api/dms/') and path.endswith('/retry'):
                parts=path.split('/')
                if len(parts)!=5: raise EngineError('not_found','No such API route',404)
                result=engine.retry(parts[3],payload)
            else: raise EngineError('not_found','No such API route',404)
        elif method=='DELETE' and path.startswith('/api/contacts/'):
            result=engine.delete_contact(path[len('/api/contacts/'):])
        else: raise EngineError('not_found','No such API route',404)
        return 200,{'ok':True,'result':result}
    def _handle(self,method):
        try:
            status,data=self._dispatch(method)
        except EngineError as e:
            self.close_connection=True
            status,data=e.status,{'ok':False,'error':{'code':e.code,'message':e.message}}
        except Exception:
            self.close_connection=True
            status,data=500,{'ok':False,'error':{'code':'internal_error','message':'Messenger could not complete the request'}}
        if status is None: return  # response already streamed (media)
        try: self._reply(status,data)
        except (BrokenPipeError,ConnectionResetError): pass
    def do_GET(self): self._handle('GET')
    def do_PUT(self): self._handle('PUT')
    def do_POST(self): self._handle('POST')
    def do_DELETE(self): self._handle('DELETE')
    def do_OPTIONS(self): self._reply(405,{'ok':False,'error':{'code':'cross_origin_disabled','message':'Cross-origin browser access is disabled'}})

if __name__=='__main__':
    os.umask(0o077)
    from remote_authority import OfflineEngine
    engine=(OfflineEngine if os.environ.get('MESSENGER_REMOTE_REQUIRED') == '1' else MarmotEngine)(os.environ.get('MESSENGER_DATA','/data'))
    server=MessengerServer(('0.0.0.0',int(os.environ.get('MESSENGER_PORT','8765'))),engine,os.environ.get('MESSENGER_API_TOKEN',''),[x for x in os.environ.get('MESSENGER_ALLOWED_ORIGINS','').split(',') if x])
    def stop(*_): threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try: server.serve_forever()
    finally: server.server_close(); engine.lock()
