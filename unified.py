"""Single-owner unified inbox; Matrix is private transport, not another UI.

All HTTP access is through Messenger's existing owner authentication boundary.
The SQLite store contains plaintext unified history: protect/back up the app data.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from engine import EngineError
from typing import NoReturn


def fail(code, message, status=400) -> NoReturn:
    raise EngineError(code, message, status)


def text(value, maximum=16384):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        fail('invalid_input', 'Please enter valid text')
    return value.strip()


def http(base, path, method='GET', body=None, token='', timeout=15):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(base.rstrip('/') + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        # Upstream error text can contain submitted login credentials. Expose only code.
        try:
            code = json.loads(error.read(65536)).get('errcode', 'upstream_rejected')
        except (ValueError, AttributeError):
            code = 'upstream_rejected'
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', code):
            code = 'upstream_rejected'
        fail('upstream_rejected', 'Upstream rejected the request (' + code + ')', 502)
    except (URLError, TimeoutError, OSError, ValueError):
        fail('upstream_unavailable', 'The private transport is unavailable. Please try again.', 503)


class PeopleStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        with self.db() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS person(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', preferred_identity TEXT);
            CREATE TABLE IF NOT EXISTS identity(id TEXT PRIMARY KEY, person_id TEXT REFERENCES person(id), network TEXT NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, last_used INTEGER NOT NULL DEFAULT 0, UNIQUE(network,address));
            CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES identity(id), sender TEXT NOT NULL, outgoing INTEGER NOT NULL, original TEXT NOT NULL, translated TEXT, translation_error TEXT, timestamp INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS room_label(identity_id TEXT NOT NULL REFERENCES identity(id), label TEXT NOT NULL, PRIMARY KEY(identity_id,label));
            CREATE TABLE IF NOT EXISTS translation(cache_key TEXT PRIMARY KEY, translated TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS preview(id TEXT PRIMARY KEY, person_id TEXT NOT NULL, identity_id TEXT NOT NULL, original TEXT NOT NULL, translated TEXT NOT NULL, error TEXT, expires INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'preview', send_original INTEGER, event_id TEXT);
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            try:
                with db:
                    yield db
            finally:
                db.close()

    def get(self, key, default=''):
        with self.db() as db:
            row = db.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()
            return row[0] if row else default

    def put(self, key, value):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)', (key, value))

    def identity(self, network, address, label, kind='person'):
        with self.db() as db:
            row = db.execute('SELECT * FROM identity WHERE network=? AND address=?', (network, address)).fetchone()
            if row:
                return dict(row)
            person_id, identity_id = secrets.token_hex(12), secrets.token_hex(12)
            db.execute('INSERT INTO person(id,display_name) VALUES (?,?)', (person_id, label))
            db.execute('INSERT INTO identity VALUES (?,?,?,?,?,?,0)', (identity_id, person_id, network, address, label, kind))
            return dict(db.execute('SELECT * FROM identity WHERE id=?', (identity_id,)).fetchone())

    def person(self, person_id):
        with self.db() as db:
            row = db.execute('SELECT * FROM person WHERE id=?', (person_id,)).fetchone()
            if not row:
                fail('not_found', 'Person not found', 404)
            result = dict(row)
            result['identities'] = [dict(r) for r in db.execute('SELECT * FROM identity WHERE person_id=? ORDER BY last_used DESC,id', (person_id,))]
            return result

    def people(self, kind='person'):
        with self.db() as db:
            ids = [r[0] for r in db.execute('SELECT DISTINCT p.id FROM person p JOIN identity i ON i.person_id=p.id WHERE i.kind=? ORDER BY p.display_name COLLATE NOCASE', (kind,))]
            result = [self.person(i) for i in ids]
            for person in result:
                person['labels'] = [r[0] for r in db.execute('SELECT DISTINCT label FROM room_label WHERE identity_id IN (SELECT id FROM identity WHERE person_id=?)', (person['id'],))]
            return result

    def update(self, person_id, payload):
        self.person(person_id)
        with self.db() as db:
            for key in ('display_name', 'language', 'preferred_identity'):
                if key not in payload:
                    continue
                value = payload[key]
                if key == 'preferred_identity':
                    if value and not db.execute('SELECT 1 FROM identity WHERE id=? AND person_id=?', (value, person_id)).fetchone():
                        fail('invalid_identity', 'Choose an identity belonging to this person')
                    value = value or None
                elif key == 'language':
                    if value not in ('', 'en', 'th', 'ja', 'zh', 'es', 'fr', 'de'):
                        fail('invalid_language', 'Choose a supported language')
                else:
                    value = text(value, 160)
                db.execute('UPDATE person SET ' + key + '=? WHERE id=?', (value, person_id))
        return self.person(person_id)

    def merge(self, target, source):
        if target == source:
            fail('invalid_merge', 'Choose two different people')
        a, b = self.person(target), self.person(source)
        if any(i['kind'] != 'person' for i in a['identities'] + b['identities']):
            fail('invalid_merge', 'Groups cannot be merged into a person')
        with self.db() as db:
            db.execute('UPDATE identity SET person_id=? WHERE person_id=?', (target, source))
            db.execute('DELETE FROM person WHERE id=?', (source,))
        return self.person(target)

    def unmerge(self, person_id, identity_id):
        person = self.person(person_id)
        identity = next((i for i in person['identities'] if i['id'] == identity_id), None)
        if not identity or len(person['identities']) < 2:
            fail('invalid_unmerge', 'Choose an identity from a merged person')
        new = secrets.token_hex(12)
        with self.db() as db:
            db.execute('INSERT INTO person(id,display_name,language) VALUES (?,?,?)', (new, identity['label'], person['language']))
            db.execute('UPDATE identity SET person_id=? WHERE id=?', (new, identity_id))
            db.execute('UPDATE person SET preferred_identity=NULL WHERE preferred_identity=?', (identity_id,))
        return self.person(new)

    def labels(self, identity_id, labels):
        if not isinstance(labels, list) or len(labels) > 20:
            fail('invalid_input', 'Use at most 20 labels')
        labels = sorted({text(x, 64) for x in labels})
        with self.db() as db:
            if not db.execute("SELECT 1 FROM identity WHERE id=? AND kind='group'", (identity_id,)).fetchone():
                fail('not_found', 'Group not found', 404)
            db.execute('DELETE FROM room_label WHERE identity_id=?', (identity_id,))
            db.executemany('INSERT INTO room_label VALUES (?,?)', [(identity_id, l) for l in labels])
        return {'labels': labels}

    def add_message(self, event_id, identity, sender, outgoing, original, timestamp, translated=None):
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO message VALUES (?,?,?,?,?,?,NULL,?)', (event_id, identity['id'], sender, int(outgoing), original, translated, timestamp))
            if not outgoing:
                db.execute('UPDATE identity SET last_used=MAX(last_used,?) WHERE id=?', (timestamp, identity['id']))

    def messages(self, person_id):
        self.person(person_id)
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT * FROM (SELECT m.*,i.network,i.label FROM message m JOIN identity i ON m.identity_id=i.id WHERE i.person_id=? ORDER BY m.timestamp DESC,m.id DESC LIMIT 2000) ORDER BY timestamp,id', (person_id,))]


class Translator:
    def __init__(self, store, root):
        self.store, self.root = store, Path(root)

    def translate(self, original, language):
        if not language:
            return original, None
        key = hashlib.sha256((os.environ.get('TRANSLATION_MODEL', 'gemma4-31b') + '\0' + language + '\0' + original).encode()).hexdigest()
        with self.store.db() as db:
            row = db.execute('SELECT translated FROM translation WHERE cache_key=?', (key,)).fetchone()
        if row:
            return row[0], None
        try:
            secret = json.loads((self.root / 'secrets.json').read_text())['translation_token']
            result = http(os.environ.get('TRANSLATION_URL', 'http://translation:8766'), '/translate', 'POST', {'text': original, 'language': language}, secret, 60)
            if result.get('error'):
                return original, result['error']
            translated = text(result.get('text'))
        except (EngineError, OSError, ValueError, KeyError):
            return original, 'Translation unavailable. You can send the original instead.'
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO translation VALUES (?,?)', (key, translated))
        return translated, None


class UnifiedInbox:
    def __init__(self, data, engine):
        self.root = Path(data) / 'unified'
        self.store = PeopleStore(self.root / 'people.sqlite3')
        self.engine = engine
        self.translator = Translator(self.store, self.root)
        self.lock = threading.RLock()
        self.sync_lock = threading.Lock()
        self.owner = '@owner:messenger.internal'
        self.matrix = os.environ.get('MATRIX_URL', 'http://matrix:8008')
        self.bridge = os.environ.get('TELEGRAM_BRIDGE_URL', 'http://telegram:29317')
        self.stop = threading.Event()
        self.worker = None

    def start(self):
        def receive():
            while not self.stop.is_set():
                try:
                    self.sync()
                except Exception:
                    self.store.put('sync_error', 'Private messaging sync failed. Retry is automatic.')
                self.stop.wait(5)
        self.worker = threading.Thread(target=receive, name='matrix-sync', daemon=True)
        self.worker.start()

    def close(self):
        self.stop.set()
        if self.worker:
            self.worker.join(timeout=2)

    def keys(self):
        try:
            return json.loads((self.root / 'secrets.json').read_text())
        except (OSError, ValueError):
            fail('not_configured', 'Private messaging plumbing is not configured', 503)

    def matrix_token(self):
        with self.lock:
            return self._matrix_token()

    def _matrix_token(self):
        token = self.store.get('matrix_token')
        if token:
            return token
        keys = self.keys()
        nonce = http(self.matrix, '/_synapse/admin/v1/register')['nonce']
        mac = hmac.new(keys['registration'].encode(), '\0'.join([nonce, 'owner', keys['owner_password'], 'notadmin']).encode(), hashlib.sha1).hexdigest()
        try:
            result = http(self.matrix, '/_synapse/admin/v1/register', 'POST', {'nonce': nonce, 'username': 'owner', 'password': keys['owner_password'], 'admin': False, 'mac': mac})
        except EngineError:
            result = http(self.matrix, '/_matrix/client/v3/login', 'POST', {'type': 'm.login.password', 'identifier': {'type': 'm.id.user', 'user': self.owner}, 'password': keys['owner_password']})
        self.store.put('matrix_token', result['access_token'])
        return result['access_token']

    def mx(self, path, method='GET', body=None):
        return http(self.matrix, '/_matrix/client/v3' + path, method, body, self.matrix_token())

    def telegram_configured(self):
        try:
            return json.loads((self.root / 'configuration.json').read_text())['telegram_configured'] is True
        except (OSError, ValueError, KeyError):
            return False

    def provision(self, path, method='GET', body=None):
        if not self.telegram_configured():
            fail('telegram_not_configured', 'Telegram not configured. Supply TELEGRAM_API_ID and TELEGRAM_API_HASH at installation.', 409)
        return http(self.bridge, '/_matrix/provision/v3' + path + '?' + urlencode({'user_id': self.owner}), method, body, self.keys()['provisioning'], 65)

    def telegram_status(self):
        if not self.telegram_configured():
            return {'state': 'not_configured', 'message': 'Telegram not configured', 'logins': [], 'flows': []}
        try:
            result = self.provision('/whoami')
            return {'state': 'connected' if result.get('logins') else 'disconnected', 'message': 'Telegram', 'logins': result.get('logins', []), 'flows': [f for f in result.get('login_flows', []) if f['id'] in ('qr', 'phone')]}
        except EngineError as error:
            return {'state': 'unavailable', 'message': error.message, 'logins': [], 'flows': []}

    def sync(self):
        if not self.sync_lock.acquire(blocking=False):
            return {'state': 'syncing'}
        try:
            since = self.store.get('sync_token')
            query = {'timeout': 0, 'filter': json.dumps({'room': {'timeline': {'limit': 100}}})}
            if since:
                query['since'] = since
            result = self.mx('/sync?' + urlencode(query))
            for room, invited in result.get('rooms', {}).get('invite', {}).items():
                events = invited.get('invite_state', {}).get('events', [])
                # Never auto-join arbitrary invitations: bridge bot/ghost namespace only.
                if any(e.get('type') == 'm.room.member' and e.get('state_key') == self.owner and e.get('sender', '').startswith(('@telegram_', '@telegrambot:')) for e in events):
                    self.mx('/join/' + quote(room, safe=''), 'POST', {})
            for room, data in result.get('rooms', {}).get('join', {}).items():
                if data.get('timeline', {}).get('limited'):
                    self.store.put('history_gap:' + room, 'Earlier history may be incomplete')
                # Complete room state is needed when an incremental sync has no bridge-info event.
                state = self.mx('/rooms/' + quote(room, safe='') + '/state')
                info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
                if not info or info.get('protocol', {}).get('id') != 'telegram':
                    continue
                channel = info.get('channel', {})
                label = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname') or 'Telegram conversation'
                members = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join' and e.get('state_key') not in (self.owner, '@telegrambot:messenger.internal')]
                # bridgev2 emits room_type in bridge info; fallback counts real participants.
                room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.telegram.type') or info.get('com.beeper.room_type')
                if any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state):
                    continue
                kind = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
                identity = self.store.identity('telegram', room, label, kind)
                for event in data.get('timeline', {}).get('events', []):
                    if event.get('type') == 'm.room.message' and event.get('content', {}).get('msgtype') == 'm.text':
                        content = event['content']
                        if content.get('m.relates_to', {}).get('rel_type') == 'm.replace':
                            continue
                        self.store.add_message(event['event_id'], identity, event.get('sender', ''), event.get('sender') == self.owner, content.get('body', ''), event.get('origin_server_ts', 0))
            self.store.put('sync_token', result['next_batch'])
            self.store.put('sync_error', '')
            return {'state': 'ready'}
        except EngineError as error:
            self.store.put('sync_error', error.message)
            return {'state': 'unavailable', 'error': error.message}
        finally:
            self.sync_lock.release()

    def marmot(self):
        if self.engine.status().get('state') != 'ready':
            return
        own = self.engine.identity().get('identity') or {}
        mine = {own.get(k) for k in ('account_id', 'member_id', 'npub')} - {None}
        for dm in self.engine.dms()['dms']:
            peer = next((m for m in dm.get('members', []) if not mine.intersection(m.get(k) for k in ('account_id', 'member_id', 'npub'))), {})
            label = peer.get('display_name') or dm.get('name') or 'Messenger contact'
            self.store.identity('messenger', dm['group_id'], label)

    def timeline(self, person_id):
        person = self.store.person(person_id)
        for identity in person['identities']:
            if identity['network'] == 'messenger' and self.engine.status().get('state') == 'ready':
                own = (self.engine.identity().get('identity') or {}).get('account_id')
                for m in self.engine.messages(identity['address'], 200).get('messages', []):
                    stamp = m.get('created_at', 0)
                    if isinstance(stamp, str):
                        from datetime import datetime
                        stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000
                    elif stamp < 1000000000000:
                        stamp *= 1000
                    self.store.add_message('messenger:' + m['message_id'], identity, m.get('author', ''), m.get('direction') == 'sent', m.get('text', ''), int(stamp))
        messages = self.store.messages(person_id)
        for message in messages:
            if not message['outgoing'] and not person['language']:
                message.update(translation_error=None)
            if not message['outgoing'] and person['language'] and not message['translated']:
                translated, error = self.translator.translate(message['original'], 'en')
                message.update(translated=None if error else translated, translation_error=error)
                with self.store.db() as db:
                    db.execute('UPDATE message SET translated=?,translation_error=? WHERE id=?', (message['translated'], error, message['id']))
        gaps = [self.store.get('history_gap:' + i['address']) for i in person['identities']]
        return {'person': person, 'messages': messages, 'history_warning': next((g for g in gaps if g), None)}

    def translate_message(self, message_id):
        """Owner tapped Translate under one incoming message: one model call, cached."""
        with self.store.db() as db:
            row = db.execute('SELECT original, translated FROM message WHERE id=? AND outgoing=0', (message_id,)).fetchone()
        if not row:
            fail('not_found', 'That message is no longer here', 404)
        if row['translated']:
            return {'id': message_id, 'translated': row['translated'], 'error': None}
        translated, error = self.translator.translate(row['original'], 'en')
        if not error:
            with self.store.db() as db:
                db.execute('UPDATE message SET translated=?, translation_error=NULL WHERE id=?', (translated, message_id))
        return {'id': message_id, 'translated': None if error else translated, 'error': error}

    def preview(self, person_id, payload):
        person = self.store.person(person_id)
        identity_id = payload.get('identity_id') or person['preferred_identity'] or person['identities'][0]['id']
        if not any(i['id'] == identity_id for i in person['identities']):
            fail('invalid_identity', 'Choose this person’s channel')
        original = text(payload.get('text'))
        translated, error = self.translator.translate(original, person['language']) if person['language'] and person['language'] != 'en' else (original, None)
        preview_id = secrets.token_hex(16)
        with self.store.db() as db:
            db.execute('INSERT INTO preview(id,person_id,identity_id,original,translated,error,expires) VALUES (?,?,?,?,?,?,?)', (preview_id, person_id, identity_id, original, translated, error, int(time.time()) + 900))
        return {'id': preview_id, 'original': original, 'translated': translated, 'error': error, 'identity_id': identity_id, 'language': person['language']}

    def confirm(self, person_id, payload):
        with self.lock:
            with self.store.db() as db:
                row = db.execute('SELECT * FROM preview WHERE id=? AND person_id=?', (payload.get('preview_id'), person_id)).fetchone()
                if not row:
                    fail('invalid_preview', 'Preview this message before sending')
                p = dict(row)
                if p['status'] in ('sent', 'queued'):
                    return {'state': p['status'], 'event_id': p['event_id']}
                if p['status'] == 'preview' and p['expires'] < time.time():
                    fail('preview_expired', 'Preview expired. Review the text again.', 409)
                identity = db.execute('SELECT * FROM identity WHERE id=? AND person_id=?', (p['identity_id'], person_id)).fetchone()
                if not identity:
                    fail('identity_changed', 'The person’s channels changed. Preview again.', 409)
                send_original = payload.get('send_original') is True
                if p['error'] and not send_original:
                    fail('translation_failed', 'Translation failed. Explicitly choose Send original.', 409)
                if p['status'] != 'preview' and p['send_original'] != int(send_original):
                    fail('request_id_conflict', 'A retry must preserve the confirmed text.', 409)
                db.execute("UPDATE preview SET status='sending',send_original=? WHERE id=?", (int(send_original), p['id']))
            body = p['original'] if send_original else p['translated']
            # Stable transaction ID makes even ambiguous Matrix retries idempotent.
            delivery = 'sent'
            if identity['network'] == 'telegram':
                result = self.mx('/rooms/' + quote(identity['address'], safe='') + '/send/m.room.message/' + p['id'], 'PUT', {'msgtype': 'm.text', 'body': body})
                event = result['event_id']
            else:
                result = self.engine.send(identity['address'], {'text': body, 'request_id': p['id']})
                event = 'messenger:' + result['message_ids'][0]
                delivery = 'sent' if result['published'] else 'queued'
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), p['original'] if body != p['original'] else None)
            with self.store.db() as db:
                db.execute('UPDATE preview SET status=?,event_id=? WHERE id=?', (delivery, event, p['id']))
                # A sync may have received our event before the confirm receipt.
                db.execute('UPDATE message SET translated=? WHERE id=?', (p['original'] if body != p['original'] else None, event))
            return {'state': delivery, 'event_id': event}

    def dispatch(self, method, path, payload):
        parts = path.strip('/').split('/')
        suffix = parts[2:]
        if suffix == ['status'] and method == 'GET':
            return {'telegram': self.telegram_status(), 'matrix_error': self.store.get('sync_error'), 'marmot': self.engine.status().get('state')}
        if suffix == ['sync'] and method == 'POST':
            self.marmot()
            return self.sync()
        if suffix in (['people'], ['groups']) and method == 'GET':
            self.marmot()
            kind = 'group' if suffix[0] == 'groups' else 'person'
            return {suffix[0]: self.store.people(kind)}
        if len(suffix) >= 2 and suffix[0] == 'people':
            person_id = suffix[1]
            if len(suffix) == 2:
                if method == 'GET':
                    return self.timeline(person_id)
                if method == 'POST':
                    return self.store.update(person_id, payload)
            if len(suffix) == 3 and method == 'POST':
                action = suffix[2]
                if action == 'merge': return self.store.merge(person_id, text(payload.get('source_id'), 24))
                if action == 'unmerge': return self.store.unmerge(person_id, payload.get('identity_id'))
                if action == 'preview': return self.preview(person_id, payload)
                if action == 'send': return self.confirm(person_id, payload)
        if len(suffix) == 3 and suffix[0] == 'messages' and suffix[2] == 'translate' and method == 'POST':
            return self.translate_message(text(suffix[1], 300))
        if len(suffix) == 3 and suffix[0] == 'groups' and suffix[2] == 'labels' and method == 'POST':
            return self.store.labels(suffix[1], payload.get('labels'))
        if suffix == ['telegram', 'status'] and method == 'GET': return self.telegram_status()
        if suffix == ['telegram', 'start'] and method == 'POST':
            flow = payload.get('flow')
            if flow not in ('qr', 'phone'): fail('invalid_flow', 'Choose QR or phone login')
            self.matrix_token()
            return self.provision('/login/start/' + flow, 'POST', {})
        if suffix == ['telegram', 'step'] and method == 'POST':
            values = [payload.get(k) for k in ('login_id', 'step_id', 'type')]
            if not all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', v) for v in values) or values[2] not in ('user_input', 'display_and_wait'):
                fail('invalid_step', 'Invalid login step')
            fields = payload.get('fields', {})
            if not isinstance(fields, dict) or not all(isinstance(k, str) and isinstance(v, str) and len(v) <= 1024 for k, v in fields.items()):
                fail('invalid_step', 'Invalid login input')
            return self.provision('/login/step/' + '/'.join(values), 'POST', fields)
        if suffix == ['telegram', 'disconnect'] and method == 'POST': return self.provision('/logout/all', 'POST', {})
        if suffix == ['telegram', 'cancel'] and method == 'POST':
            return self.provision('/login/cancel/' + quote(text(payload.get('login_id'), 160), safe=''), 'POST', {})
        fail('not_found', 'No such unified inbox route', 404)
