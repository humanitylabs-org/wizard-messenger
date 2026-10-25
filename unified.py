"""Single-owner unified inbox; Matrix is private transport, not another UI.

All HTTP access is through Messenger's existing owner authentication boundary.
The SQLite store contains plaintext unified history: protect/back up the app data.

Speed contract: no request path waits on the Marmot engine or on the translation model.
Matrix is long-polled by one background worker; every write bumps a monotonic `seq`
and wakes `/updates` waiters, so the view never re-fetches whole threads.
"""
from __future__ import annotations
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode
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


class Blob:
    """A binary response (media) the view server streams with Range support."""
    def __init__(self, path, mime, filename='', inline=True):
        self.path, self.mime, self.filename, self.inline = Path(path), mime, filename, inline


# Served inline only for these; everything else (SVG, HTML, PDF...) is an attachment download.
INLINE_MIME = {'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4',
               'audio/webm', 'audio/aac', 'audio/x-m4a', 'video/mp4', 'video/webm', 'video/quicktime'}
UPLOAD_MAX = 25 * 1024 * 1024
MEDIA_CACHE_MAX = 300 * 1024 * 1024


def sniff(data):
    """Magic-byte type check for uploads; the client's Content-Type is never trusted."""
    if data[:3] == b'\xff\xd8\xff': return 'image/jpeg'
    if data[:8] == b'\x89PNG\r\n\x1a\n': return 'image/png'
    if data[:6] in (b'GIF87a', b'GIF89a'): return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP': return 'image/webp'
    if data[:4] == b'OggS': return 'audio/ogg'
    if data[:4] == b'\x1a\x45\xdf\xa3': return 'audio/webm'
    if data[4:8] == b'ftyp': return 'audio/mp4' if data[8:11] in (b'M4A', b'mp4', b'iso') and b'M4A' in data[8:32] else 'video/mp4'
    return None


MIGRATIONS = [
    ('person', 'muted', 'INTEGER NOT NULL DEFAULT 0'),
    ('message', 'seq', 'INTEGER NOT NULL DEFAULT 0'),
    ('message', 'msgtype', "TEXT NOT NULL DEFAULT 'm.text'"),
    ('message', 'media', 'TEXT'),
    ('message', 'transcript', 'TEXT'),
    ('message', 'reply_to', 'TEXT'),
    ('message', 'edited', 'INTEGER NOT NULL DEFAULT 0'),
    ('message', 'deleted', 'INTEGER NOT NULL DEFAULT 0'),
    ('message', 'client_id', 'TEXT'),
    ('message', 'failed', 'TEXT'),
    ('identity', 'last_read_ts', 'INTEGER NOT NULL DEFAULT 0'),
    ('identity', 'peer_read_ts', 'INTEGER NOT NULL DEFAULT 0'),
    ('identity', 'seq', 'INTEGER NOT NULL DEFAULT 0'),
]


class PeopleStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.on_change = None
        self._conn = None
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
        self.migrate()
        os.chmod(self.path, 0o600)
        with self.db() as db:
            self.seq = max(db.execute('SELECT COALESCE(MAX(seq),0) FROM message').fetchone()[0],
                           db.execute('SELECT COALESCE(MAX(seq),0) FROM identity').fetchone()[0])

    def migrate(self):
        with self.db() as db:
            have = {t: {r[1] for r in db.execute('PRAGMA table_info(' + t + ')')} for t in ('message', 'identity', 'person')}
            missing = [m for m in MIGRATIONS if m[1] not in have[m[0]]]
            if missing and db.execute('SELECT COUNT(*) FROM message').fetchone()[0]:
                # Additive only, but keep a copy of the pre-migration history anyway.
                db.execute('PRAGMA wal_checkpoint(FULL)')
                shutil.copy2(self.path, self.path.with_name(self.path.name + '.pre-signal-%d.bak' % int(time.time())))
            for table, column, decl in missing:
                db.execute('ALTER TABLE %s ADD COLUMN %s %s' % (table, column, decl))
            if any(m[1] == 'last_read_ts' for m in missing):
                # Existing chats start read: no wall of unread badges after the upgrade.
                db.execute('UPDATE identity SET last_read_ts=(SELECT COALESCE(MAX(timestamp),0) FROM message WHERE identity_id=identity.id)')
            db.executescript('''
            CREATE TABLE IF NOT EXISTS reaction(event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender TEXT NOT NULL, key TEXT NOT NULL, outgoing INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS room_meta(room TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS redacted(event_id TEXT PRIMARY KEY);
            CREATE INDEX IF NOT EXISTS message_identity_ts ON message(identity_id, timestamp);
            CREATE INDEX IF NOT EXISTS message_seq ON message(seq);
            CREATE INDEX IF NOT EXISTS identity_person ON identity(person_id);
            CREATE INDEX IF NOT EXISTS reaction_message ON reaction(message_id);
            ''')

    @contextmanager
    def db(self):
        # One long-lived connection guarded by the store lock: no per-call connect cost.
        with self.lock:
            if self._conn is None:
                self._conn = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
                self._conn.row_factory = sqlite3.Row
                self._conn.execute('PRAGMA foreign_keys=ON')
                self._conn.execute('PRAGMA synchronous=NORMAL')
            if self._conn.in_transaction:
                yield self._conn
                return
            with self._conn:
                yield self._conn

    def next_seq(self):
        with self.lock:
            self.seq += 1
            return self.seq

    def changed(self):
        if self.on_change:
            self.on_change()

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
            db.execute('INSERT INTO identity(id,person_id,network,address,label,kind,last_used,seq) VALUES (?,?,?,?,?,?,0,?)',
                       (identity_id, person_id, network, address, label, kind, self.next_seq()))
            return dict(db.execute('SELECT * FROM identity WHERE id=?', (identity_id,)).fetchone())

    def touch_identity(self, identity_id, **fields):
        with self.db() as db:
            sets = ''.join(',%s=MAX(%s,?)' % (k, k) for k in fields)
            db.execute('UPDATE identity SET seq=?' + sets + ' WHERE id=?', (self.next_seq(), *fields.values(), identity_id))
        self.changed()

    def forget(self, network, address):
        with self.db() as db:
            row = db.execute('SELECT id,person_id FROM identity WHERE network=? AND address=?', (network, address)).fetchone()
            if not row:
                return False
            db.execute('DELETE FROM reaction WHERE message_id IN (SELECT id FROM message WHERE identity_id=?)', (row[0],))
            db.execute('DELETE FROM message WHERE identity_id=?', (row[0],))
            db.execute('DELETE FROM room_label WHERE identity_id=?', (row[0],))
            db.execute('DELETE FROM identity WHERE id=?', (row[0],))
            if not db.execute('SELECT 1 FROM identity WHERE person_id=?', (row[1],)).fetchone():
                db.execute('DELETE FROM person WHERE id=?', (row[1],))
            return True

    def person(self, person_id):
        with self.db() as db:
            row = db.execute('SELECT * FROM person WHERE id=?', (person_id,)).fetchone()
            if not row:
                fail('not_found', 'Person not found', 404)
            result = dict(row)
            result['identities'] = [dict(r) for r in db.execute('SELECT * FROM identity WHERE person_id=? ORDER BY last_used DESC,id', (person_id,))]
            return result

    def people(self, kind='person', chats=True, ids=None):
        # Chats: only conversations with messages, newest first, each with its latest line and unread count.
        # Directory (chats=False): everyone A-Z, used by New chat. A fixed handful of queries, never N+1.
        with self.db() as db:
            persons = {r['id']: dict(r) for r in db.execute('SELECT * FROM person')}
            idents = {}
            for r in db.execute('SELECT * FROM identity WHERE kind=? ORDER BY last_used DESC,id', (kind,)):
                idents.setdefault(r['person_id'], []).append(dict(r))
            labels = {}
            for r in db.execute('SELECT DISTINCT i.person_id,l.label FROM room_label l JOIN identity i ON i.id=l.identity_id ORDER BY l.label'):
                labels.setdefault(r[0], []).append(r[1])
            last = {r['person_id']: r for r in db.execute(
                'SELECT * FROM (SELECT m.original,m.outgoing,m.sender,m.timestamp,m.msgtype,m.deleted,m.media,i.person_id,'
                'ROW_NUMBER() OVER (PARTITION BY i.person_id ORDER BY m.timestamp DESC,m.id DESC) rn '
                'FROM message m JOIN identity i ON i.id=m.identity_id WHERE i.kind=? AND m.deleted=0) WHERE rn=1', (kind,))}
            unread = dict(db.execute(
                'SELECT i.person_id,COUNT(*) FROM message m JOIN identity i ON i.id=m.identity_id '
                'WHERE i.kind=? AND m.outgoing=0 AND m.deleted=0 AND m.timestamp>i.last_read_ts GROUP BY i.person_id', (kind,)).fetchall())
        result = []
        for pid, ident in idents.items():
            if pid not in persons or (ids is not None and pid not in ids):
                continue
            if chats and pid not in last:
                continue
            p = dict(persons[pid], identities=ident, labels=labels.get(pid, []))
            if pid in last:
                r = last[pid]
                media = json.loads(r['media']) if r['media'] else {}
                p['last'] = {'text': '' if r['deleted'] else r['original'][:140], 'outgoing': bool(r['outgoing']), 'sender': r['sender'], 'timestamp': r['timestamp']}
                if r['msgtype'] != 'm.text' or r['deleted'] or media.get('voice'):
                    p['last'].update(msgtype=r['msgtype'], deleted=bool(r['deleted']), voice=bool(media.get('voice')))
                p['unread'] = unread.get(pid, 0)
                p['last_read_ts'] = max(i['last_read_ts'] for i in ident)
                p['peer_read_ts'] = max(i['peer_read_ts'] for i in ident)
            result.append(p)
        if chats:
            result.sort(key=lambda p: -p['last']['timestamp'])
        else:
            result.sort(key=lambda p: p['display_name'].casefold())
        return result

    def update(self, person_id, payload):
        self.person(person_id)
        with self.db() as db:
            for key in ('display_name', 'language', 'preferred_identity', 'muted'):
                if key not in payload:
                    continue
                value = payload[key]
                if key == 'preferred_identity':
                    if value and not db.execute('SELECT 1 FROM identity WHERE id=? AND person_id=?', (value, person_id)).fetchone():
                        fail('invalid_identity', 'Choose an identity belonging to this person')
                    value = value or None
                elif key == 'muted':
                    if not isinstance(value, bool):
                        fail('invalid_input', 'muted is true or false')
                    value = int(value)
                elif key == 'language':
                    if value not in ('', 'en', 'th', 'ja', 'zh', 'es', 'fr', 'de'):
                        fail('invalid_language', 'Choose a supported language')
                else:
                    value = text(value, 160)
                db.execute('UPDATE person SET ' + key + '=? WHERE id=?', (value, person_id))
            db.execute('UPDATE identity SET seq=? WHERE person_id=?', (self.next_seq(), person_id))
        self.changed()
        return self.person(person_id)

    def merge(self, target, source):
        if target == source:
            fail('invalid_merge', 'Choose two different people')
        a, b = self.person(target), self.person(source)
        if any(i['kind'] != 'person' for i in a['identities'] + b['identities']):
            fail('invalid_merge', 'Groups cannot be merged into a person')
        with self.db() as db:
            db.execute('UPDATE identity SET person_id=?,seq=? WHERE person_id=?', (target, self.next_seq(), source))
            db.execute('DELETE FROM person WHERE id=?', (source,))
        self.changed()
        return self.person(target)

    def unmerge(self, person_id, identity_id):
        person = self.person(person_id)
        identity = next((i for i in person['identities'] if i['id'] == identity_id), None)
        if not identity or len(person['identities']) < 2:
            fail('invalid_unmerge', 'Choose an identity from a merged person')
        new = secrets.token_hex(12)
        with self.db() as db:
            db.execute('INSERT INTO person(id,display_name,language) VALUES (?,?,?)', (new, identity['label'], person['language']))
            db.execute('UPDATE identity SET person_id=?,seq=? WHERE id=?', (new, self.next_seq(), identity_id))
            db.execute('UPDATE person SET preferred_identity=NULL WHERE preferred_identity=?', (identity_id,))
        self.changed()
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

    def add_message(self, event_id, identity, sender, outgoing, original, timestamp, translated=None,
                    msgtype='m.text', media=None, reply_to=None, client_id=None):
        """Insert once; a later sighting with richer media upgrades a label-only row in place."""
        media_json = json.dumps(media, ensure_ascii=False) if media else None
        with self.db() as db:
            seq = self.next_seq()
            cur = db.execute('INSERT OR IGNORE INTO message(id,identity_id,sender,outgoing,original,translated,timestamp,seq,msgtype,media,reply_to,client_id) '
                             'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                             (event_id, identity['id'], sender, int(outgoing), original, translated, timestamp, seq, msgtype, media_json, reply_to, client_id))
            inserted = cur.rowcount == 1
            if not inserted and msgtype != 'm.text':
                cur = db.execute("UPDATE message SET msgtype=?,media=?,original=?,reply_to=COALESCE(reply_to,?),seq=? WHERE id=? AND (msgtype='m.text' OR media IS NULL)",
                                 (msgtype, media_json, original, reply_to, seq, event_id))
                inserted = cur.rowcount == 1
            if not outgoing:
                db.execute('UPDATE identity SET last_used=MAX(last_used,?) WHERE id=?', (timestamp, identity['id']))
            else:
                # Anything we wrote ourselves (here or on another device) means the chat is read up to it.
                db.execute('UPDATE identity SET last_read_ts=MAX(last_read_ts,?) WHERE id=?', (timestamp, identity['id']))
        if inserted:
            self.changed()
        return inserted

    def claim_own(self, ghost):
        """Lines the owner wrote in the Telegram app were stored as incoming; mark them outgoing, chats read up to them."""
        with self.db() as db:
            rooms = [(r[0], json.loads(r[1]).get('names', {}).get(ghost)) for r in db.execute('SELECT room,json FROM room_meta')]
            changed = 0
            for room, name in rooms:
                row = db.execute("SELECT id FROM identity WHERE network='telegram' AND address=?", (room,)).fetchone()
                if not row:
                    continue
                senders = [ghost] + ([name] if name else [])
                q = ','.join('?' * len(senders))
                changed += db.execute('UPDATE message SET outgoing=1,seq=? WHERE identity_id=? AND outgoing=0 AND sender IN (%s)' % q, (self.next_seq(), row[0], *senders)).rowcount
                db.execute('UPDATE identity SET last_read_ts=MAX(last_read_ts,(SELECT COALESCE(MAX(timestamp),0) FROM message WHERE identity_id=? AND outgoing=1)),seq=? WHERE id=?', (row[0], self.next_seq(), row[0]))
        self.changed()
        return changed

    def bump(self, message_id, sql='', args=()):
        with self.db() as db:
            cur = db.execute('UPDATE message SET seq=?' + sql + ' WHERE id=?', (self.next_seq(), *args, message_id))
        if cur.rowcount:
            self.changed()
        return cur.rowcount == 1

    def message(self, message_id):
        with self.db() as db:
            row = db.execute('SELECT m.*,i.network,i.address,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id WHERE m.id=?', (message_id,)).fetchone()
        if not row:
            fail('not_found', 'That message is no longer here', 404)
        return dict(row)

    def transcript(self, message_id, payload):
        value = text(payload.get('text'), 100000)
        with self.db() as db:
            m = self.message(message_id)
            if m['deleted'] or m['msgtype'] != 'm.audio':
                fail('invalid_message', 'Only audio messages can have a transcript')
            # First successful transcript wins across devices; seq notifies every open view.
            if not m.get('transcript'):
                self.bump(message_id, ',transcript=?', (value,))
        return {'id': message_id, 'text': self.message(message_id)['transcript']}

    def react(self, event_id, message_id, sender, key, outgoing):
        with self.db() as db:
            if not db.execute('SELECT 1 FROM message WHERE id=?', (message_id,)).fetchone():
                return False
            if db.execute('SELECT 1 FROM redacted WHERE event_id=?', (event_id,)).fetchone():
                return False  # a late sync echo of a reaction we already removed
            db.execute('INSERT OR IGNORE INTO reaction VALUES (?,?,?,?,?)', (event_id, message_id, sender, key, int(outgoing)))
        return self.bump(message_id)

    def redact(self, event_id):
        """A redaction removes a reaction or blanks a message ("This message was deleted")."""
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO redacted VALUES (?)', (event_id,))
            row = db.execute('SELECT message_id FROM reaction WHERE event_id=?', (event_id,)).fetchone()
            if row:
                db.execute('DELETE FROM reaction WHERE event_id=?', (event_id,))
                return self.bump(row[0])
        return self.bump(event_id, ",deleted=1,original='',translated=NULL,media=NULL,transcript=NULL")

    def decorate(self, rows):
        """Public message rows: media without mxc URIs, aggregated reactions, reply excerpts."""
        rows = [dict(r) for r in rows]
        if not rows:
            return rows
        ids = [r['id'] for r in rows]
        replies = list({r['reply_to'] for r in rows if r.get('reply_to')})
        with self.db() as db:
            reacts = {}
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for r in db.execute('SELECT message_id,key,outgoing FROM reaction WHERE message_id IN (%s) ORDER BY rowid' % ','.join('?' * len(chunk)), chunk):
                    agg = reacts.setdefault(r[0], {})
                    entry = agg.setdefault(r[1], {'key': r[1], 'count': 0, 'mine': False})
                    entry['count'] += 1
                    entry['mine'] = entry['mine'] or bool(r[2])
            quoted = {}
            if replies:
                for r in db.execute('SELECT id,sender,outgoing,original,msgtype,deleted,media FROM message WHERE id IN (%s)' % ','.join('?' * len(replies)), replies):
                    media = json.loads(r['media']) if r['media'] else {}
                    quoted[r['id']] = {'id': r['id'], 'sender': r['sender'], 'outgoing': bool(r['outgoing']), 'text': '' if r['deleted'] else r['original'][:200],
                                       'msgtype': r['msgtype'], 'voice': bool(media.get('voice')), 'deleted': bool(r['deleted'])}
        for r in rows:
            r['outgoing'] = bool(r['outgoing'])
            r['edited'], r['deleted'] = bool(r.get('edited')), bool(r.get('deleted'))
            media = json.loads(r['media']) if r.get('media') else None
            if media:
                r['media'] = {k: v for k, v in media.items() if k in ('mime', 'size', 'w', 'h', 'duration', 'filename', 'waveform', 'voice')}
                r['media']['thumb'] = bool(media.get('thumb')) or (media.get('mime', '').startswith('image/'))
            r['reactions'] = list(reacts.get(r['id'], {}).values())
            if r.get('reply_to'):
                r['reply'] = quoted.get(r['reply_to'])
            r.pop('address', None)
        return rows

    def messages(self, person_id, before=None, limit=2000):
        self.person(person_id)
        with self.db() as db:
            rows = db.execute('SELECT * FROM (SELECT m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id '
                              'WHERE i.person_id=? AND (? IS NULL OR m.timestamp<?) ORDER BY m.timestamp DESC,m.id DESC LIMIT ?) ORDER BY timestamp,id',
                              (person_id, before, before, limit)).fetchall()
        return self.decorate(rows)

    def since(self, seq, limit=400):
        with self.db() as db:
            rows = db.execute('SELECT m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id '
                              'WHERE m.seq>? ORDER BY m.seq LIMIT ?', (seq, limit)).fetchall()
            touched = {r[0] for r in db.execute('SELECT person_id FROM identity WHERE seq>?', (seq,))}
        return self.decorate(rows), touched | {r['person_id'] for r in rows}


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


MEDIA_LABELS = {'m.image': 'Photo', 'm.video': 'Video', 'm.audio': 'Voice message', 'm.file': 'File', 'm.location': 'Location'}


def message_text(event):
    # Text, notices and emotes as written; media as a short label plus any caption. Edits and other events are skipped.
    content = event.get('content') or {}
    if content.get('m.relates_to', {}).get('rel_type') == 'm.replace':
        return None
    if event.get('type') == 'm.sticker':
        return '[Sticker] ' + content.get('body', '') if content.get('body') else '[Sticker]'
    if event.get('type') != 'm.room.message':
        return None
    kind, body = content.get('msgtype'), content.get('body', '')
    if kind in ('m.text', 'm.notice'):
        return body
    if kind == 'm.emote':
        return '* ' + body
    if kind in MEDIA_LABELS:
        caption = body if content.get('filename') and body != content.get('filename') else ''
        if kind == 'm.file' and not caption:
            caption = content.get('filename') or body
        return '[' + MEDIA_LABELS[kind] + ']' + (' ' + caption if caption else '')
    return None


REPLY_FALLBACK = re.compile(r'\A(?:> [^\n]*\n)+\n', re.S)


def message_parts(event):
    """(msgtype, text, media, reply_to) for a timeline event, or None when it is not a message.

    `media` keeps the mxc URIs server-side; `decorate` strips them before anything leaves the box."""
    content = event.get('content') or {}
    relates = content.get('m.relates_to') or {}
    if relates.get('rel_type') == 'm.replace':
        return None
    reply_to = (relates.get('m.in_reply_to') or {}).get('event_id')
    if event.get('type') == 'm.sticker':
        info = content.get('info') or {}
        return 'm.sticker', '', {'mxc': content.get('url'), 'mime': info.get('mimetype', 'image/webp'), 'w': info.get('w'), 'h': info.get('h'),
                                 'size': info.get('size'), 'thumb': (info.get('thumbnail_url') or None), 'alt': content.get('body', '')}, reply_to
    if event.get('type') != 'm.room.message':
        return None
    kind, body = content.get('msgtype'), content.get('body', '')
    if not isinstance(body, str):
        body = ''
    if reply_to:
        body = REPLY_FALLBACK.sub('', body, count=1)
    if kind in ('m.text', 'm.notice'):
        return 'm.text', body, None, reply_to
    if kind == 'm.emote':
        return 'm.text', '* ' + body, None, reply_to
    if kind == 'm.location':
        return 'm.location', body or content.get('geo_uri', ''), {'geo': content.get('geo_uri', '')}, reply_to
    if kind in ('m.image', 'm.video', 'm.audio', 'm.file'):
        info = content.get('info') or {}
        filename = content.get('filename') or body
        caption = body if content.get('filename') and body != content.get('filename') else ''
        audio = content.get('org.matrix.msc1767.audio') or {}
        media = {'mxc': content.get('url'), 'mime': info.get('mimetype', ''), 'size': info.get('size'), 'w': info.get('w'), 'h': info.get('h'),
                 'duration': info.get('duration') or audio.get('duration'), 'filename': filename[:200] if kind == 'm.file' or kind == 'm.audio' else '',
                 'thumb': info.get('thumbnail_url') or None}
        if kind == 'm.audio' and ('org.matrix.msc3245.voice' in content or 'org.matrix.msc3245.voice.v2' in content):
            media['voice'] = True
        wave = audio.get('waveform')
        if isinstance(wave, list) and wave:
            # Normalise to 48 buckets of 0-100 for the voice bubble.
            step = max(1, len(wave) / 48)
            top = max(max(wave), 1)
            media['waveform'] = [int(100 * wave[int(i * step)] / top) for i in range(min(48, len(wave)))]
        if not media['mxc']:
            return 'm.text', '[' + MEDIA_LABELS[kind] + ']' + (' ' + caption if caption else ''), None, reply_to
        return kind, caption, {k: v for k, v in media.items() if v not in (None, '')}, reply_to
    return None


class UnifiedInbox:
    HOLD_MAX = 25
    WAITERS_MAX = 8

    def __init__(self, data, engine):
        self.root = Path(data) / 'unified'
        self.store = PeopleStore(self.root / 'people.sqlite3')
        self.engine = engine
        self.translator = Translator(self.store, self.root)
        self.lock = threading.RLock()
        self.sync_lock = threading.Lock()
        self.warm_queue = queue.Queue(maxsize=200)
        self.owner = '@owner:messenger.internal'
        # The owner's own Telegram account appears as a ghost (@telegram_<id>) for anything
        # done in the Telegram app before double puppeting existed: that is still "me".
        self.mine = set(json.loads(self.store.get('own_ghosts') or '[]'))
        self.mine_checked = 0
        self.matrix = os.environ.get('MATRIX_URL', 'http://matrix:8008')
        self.bridge = os.environ.get('TELEGRAM_BRIDGE_URL', 'http://telegram:29317')
        self.stop = threading.Event()
        self.worker = None
        self._token = None
        self.cond = threading.Condition()
        self.waiters = 0
        self.typing = {}
        self.rooms = {}
        self.uploads = {}
        self.backfilled = set()
        self.tq = queue.Queue()
        self.tq_seen = set()
        self.timings = []
        self.store.on_change = self.notify

    # ---------- background workers ----------
    def notify(self):
        with self.cond:
            self.cond.notify_all()

    def start(self):
        def receive():
            while not self.stop.is_set():
                try:
                    ok = self.sync(timeout_ms=20000).get('state') in ('ready', 'syncing')
                except Exception:
                    ok = False
                    self.store.put('sync_error', 'Private messaging sync failed. Retry is automatic.')
                # A long-poll returns as soon as anything happens: go straight back; back off only after failures.
                self.stop.wait(0.05 if ok else 3)

        def translate():
            while not self.stop.is_set():
                try:
                    item = self.tq.get(timeout=1)
                except queue.Empty:
                    continue
                try:
                    self.translate_one(*item)
                except Exception:
                    pass

        def mirror():
            while not self.stop.is_set():
                try:
                    self.marmot()
                except Exception:
                    pass
                self.stop.wait(30)

        self.worker = threading.Thread(target=receive, name='matrix-sync', daemon=True)
        self.worker.start()
        threading.Thread(target=translate, name='translate', daemon=True).start()
        threading.Thread(target=mirror, name='marmot-mirror', daemon=True).start()

        def warm():
            # Voice notes from other people are fetched into the media cache as they arrive, so Play starts at once
            # instead of waiting on Telegram -> homeserver -> here.
            while not self.stop.is_set():
                try:
                    message_id = self.warm_queue.get(timeout=5)
                except queue.Empty:
                    continue
                try:
                    self.media(message_id, None)
                except Exception:
                    pass
        threading.Thread(target=warm, name='voice-warm', daemon=True).start()

    def close(self):
        self.stop.set()
        self.notify()
        if self.worker:
            self.worker.join(timeout=2)

    def keys(self):
        try:
            return json.loads((self.root / 'secrets.json').read_text())
        except (OSError, ValueError):
            fail('not_configured', 'Private messaging plumbing is not configured', 503)

    def matrix_token(self):
        if self._token:
            return self._token
        with self.lock:
            self._token = self._matrix_token()
            return self._token

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

    def mx(self, path, method='GET', body=None, timeout=15):
        return http(self.matrix, '/_matrix/client/v3' + path, method, body, self.matrix_token(), timeout)

    def room(self, address):
        return '/rooms/' + quote(address, safe='')

    def telegram_configured(self):
        try:
            return json.loads((self.root / 'configuration.json').read_text())['telegram_configured'] is True
        except (OSError, ValueError, KeyError):
            return False

    def provision(self, path, method='GET', body=None):
        if not self.telegram_configured():
            fail('telegram_not_configured', 'Telegram not configured. Supply TELEGRAM_API_ID and TELEGRAM_API_HASH at installation.', 409)
        return http(self.bridge, '/_matrix/provision/v3' + path + '?' + urlencode({'user_id': self.owner}), method, body, self.keys()['provisioning'], 65)

    # A Telegram login waits on the owner leaving the app to read a code, so the current
    # step lives here (shape only, never typed values) and the view resumes it on return.
    PENDING_LOGIN_SECONDS = 15 * 60

    def pending_login(self):
        pending = getattr(self, '_pending_login', None)
        if not pending or time.time() - pending['at'] > self.PENDING_LOGIN_SECONDS:
            self._pending_login = None
            return None
        return pending['step']

    def remember_login(self, result):
        step = result.get('step', result) if isinstance(result, dict) else {}
        if isinstance(result, dict) and result.get('login_id') and step.get('type') in ('user_input', 'display_and_wait'):
            self._pending_login = {'at': time.time(), 'step': result}
        else:
            self._pending_login = None
        return result

    # ---------- My QR codes: the owner's own contact links, shown as scannable codes ----------
    QR_NETWORKS = ('telegram', 'whatsapp', 'signal', 'messenger', 'instagram', 'x', 'line', 'wechat', 'facebook', 'email', 'phone', 'link')

    def qr_codes(self):
        # Saved list once the owner has edited it; until then, what this Messenger already knows (Telegram username).
        saved = self.store.get('my_qr_codes')
        suggested = []
        try:
            for login in self.telegram_status().get('logins') or []:
                username = ((login.get('profile') or {}).get('username') or '').strip()
                if re.fullmatch(r'[A-Za-z0-9_]{4,64}', username):
                    suggested.append({'network': 'telegram', 'value': username, 'label': ''})
                    break
        except Exception:  # Telegram unreachable: the saved list still shows.
            pass
        if saved:
            try:
                return {'codes': json.loads(saved), 'saved': True, 'suggested': suggested}
            except ValueError:
                pass
        return {'codes': suggested, 'saved': False, 'suggested': suggested}

    def save_qr_codes(self, payload):
        codes = payload.get('codes')
        if not isinstance(codes, list) or len(codes) > 24:
            fail('invalid_codes', 'Invalid QR code list')
        clean = []
        for item in codes:
            if not isinstance(item, dict) or item.get('network') not in self.QR_NETWORKS:
                fail('invalid_codes', 'Unknown network')
            value, label = item.get('value'), item.get('label') or ''
            if not isinstance(value, str) or not value.strip() or len(value) > 1024:
                fail('invalid_codes', 'Each code needs a username, number or link')
            if not isinstance(label, str) or len(label) > 80:
                fail('invalid_codes', 'Labels are up to 80 characters')
            clean.append({'network': item['network'], 'value': value.strip(), 'label': label.strip()})
        self.store.put('my_qr_codes', json.dumps(clean))
        return {'codes': clean, 'saved': True}

    def telegram_status(self):
        if not self.telegram_configured():
            return {'state': 'not_configured', 'message': 'Telegram not configured', 'logins': [], 'flows': []}
        try:
            result = self.provision('/whoami')
            return {'state': 'connected' if result.get('logins') else 'disconnected', 'message': 'Telegram', 'logins': result.get('logins', []), 'flows': [f for f in result.get('login_flows', []) if f['id'] in ('qr', 'phone')], 'pending_login': self.pending_login()}
        except EngineError as error:
            return {'state': 'unavailable', 'message': error.message, 'logins': [], 'flows': []}

    # ---------- Matrix ingest ----------
    META_TYPES = ('m.room.member', 'm.room.name', 'm.bridge', 'uk.half-shot.bridge', 'm.room.create')

    def room_meta(self, room, data):
        """Room kind/label/member names, cached; full state is fetched only for new rooms or state changes."""
        meta = self.rooms.get(room)
        if meta is None:
            with self.store.db() as db:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
            meta = json.loads(row[0]) if row else None
        events = (data.get('state', {}).get('events') or []) + [e for e in data.get('timeline', {}).get('events', []) if 'state_key' in e]
        if meta is not None and not any(e.get('type') in self.META_TYPES for e in events):
            self.rooms[room] = meta
            return meta
        state = self.mx(self.room(room) + '/state')
        info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
        meta = {'telegram': bool(info and info.get('protocol', {}).get('id') == 'telegram')}
        if meta['telegram']:
            channel = info.get('channel', {})
            members = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join' and e.get('state_key') not in (self.owner, '@telegrambot:messenger.internal')]
            # bridgev2 emits room_type in bridge info; fallback counts real participants.
            room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.telegram.type') or info.get('com.beeper.room_type')
            meta['space'] = any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state)
            meta['kind'] = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
            meta['label'] = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname') or 'Telegram conversation'
            meta['names'] = {e.get('state_key'): (e.get('content') or {}).get('displayname') for e in state if e['type'] == 'm.room.member' and (e.get('content') or {}).get('displayname')}
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta, ensure_ascii=False)))
        self.rooms[room] = meta
        return meta

    def ingest(self, identity, meta, event):
        etype, content = event.get('type'), event.get('content') or {}
        sender = event.get('sender', '')
        outgoing = self.is_me(sender)
        relates = content.get('m.relates_to') or {}
        if etype == 'm.room.redaction':
            target = event.get('redacts') or content.get('redacts')
            if target:
                self.store.redact(target)
            return
        if etype == 'm.reaction' and relates.get('rel_type') == 'm.annotation' and isinstance(relates.get('key'), str):
            self.store.react(event['event_id'], relates.get('event_id', ''), sender, relates['key'][:32], outgoing)
            return
        if etype == 'm.room.message' and relates.get('rel_type') == 'm.replace':
            new = content.get('m.new_content') or {}
            if isinstance(new.get('body'), str) and new.get('msgtype') in ('m.text', 'm.notice', 'm.emote'):
                with self.store.db() as db:
                    ok = db.execute('SELECT 1 FROM message WHERE id=? AND (sender=? OR (outgoing=1 AND ?))', (relates.get('event_id'), meta.get('names', {}).get(sender) or sender, outgoing)).fetchone()
                if ok:
                    self.store.bump(relates.get('event_id'), ',original=?,translated=NULL,translation_error=NULL,edited=1', (new['body'],))
            return
        if sender.startswith('@telegrambot:'):
            # Bridge error notices are not chat lines: mark our newest recent outgoing message as failed.
            if content.get('msgtype') == 'm.notice':
                stamp = event.get('origin_server_ts', 0)
                with self.store.db() as db:
                    row = db.execute('SELECT id FROM message WHERE identity_id=? AND outgoing=1 AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 1',
                                     (identity['id'], stamp - 120000, stamp + 5000)).fetchone()
                if row:
                    self.store.bump(row[0], ',failed=?', ('Telegram did not accept this message',))
            return
        parts = message_parts(event)
        if parts is None:
            return
        msgtype, body, media, reply_to = parts
        self.store.add_message(event['event_id'], identity, meta.get('names', {}).get(sender) or sender, outgoing, body,
                               event.get('origin_server_ts', 0), msgtype=msgtype, media=media, reply_to=reply_to)
        self.warm_voice(event['event_id'], msgtype, outgoing, media, event.get('origin_server_ts', 0))

    WARM_DAYS = 3

    def warm_voice(self, message_id, msgtype, outgoing, media, stamp):
        if msgtype != 'm.audio' or outgoing or not media or not media.get('mxc'):
            return
        if stamp < (time.time() - self.WARM_DAYS * 86400) * 1000:
            return  # backlog replay on start: older notes load on demand
        try:
            self.warm_queue.put_nowait(message_id)
        except queue.Full:
            pass

    def ephemeral(self, identity, events):
        for event in events:
            if event.get('type') == 'm.typing':
                users = [u for u in (event.get('content') or {}).get('user_ids', []) if not self.is_me(u)]
                names = self.rooms.get(identity['address'], {}).get('names', {})
                now = [names.get(u) or 'Someone' for u in users]
                if self.typing.get(identity['person_id'], {}).get('names') != now:
                    self.typing[identity['person_id']] = {'names': now, 'until': time.time() + 30}
                    self.store.touch_identity(identity['id'])
            elif event.get('type') == 'm.receipt':
                for event_id, kinds in (event.get('content') or {}).items():
                    for kind in ('m.read', 'm.read.private'):
                        for user in (kinds.get(kind) or {}):
                            with self.store.db() as db:
                                row = db.execute('SELECT timestamp FROM message WHERE id=?', (event_id,)).fetchone()
                            if not row:
                                continue
                            if self.is_me(user):
                                self.store.touch_identity(identity['id'], last_read_ts=row[0])
                            elif user != '@telegrambot:messenger.internal':
                                self.store.touch_identity(identity['id'], peer_read_ts=row[0])

    def is_me(self, user):
        return user == self.owner or user in self.mine

    def learn_me(self):
        """Find the owner's Telegram ghost from the bridge login; fix lines already stored under it."""
        if time.time() - self.mine_checked < 300 or not self.telegram_configured():
            return
        self.mine_checked = time.time()
        try:
            logins = self.provision('/whoami').get('logins') or []
        except EngineError:
            return
        found = {'@telegram_%s:messenger.internal' % l['id'] for l in logins if str(l.get('id', '')).isdecimal()}
        if found - self.mine:
            self.mine |= found
            self.store.put('own_ghosts', json.dumps(sorted(self.mine)))
        for ghost in sorted(self.mine):
            if not self.store.get('own_fixed:' + ghost):
                self.store.claim_own(ghost)
                self.store.put('own_fixed:' + ghost, '1')

    def sync(self, timeout_ms=0):
        if not self.sync_lock.acquire(blocking=False):
            return {'state': 'syncing'}
        try:
            self.learn_me()
            since = self.store.get('sync_token')
            query = {'timeout': timeout_ms if since else 0, 'filter': json.dumps({'room': {'timeline': {'limit': 100}}})}
            if since:
                query['since'] = since
            result = self.mx('/sync?' + urlencode(query), timeout=timeout_ms / 1000 + 15)
            for room, invited in result.get('rooms', {}).get('invite', {}).items():
                events = invited.get('invite_state', {}).get('events', [])
                # Never auto-join arbitrary invitations: bridge bot/ghost namespace only.
                if any(e.get('type') == 'm.room.member' and e.get('state_key') == self.owner and e.get('sender', '').startswith(('@telegram_', '@telegrambot:')) for e in events):
                    self.mx('/join/' + quote(room, safe=''), 'POST', {})
            for room in result.get('rooms', {}).get('leave', {}):
                # A bridged chat that was removed (e.g. on disconnect) leaves no stale card behind.
                if self.store.forget('telegram', room):
                    self.store.next_seq()
                    self.notify()
            for room, data in result.get('rooms', {}).get('join', {}).items():
                if data.get('timeline', {}).get('limited'):
                    self.store.put('history_gap:' + room, 'Earlier history may be incomplete')
                meta = self.room_meta(room, data)
                if not meta.get('telegram') or meta.get('space'):
                    continue
                identity = self.store.identity('telegram', room, meta['label'], meta['kind'])
                for event in data.get('timeline', {}).get('events', []):
                    self.ingest(identity, meta, event)
                self.ephemeral(identity, data.get('ephemeral', {}).get('events', []))
            self.store.put('sync_token', result['next_batch'])
            self.store.put('sync_error', '')
            return {'state': 'ready'}
        except EngineError as error:
            self.store.put('sync_error', error.message)
            return {'state': 'unavailable', 'error': error.message}
        finally:
            self.sync_lock.release()

    def backfill_media(self, identity):
        """Rows stored before media support carry only "[Photo] caption"; re-read recent room history once
        and upgrade those rows in place so the pictures appear a moment after the thread opens."""
        room = identity['address']
        if room in self.backfilled or identity['network'] != 'telegram':
            return
        self.backfilled.add(room)

        def run():
            try:
                meta = self.room_meta(room, {})
                token = None
                for _ in range(3):
                    query = {'dir': 'b', 'limit': 100}
                    if token:
                        query['from'] = token
                    page = self.mx(self.room(room) + '/messages?' + urlencode(query))
                    for event in page.get('chunk', []):
                        if event.get('type') in ('m.room.message', 'm.sticker', 'm.reaction', 'm.room.redaction'):
                            self.ingest(identity, meta, event)
                    token = page.get('end')
                    if not token or not page.get('chunk'):
                        break
            except Exception:
                self.backfilled.discard(room)
        threading.Thread(target=run, name='media-backfill', daemon=True).start()

    # ---------- Marmot mirror (background only) ----------
    def marmot(self):
        if self.engine.status().get('state') != 'ready':
            return
        own = self.engine.identity().get('identity') or {}
        mine = {own.get(k) for k in ('account_id', 'member_id', 'npub')} - {None}
        for dm in self.engine.dms()['dms']:
            peer = next((m for m in dm.get('members', []) if not mine.intersection(m.get(k) for k in ('account_id', 'member_id', 'npub'))), {})
            label = peer.get('display_name') or dm.get('name') or 'Messenger contact'
            identity = self.store.identity('messenger', dm['group_id'], label)
            self.import_marmot(identity, 50)

    def import_marmot(self, identity, limit=200):
        for m in self.engine.messages(identity['address'], limit).get('messages', []):
            stamp = m.get('created_at', 0)
            if isinstance(stamp, str):
                from datetime import datetime
                stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000
            elif stamp < 1000000000000:
                stamp *= 1000
            self.store.add_message('messenger:' + m['message_id'], identity, m.get('author', ''), m.get('direction') == 'sent', m.get('text', ''), int(stamp))

    # ---------- reading ----------
    def timeline(self, person_id, before=None, limit=2000):
        person = self.store.person(person_id)
        if before is None:
            for identity in person['identities']:
                if identity['network'] == 'messenger':
                    def pull(identity=identity):
                        try:
                            if self.engine.status().get('state') == 'ready':
                                self.import_marmot(identity)
                        except Exception:
                            pass
                    threading.Thread(target=pull, daemon=True).start()
        messages = self.store.messages(person_id, before, limit + 1)
        has_more = len(messages) > limit
        messages = messages[-limit:]
        pending = False
        for message in messages:
            if not message['outgoing'] and not person['language']:
                message.update(translation_error=None)
            if not message['outgoing'] and person['language'] and not message['translated'] and not message['deleted'] and message['original'].strip():
                pending = True
                if message['id'] not in self.tq_seen:
                    self.tq_seen.add(message['id'])
                    self.tq.put((message['id'], message['original']))
            if message['msgtype'] == 'm.text' and re.match(r'\[(Photo|Video|Voice message|File|Sticker)\]', message['original']):
                self.backfill_media(next(i for i in person['identities'] if i['id'] == message['identity_id']))
        gaps = [self.store.get('history_gap:' + i['address']) for i in person['identities']]
        typing = self.typing.get(person_id)
        return {'person': person, 'messages': messages, 'has_more': has_more, 'translating': pending, 'seq': self.store.seq,
                'typing': typing['names'] if typing and typing['until'] > time.time() else [],
                'history_warning': next((g for g in gaps if g), None)}

    def translate_one(self, message_id, original):
        translated, error = self.translator.translate(original, 'en')
        self.store.bump(message_id, ',translated=?,translation_error=?', (None if error else translated, error))

    def translate_pending(self):
        """Drain the background translation queue synchronously (tests)."""
        while not self.tq.empty():
            self.translate_one(*self.tq.get())

    def updates(self, since, hold):
        """Long-poll change feed: returns as soon as anything newer than `since` exists."""
        hold = max(0.0, min(float(hold), self.HOLD_MAX))
        deadline = time.time() + hold
        with self.cond:
            if self.waiters >= self.WAITERS_MAX:
                fail('busy', 'Too many open views', 429)
            self.waiters += 1
            try:
                while self.store.seq <= since and not self.stop.is_set():
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        break
                    self.cond.wait(remaining)
            finally:
                self.waiters -= 1
        if since > self.store.seq:
            return {'seq': self.store.seq, 'reset': True}
        if self.store.seq <= since:
            return {'seq': since, 'people': [], 'messages': {}, 'typing': {}}
        target = self.store.seq  # read before the query: a concurrent write is re-sent, never skipped
        rows, touched = self.store.since(since)
        seq = max([since] + [r['seq'] for r in rows]) if len(rows) >= 400 else target
        grouped = {}
        for row in rows:
            grouped.setdefault(row['person_id'], []).append(row)
        people = self.store.people('person', True, touched) + self.store.people('group', True, touched)
        now = time.time()
        typing = {pid: t['names'] for pid, t in self.typing.items() if pid in touched and t['until'] > now}
        return {'seq': seq, 'people': people, 'removed': sorted(set(touched) - {p['id'] for p in people}), 'messages': grouped, 'typing': typing}

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

    # ---------- sending ----------
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
            reply_to = self.reply_target(identity, payload.get('reply_to'))
            # Stable transaction ID makes even ambiguous Matrix retries idempotent.
            delivery = 'sent'
            if identity['network'] == 'telegram':
                content = {'msgtype': 'm.text', 'body': body}
                if reply_to:
                    content['m.relates_to'] = {'m.in_reply_to': {'event_id': reply_to}}
                result = self.mx(self.room(identity['address']) + '/send/m.room.message/' + p['id'], 'PUT', content)
                event = result['event_id']
            else:
                result = self.engine.send(identity['address'], {'text': body, 'request_id': p['id']})
                event = 'messenger:' + result['message_ids'][0]
                delivery = 'sent' if result['published'] else 'queued'
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), p['original'] if body != p['original'] else None,
                                   reply_to=reply_to, client_id=payload.get('client_id'))
            with self.store.db() as db:
                db.execute('UPDATE preview SET status=?,event_id=? WHERE id=?', (delivery, event, p['id']))
                # A sync may have received our event before the confirm receipt.
                db.execute('UPDATE message SET translated=? WHERE id=?', (p['original'] if body != p['original'] else None, event))
            return {'state': delivery, 'event_id': event, 'message': self.row(event)}

    def row(self, message_id):
        with self.store.db() as db:
            rows = db.execute('SELECT m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id WHERE m.id=?', (message_id,)).fetchall()
        rows = self.store.decorate(rows)
        return rows[0] if rows else None

    def reply_target(self, identity, reply_to):
        if not reply_to:
            return None
        message = self.store.message(text(reply_to, 300))
        if message['identity_id'] != identity['id']:
            fail('invalid_reply', 'Reply to a message in this chat')
        return message['id']

    def channel(self, person_id, identity_id=None):
        person = self.store.person(person_id)
        identity_id = identity_id or person['preferred_identity'] or person['identities'][0]['id']
        identity = next((i for i in person['identities'] if i['id'] == identity_id), None)
        if not identity:
            fail('invalid_identity', 'Choose this person’s channel')
        return person, identity

    def send(self, person_id, payload):
        """One-call send for chats that need no translation review; the client id is the Matrix
        transaction id, so a retried tap can never produce a second message."""
        if payload.get('preview_id'):
            return self.confirm(person_id, payload)
        client_id = payload.get('client_id')
        if not isinstance(client_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', client_id):
            fail('invalid_client_id', 'Missing message id')
        with self.store.db() as db:
            done = db.execute('SELECT id FROM message WHERE client_id=?', (client_id,)).fetchone()
        if done:
            return {'state': 'sent', 'event_id': done[0], 'message': self.row(done[0])}
        person, identity = self.channel(person_id, payload.get('identity_id'))
        upload = self.uploads.get(payload.get('upload_id')) if payload.get('upload_id') else None
        if payload.get('upload_id') and (not upload or upload['person_id'] != person_id):
            fail('upload_expired', 'Attach the file again', 409)
        body = payload.get('text') or ''
        if body:
            body = text(body)
        elif not upload:
            fail('invalid_input', 'Please enter valid text')
        if body and not upload and person['language'] and person['language'] != 'en':
            fail('review_required', 'This chat translates before sending', 409)
        reply_to = self.reply_target(identity, payload.get('reply_to'))
        if identity['network'] != 'telegram':
            if upload:
                fail('media_unsupported', 'Photos and voice notes are not available on Messenger yet', 409)
            result = self.engine.send(identity['address'], {'text': body, 'request_id': client_id[:64]})
            event = 'messenger:' + result['message_ids'][0]
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), client_id=client_id)
            return {'state': 'sent' if result['published'] else 'queued', 'event_id': event, 'message': self.row(event)}
        msgtype, media = 'm.text', None
        if upload:
            msgtype, content, media = self.media_content(upload, body, payload)
        else:
            content = {'msgtype': 'm.text', 'body': body}
        if reply_to:
            content['m.relates_to'] = {'m.in_reply_to': {'event_id': reply_to}}
        started = time.time()
        result = self.mx(self.room(identity['address']) + '/send/m.room.message/' + client_id, 'PUT', content)
        self.timing('send', started)
        event = result['event_id']
        self.store.add_message(event, identity, self.owner, True, body if upload is None else (body or ''), int(time.time() * 1000),
                               msgtype=msgtype, media=media, reply_to=reply_to, client_id=client_id)
        if upload:
            self.uploads.pop(payload.get('upload_id'), None)
        return {'state': 'sent', 'event_id': event, 'message': self.row(event)}

    def media_content(self, upload, caption, payload):
        info = {'mimetype': upload['mime'], 'size': upload['size']}
        meta = payload.get('media') if isinstance(payload.get('media'), dict) else {}
        for key in ('w', 'h', 'duration'):
            if isinstance(meta.get(key), int) and 0 < meta[key] < 10 ** 8:
                info[key] = meta[key]
        media = {'mxc': upload['mxc'], 'mime': upload['mime'], 'size': upload['size'], 'w': info.get('w'), 'h': info.get('h'), 'duration': info.get('duration')}
        if upload['kind'] == 'voice':
            wave = [int(x) for x in (meta.get('waveform') or []) if isinstance(x, (int, float))][:128]
            wave = [max(0, min(1024, x)) for x in wave]
            content = {'msgtype': 'm.audio', 'body': 'Voice message', 'filename': upload['filename'], 'url': upload['mxc'], 'info': info,
                       'org.matrix.msc1767.audio': {'duration': info.get('duration', 0), 'waveform': wave},
                       'org.matrix.msc1767.text': 'Voice message', 'org.matrix.msc3245.voice': {}}
            media.update(voice=True, filename=upload['filename'])
            if wave:
                top = max(max(wave), 1)
                step = max(1, len(wave) / 48)
                media['waveform'] = [int(100 * wave[int(i * step)] / top) for i in range(min(48, len(wave)))]
            return 'm.audio', content, {k: v for k, v in media.items() if v is not None}
        content = {'msgtype': 'm.image', 'body': caption or upload['filename'], 'filename': upload['filename'], 'url': upload['mxc'], 'info': info}
        return 'm.image', content, {k: v for k, v in media.items() if v is not None}

    def upload(self, person_id, kind, data):
        """Owner upload (already size-capped by the view server) → Synapse media repo. Returns an opaque id."""
        if kind not in ('image', 'voice'):
            fail('invalid_upload', 'Choose a photo or a voice note')
        _, identity = self.channel(person_id)
        if identity['network'] != 'telegram':
            fail('media_unsupported', 'Photos and voice notes are not available on Messenger yet', 409)
        mime = sniff(data)
        if kind == 'voice' and mime == 'video/mp4':
            mime = 'audio/mp4'  # Safari records voice into an mp4 container
        ok = {'image': ('image/jpeg', 'image/png', 'image/gif', 'image/webp'), 'voice': ('audio/ogg', 'audio/webm', 'audio/mp4')}[kind]
        if mime not in ok:
            fail('invalid_upload', 'That file type is not supported here', 415)
        ext = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a'}[mime]
        filename = ('voice-message.' if kind == 'voice' else 'photo.') + ext
        started = time.time()
        req = Request(self.matrix.rstrip('/') + '/_matrix/media/v3/upload?' + urlencode({'filename': filename}), data=data, method='POST',
                      headers={'Authorization': 'Bearer ' + self.matrix_token(), 'Content-Type': mime})
        try:
            with urlopen(req, timeout=60) as response:
                mxc = json.load(response)['content_uri']
        except (HTTPError, URLError, OSError, ValueError, KeyError):
            fail('upstream_unavailable', 'Upload failed. Please try again.', 503)
        self.timing('upload', started)
        upload_id = secrets.token_hex(16)
        now = time.time()
        self.uploads = {k: v for k, v in self.uploads.items() if v['expires'] > now}
        self.uploads[upload_id] = {'mxc': mxc, 'mime': mime, 'size': len(data), 'kind': kind, 'filename': filename, 'person_id': person_id, 'expires': now + 3600}
        return {'upload_id': upload_id, 'mime': mime, 'size': len(data)}

    def media(self, message_id, kind):
        """Proxy a message's media from the private homeserver; mxc URIs and tokens never leave the box."""
        message = self.store.message(message_id)
        media = json.loads(message['media']) if message.get('media') else None
        if not media or not media.get('mxc'):
            fail('not_found', 'No media on that message', 404)
        thumb = kind == 'thumb'
        mime = media.get('mime') or 'application/octet-stream'
        if thumb and not (media.get('thumb') or mime.startswith('image/')):
            fail('not_found', 'No preview for that message', 404)
        mxc = (media.get('thumb') if thumb and media.get('thumb') else media['mxc'])
        match = re.fullmatch(r'mxc://([A-Za-z0-9.:_-]+)/([A-Za-z0-9_-]+)', mxc or '')
        if not match:
            fail('not_found', 'No media on that message', 404)
        cache = self.root / 'media-cache'
        cache.mkdir(mode=0o700, exist_ok=True)
        key = hashlib.sha256((mxc + '|' + ('thumb' if thumb else 'full')).encode()).hexdigest()
        path = cache / key
        meta_path = cache / (key + '.type')
        if not path.exists():
            server, media_id = match.groups()
            if thumb and not media.get('thumb'):
                url = '/_matrix/client/v1/media/thumbnail/%s/%s?%s' % (server, media_id, urlencode({'width': 800, 'height': 800, 'method': 'scale', 'animated': 'true'}))
            else:
                url = '/_matrix/client/v1/media/download/%s/%s' % (server, media_id)
            started = time.time()
            req = Request(self.matrix.rstrip('/') + url, headers={'Authorization': 'Bearer ' + self.matrix_token()})
            tmp = cache / (key + '.part-' + secrets.token_hex(4))
            try:
                with urlopen(req, timeout=60) as response, tmp.open('wb') as out:
                    got = response.headers.get('Content-Type', '').split(';')[0].strip()
                    total = 0
                    while True:
                        chunk = response.read(65536)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > 200 * 1024 * 1024:
                            fail('too_large', 'That file is too large to show', 413)
                        out.write(chunk)
            except (HTTPError, URLError, OSError):
                tmp.unlink(missing_ok=True)
                fail('upstream_unavailable', 'Could not load that media. Try again.', 503)
            except EngineError:
                tmp.unlink(missing_ok=True)
                raise
            with tmp.open('rb') as f:
                sniffed = sniff(f.read(64))
            meta_path.write_text(sniffed or got or mime)
            os.replace(tmp, path)
            self.timing('media', started)
            self.evict(cache)
        else:
            os.utime(path)
        served = meta_path.read_text().strip() if meta_path.exists() else mime
        if served == 'audio/webm' and mime.startswith('video/'):
            served = 'video/webm'
        if served == 'audio/mp4' and mime.startswith('video/'):
            served = 'video/mp4'
        name = media.get('filename') or ('media')
        return Blob(path, served if served in INLINE_MIME else 'application/octet-stream', name, served in INLINE_MIME)

    def evict(self, cache):
        files = [(p.stat().st_atime, p.stat().st_size, p) for p in cache.iterdir() if p.is_file() and not p.name.endswith('.type')]
        total = sum(f[1] for f in files)
        for _, size, p in sorted(files):
            if total <= MEDIA_CACHE_MAX:
                break
            p.unlink(missing_ok=True)
            Path(str(p) + '.type').unlink(missing_ok=True)
            total -= size

    def react(self, message_id, payload):
        message = self.store.message(message_id)
        key = payload.get('key')
        if not isinstance(key, str) or not key or len(key) > 32:
            fail('invalid_input', 'Choose a reaction')
        if message['network'] != 'telegram':
            fail('unsupported', 'Reactions are not available on Messenger yet', 409)
        room = self.room(message['address'])
        with self.store.db() as db:
            mine = db.execute('SELECT event_id,key FROM reaction WHERE message_id=? AND outgoing=1', (message_id,)).fetchall()
        # Telegram allows one reaction per person here: replace any previous one (Signal behaves the same).
        for row in mine:
            self.mx(room + '/redact/' + quote(row[0], safe='') + '/' + secrets.token_hex(8), 'PUT', {})
            self.store.redact(row[0])
        if payload.get('remove') is True or any(r[1] == key for r in mine):
            return {'message': self.row(message_id)}
        result = self.mx(room + '/send/m.reaction/' + secrets.token_hex(12), 'PUT',
                         {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': message_id, 'key': key}})
        self.store.react(result['event_id'], message_id, self.owner, key, True)
        return {'message': self.row(message_id)}

    def edit(self, message_id, payload):
        message = self.store.message(message_id)
        new = text(payload.get('text'))
        if not message['outgoing'] or message['deleted'] or message['network'] != 'telegram' or message['msgtype'] != 'm.text':
            fail('not_editable', 'Only your own text messages can be edited', 409)
        self.mx(self.room(message['address']) + '/send/m.room.message/' + secrets.token_hex(12), 'PUT',
                {'msgtype': 'm.text', 'body': '* ' + new, 'm.new_content': {'msgtype': 'm.text', 'body': new},
                 'm.relates_to': {'rel_type': 'm.replace', 'event_id': message_id}})
        self.store.bump(message_id, ',original=?,translated=NULL,edited=1', (new,))
        return {'message': self.row(message_id)}

    def delete(self, message_id, payload):
        message = self.store.message(message_id)
        everyone = payload.get('everyone') is True
        if everyone:
            if not message['outgoing'] or message['network'] != 'telegram':
                fail('not_deletable', 'Only your own messages can be deleted for everyone', 409)
            self.mx(self.room(message['address']) + '/redact/' + quote(message_id, safe='') + '/' + secrets.token_hex(8), 'PUT', {})
        self.store.redact(message_id)
        return {'message': self.row(message_id)}

    def read(self, person_id, payload):
        person = self.store.person(person_id)
        stamp = payload.get('timestamp')
        if not isinstance(stamp, int) or stamp < 0:
            fail('invalid_input', 'Missing read position')
        for identity in person['identities']:
            with self.store.db() as db:
                row = db.execute('SELECT id,timestamp FROM message WHERE identity_id=? AND outgoing=0 AND timestamp<=? ORDER BY timestamp DESC LIMIT 1',
                                 (identity['id'], stamp)).fetchone()
            if not row or row[1] <= identity['last_read_ts']:
                continue
            self.store.touch_identity(identity['id'], last_read_ts=row[1])
            if identity['network'] == 'telegram':
                event_id = row[0]

                def receipt(address=identity['address'], event_id=event_id):
                    try:
                        self.mx(self.room(address) + '/receipt/m.read/' + quote(event_id, safe=''), 'POST', {})
                    except EngineError:
                        pass
                threading.Thread(target=receipt, daemon=True).start()
        return {'ok': True}

    def set_typing(self, person_id, payload):
        _, identity = self.channel(person_id)
        if identity['network'] == 'telegram':
            on = payload.get('typing') is True
            self.mx(self.room(identity['address']) + '/typing/' + quote(self.owner, safe=''), 'PUT', {'typing': on, 'timeout': 6000} if on else {'typing': False})
        return {'ok': True}

    def timing(self, name, started):
        self.timings = (self.timings + [(name, int((time.time() - started) * 1000))])[-200:]

    def dispatch(self, method, path, payload, query=None, raw=None):
        parts = path.split('?')[0].strip('/').split('/')
        suffix = [unquote(x) for x in parts[2:]]
        query = query or {}
        q = lambda k, d=None: (query.get(k) or [d])[0]
        if suffix == ['status'] and method == 'GET':
            stats = {}
            for name, ms in self.timings:
                stats.setdefault(name, []).append(ms)
            return {'telegram': self.telegram_status(), 'matrix_error': self.store.get('sync_error'), 'marmot': self.engine.status().get('state'),
                    'timings': {k: {'n': len(v), 'p50': sorted(v)[len(v) // 2]} for k, v in stats.items()}}
        if suffix == ['sync'] and method == 'POST':
            # The background long-poll keeps the store current; this answers at once.
            return {'state': 'syncing' if self.sync_lock.locked() else 'ready', 'error': self.store.get('sync_error') or None}
        if suffix == ['updates'] and method == 'GET':
            try:
                since, hold = int(q('since', '0')), float(q('hold', '0'))
            except ValueError:
                fail('invalid_cursor', 'Invalid update cursor')
            return self.updates(since, hold)
        if suffix in (['people'], ['groups']) and method == 'GET':
            kind = 'group' if suffix[0] == 'groups' else 'person'
            return {suffix[0]: self.store.people(kind), 'seq': self.store.seq}
        if suffix == ['directory'] and method == 'GET':
            return {'people': self.store.people('person', chats=False), 'groups': self.store.people('group', chats=False)}
        if len(suffix) == 2 and suffix[0] == 'media' and method == 'GET':
            return self.media(text(suffix[1], 300), 'thumb' if q('kind') == 'thumb' else 'full')
        if len(suffix) >= 2 and suffix[0] == 'people':
            person_id = suffix[1]
            if len(suffix) == 2:
                if method == 'GET':
                    try:
                        before = int(q('before')) if q('before') else None
                        limit = max(1, min(int(q('limit', '2000')), 2000))
                    except ValueError:
                        fail('invalid_cursor', 'Invalid message query')
                    return self.timeline(person_id, before, limit)
                if method == 'POST':
                    return self.store.update(person_id, payload)
            if len(suffix) == 3 and method == 'PUT' and suffix[2] == 'upload':
                return self.upload(person_id, q('kind', 'image'), raw or b'')
            if len(suffix) == 3 and method == 'POST':
                action = suffix[2]
                if action == 'merge': return self.store.merge(person_id, text(payload.get('source_id'), 24))
                if action == 'unmerge': return self.store.unmerge(person_id, payload.get('identity_id'))
                if action == 'preview': return self.preview(person_id, payload)
                if action == 'send': return self.send(person_id, payload)
                if action == 'read': return self.read(person_id, payload)
                if action == 'typing': return self.set_typing(person_id, payload)
        if len(suffix) == 3 and suffix[0] == 'messages' and method == 'POST':
            message_id = text(suffix[1], 300)
            if suffix[2] == 'transcript': return self.store.transcript(message_id, payload)
            if suffix[2] == 'translate': return self.translate_message(message_id)
            if suffix[2] == 'react': return self.react(message_id, payload)
            if suffix[2] == 'edit': return self.edit(message_id, payload)
            if suffix[2] == 'delete': return self.delete(message_id, payload)
        if len(suffix) == 3 and suffix[0] == 'groups' and suffix[2] == 'labels' and method == 'POST':
            return self.store.labels(suffix[1], payload.get('labels'))
        if suffix == ['qr-codes'] and method == 'GET': return self.qr_codes()
        if suffix == ['qr-codes'] and method == 'POST': return self.save_qr_codes(payload)
        if suffix == ['telegram', 'status'] and method == 'GET': return self.telegram_status()
        if suffix == ['telegram', 'start'] and method == 'POST':
            flow = payload.get('flow')
            if flow not in ('qr', 'phone'): fail('invalid_flow', 'Choose QR or phone login')
            self.matrix_token()
            return self.remember_login(self.provision('/login/start/' + flow, 'POST', {}))
        if suffix == ['telegram', 'step'] and method == 'POST':
            values = [payload.get(k) for k in ('login_id', 'step_id', 'type')]
            if not all(isinstance(v, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', v) for v in values) or values[2] not in ('user_input', 'display_and_wait'):
                fail('invalid_step', 'Invalid login step')
            fields = payload.get('fields', {})
            if not isinstance(fields, dict) or not all(isinstance(k, str) and isinstance(v, str) and len(v) <= 1024 for k, v in fields.items()):
                fail('invalid_step', 'Invalid login input')
            return self.remember_login(self.provision('/login/step/' + '/'.join(values), 'POST', fields))
        if suffix == ['telegram', 'disconnect'] and method == 'POST': return self.provision('/logout/all', 'POST', {})
        if suffix == ['telegram', 'cancel'] and method == 'POST':
            self._pending_login = None
            return self.provision('/login/cancel/' + quote(text(payload.get('login_id'), 160), safe=''), 'POST', {})
        fail('not_found', 'No such unified inbox route', 404)
