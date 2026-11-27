"""Usage: AGENT_STAGE_DIR=<dir> python tests/pickers_stage.py <port>, then node tests/pickers_browser.cjs.
Disposable staging for the composer's Emoji / GIFs / Stickers panel: real ViewServer + real UnifiedInbox store and send
path, one Telegram chat and one WhatsApp chat. The Telegram bridge's picker routes (provision) and Matrix (mx) are
mocked; every Matrix send is appended to <dir>/sends.jsonl so the test can read the exact event type and content.
Preview and prepared media bytes are generated with ffmpeg and pre-seeded into the media cache. No homeserver,
no provider, no real account. Writes <dir>/state.json."""
import hashlib, itertools, json, os, subprocess, sys, tempfile, time, urllib.parse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tests'))
OUT = os.environ.get('AGENT_STAGE_DIR', '/home/oscar/.hermes/cache/scratch/pickers-stage'); os.makedirs(OUT, exist_ok=True)
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
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18961
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
SENDS = os.path.join(OUT, 'sends.jsonl'); open(SENDS, 'w').close()
_sent = itertools.count(1)
# Issue 471: the bridges' reaction rules (com.beeper.room_features) per room, written by a test as
# <dir>/features.json {"!zoe": [state events]}; a room missing there has none (any emoji).
FEATURES = os.path.join(OUT, 'features.json')
def mx(path, method='GET', body=None, timeout=15):
    if method == 'GET' and path.endswith('/state'):
        room = urllib.parse.unquote(path.split('/')[2])
        return (json.load(open(FEATURES)) if os.path.exists(FEATURES) else {}).get(room, [])
    with open(SENDS, 'a') as f:
        f.write(json.dumps({'path': path, 'method': method, 'body': body}) + '\n')
    return {'event_id': '$sent%d' % next(_sent)}
inbox.mx = mx
inbox.matrix_token = lambda: 'staged'
server.drafts = Drafts(tmp)

media_dir = os.path.join(tmp, 'gen'); os.makedirs(media_dir)
def ff(name, *args):
    path = os.path.join(media_dir, name)
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args, path], check=True)
    return path
cache = os.path.join(tmp, 'unified', 'media-cache'); os.makedirs(cache, exist_ok=True)
def seed(mxc, path, mime):
    # Full file and the homeserver's preview (sent stickers show through the thumbnail route).
    for kind in ('full', 'thumb'):
        key = hashlib.sha256((mxc + '|' + kind).encode()).hexdigest()
        with open(path, 'rb') as src, open(os.path.join(cache, key), 'wb') as dst:
            dst.write(src.read())
        open(os.path.join(cache, key + '.type'), 'w').write(mime)
colors = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']
for i, c in enumerate(colors):
    seed('mxc://messenger.internal/st%d' % i, ff('st%d.webp' % i, '-f', 'lavfi', '-i', 'color=c=%s:s=256x256' % c, '-vf', 'drawbox=x=64:y=64:w=128:h=128:color=white@0.8:t=fill', '-frames:v', '1'), 'image/webp')
    seed('mxc://messenger.internal/gt%d' % i, ff('gt%d.jpg' % i, '-f', 'lavfi', '-i', 'testsrc=s=320x%d' % (180 + 20 * i), '-frames:v', '1'), 'image/jpeg')
seed('mxc://messenger.internal/gfull', ff('g.mp4', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=15', '-pix_fmt', 'yuv420p', '-an'), 'video/mp4')

STICKERS = [{'id': str(1000 + i), 'kind': 'sticker', 'emoji': e, 'pack': 'Cats', 'mime': 'image/webp', 'w': 512, 'h': 512,
             'thumb': 'mxc://messenger.internal/st%d' % i, 'thumb_mime': 'image/webp'} for i, e in enumerate('😀😺🙀😻😼😽🐱😸')]
GIFS = [{'id': str(-2000 - i), 'kind': 'gif', 'mime': 'video/mp4', 'w': 320, 'h': 180 + 20 * i, 'duration': 2000,
         'thumb': 'mxc://messenger.internal/gt%d' % i, 'thumb_mime': 'image/jpeg'} for i in range(8)]
PROVISION = []
def provision(path, method='GET', body=None, query=None, timeout=65):
    PROVISION.append(path)
    if path == '/wizard/stickers':
        return {'recent': STICKERS[:3], 'favorites': STICKERS[3:5], 'packs': [{'short_name': 'Cats', 'title': 'Cats', 'count': 8}, {'short_name': 'Dogs_Pack', 'title': 'Dogs', 'count': 4}]}
    if path == '/wizard/stickers/Cats':
        return {'short_name': 'Cats', 'title': 'Cats', 'stickers': STICKERS}
    if path == '/wizard/gifs':
        q = (query or {}).get('q', '')
        return {'items': GIFS if not q else GIFS[:5], 'next_offset': '5' if q else ''}
    if path.startswith('/wizard/prepare/sticker/'):
        doc = path.rsplit('/', 1)[1]
        i = next(n for n, s in enumerate(STICKERS) if s['id'] == doc)
        return {'url': 'mxc://messenger.internal/st%d' % i, 'emoji': STICKERS[i]['emoji'],
                'info': {'mimetype': 'image/webp', 'w': 256, 'h': 256, 'size': 9000,
                         'fi.mau.bridged_sticker': {'network': 'telegram', 'id': doc, 'emoji': STICKERS[i]['emoji'], 'pack_url': 'https://t.me/addstickers/Cats'}}}
    if path.startswith('/wizard/prepare/gif/'):
        return {'url': 'mxc://messenger.internal/gfull', 'info': {'mimetype': 'video/mp4', 'w': 320, 'h': 180, 'size': 40000, 'duration': 2000, 'fi.mau.gif': True}}
    raise AssertionError('unexpected provision ' + path)
inbox.provision = provision

ZOE, BRAM = '@telegram_9:messenger.internal', '@whatsapp_316123:messenger.internal'
zoe = inbox.store.identity('telegram', '!zoe', 'Zoe')
bram = inbox.store.identity('whatsapp', '!bram', 'Bram')
metas = {'!zoe': {'network': 'telegram', 'kind': 'person', 'label': 'Zoe', 'names': {ZOE: 'Zoe'}},
         '!bram': {'network': 'whatsapp', 'kind': 'person', 'label': 'Bram', 'names': {BRAM: 'Bram (WA)'}}}
with inbox.store.db() as db:
    for room, meta in metas.items():
        db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
inbox.rooms.update(metas)
t = [int(time.time() * 1000) - 3600000]
def ev(eid, body, sender):
    t[0] += 60000
    return {'event_id': eid, 'type': 'm.room.message', 'sender': sender, 'origin_server_ts': t[0], 'content': {'msgtype': 'm.text', 'body': body}}
inbox.ingest(bram, metas['!bram'], ev('$b1', 'see you at the party', BRAM))
inbox.ingest(zoe, metas['!zoe'], ev('$z1', 'did you see the cat video?', ZOE))
token, session = server.auth.create()
state = {'port': port, 'origin': origin, 'cookie': token, 'zoe': zoe['person_id'], 'bram': bram['person_id'], 'data': tmp, 'sends': SENDS}
open(os.path.join(OUT, 'state.json'), 'w').write(json.dumps(state))
print('ready', flush=True)
server.serve_forever()
