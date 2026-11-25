"""Usage: AGENT_STAGE_DIR=<dir> python tests/video_send_stage.py <port>, then node tests/video_send_browser.cjs.
Disposable staging for sending videos (issue 402): real ViewServer + real UnifiedInbox upload and send path, one chat
each on LINE, Telegram, WhatsApp and Signal, plus one private Wizard chat. Matrix (mx), the Synapse media upload and
the Wizard chat engine are faked: every Matrix send is appended to <dir>/sends.jsonl, every Synapse upload to
<dir>/uploads.jsonl and every Wizard chat send to <dir>/marmot.jsonl, and uploaded bytes are seeded into the media cache
so the sent bubbles load them back through the real media route. No homeserver, no bridge, no account.
Writes <dir>/state.json."""
import hashlib, itertools, json, os, shutil, sys, tempfile, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, 'tests'))
OUT = os.environ.get('AGENT_STAGE_DIR') or tempfile.mkdtemp(prefix='video-send-stage-'); os.makedirs(OUT, exist_ok=True)
os.environ['MESSENGER_COOKIE_SECURE'] = '0'
import test_web as fx
from web import ViewServer
from unified import UnifiedInbox
from drafts import Drafts

tmp = tempfile.mkdtemp(dir=OUT)
BLOBS = os.path.join(tmp, 'marmot-blobs'); os.makedirs(BLOBS)
MARMOT = os.path.join(OUT, 'marmot.jsonl'); open(MARMOT, 'w').close()
_mid = itertools.count(1)


class Engine(fx.FakeEngine):
    def __init__(self): super().__init__(); self.ready = True
    def dms(self): return {'dms': []}
    def invites(self): return {'invites': []}
    def messages(self, *a, **k): return {'messages': []}
    def send_media(self, group, payload):
        attachments = []
        for p in payload['paths']:
            data = open(p, 'rb').read(); digest = hashlib.sha256(data).hexdigest()
            open(os.path.join(BLOBS, digest), 'wb').write(data)
            attachments.append({'sha256': digest, 'filename': os.path.basename(p)})
        with open(MARMOT, 'a') as f:
            f.write(json.dumps({'group': group, 'text': payload.get('text'), 'files': [os.path.basename(p) for p in payload['paths']]}) + '\n')
        return {'message_ids': ['%064x' % next(_mid)], 'published': 1, 'attachments': attachments}
    def media_download(self, group, digest, dest):
        shutil.copyfile(os.path.join(BLOBS, digest), dest)


engine = Engine(); engine.data = tmp
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18962
origin = 'http://127.0.0.1:%d' % port
server = ViewServer(('127.0.0.1', port), engine, fx.TOKEN, [origin])
inbox = UnifiedInbox(tmp, engine); server.unified = inbox
SENDS = os.path.join(OUT, 'sends.jsonl'); open(SENDS, 'w').close()
UPLOADS = os.path.join(OUT, 'uploads.jsonl'); open(UPLOADS, 'w').close()
_sent, _up = itertools.count(1), itertools.count(1)


def mx(path, method='GET', body=None, timeout=15):
    with open(SENDS, 'a') as f:
        f.write(json.dumps({'path': path, 'method': method, 'body': body}) + '\n')
    return {'event_id': '$sent%d' % next(_sent)}


cache = os.path.join(tmp, 'unified', 'media-cache'); os.makedirs(cache, exist_ok=True)


def matrix_upload(data, filename, mime):
    mxc = 'mxc://messenger.internal/up%d' % next(_up)
    with open(UPLOADS, 'a') as f:
        f.write(json.dumps({'mxc': mxc, 'filename': filename, 'mime': mime, 'size': len(data)}) + '\n')
    for kind in ('full', 'thumb'):  # what the homeserver would hand back for the file and for its preview
        key = hashlib.sha256((mxc + '|' + kind).encode()).hexdigest()
        open(os.path.join(cache, key), 'wb').write(data)
        open(os.path.join(cache, key + '.type'), 'w').write(mime)
    return {'content_uri': mxc}


inbox.mx = mx
inbox.matrix_upload = matrix_upload
inbox.matrix_token = lambda: 'staged'
server.drafts = Drafts(tmp)

CHATS = {'line': ('!lin', 'Lin (LINE)'), 'telegram': ('!zoe', 'Zoe (Telegram)'), 'whatsapp': ('!bram', 'Bram (WhatsApp)'),
         'signal': ('!sam', 'Sam (Signal)')}
people, t = {}, [int(time.time() * 1000) - 3600000]
for network, (room, name) in CHATS.items():
    ident = inbox.store.identity(network, room, name)
    meta = {'network': network, 'kind': 'person', 'label': name, 'names': {'@%s_1:messenger.internal' % network: name}}
    with inbox.store.db() as db:
        db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
    inbox.rooms[room] = meta
    t[0] += 60000
    inbox.ingest(ident, meta, {'event_id': '$hi-' + network, 'type': 'm.room.message', 'sender': '@%s_1:messenger.internal' % network,
                               'origin_server_ts': t[0], 'content': {'msgtype': 'm.text', 'body': 'send me the clip?'}})
    people[network] = ident['person_id']
ana = inbox.store.identity('messenger', 'ab' * 16, 'Ana (Wizard)')
inbox.store.add_message('messenger:' + 'e' * 64, ana, 'ana', False, 'and to me please', t[0] + 60000)
people['wizard'] = ana['person_id']
token, session = server.auth.create()
state = {'port': port, 'origin': origin, 'cookie': token, 'people': people, 'data': tmp, 'sends': SENDS, 'uploads': UPLOADS, 'marmot': MARMOT}
open(os.path.join(OUT, 'state.json'), 'w').write(json.dumps(state))
print('ready', flush=True)
server.serve_forever()
