"""Usage: AGENT_STAGE_DIR=<dir> python tests/line_photo_stage.py <port>, then tests/native_read_shell_proxy.py for the shell host.
Disposable staging for the LINE-photo evidence (16.33): real ViewServer + real UnifiedInbox store, one SYNTHETIC LINE chat whose
photos are shaped exactly like the LINE bridge's (m.image with a url and body image.jpg and NO info block) fed through the real
ingest path, plus a sticker. Image bytes are generated with ffmpeg and pre-seeded into the media cache the media route reads:
no homeserver, provider or real account. Writes <dir>/state.json."""
import hashlib, itertools, json, os, subprocess, sys, tempfile, time
from unittest.mock import Mock
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
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18991
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
_sent = itertools.count(1)
inbox.mx = Mock(side_effect=lambda *a, **k: {'event_id': '$sent%d' % next(_sent)})
inbox.matrix_token = lambda: 'staged'
server.drafts = Drafts(tmp)
cache = os.path.join(tmp, 'unified', 'media-cache'); os.makedirs(cache, mode=0o700, exist_ok=True)


def seed(mxc, vf):
    """A synthetic gradient picture under the cache key the media route computes for this mxc (thumbnail and full)."""
    jpg = os.path.join(tmp, 'g.jpg')
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=640x480:c0=%s:c1=%s:duration=1:r=1' % vf,
                    '-frames:v', '1', jpg], check=True)
    data = open(jpg, 'rb').read()
    for kind in ('thumb', 'full'):
        key = hashlib.sha256((mxc + '|' + kind).encode()).hexdigest()
        open(os.path.join(cache, key), 'wb').write(data); open(os.path.join(cache, key + '.type'), 'w').write('image/jpeg')


now = int(time.time() * 1000)
peer = '@line_uann:messenger.internal'
room = '!line-photos'
ident = inbox.store.identity('line', room, 'Ann (LINE)', 'person')
meta = {'network': 'line', 'kind': 'person', 'label': 'Ann (LINE)', 'names': {peer: 'Ann'}}
with inbox.store.db() as db:
    db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
inbox.rooms[room] = meta
rows = [
    ('$t1', {'msgtype': 'm.text', 'body': 'Here are the photos from the trip'}),
    ('$p1', {'msgtype': 'm.image', 'body': 'image.jpg', 'url': 'mxc://messenger.internal/linephotoone'}),   # exactly what the LINE bridge sends
    ('$p2', {'msgtype': 'm.image', 'body': 'image.jpg', 'url': 'mxc://messenger.internal/linephototwo'}),
    ('$t2', {'msgtype': 'm.text', 'body': 'The second one is my favourite'}),
]
seed('mxc://messenger.internal/linephotoone', ('0x2a9d8f', '0xe9c46a')); seed('mxc://messenger.internal/linephototwo', ('0x264653', '0xe76f51'))
for i, (eid, content) in enumerate(rows):
    inbox.ingest(ident, meta, {'event_id': eid, 'type': 'm.room.message', 'origin_server_ts': now - (len(rows) - i) * 60000, 'sender': peer, 'content': content})
token, session = server.auth.create()
state = {'port': port, 'origin': origin, 'cookie': token, 'data': tmp, 'chat': ident['person_id']}
with open(os.path.join(OUT, 'state.json'), 'w') as f: f.write(json.dumps(state))
print('ready', flush=True)
server.serve_forever()
