"""Usage: AGENT_STAGE_DIR=<dir> python tests/boot_chain_stage.py <port> [chats] [messages per chat], then node tests/boot_chain_browser.cjs.
Disposable stage for timing Messenger's first open (issue 484): the real ViewServer + real UnifiedInbox store with
<chats> made-up chats (40 by default, 3 messages each) across Telegram, WhatsApp and Signal. No homeserver, no provider, no real
account, no real messages. MESSENGER_STAGE_TRUSTED=1 runs it as a trusted-owner box (the owner edge's proof is added
by the browser test's own small signer, tests/boot_chain_browser.cjs). Writes <dir>/state.json."""
import json, os, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tests'))
OUT = os.environ.get('AGENT_STAGE_DIR') or tempfile.mkdtemp(prefix='boot-chain-stage-'); os.makedirs(OUT, exist_ok=True)
os.environ['MESSENGER_COOKIE_SECURE'] = '0'
import test_web as fx
from web import ViewServer
from unified import UnifiedInbox


class Engine(fx.FakeEngine):
    def __init__(self): super().__init__(); self.ready = True
    def dms(self): return {'dms': []}
    def invites(self): return {'invites': []}
    def messages(self, *a, **k): return {'messages': []}


tmp = tempfile.mkdtemp(dir=OUT)
engine = Engine(); engine.data = tmp
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18984
chats = int(sys.argv[2]) if len(sys.argv) > 2 else 40
per_chat = int(sys.argv[3]) if len(sys.argv) > 3 else 3
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
inbox.mx = lambda path, method='GET', body=None, timeout=15: {'event_id': '$staged'}
inbox.matrix_token = lambda: 'staged'

NETWORKS = ['telegram', 'whatsapp', 'signal']
WORDS = ['see you at the party', 'did you see the cat video?', 'running ten minutes late', 'ok!', 'thanks, that works',
         'can you send the photos?', 'lunch tomorrow?', 'haha yes', 'call me when you are free', 'good night']
t = int(time.time() * 1000) - 86400000
for i in range(chats):
    net, room, name = NETWORKS[i % 3], '!room%d' % i, 'Friend %d' % (i + 1)
    who = '@%s_%d:messenger.internal' % (net, 1000 + i)
    meta = {'network': net, 'kind': 'person', 'label': name, 'names': {who: name}}
    with inbox.store.db() as db:
        db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
    inbox.rooms[room] = meta
    ident = inbox.store.identity(net, room, name)
    for n in range(per_chat):
        t += 6000
        inbox.ingest(ident, meta, {'event_id': '$e%d_%d' % (i, n), 'type': 'm.room.message', 'sender': who, 'origin_server_ts': t,
                                   'content': {'msgtype': 'm.text', 'body': WORDS[(i + n) % len(WORDS)]}})
token, session = server.auth.create()
state = {'port': port, 'origin': origin, 'cookie': token, 'chats': chats, 'data': tmp}
open(os.path.join(OUT, 'state.json'), 'w').write(json.dumps(state))
print('ready', OUT, flush=True)
server.serve_forever()
