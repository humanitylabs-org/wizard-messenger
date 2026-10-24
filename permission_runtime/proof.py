"""Actual restricted Docker worker -> scoped broker -> normal Messenger HTTP.
Run from repository: python3 permission_runtime/proof.py. No pulls/live accounts.
"""
import json
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'same_host_isolation'))
from deployment import Deployment, docker
from proof import check
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

class RuntimeDeployment(Deployment):
    def __init__(self):
        super().__init__()
        self.names['app'] = self.prefix+'-app'
        self.network = self.prefix+'-private'
        self.image_tag = self.prefix+'-runtime'
        self.base_image = self.image
        base_tag = self.prefix+'-base:local'
        docker('tag',self.base_image,base_tag)
        try:
            docker('build','--network=none','--pull=false','--build-arg','RUNTIME_BASE='+base_tag,'-t',self.image_tag,HERE)
        finally:
            docker('image','rm',base_tag)
        self.image = docker('image','inspect',self.image_tag,'--format','{{.Id}}')
    def common(self, name, uid):
        args = super().common(name, uid)
        i = args.index('type=bind,src=%s,dst=/code,readonly' % (ROOT/'same_host_isolation'))
        del args[i-1:i+1]  # code is baked into the image, never a host bind
        return args
    def start(self):
        docker('network','create','--internal',self.network)
        for key in ('agent','state'):
            docker('volume','create',self.vol[key]); self.volumes.append(self.vol[key])
        init = """from pathlib import Path
import os,secrets,json
p=Path('/state/token');p.write_text(secrets.token_hex(32));os.chown(p,10001,10001);os.chmod(p,0o600)
p=Path('/state/config.json');p.write_text(json.dumps({'origin':'http://app:8765','token_file':'/state/token','mode':'no_access'}));os.chown(p,10001,10001);os.chmod(p,0o600)
for p in ['/agent','/state']:
 os.chmod(p,0o755 if p=='/agent' else 0o700); os.chown(p,10001,10001)
"""
        docker('run','--rm','--pull=never','--network','none','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=FOWNER',
          '--mount','type=volume,src='+self.vol['agent']+',dst=/agent','--mount','type=volume,src='+self.vol['state']+',dst=/state',
          self.base_image,'python3','-c',init)
        for role, uid in [('app',10001),('broker',10001),('worker',10002)]:
            args = self.common(self.names[role], uid)
            if role != 'worker': args[args.index('none')] = self.network
            if role == 'app': args += ['--network-alias','app','--mount','type=bind,src='+str(ROOT)+',dst=/app,readonly']
            for key in (('state',) if role == 'app' else ('agent','state') if role == 'broker' else ('agent',)):
                args += ['--mount','type=volume,src='+self.vol[key]+',dst=/'+key+(',readonly' if role == 'worker' else '')]
            args += ['--env','MESSENGER_COOKIE_SECURE=0']
            cmd = ['/app/permission_runtime/app_fixture.py'] if role == 'app' else ['/code/broker.py','/state/config.json','/agent/broker.sock'] if role == 'broker' else ['-c','import time;time.sleep(86400)']
            self.containers.append(self.names[role]); docker(*args,self.image,*cmd)
        for _ in range(60):
            try:
                self.owner('GET','/api/status'); return
            except Exception: time.sleep(.1)
        raise RuntimeError('app not ready '+docker('logs',self.names['app']))
    def owner(self, method, path, body=None, bad_csrf=False):
        code = """import http.client,json
from pathlib import Path
h=json.loads(Path('/state/owner.json').read_text());h['Content-Type']='application/json'
if %r: h['X-Messenger-CSRF']='bad'
c=http.client.HTTPConnection('127.0.0.1',8765);c.request(%r,%r,json.dumps(%r) if %r else None,h)
r=c.getresponse();print(json.dumps({'status':r.status,'body':json.loads(r.read())}))
""" % (bad_csrf,method,path,body,body is not None)
        return json.loads(docker('exec',self.names['app'],'python3','-c',code))
    def policy(self, mode, app_mode=None):
        code = "from pathlib import Path;import json;p=Path('/state/config.json');c=json.loads(p.read_text());c['mode']=%r;p.write_text(json.dumps(c))" % mode
        docker('exec',self.names['broker'],'python3','-c',code)
        r = self.owner('POST','/api/view/agent-access',{'mode':app_mode or mode})
        assert r['status']==200,r
        assert self.owner('GET','/api/view/agent-access')['body']['result']['mode']==(app_mode or mode)
    def rpc(self, op, arguments=None):
        q = {'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'messenger_'+op,'arguments':arguments or {}}}
        out = docker('exec',self.names['worker'],'python3','-c',
          "import subprocess; p=subprocess.run(['python3','/code/mcp.py','/agent/broker.sock'],input=%r,text=True,capture_output=True);print(p.stdout,end='')" % (json.dumps(q)+'\n'))
        r=json.loads(out)['result']
        return {'ok':not r['isError'],'result':json.loads(r['content'][0]['text'])}
    def ledger(self):
        return json.loads(docker('exec',self.names['app'],'python3','-c',"from pathlib import Path;import json;p=Path('/state/ledger.jsonl');print(json.dumps([json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []))"))
    def cleanup(self):
        try: super().cleanup()
        finally:
            docker('image','rm',self.image_tag)
            docker('network','rm',self.network)
            assert self.network not in docker('network','ls','--format','{{.Name}}').splitlines()

def main():
    d = RuntimeDeployment()
    print('NORMAL MESSENGER HTTP + FIXTURE PROVIDER CALLBACK ONLY; no current Oscar confinement claim',flush=True)
    print('IMAGE '+d.image,flush=True)
    try:
        d.start()
        h=json.loads(docker('inspect',d.names['worker']))[0]
        cfg=h['HostConfig']
        check('worker no network, nonroot, RO, no caps/admin mounts',cfg['NetworkMode']=='none' and cfg['ReadonlyRootfs'] and cfg['CapDrop']==['ALL'] and h['Config']['User']=='10002:10002' and {m['Destination'] for m in h['Mounts']}=={'/agent'} and all(not m['RW'] for m in h['Mounts']))
        check('default no access enforced',not d.rpc('drafts')['ok'])
        d.policy('read_only')
        check('real app read through MCP and broker',d.rpc('people')['ok'])
        # Official MCP SDK exercises initialization/discovery/stdio transport used by Hermes.
        import subprocess
        sdk = '''import asyncio,sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
async def main():
 p=StdioServerParameters(command='docker',args=['exec','-i',sys.argv[1],'python3','/code/mcp.py','/agent/broker.sock'])
 async with stdio_client(p) as (r,w):
  async with ClientSession(r,w) as s:
   await s.initialize()
   t=await s.list_tools(); assert any(x.name=='messenger_create_draft' for x in t.tools)
   out=await s.call_tool('messenger_drafts',{}); assert not getattr(out,'isError',getattr(out,'is_error',True)),out
 print('PASS official MCP SDK initialization, discovery and broker-backed read')
asyncio.run(main())
'''
        p=subprocess.run([sys.executable,'-c',sdk,d.names['worker']],text=True,capture_output=True,cwd=ROOT)
        check('MCP SDK transport interoperates',p.returncode==0,p.stdout+p.stderr)
        print(p.stdout,flush=True)
        recipient=json.loads(docker('exec',d.names['app'],'python3','-c',"from pathlib import Path;print(Path('/state/recipient.json').read_text())"))
        fields={'person_id':recipient['person_id'],'identity_id':recipient['id'],'text':'Initial fixture draft'}
        check('read-only cannot draft',not d.rpc('create_draft',fields)['ok'])
        d.policy('draft_only')
        draft=d.rpc('create_draft',fields)['result']['draft']; ident=draft['id']
        check('real persisted draft readback',d.rpc('draft',{'id':ident})['result']['draft']==draft)
        for op,args in [('send_draft',{'id':ident,'revision':1}),('preview_draft',{'id':ident,'revision':1}),('react',{'id':'m','key':'x'}),('typing',{'id':'p','typing':True}),('read_receipt',{'id':'p'}),('edit',{'id':'m','text':'x'}),('delete_message',{'id':'m'}),('policy',{'mode':'draft_and_send'}),('approve',{'id':ident}),('http',{'url':'http://app:8765/api/setup'})]:
            check('draft-only broker denies '+op,not d.rpc(op,args)['ok'])
        # Actual restricted kernel/container attacks, not simulated exceptions.
        attack = (ROOT/'same_host_isolation'/'attack.py').read_text()
        attack = attack.replace("paths = [", "paths = ['/state/token', '/state/config.json', '/state/owner.json', '/app', ", 1)
        # Existing attack script speaks old fixture op schemas; its malicious payloads
        # remain valid negative tests on the stricter runtime schema.
        print(docker('exec',d.names['worker'],'python3','-c',attack),flush=True)
        check('no worker-caused callback',d.ledger()==[])
        path='/api/drafts/'+ident
        changed={**fields,'text':'Exact owner edited fixture text','revision':1}
        r=d.owner('POST',path,changed);check('owner HTTP edit with cookie+CSRF',r['status']==200)
        check('owner edit readback',d.rpc('draft',{'id':ident})['result']['draft']['text']==changed['text'])
        check('owner wrong CSRF denied',d.owner('POST',path+'/preview',{'revision':2},True)['status']==403)
        check('owner HTTP preview',d.owner('POST',path+'/preview',{'revision':2})['status']==200)
        check('review alone has zero callbacks',d.ledger()==[])
        check('owner exact click send',d.owner('POST',path+'/send',{'revision':2})['status']==200)
        check('owner callback exact text and recipient',len(d.ledger())==1 and d.ledger()[0]['body']['body']==changed['text'] and '%21alice' in d.ledger()[0]['path'])
        check('send persisted and idempotent',d.rpc('draft',{'id':ident})['result']['draft']['state']=='sent' and d.owner('POST',path+'/send',{'revision':2})['status']==200 and len(d.ledger())==1)
        d.policy('draft_and_send',app_mode='draft_only')
        second=d.rpc('create_draft',fields)['result']['draft']
        check('app policy still denies despite broker ceiling',not d.rpc('preview_draft',{'id':second['id'],'revision':1})['ok'])
        d.policy('draft_and_send')
        check('explicit Draft-and-send preview',d.rpc('preview_draft',{'id':second['id'],'revision':1})['ok'])
        check('explicit Draft-and-send callback',d.rpc('send_draft',{'id':second['id'],'revision':1})['ok'] and len(d.ledger())==2)
        for op in ('policy','provision','owner_session','approve','shell','http'):
            check('Draft-and-send denies admin '+op,not d.rpc(op)['ok'])
        d.policy('no_access')
        check('live revocation denies reads',not d.rpc('drafts')['ok'])
        print('PASS runtime vertical slice: two fixture callbacks (one owner click, one explicitly permitted agent)',flush=True)
    finally: d.cleanup()

if __name__ == '__main__': main()
