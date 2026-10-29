"""Usage: AGENT_STAGE_DIR=<dir> python tests/agent_drafts_stage.py <port>, then node tests/agent_drafts_browser.cjs.
Disposable staging: real ViewServer + real UnifiedInbox store (synthetic chats), fake provider I/O.
No real account, no network providers. Prints JSON with port, owner cookie and agent keys."""
import json, os, sys, tempfile, threading, time
from unittest.mock import Mock
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tests'))
OUT = os.environ.get('AGENT_STAGE_DIR', '/home/oscar/.hermes/cache/scratch/agentkeys'); os.makedirs(OUT, exist_ok=True)
os.environ['MESSENGER_COOKIE_SECURE'] = '0'
import test_web as fx
from web import ViewServer
from unified import UnifiedInbox
from drafts import Drafts

class Engine(fx.FakeEngine):
    def __init__(self): super().__init__(); self.ready = True; self.sent = []
    def dms(self): return {'dms': [{'group_id': 'groupbob', 'members': [{'member_id': '22' * 32, 'display_name': 'Bob Wizard'}, {'member_id': fx.KEY}]}]}
    def invites(self): return {'invites': []}
    def messages(self, *a, **k): return {'messages': []}
    def send(self, group, payload): self.sent.append((group, payload)); return {'message_ids': ['e' * 64], 'published': True}

tmp = tempfile.mkdtemp(dir=OUT)
engine = Engine(); engine.data = tmp
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18931
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
sent = []
inbox.mx = Mock(side_effect=lambda *a, **k: (sent.append(a), {'event_id': '$sent%d' % len(sent)})[1])
now = int(time.time() * 1000)
alice = inbox.store.identity('telegram', '!alice', 'Alice Example')
bob = inbox.store.identity('messenger', 'groupbob', 'Bob Wizard')
inbox.store.add_message('$a1', alice, '@alice', False, 'Are we still on for lunch tomorrow?', now - 600000)
inbox.store.add_message('messenger:b1', bob, 'npubbob', False, 'Ping me when you land', now - 300000)
server.drafts = Drafts(tmp)
token, session = server.auth.create()
agents = {}
for name, level in (('Oscar', 'draft_only'), ('Reader', 'read_only')):
    made = server.agent_keys.create(name); server.agent_keys.set_level(made['agent']['id'], level)
    agents[name] = made['key']
state = {'port': port, 'origin': origin, 'cookie': token, 'agents': agents, 'alice': alice['person_id'], 'bob': bob['person_id'], 'data': tmp}
open(os.path.join(OUT, 'state.json'), 'w').write(json.dumps(state))
threading.Thread(target=lambda: [time.sleep(1) or open(os.path.join(OUT, 'sent.json'), 'w').write(json.dumps({'mx': [list(map(str, a)) for a in sent], 'engine': engine.sent})) for _ in iter(int, 1)], daemon=True).start()
print('ready', flush=True)
server.serve_forever()
