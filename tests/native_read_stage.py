"""Usage: AGENT_STAGE_DIR=<dir> python tests/native_read_stage.py <port>
Disposable staging for the native-read evidence screenshots (16.32): the real ViewServer and UnifiedInbox store with
SYNTHETIC chats on LINE, WhatsApp and Telegram fed through the real ingest path. A control port (port+1) replays what the
bridges send when the owner reads a chat in the network's own app: an m.receipt from the owner through the real
UnifiedInbox.ephemeral. GET /read?room=!line-ann&event=$... applies it; GET /state shows numbers only.
No homeserver, provider or real account. Writes <dir>/state.json."""
import itertools, json, os, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tests'))
OUT = os.environ.get('AGENT_STAGE_DIR') or sys.exit('AGENT_STAGE_DIR required'); os.makedirs(OUT, exist_ok=True)
os.environ['MESSENGER_COOKIE_SECURE'] = '0'
import test_web as fx
from web import ViewServer
from unified import UnifiedInbox
from drafts import Drafts


class Engine(fx.FakeEngine):
    def __init__(self): super().__init__(); self.ready = True
    def dms(self): return {'dms': []}
    def invites(self): return {'invites': []}
    def messages(self, *a, **k): return {'messages': []}


tmp = tempfile.mkdtemp(dir=OUT)
engine = Engine(); engine.data = tmp
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18981
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
_sent = itertools.count(1)
inbox.mx = Mock(side_effect=lambda *a, **k: {'event_id': '$sent%d' % next(_sent)})
inbox.matrix_token = lambda: 'staged'
server.drafts = Drafts(tmp)
now = int(time.time() * 1000)
CHATS = [
    ('line', '!line-ann', 'Ann (LINE)', 'person', 'Uann', ['Are you free for dinner?', 'The booking is at seven', 'I will wait by the station']),
    ('line', '!line-ben', 'Ben (LINE)', 'person', 'Uben', ['Sent you the photos', 'Call me when you can']),
    ('whatsapp', '!wa-cleo', 'Cleo (WhatsApp)', 'person', '15550102', ['Landed safely', 'See you tomorrow']),
    ('telegram', '!tg-dev', 'Dev (Telegram)', 'person', '42', ['Build is green', 'Shipping now', 'Thanks!']),
]
state, idents = {'chats': {}}, {}
for n, (network, room, label, kind, uid, lines) in enumerate(CHATS):
    peer = '@%s_%s:messenger.internal' % (network, uid.lower())
    ident = inbox.store.identity(network, room, label, kind)
    meta = {'network': network, 'kind': kind, 'label': label, 'names': {peer: label.split(' ')[0]}}
    with inbox.store.db() as db:
        db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
    inbox.rooms[room] = meta
    ids = []
    for i, text in enumerate(lines):
        event = {'event_id': '$%s-%d' % (room.strip('!'), i), 'type': 'm.room.message', 'origin_server_ts': now - (len(lines) - i + n) * 60000,
                 'sender': peer, 'content': {'msgtype': 'm.text', 'body': text}}
        inbox.ingest(ident, meta, event); ids.append(event['event_id'])
    state['chats'][room] = {'id': ident['person_id'], 'label': label, 'events': ids}
    idents[room] = ident

OWNER = inbox.owner


class Control(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        url = urlsplit(self.path); q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == '/read':
            inbox.ephemeral(idents[q['room']], [{'type': 'm.receipt', 'content': {q['event']: {'m.read': {OWNER: {'ts': 1}}}}}])
        body = json.dumps({'read_sync': inbox.read_sync_stats(), 'unread': {r['label']: p['unread'] for r in state['chats'].values()
                           for p in inbox.store.people('person') if p['id'] == r['id']}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', port + 1), Control).serve_forever, daemon=True).start()
token, session = server.auth.create()
state.update({'port': port, 'control': 'http://127.0.0.1:%d' % (port + 1), 'origin': origin, 'cookie': token, 'data': tmp})
with open(os.path.join(OUT, 'state.json'), 'w') as f: f.write(json.dumps(state))
print('ready', flush=True)
server.serve_forever()
