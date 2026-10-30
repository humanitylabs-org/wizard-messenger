"""Unmodified Hermes stdio MCP transport -> narrow UDS. No HTTP credential.
Run: python3 /code/mcp.py /agent/broker.sock
"""
import json
import socket
import sys
from broker import OPS, MAX

def call(path, q):
    with socket.socket(socket.AF_UNIX) as s:
        s.settimeout(25)
        s.connect(path)
        s.sendall(json.dumps(q).encode()+b'\n')
        f = s.makefile('rb')
        data = f.readline(4*MAX+1024)
        return json.loads(data)

def tools():
    result = []
    for name, (_, _, _, required, optional) in OPS.items():
        props = {k:{'type': 'integer' if k in ('revision','timestamp') else 'boolean' if k in ('typing','everyone','send_original') else 'string'} for k in required+optional}
        result.append({'name':'messenger_'+name, 'description':'Owner-scoped Messenger '+name.replace('_',' '),
                       'inputSchema':{'type':'object','properties':props,'required':list(required),'additionalProperties':False}})
    return result

def respond(q, path):
    ident, method = q.get('id'), q.get('method')
    if q.get('jsonrpc') != '2.0': raise ValueError('jsonrpc required')
    if method.startswith('notifications/'): return None
    if method == 'initialize': result = {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'messenger-scoped-uds','version':'1.0'}}
    elif method == 'ping': result = {}
    elif method == 'tools/list': result = {'tools':tools()}
    elif method == 'tools/call':
        p = q.get('params', {})
        name = p.get('name','')
        if not name.startswith('messenger_'): raise ValueError('unknown tool')
        r = call(path, {'op':name[len('messenger_'):], 'arguments':p.get('arguments',{})})
        result = {'content':[{'type':'text','text':json.dumps(r.get('result') if r['ok'] else {'error':r['error']})}], 'isError':not r['ok']}
    else: return {'jsonrpc':'2.0','id':ident,'error':{'code':-32601,'message':'Unknown method'}}
    return {'jsonrpc':'2.0','id':ident,'result':result}

def main():
    for line in sys.stdin:
        try:
            if len(line) > MAX: raise ValueError('request limit')
            q = json.loads(line)
            out = respond(q, sys.argv[1])
        except Exception:
            out = {'jsonrpc':'2.0','id':None,'error':{'code':-32600,'message':'Invalid request or broker unavailable'}}
        if out is not None: print(json.dumps(out), flush=True)

if __name__ == '__main__': main()
