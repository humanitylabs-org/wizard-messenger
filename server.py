"""Wizard Messenger's authenticated container HTTP/JSON boundary (API only)."""
from __future__ import annotations
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import signal
import threading
from typing import cast
from urllib.parse import parse_qs, urlsplit
from engine import EngineError, MarmotEngine

MAX_BODY=65536
MCP_TOOLS=[
    {'name':'messenger_status','description':'Dedicated messaging vault status; no messages, contacts or secrets','inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
    {'name':'messenger_public_identity','description':'Current public messaging identity only; never private keys or message bodies','inputSchema':{'type':'object','properties':{},'additionalProperties':False}},
]

class MessengerServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self, address, engine, token, origins):
        if not isinstance(token,str) or len(token)<32:
            raise ValueError('MESSENGER_API_TOKEN must contain at least 32 characters')
        self.engine, self.token, self.origins=engine, token, frozenset(origins)
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
    def _authorize(self):
        authorization=self.headers.get('Authorization','')
        if not hmac.compare_digest(authorization.encode(),('Bearer '+self.service.token).encode()):
            raise EngineError('unauthorized','A Messenger API capability is required',401)
        origin=self.headers.get('Origin')
        if origin is not None and not self._origin_allowed(origin):
            raise EngineError('origin_forbidden','This browser origin is not allowed',403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise EngineError('origin_forbidden','Cross-site requests are not permitted',403)
    def _body(self):
        if self.headers.get('Transfer-Encoding'):
            raise EngineError('invalid_request','Chunked bodies are not supported',400)
        if self.headers.get('Content-Type','').split(';')[0].strip() != 'application/json':
            raise EngineError('invalid_content_type','Use application/json',415)
        try: length=int(self.headers.get('Content-Length','0'))
        except ValueError: raise EngineError('invalid_length','Invalid body length',400) from None
        if not 0 < length <= MAX_BODY:
            raise EngineError('invalid_length','JSON body must be between 1 and 65536 bytes',413)
        self.connection.settimeout(15)
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
            result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'wizard-messenger','version':'0.2.0-unified.10.6'}}
        elif method == 'notifications/initialized':
            return 200,{'jsonrpc':'2.0','id':request_id,'result':{}}
        elif method == 'tools/list': result={'tools':MCP_TOOLS}
        elif method == 'tools/call':
            params=payload.get('params') or {}
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
        if method=='GET' and path=='/healthz':
            return 200,{'ok':True,'service':'wizard-messenger'}
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
    engine=MarmotEngine(os.environ.get('MESSENGER_DATA','/data'))
    server=MessengerServer(('0.0.0.0',int(os.environ.get('MESSENGER_PORT','8765'))),engine,os.environ.get('MESSENGER_API_TOKEN',''),[x for x in os.environ.get('MESSENGER_ALLOWED_ORIGINS','').split(',') if x])
    def stop(*_): threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try: server.serve_forever()
    finally: server.server_close(); engine.lock()
