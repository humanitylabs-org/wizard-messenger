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
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode
from urllib.request import Request, urlopen
from engine import EngineError
from readiness.search import SearchStore
import history_cursor
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
MXC = re.compile(r'mxc://([A-Za-z0-9.:_-]+)/([A-Za-z0-9_-]+)')

# Bridges tag ghost names with their network ("Ana (WA)"); the Inbox already shows the network's icon.
NAME_SUFFIX = {'whatsapp': ' (WA)', 'twitter': ' (Twitter)', 'linkedin': ' (LinkedIn)'}


def name_key(name):
    """Comparable form of a person's name: accents, case, punctuation and emoji dropped."""
    name = unicodedata.normalize('NFKD', name or '')
    name = ''.join(c for c in name if not unicodedata.combining(c))
    return ' '.join(re.sub(r'[^\w\s]', ' ', name.casefold()).split())


def link_previews(content):
    """Bridges attach the sender's own link preview (com.beeper.linkpreviews); keep up to two, image as mxc."""
    out = []
    for lp in (content.get('com.beeper.linkpreviews') or [])[:2]:
        if not isinstance(lp, dict):
            continue
        url = lp.get('matched_url') or lp.get('og:url') or ''
        if not isinstance(url, str) or not re.match(r'https?://', url):
            continue
        img = lp.get('og:image') or (lp.get('beeper:image:encryption') or {}).get('url')
        item = {'url': url[:2000], 'title': str(lp.get('og:title') or '')[:300], 'desc': str(lp.get('og:description') or '')[:400],
                'site': str(lp.get('og:site_name') or '')[:80]}
        if isinstance(img, str) and MXC.fullmatch(img) and not lp.get('beeper:image:encryption'):
            item.update(mxc=img, w=lp.get('og:image:width'), h=lp.get('og:image:height'))
        if item['title'] or item['desc']:
            out.append(item)
    return {'links': out} if out else None


def picture_tag(mxc):
    return hashlib.sha256(mxc.encode()).hexdigest()[:12] if mxc else None


def plain_name(network, label):
    tag = NAME_SUFFIX.get(network)
    if isinstance(label, str) and tag and label.endswith(tag) and len(label) > len(tag):
        return label[:-len(tag)].rstrip()
    return label


MATRIX_NETWORKS = frozenset(('telegram', 'whatsapp', 'signal', 'slack', 'line', 'instagram', 'facebook', 'twitter', 'linkedin', 'gmessages', 'dots'))
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
    if data[:5] == b'%PDF-': return 'application/pdf'
    if data[:4] in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'): return 'application/zip'
    return None


def file_name(name):
    # Any-file uploads keep a display name, never a path (James, 26 Oct 2026).
    name = re.split(r'[/\\]', name if isinstance(name, str) else '')[-1]
    name = ''.join(c for c in name if unicodedata.category(c) not in ('Cc', 'Cf', 'Cs'))
    name = ' '.join(name.split()).lstrip(' .') or 'file'
    suffix = Path(name).suffix
    # Reserve a stem character even for a pathological extension over 118 chars.
    ext = suffix[:119]
    stem = name[:-len(suffix)] if suffix else name
    return stem[:120 - len(ext)].rstrip() + ext


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
    ('message', 'album', 'TEXT'),
    ('message', 'source_event', 'TEXT'),
    ('identity', 'last_read_ts', 'INTEGER NOT NULL DEFAULT 0'),
    ('identity', 'peer_read_ts', 'INTEGER NOT NULL DEFAULT 0'),
    ('identity', 'seq', 'INTEGER NOT NULL DEFAULT 0'),
    # 1 once the owner renamed the person: synced network names never overwrite it.
    ('person', 'name_locked', 'INTEGER NOT NULL DEFAULT 0'),
    # 1 = the owner moved this chat to Low priority: it leaves the Inbox, unread counts and notifications.
    ('person', 'low_priority', 'INTEGER NOT NULL DEFAULT 0'),
    # 1 = Medium priority: stays in the Inbox but never pings (no push, badge, Unread count or Wizard inbox feed).
    # Medium and Low are exclusive; setting one clears the other.
    ('person', 'medium_priority', 'INTEGER NOT NULL DEFAULT 0'),
]

# Matches the bridges' backfill.unread_hours_threshold: older history is read.
HISTORY_UNREAD_HOURS = 720
OWN_SENDER = 'You'
_PHONE = re.compile(r'\+?[\d\s().-]{5,}\Z')
_RAW_ID = re.compile(r'(@[^\s:]+:\S+|[uUcCrR][0-9a-f]{32})\Z')


def weak_label(label, own=()):
    """Labels that must never replace a real name: generic fallbacks, phone
    numbers, raw protocol IDs and the owner's own names."""
    if not isinstance(label, str) or not label.strip():
        return True
    label = label.strip()
    return (label in own or label.endswith(' conversation') or label in ('Messenger contact', 'Direct message')
            or bool(_PHONE.fullmatch(label)) or bool(_RAW_ID.fullmatch(label)))


class PeopleStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.on_change = None
        self.push_enabled = False
        self._conn = None
        with self.db() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS person(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', preferred_identity TEXT);
            CREATE TABLE IF NOT EXISTS identity(id TEXT PRIMARY KEY, person_id TEXT REFERENCES person(id), network TEXT NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL, last_used INTEGER NOT NULL DEFAULT 0, UNIQUE(network,address));
            CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES identity(id), sender TEXT NOT NULL, outgoing INTEGER NOT NULL, original TEXT NOT NULL, translated TEXT, translation_error TEXT, timestamp INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS room_label(identity_id TEXT NOT NULL REFERENCES identity(id), label TEXT NOT NULL, PRIMARY KEY(identity_id,label));
            CREATE TABLE IF NOT EXISTS translation(cache_key TEXT PRIMARY KEY, translated TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS push_intent(message TEXT PRIMARY KEY, created REAL NOT NULL, done INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS preview(id TEXT PRIMARY KEY, person_id TEXT NOT NULL, identity_id TEXT NOT NULL, original TEXT NOT NULL, translated TEXT NOT NULL, error TEXT, expires INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'preview', send_original INTEGER, event_id TEXT);
            ''')
        self.migrate()
        self.search_index = SearchStore(self.path, connection=self._conn, lock=self.lock)
        self.install_search()
        os.chmod(self.path, 0o600)
        with self.db() as db:
            self.seq = max(db.execute('SELECT COALESCE(MAX(seq),0) FROM message').fetchone()[0],
                           db.execute('SELECT COALESCE(MAX(seq),0) FROM identity').fetchone()[0])

    def install_search(self):
        # Same connection/transaction as history: edits, translations, tombstones and
        # forget cannot leave a stale plaintext mirror after a crash. One owner per DB;
        # network + immutable identity id keep merged people from collapsing threads.
        with self.db() as db:
            db.executescript('''
            CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON message BEGIN
                INSERT INTO normalized_message(account,network,thread,message_id,timestamp,original,translated)
                SELECT 'owner',i.network,i.id,new.id,new.timestamp,new.original,COALESCE(new.translated,'')
                FROM identity i WHERE i.id=new.identity_id AND new.deleted=0;
            END;
            CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON message BEGIN
                DELETE FROM normalized_message WHERE account='owner' AND message_id=old.id;
            END;
            CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE ON message BEGIN
                DELETE FROM normalized_message WHERE account='owner' AND message_id=old.id AND new.deleted!=0;
                INSERT INTO normalized_message(account,network,thread,message_id,timestamp,original,translated)
                SELECT 'owner',i.network,i.id,new.id,new.timestamp,new.original,COALESCE(new.translated,'')
                FROM identity i WHERE i.id=new.identity_id AND new.deleted=0
                ON CONFLICT(account,network,thread,message_id) DO UPDATE SET
                timestamp=excluded.timestamp,original=excluded.original,translated=excluded.translated;
            END;
            ''')
        self.rebuild_search()

    def rebuild_search(self):
        # Reconcile authoritative rows, including messages removed while upgrading.
        with self.db() as db:
            db.execute('''DELETE FROM normalized_message AS n WHERE n.account!='owner' OR NOT EXISTS
                (SELECT 1 FROM message m JOIN identity i ON i.id=m.identity_id
                 WHERE m.deleted=0 AND m.id=n.message_id AND i.network=n.network AND i.id=n.thread)''')
            db.execute('''INSERT INTO normalized_message(account,network,thread,message_id,timestamp,original,translated)
                SELECT 'owner',i.network,i.id,m.id,m.timestamp,m.original,COALESCE(m.translated,'')
                FROM message m JOIN identity i ON i.id=m.identity_id WHERE m.deleted=0
                ON CONFLICT(account,network,thread,message_id) DO UPDATE SET
                timestamp=excluded.timestamp,original=excluded.original,translated=excluded.translated''')
            db.execute("INSERT INTO message_fts(message_fts) VALUES('rebuild')")

    def search(self, query, *, network=None, thread=None, limit=50, cursor=None):
        # Account is server-derived, never an HTTP-supplied identifier.
        if thread is not None:
            with self.db() as db:
                if not db.execute('SELECT 1 FROM identity WHERE id=? AND (? IS NULL OR network=?)',
                                  (thread, network, network)).fetchone():
                    fail('not_found', 'That conversation is no longer here', 404)
        with self.db() as db:
            result = self.search_index.search(account='owner', query=query, network=network,
                                              thread=thread, limit=limit, cursor=cursor)
            for message in result['messages']:
                identity = db.execute('SELECT i.person_id,p.display_name FROM identity i JOIN person p ON p.id=i.person_id WHERE i.id=?', (message['thread'],)).fetchone()
                message.update(person_id=identity[0], display_name=identity[1])
        return result

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
            if any(m[1] == 'name_locked' for m in missing):
                # Earlier owner renames are the only way a single-channel person's name
                # differs from all its channel labels: keep those names authoritative.
                db.execute('UPDATE person SET name_locked=1 WHERE display_name NOT IN (SELECT label FROM identity WHERE person_id=person.id)')
            # Idempotent: rooms the bridge reports as groups are groups, even if first filed as a person.
            for room, meta in db.execute('SELECT room,json FROM room_meta').fetchall() if db.execute("SELECT 1 FROM sqlite_master WHERE name='room_meta'").fetchone() else []:
                try:
                    if json.loads(meta).get('kind') == 'group':
                        db.execute("UPDATE identity SET kind='group' WHERE address=? AND kind!='group'", (room,))
                except ValueError:
                    pass
            # Idempotent: drop network tags from synced names (owner renames are never touched).
            for network, tag in NAME_SUFFIX.items():
                n = len(tag)
                db.execute('UPDATE person SET display_name=rtrim(substr(display_name,1,length(display_name)-?)) WHERE name_locked=0 AND length(display_name)>? AND substr(display_name,-?)=? '
                           'AND id IN (SELECT person_id FROM identity WHERE network=?)', (n, n, n, tag, network))
                db.execute('UPDATE identity SET label=rtrim(substr(label,1,length(label)-?)) WHERE network=? AND length(label)>? AND substr(label,-?)=?', (n, network, n, n, tag))
            if any(m[1] == 'last_read_ts' for m in missing):
                # Existing chats start read: no wall of unread badges after the upgrade.
                db.execute('UPDATE identity SET last_read_ts=(SELECT COALESCE(MAX(timestamp),0) FROM message WHERE identity_id=identity.id)')
            db.executescript('''
            CREATE TABLE IF NOT EXISTS reaction(event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, sender TEXT NOT NULL, key TEXT NOT NULL, outgoing INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS room_meta(room TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS redacted(event_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS scoped_redaction(identity_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(identity_id,event_id));
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

    def own_names(self):
        """Names the owner is known by on each network (private store, never logged)."""
        names = set()
        with self.db() as db:
            for (value,) in db.execute("SELECT value FROM kv WHERE key LIKE 'own_names:%'"):
                try:
                    names.update(n for n in json.loads(value) if isinstance(n, str) and n.strip())
                except ValueError:
                    pass
        return names

    def remember_own_names(self, source, names):
        names = sorted({n.strip() for n in names if isinstance(n, str) and n.strip()})
        if names and self.get('own_names:' + source) != json.dumps(names, ensure_ascii=False):
            self.put('own_names:' + source, json.dumps(names, ensure_ascii=False))
            return True
        return False

    def identity(self, network, address, label, kind='person'):
        """Find or create a channel; a better synced name replaces a weak or stale one."""
        label = plain_name(network, label)
        with self.db() as db:
            row = db.execute('SELECT * FROM identity WHERE network=? AND address=?', (network, address)).fetchone()
            if row:
                if kind == 'group' and row['kind'] != 'group':
                    # A room first seen before its metadata arrived was filed as a person; the bridge now says group.
                    db.execute('UPDATE identity SET kind=?,seq=? WHERE id=?', (kind, self.next_seq(), row['id']))
                self.refresh_label(dict(row), label)
                return dict(db.execute('SELECT * FROM identity WHERE id=?', (row['id'],)).fetchone())
            person_id, identity_id = secrets.token_hex(12), secrets.token_hex(12)
            db.execute('INSERT INTO person(id,display_name) VALUES (?,?)', (person_id, label))
            db.execute('INSERT INTO identity(id,person_id,network,address,label,kind,last_used,seq) VALUES (?,?,?,?,?,?,0,?)',
                       (identity_id, person_id, network, address, label, kind, self.next_seq()))
            return dict(db.execute('SELECT * FROM identity WHERE id=?', (identity_id,)).fetchone())

    def refresh_label(self, identity, label):
        label = plain_name(identity.get('network'), label)
        own = self.own_names()
        current = identity['label']
        if not isinstance(label, str) or label == current or label in own:
            return False
        # A real name always wins; a generic fallback only replaces the owner's own
        # name (a DM must be titled by the other participant, never by "me").
        if weak_label(label, own) and not (current in own and identity['kind'] == 'person'):
            return False
        label = label.strip()[:160]
        changed = False
        with self.db() as db:
            seq = self.next_seq()
            db.execute('UPDATE identity SET label=?,seq=? WHERE id=?', (label, seq, identity['id']))
            person = db.execute('SELECT display_name,name_locked FROM person WHERE id=?', (identity['person_id'],)).fetchone()
            if person and not person['name_locked'] and (person['display_name'] == current or weak_label(person['display_name'], own)):
                db.execute('UPDATE person SET display_name=? WHERE id=?', (label, identity['person_id']))
                db.execute('UPDATE identity SET seq=? WHERE person_id=?', (seq, identity['person_id']))
            changed = True
        self.changed()
        return changed

    def mark_history_read(self, identity_id, timestamp):
        """Historical lines older than the unread window never create unread badges."""
        if timestamp < (time.time() - HISTORY_UNREAD_HOURS * 3600) * 1000:
            with self.db() as db:
                db.execute('UPDATE identity SET last_read_ts=MAX(last_read_ts,?) WHERE id=?', (timestamp, identity_id))

    def touch_identity(self, identity_id, **fields):
        with self.db() as db:
            sets = ''.join(',%s=MAX(%s,?)' % (k, k) for k in fields)
            db.execute('UPDATE identity SET seq=?' + sets + ' WHERE id=?', (self.next_seq(), *fields.values(), identity_id))
        self.changed()

    def mark_unread(self, person_id):
        """Owner's 'Mark as unread': the newest incoming message counts as unread again (this Messenger only)."""
        with self.db() as db:
            row = db.execute('SELECT i.id,m.timestamp FROM message m JOIN identity i ON i.id=m.identity_id '
                             'WHERE i.person_id=? AND m.outgoing=0 AND m.deleted=0 ORDER BY m.timestamp DESC LIMIT 1', (person_id,)).fetchone()
            if not row:
                fail('invalid_input', 'Nothing to mark unread')
            db.execute('UPDATE identity SET last_read_ts=?,seq=? WHERE id=?', (row[1] - 1, self.next_seq(), row[0]))
        self.changed()
        return {'ok': True}

    def forget(self, network, address):
        with self.db() as db:
            row = db.execute('SELECT id,person_id FROM identity WHERE network=? AND address=?', (network, address)).fetchone()
            if not row:
                return False
            db.execute('DELETE FROM reaction WHERE message_id IN (SELECT id FROM message WHERE identity_id=?)', (row[0],))
            db.execute('DELETE FROM message WHERE identity_id=?', (row[0],))
            db.execute('DELETE FROM room_label WHERE identity_id=?', (row[0],))
            db.execute('DELETE FROM scoped_redaction WHERE identity_id=?', (row[0],))
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
            pictures = self.room_pictures(db)
            remote = self.room_accounts(db) if kind == 'person' else {}
        result = []
        for pid, ident in idents.items():
            if pid not in persons or (ids is not None and pid not in ids):
                continue
            if chats and pid not in last:
                continue
            p = dict(persons[pid], identities=ident, labels=labels.get(pid, []))
            pic = next((pictures[i['address']] for i in ident if pictures.get(i['address'])), None)
            p['avatar'] = picture_tag(pic)
            if remote:
                p['accounts'] = [a for i in ident for a in remote.get(i['address'], [])]
            if pid in last:
                r = last[pid]
                media = json.loads(r['media']) if r['media'] else {}
                p['last'] = {'text': '' if r['deleted'] else r['original'][:140], 'outgoing': bool(r['outgoing']), 'sender': OWN_SENDER if r['outgoing'] else r['sender'], 'timestamp': r['timestamp']}
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

    @staticmethod
    def room_accounts(db):
        """The other person's account id per one-on-one room (their ghost's localpart), for Contacts."""
        out = {}
        for room, raw in db.execute("SELECT m.room,m.json FROM room_meta m JOIN identity i ON i.address=m.room WHERE i.kind='person'"):
            try:
                meta = json.loads(raw)
            except ValueError:
                continue
            net, names = meta.get('network'), meta.get('names') or {}
            if not net or not isinstance(names, dict):
                continue
            pre = '@' + net + '_'
            ghosts = [(k, v) for k, v in names.items() if isinstance(k, str) and k.startswith(pre)]
            if len(ghosts) > 1:  # the owner's own puppet can sit in the room too: prefer the one named like the chat
                ghosts = [g for g in ghosts if plain_name(net, g[1]) == plain_name(net, meta.get('label') or '')] or ghosts[:1]
            out[room] = [{'network': net, 'value': k[len(pre):].split(':')[0], 'label': plain_name(net, v or '')} for k, v in ghosts[:1]]
        return out

    @staticmethod
    def room_pictures(db):
        out = {}
        for room, raw in db.execute("SELECT room,json FROM room_meta WHERE json LIKE '%\"avatar\": \"mxc%'"):
            try:
                pic = json.loads(raw).get('avatar')
            except ValueError:
                continue
            if isinstance(pic, str) and MXC.fullmatch(pic):
                out[room] = pic
        return out

    def picture(self, person_id, who=None):
        """mxc of a chat's picture, or of one group member (by the display name the view shows)."""
        person = self.person(person_id)
        with self.db() as db:
            for ident in person['identities']:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (ident['address'],)).fetchone()
                if not row:
                    continue
                meta = json.loads(row[0])
                if who is None:
                    pic = meta.get('avatar')
                else:
                    ids = [k for k, v in (meta.get('names') or {}).items() if v == who or plain_name(ident['network'], v) == who]
                    pic = next(((meta.get('avatars') or {}).get(k) for k in ids if (meta.get('avatars') or {}).get(k)), None)
                if isinstance(pic, str) and MXC.fullmatch(pic):
                    return pic
        return None

    def faces(self, person_id):
        """Display name -> picture tag for a chat's members (group bubbles show the sender's face)."""
        out = {}
        with self.db() as db:
            for ident in self.person(person_id)['identities']:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (ident['address'],)).fetchone()
                if not row:
                    continue
                meta = json.loads(row[0])
                for mxid, pic in (meta.get('avatars') or {}).items():
                    name = (meta.get('names') or {}).get(mxid)
                    if name and isinstance(pic, str) and MXC.fullmatch(pic):
                        out[plain_name(ident['network'], name)] = picture_tag(pic)
        return out

    def update(self, person_id, payload):
        self.person(person_id)
        with self.db() as db:
            for key in ('display_name', 'language', 'preferred_identity', 'muted', 'low_priority', 'medium_priority'):
                if key not in payload:
                    continue
                value = payload[key]
                if key == 'preferred_identity':
                    if value and not db.execute('SELECT 1 FROM identity WHERE id=? AND person_id=?', (value, person_id)).fetchone():
                        fail('invalid_identity', 'Choose an identity belonging to this person')
                    value = value or None
                elif key in ('muted', 'low_priority', 'medium_priority'):
                    if not isinstance(value, bool):
                        fail('invalid_input', key + ' is true or false')
                    value = int(value)
                    if key == 'low_priority' and value and payload.get('medium_priority') is True:
                        fail('invalid_input', 'A chat is either Medium or Low priority')
                    # One priority at a time: Medium clears Low and Low clears Medium.
                    if value and key in ('low_priority', 'medium_priority'):
                        other = 'medium_priority' if key == 'low_priority' else 'low_priority'
                        db.execute('UPDATE person SET ' + other + '=0 WHERE id=?', (person_id,))
                elif key == 'language':
                    if value not in ('', 'en', 'th', 'ja', 'zh', 'es', 'fr', 'de'):
                        fail('invalid_language', 'Choose a supported language')
                else:
                    value = text(value, 160)
                    # An owner rename is final; synced contact names stop applying.
                    db.execute('UPDATE person SET name_locked=1 WHERE id=?', (person_id,))
                db.execute('UPDATE person SET ' + key + '=? WHERE id=?', (value, person_id))
            db.execute('UPDATE identity SET seq=? WHERE person_id=?', (self.next_seq(), person_id))
        self.changed()
        return self.person(person_id)

    def merge_suggestions(self):
        """Pairs of one-on-one chats on different networks that look like the same person. Never applied
        automatically: the owner merges or dismisses each one."""
        try:
            dismissed = set(json.loads(self.get('merge_dismissed') or '[]'))
        except ValueError:
            dismissed = set()
        own = {name_key(n) for n in self.own_names()}
        people = [p for p in self.people('person', chats=False) if p['identities']]
        by_key = {}
        for p in people:
            key = name_key(p['display_name'])
            if len(key) < 3 or key in own or weak_label(p['display_name'], self.own_names()):
                continue
            by_key.setdefault(key, []).append(p)
        out = []
        for key, group in by_key.items():
            if len(group) < 2:
                continue
            nets = [set(i['network'] for i in p['identities']) for p in group]
            # Same network twice is usually two different people with one name: only suggest across networks.
            pick, seen = [], set()
            for p, n in sorted(zip(group, nets), key=lambda x: -len(x[1])):
                if not (n & seen):
                    pick.append(p); seen |= n
            ids = sorted(p['id'] for p in pick)
            if len(pick) < 2 or '|'.join(ids) in dismissed:
                continue
            out.append({'id': '|'.join(ids), 'name': pick[0]['display_name'],
                        'people': [{'id': p['id'], 'display_name': p['display_name'], 'avatar': p.get('avatar'),
                                    'networks': sorted(set(i['network'] for i in p['identities'])),
                                    'last': p.get('last')} for p in pick]})
        return {'suggestions': sorted(out, key=lambda s: s['name'].casefold())}

    def dismiss_merge(self, suggestion_id):
        ids = sorted(text(x, 24) for x in str(suggestion_id or '').split('|') if x)
        if len(ids) < 2:
            fail('invalid_input', 'Choose a suggestion')
        try:
            dismissed = json.loads(self.get('merge_dismissed') or '[]')
        except ValueError:
            dismissed = []
        dismissed = (dismissed + ['|'.join(ids)])[-2000:]
        self.put('merge_dismissed', json.dumps(dismissed))
        return {'dismissed': True}

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
                    msgtype='m.text', media=None, reply_to=None, client_id=None, album=None, source_event=None, push_live=False):
        """Insert once; a later sighting with richer media upgrades a label-only row in place."""
        media_json = json.dumps(media, ensure_ascii=False) if media else None
        with self.db() as db:
            if db.execute('SELECT 1 FROM redacted WHERE event_id=? UNION ALL SELECT 1 FROM scoped_redaction WHERE identity_id=? AND event_id=?',
                          (event_id, identity['id'], event_id)).fetchone():
                return False  # Late history/sync must not resurrect a redaction.
            seq = self.next_seq()
            cur = db.execute('INSERT OR IGNORE INTO message(id,identity_id,sender,outgoing,original,translated,timestamp,seq,msgtype,media,reply_to,client_id,album,source_event) '
                             'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                             (event_id, identity['id'], sender, int(outgoing), original, translated, timestamp, seq, msgtype, media_json, reply_to, client_id, album, source_event))
            inserted = cur.rowcount == 1
            # Muted, Medium and Low priority chats never notify (the person may have been merged since: join on the identity).
            quiet = db.execute('SELECT 1 FROM identity i JOIN person p ON p.id=i.person_id WHERE i.id=? AND (p.muted=1 OR p.low_priority=1 OR p.medium_priority=1)',
                               (identity['id'],)).fetchone()
            if inserted and not outgoing and push_live and self.push_enabled and not quiet:
                db.execute('INSERT OR IGNORE INTO push_intent(message,created) VALUES(?,?)',
                           (event_id if event_id.startswith('messenger:') else 'matrix:' + event_id, time.time()))
            if not inserted and msgtype != 'm.text':
                cur = db.execute("UPDATE message SET msgtype=?,media=?,original=?,reply_to=COALESCE(reply_to,?),seq=? WHERE id=? AND (msgtype='m.text' OR media IS NULL)",
                                 (msgtype, media_json, original, reply_to, seq, event_id))
                inserted = cur.rowcount == 1
            if album and not inserted:
                db.execute('UPDATE message SET album=COALESCE(album,?),source_event=COALESCE(source_event,?),client_id=COALESCE(client_id,?),seq=? WHERE id=? AND (album IS NULL OR (client_id IS NULL AND ? IS NOT NULL))',
                           (album, source_event, client_id, seq, event_id, client_id))
            if not outgoing:
                db.execute('UPDATE identity SET last_used=MAX(last_used,?) WHERE id=?', (timestamp, identity['id']))
            else:
                # Anything we wrote ourselves (here or on another device) means the chat is read up to it.
                db.execute('UPDATE identity SET last_read_ts=MAX(last_read_ts,?) WHERE id=?', (timestamp, identity['id']))
        if inserted:
            self.changed()
        return inserted

    def claim_own(self, ghost, network=None):
        """Lines the owner wrote in a network's own app arrive from their ghost and were stored
        as incoming; mark them outgoing (that network only), chats read up to them."""
        if network is None:
            match = re.match(r'@([a-z]+)_', ghost)
            network = match.group(1) if match else 'telegram'
        with self.db() as db:
            rooms = [(r[0], json.loads(r[1]).get('names', {}).get(ghost)) for r in db.execute('SELECT room,json FROM room_meta')]
            changed = 0
            for room, name in rooms:
                row = db.execute('SELECT id FROM identity WHERE network=? AND address=?', (network, room)).fetchone()
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
            row = db.execute('SELECT m.rowid AS timeline_order,m.*,i.network,i.address,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id WHERE m.id=?', (message_id,)).fetchone()
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

    def redact_scoped(self, identity_id, event_id):
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO scoped_redaction VALUES (?,?)', (identity_id, event_id))
            row = db.execute('SELECT identity_id FROM message WHERE id=? UNION ALL '
                             'SELECT m.identity_id FROM reaction r JOIN message m ON m.id=r.message_id WHERE r.event_id=?',
                             (event_id, event_id)).fetchone()
            if row and row[0] == identity_id:
                return self.redact(event_id)
        return False

    def redact(self, event_id):
        """A redaction removes a reaction or blanks a message ("This message was deleted")."""
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO redacted VALUES (?)', (event_id,))
            row = db.execute('SELECT message_id FROM reaction WHERE event_id=?', (event_id,)).fetchone()
            if row:
                db.execute('DELETE FROM reaction WHERE event_id=?', (event_id,))
                return self.bump(row[0])
        with self.db() as db:
            ids = [r[0] for r in db.execute('SELECT id FROM message WHERE id=? OR source_event=?', (event_id, event_id))]
        for target in ids:
            self.bump(target, ",deleted=1,original='',translated=NULL,media=NULL,transcript=NULL")
        return bool(ids)

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
                    quoted[r['id']] = {'id': r['id'], 'sender': OWN_SENDER if r['outgoing'] else r['sender'], 'outgoing': bool(r['outgoing']), 'text': '' if r['deleted'] else r['original'][:200],
                                       'msgtype': r['msgtype'], 'voice': bool(media.get('voice')), 'deleted': bool(r['deleted'])}
        for r in rows:
            r['outgoing'] = bool(r['outgoing'])
            if r['outgoing']:
                # Never surface the owner's own network name/ghost as a sender.
                r['sender'] = OWN_SENDER
            r['edited'], r['deleted'] = bool(r.get('edited')), bool(r.get('deleted'))
            media = json.loads(r['media']) if r.get('media') else None
            if media and media.get('links') and not media.get('mxc'):
                r['links'] = [{k: v for k, v in l.items() if k in ('url', 'title', 'desc', 'site', 'w', 'h')} | {'image': bool(l.get('mxc'))} for l in media['links']]
                r['media'] = None
            elif media:
                r['media'] = {k: v for k, v in media.items() if k in ('mime', 'size', 'w', 'h', 'duration', 'filename', 'waveform', 'voice')}
                r['media']['thumb'] = bool(media.get('thumb')) or (media.get('mime', '').startswith('image/'))
            r['reactions'] = list(reacts.get(r['id'], {}).values())
            if r.get('reply_to'):
                r['reply'] = quoted.get(r['reply_to'])
            r.pop('address', None)
        return rows

    def messages(self, person_id, before=None, limit=2000):
        self.person(person_id)
        where, args = '', [person_id]
        if isinstance(before, str):
            try:
                stamp, message_id = history_cursor.decode(before, person_id)
            except ValueError:
                fail('invalid_cursor', 'Invalid message cursor')
            where = ' AND (m.timestamp,m.id)<(?,?)'
            args.extend((stamp, message_id))
        elif before is not None:
            # Legacy explicit timestamp cutoffs remain supported, not used for paging.
            where = ' AND m.timestamp<?'
            args.append(before)
        with self.db() as db:
            rows = db.execute('SELECT * FROM (SELECT m.rowid AS timeline_order,m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id '
                              'WHERE i.person_id=?' + where + ' ORDER BY m.timestamp DESC,m.id DESC LIMIT ?) ORDER BY timestamp,timeline_order',
                              (*args, limit)).fetchall()
        return self.decorate(rows)

    def since(self, seq, limit=400):
        with self.db() as db:
            rows = db.execute('SELECT m.rowid AS timeline_order,m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id '
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
        return 'm.text', body, link_previews(content), reply_to
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
    # Every connected account becomes a code automatically; the owner only adds extras or hides one.
    QR_NETWORKS = ('telegram', 'whatsapp', 'signal', 'messenger', 'instagram', 'x', 'linkedin', 'line', 'wechat', 'facebook', 'email', 'phone', 'link')

    @staticmethod
    def qr_key(code):
        return '%s:%s' % (code.get('network'), re.sub(r'\s+', '', str(code.get('value') or '')).lower().lstrip('@+'))

    def own_profiles(self):
        """[(network, login dict)] for the bridges connected here; overridden where bridges exist."""
        try:
            return [('telegram', login) for login in self.telegram_status().get('logins') or []]
        except Exception:  # unreachable: the saved list still shows
            return []

    def connected_codes(self):
        """(codes, owner name) derived from connected accounts. Read-only, cached briefly."""
        cached = getattr(self, '_qr_cache', None)
        if cached and time.time() - cached[0] < 120:
            return cached[1], cached[2]
        codes, names = [], []
        def add(network, value, source):
            value = (value or '').strip() if isinstance(value, str) else ''
            if value and len(value) <= 300:
                codes.append({'network': network, 'value': value, 'label': '', 'auto': True, 'source': source})
        phone = lambda v: v if isinstance(v, str) and re.fullmatch(r'\+?\d[\d\s-]{5,20}', v.strip()) else ''
        user = lambda v, pat=r'[A-Za-z0-9_.]{2,64}': v.strip().lstrip('@') if isinstance(v, str) and re.fullmatch(pat, v.strip().lstrip('@')) else ''
        for network, login in self.own_profiles():
            if not isinstance(login, dict):
                continue
            state = (login.get('state') or {}).get('state_event', login.get('state_event')) if isinstance(login.get('state'), dict) else login.get('state_event')
            if state not in (None, 'CONNECTED'):
                continue
            prof = login.get('profile') if isinstance(login.get('profile'), dict) else {}
            if isinstance(prof.get('name'), str) and prof['name'].strip():
                names.append(prof['name'].strip())
            login_id = str(login.get('id') or '')
            if network == 'telegram':
                add('telegram', user(prof.get('username'), r'[A-Za-z][A-Za-z0-9_]{3,31}') or phone(prof.get('phone')), network)
            elif network == 'whatsapp':
                add('whatsapp', phone(prof.get('phone')) or ('+' + login_id if re.fullmatch(r'\d{6,15}', login_id) else ''), network)
            elif network == 'signal':
                add('signal', phone(prof.get('phone')), network)
            elif network == 'instagram':
                add('instagram', user(prof.get('username')), network)
            elif network == 'twitter':
                add('x', user(prof.get('username'), r'[A-Za-z0-9_]{1,15}'), network)
            elif network == 'facebook':
                add('facebook', user(prof.get('username')), network)
            elif network == 'linkedin':
                add('linkedin', user(prof.get('username'), r'[A-Za-z0-9-]{3,100}'), network)
            elif network == 'gmessages':
                add('phone', phone(prof.get('phone')), network)
        try:
            ident = (self.engine.identity() or {}).get('identity') or {}
            add('messenger', ident.get('npub') or '', 'messenger')
            if ident.get('display_name'):
                names.insert(0, ident['display_name'])
        except Exception:
            pass
        seen, unique = set(), []
        for c in codes:
            if self.qr_key(c) not in seen:
                seen.add(self.qr_key(c)); unique.append(c)
        name = names[0] if names else ''
        self._qr_cache = (time.time(), unique, name)
        return unique, name

    def qr_codes(self):
        auto, name = self.connected_codes()
        try:
            hidden = set(json.loads(self.store.get('my_qr_hidden') or '[]'))
        except ValueError:
            hidden = set()
        try:
            saved = json.loads(self.store.get('my_qr_codes') or '[]')
        except ValueError:
            saved = []
        keys = {self.qr_key(c) for c in auto}
        extras = [c for c in saved if isinstance(c, dict) and self.qr_key(c) not in keys]
        shown = [c for c in auto if self.qr_key(c) not in hidden]
        return {'codes': shown + extras, 'connected': auto, 'hidden': sorted(hidden & keys), 'extras': extras,
                'name': name, 'saved': bool(saved)}

    def save_qr_codes(self, payload):
        codes = payload.get('codes')
        if not isinstance(codes, list) or len(codes) > 24:
            fail('invalid_codes', 'Invalid QR code list')
        clean, connected = [], {self.qr_key(c) for c in self.connected_codes()[0]}
        for item in codes:
            if not isinstance(item, dict) or item.get('network') not in self.QR_NETWORKS:
                fail('invalid_codes', 'Unknown network')
            if item.get('auto') or self.qr_key(item) in connected:
                continue  # connected accounts are never stored; they follow the account
            value, label = item.get('value'), item.get('label') or ''
            if not isinstance(value, str) or not value.strip() or len(value) > 1024:
                fail('invalid_codes', 'Each code needs a username, number or link')
            if not isinstance(label, str) or len(label) > 80:
                fail('invalid_codes', 'Labels are up to 80 characters')
            clean.append({'network': item['network'], 'value': value.strip(), 'label': label.strip()})
        hidden = payload.get('hidden')
        if hidden is not None:
            if not isinstance(hidden, list) or len(hidden) > 50 or not all(isinstance(h, str) and len(h) < 400 for h in hidden):
                fail('invalid_codes', 'Invalid hidden list')
            self.store.put('my_qr_hidden', json.dumps(sorted(set(hidden))))
        self.store.put('my_qr_codes', json.dumps(clean))
        return self.qr_codes()

    def telegram_status(self):
        if not self.telegram_configured():
            return {'state': 'not_configured', 'message': 'Telegram not configured', 'logins': [], 'flows': []}
        try:
            result = self.provision('/whoami')
            return {'state': 'connected' if result.get('logins') else 'disconnected', 'message': 'Telegram', 'logins': result.get('logins', []), 'flows': [f for f in result.get('login_flows', []) if f['id'] in ('qr', 'phone')], 'pending_login': self.pending_login()}
        except EngineError as error:
            return {'state': 'unavailable', 'message': error.message, 'logins': [], 'flows': []}

    # ---------- Matrix ingest ----------
    META_TYPES = ('m.room.member', 'm.room.name', 'm.room.avatar', 'm.bridge', 'uk.half-shot.bridge', 'm.room.create')

    def room_meta(self, room, data):
        """Room kind/label/member names, cached; full state is fetched only for new rooms or state changes."""
        meta = self.rooms.get(room)
        if meta is None:
            with self.store.db() as db:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
            meta = json.loads(row[0]) if row else None
        events = (data.get('state', {}).get('events') or []) + [e for e in data.get('timeline', {}).get('events', []) if 'state_key' in e]
        if meta is not None and 'network' in meta and not any(e.get('type') in self.META_TYPES for e in events):
            self.rooms[room] = meta
            return meta
        state = self.mx(self.room(room) + '/state')
        info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
        from connectors import room_network
        network = room_network(state)
        meta = {'network': network, 'telegram': network == 'telegram'}
        if network:
            channel = info.get('channel', {})
            members = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join' and e.get('state_key') not in (self.owner, '@' + network + 'bot:messenger.internal') and not self.is_me(e.get('state_key'))]
            # bridgev2 emits room_type in bridge info; fallback counts real participants.
            room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.' + network + '.type') or info.get('com.beeper.room_type')
            meta['space'] = any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state)
            meta['kind'] = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
            meta['label'] = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname') or network.title() + ' conversation'
            meta['names'] = {e.get('state_key'): (e.get('content') or {}).get('displayname') for e in state if e['type'] == 'm.room.member' and (e.get('content') or {}).get('displayname')}
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta, ensure_ascii=False)))
        self.rooms[room] = meta
        return meta

    def ingest(self, identity, meta, event, *, live=False):
        etype, content = event.get('type'), event.get('content') or {}
        sender = event.get('sender', '')
        outgoing = self.is_me(sender)
        relates = content.get('m.relates_to') or {}
        if etype == 'm.room.redaction':
            target = event.get('redacts') or content.get('redacts')
            if target:
                self.store.redact_scoped(identity['id'], target)
            return
        if etype == 'm.reaction' and relates.get('rel_type') == 'm.annotation' and isinstance(relates.get('key'), str):
            with self.store.db() as db:
                target = db.execute('SELECT 1 FROM message WHERE id=? AND identity_id=?', (relates.get('event_id', ''), identity['id'])).fetchone()
                redacted = db.execute('SELECT 1 FROM scoped_redaction WHERE identity_id=? AND event_id=?', (identity['id'], event['event_id'])).fetchone()
                if target and not redacted:
                    self.store.react(event['event_id'], relates.get('event_id', ''), sender, relates['key'][:32], outgoing)
            return
        if etype == 'm.room.message' and relates.get('rel_type') == 'm.replace':
            new = content.get('m.new_content') or {}
            if isinstance(new.get('body'), str) and new.get('msgtype') in ('m.text', 'm.notice', 'm.emote'):
                with self.store.db() as db:
                    ok = db.execute('SELECT 1 FROM message WHERE id=? AND identity_id=? AND deleted=0 AND (sender=? OR (outgoing=1 AND ?))', (relates.get('event_id'), identity['id'], meta.get('names', {}).get(sender) or sender, outgoing)).fetchone()
                if ok:
                    self.store.bump(relates.get('event_id'), ',original=?,translated=NULL,translation_error=NULL,edited=1', (new['body'],))
            return
        if sender == '@' + identity['network'] + 'bot:messenger.internal':
            # Bridge error notices are not chat lines: mark our newest recent outgoing message as failed.
            if content.get('msgtype') == 'm.notice':
                stamp = event.get('origin_server_ts', 0)
                with self.store.db() as db:
                    row = db.execute('SELECT id FROM message WHERE identity_id=? AND outgoing=1 AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 1',
                                     (identity['id'], stamp - 120000, stamp + 5000)).fetchone()
                if row:
                    self.store.bump(row[0], ',failed=?', (identity['network'].title() + ' did not accept this message',))
            return
        parts = message_parts(event)
        if parts is None:
            return
        msgtype, body, media, reply_to = parts
        if content.get('org.wizard.gallery') is not None and msgtype == 'm.image':
            try:
                self.store_gallery(event['event_id'], identity, meta.get('names', {}).get(sender) or sender, outgoing, content, event.get('origin_server_ts', 0), reply_to=reply_to)
                return
            except (EngineError, TypeError, AttributeError):
                pass  # A malformed optional extension must not stall the room's sync.

        grouped = content.get('fi.mau.telegram.grouped_id')
        album = 'telegram:' + str(grouped) if isinstance(grouped, (str, int)) and str(grouped) else None
        self.store.add_message(event['event_id'], identity, meta.get('names', {}).get(sender) or sender, outgoing, body,
                               event.get('origin_server_ts', 0), msgtype=msgtype, media=media, reply_to=reply_to, album=album, push_live=live)
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
                            elif user != '@' + identity['network'] + 'bot:messenger.internal':
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

    def trusted_inviter(self, sender):
        return sender.endswith(':messenger.internal') and sender.startswith(('@telegram_', '@telegrambot:'))

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
                if any(e.get('type') == 'm.room.member' and e.get('state_key') == self.owner and self.trusted_inviter(e.get('sender', '')) for e in events):
                    self.mx('/join/' + quote(room, safe=''), 'POST', {})
            for room in result.get('rooms', {}).get('leave', {}):
                # A bridged chat that was removed (e.g. on disconnect) leaves no stale card behind.
                if any([self.store.forget(network, room) for network in MATRIX_NETWORKS]):
                    self.store.next_seq()
                    self.notify()
            for room, data in result.get('rooms', {}).get('join', {}).items():
                if data.get('timeline', {}).get('limited'):
                    self.store.put('history_gap:' + room, 'Earlier history may be incomplete')
                meta = self.room_meta(room, data)
                if not (meta.get('network') or meta.get('telegram')) or meta.get('space'):
                    continue
                identity = self.store.identity(meta.get('network') or 'telegram', room, meta['label'], meta['kind'])
                for event in data.get('timeline', {}).get('events', []):
                    self.ingest(identity, meta, event, live=bool(since))
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
        if room in self.backfilled or identity['network'] not in MATRIX_NETWORKS:
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
            # The group name is chosen by whoever created the DM (often the recipient's
            # name, i.e. the owner's): it is only a fallback, and never the owner's own name.
            own_names = self.store.own_names() | {own.get('display_name')} - {None, ''}
            label = next((n for n in (peer.get('display_name'), dm.get('name')) if not weak_label(n, own_names)), 'Messenger contact')
            identity = self.store.identity('messenger', dm['group_id'], label)
            self.import_marmot(identity, 50, live=True)

    def import_marmot(self, identity, limit=200, *, live=False):
        watermark_key = 'push_marmot_watermark:' + identity['id']
        prior = self.store.get(watermark_key)
        watermark = int(prior) if prior else 0
        newest = watermark
        for m in self.engine.messages(identity['address'], limit).get('messages', []):
            stamp = m.get('created_at', 0)
            if isinstance(stamp, str):
                from datetime import datetime
                stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000
            elif stamp < 1000000000000:
                stamp *= 1000
            newest = max(newest, int(stamp))
            if m.get('attachments'):
                self.store_marmot(m['message_id'], identity, m.get('author', ''), m.get('direction') == 'sent', m.get('text', ''), int(stamp), m['attachments'],
                                  push_live=live and bool(prior) and int(stamp) >= watermark and m.get('direction') == 'received')
                continue
            self.store.add_message('messenger:' + m['message_id'], identity, m.get('author', ''), m.get('direction') == 'sent', m.get('text', ''), int(stamp),
                                   push_live=live and bool(prior) and int(stamp) >= watermark and m.get('direction') == 'received')
        if live:
            self.store.put(watermark_key, str(newest))

    # ---------- reading ----------
    def timeline(self, person_id, before=None, limit=2000):
        person = self.store.person(person_id)
        try:
            person['faces'] = self.store.faces(person_id)
            person['avatar'] = picture_tag(self.store.picture(person_id))
        except Exception:
            person['faces'] = {}
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
        return {'person': person, 'messages': messages, 'has_more': has_more,
                'next_cursor': history_cursor.encode(person_id, messages[0]['timestamp'], messages[0]['id']) if has_more else None,
                'translating': pending, 'seq': self.store.seq,
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
            if identity['network'] in MATRIX_NETWORKS:
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
            rows = db.execute('SELECT m.rowid AS timeline_order,m.*,i.network,i.label,i.kind,i.person_id FROM message m JOIN identity i ON m.identity_id=i.id WHERE m.id=?', (message_id,)).fetchall()
        rows = self.store.decorate(rows)
        return rows[0] if rows else None

    def reply_target(self, identity, reply_to):
        if not reply_to:
            return None
        message = self.store.message(text(reply_to, 300))
        if message['identity_id'] != identity['id']:
            fail('invalid_reply', 'Reply to a message in this chat')
        return message.get('source_event') or message['id']

    def channel(self, person_id, identity_id=None):
        person = self.store.person(person_id)
        identity_id = identity_id or person['preferred_identity'] or person['identities'][0]['id']
        identity = next((i for i in person['identities'] if i['id'] == identity_id), None)
        if not identity:
            fail('invalid_identity', 'Choose this person’s channel')
        return person, identity

    def send(self, person_id, payload):
        # Serialize duplicate taps, including the local rows after the Matrix receipt.
        with self.lock:
            return self._send(person_id, payload)

    def _send(self, person_id, payload):
        """One-call send for chats that need no translation review; the client id is the Matrix
        transaction id, so a retried tap can never produce a second message."""
        if payload.get('preview_id'):
            return self.confirm(person_id, payload)
        client_id = payload.get('client_id')
        if not isinstance(client_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', client_id):
            fail('invalid_client_id', 'Missing message id')
        with self.store.db() as db:
            done = db.execute('SELECT m.id FROM message m JOIN identity i ON i.id=m.identity_id WHERE m.client_id=? AND i.person_id=?', (client_id, person_id)).fetchone()
        if done:
            rows = self.album_rows(done[0])
            with self.store.db() as db:
                caption = db.execute('SELECT id FROM message WHERE client_id=? AND identity_id=(SELECT identity_id FROM message WHERE id=?)', (client_id + '.caption', done[0])).fetchone()
            if caption:
                rows.append(self.row(caption[0]))
            return {'state': 'sent', 'event_id': done[0], 'message': self.row(done[0]), 'messages': rows}
        person, identity = self.channel(person_id, payload.get('identity_id'))
        upload_ids = payload.get('upload_ids')
        gallery = None
        if upload_ids is not None:
            if (not isinstance(upload_ids, list) or not 2 <= len(upload_ids) <= 10
                    or not all(isinstance(x, str) for x in upload_ids) or len(set(upload_ids)) != len(upload_ids)
                    or payload.get('upload_id')):
                fail('invalid_album', 'Choose between 2 and 10 different photos')
            gallery = [self.uploads.get(x) for x in upload_ids]
            if any(not u or u['person_id'] != person_id or u['expires'] <= time.time() for u in gallery):
                fail('upload_expired', 'Attach the photos again', 409)
            if any(u['kind'] != 'image' or u['mime'] not in ('image/jpeg', 'image/png', 'image/webp') for u in gallery):
                fail('invalid_album', 'Albums contain still photos only')
        upload = gallery[0] if gallery else self.uploads.get(payload.get('upload_id')) if payload.get('upload_id') else None
        if payload.get('upload_id') and (not upload or upload['person_id'] != person_id or upload['expires'] <= time.time()):
            fail('upload_expired', 'Attach the file again', 409)
        body = payload.get('text') or ''
        if body:
            body = text(body)
        elif not upload:
            fail('invalid_input', 'Please enter valid text')
        if body and not upload and person['language'] and person['language'] != 'en':
            fail('review_required', 'This chat translates before sending', 409)
        reply_to = self.reply_target(identity, payload.get('reply_to'))
        if identity['network'] not in MATRIX_NETWORKS:
            if upload:
                if any(u['kind'] == 'voice' for u in (gallery or [upload])):
                    fail('media_unsupported', 'Voice notes are not available in Wizard chats yet', 409)
                meta = payload.get('media') if isinstance(payload.get('media'), list) else [payload.get('media')]
                event, state = self.send_marmot_media(identity, gallery or [upload], body, client_id, meta)
                for key in (upload_ids or [payload.get('upload_id')]):
                    self.drop_upload(key)
                return {'state': state, 'event_id': event, 'message': self.row(event), 'messages': self.album_rows(event)}
            result = self.engine.send(identity['address'], {'text': body, 'request_id': client_id[:64]})
            event = 'messenger:' + result['message_ids'][0]
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), client_id=client_id)
            return {'state': 'sent' if result['published'] else 'queued', 'event_id': event, 'message': self.row(event)}
        msgtype, media = 'm.text', None
        if any(not u.get('mxc') for u in (gallery or ([upload] if upload else []))):
            fail('upload_expired', 'Attach the file again', 409)
        if upload:
            msgtype, content, media = self.media_content(upload, body, {} if gallery else payload)
        else:
            content = {'msgtype': 'm.text', 'body': body}
        if gallery:
            metadata = payload.get('media') if isinstance(payload.get('media'), list) else []
            items = [self.media_content(u, body if i == 0 else '', {'media': metadata[i] if i < len(metadata) else {}})[1]
                     for i, u in enumerate(gallery)]
            content = dict(items[0], **{'org.wizard.gallery': items})
        if reply_to:
            content['m.relates_to'] = {'m.in_reply_to': {'event_id': reply_to}}
        started = time.time()
        result = self.mx(self.room(identity['address']) + '/send/m.room.message/' + client_id, 'PUT', content)
        self.timing('send', started)
        event = result['event_id']
        if msgtype == 'm.file':
            # Bridges use m.file body as the filename; text follows separately (James, 26 Oct 2026).
            # Keep the handle until BOTH receipts; deterministic transactions make partial retries safe.
            caption_id = client_id + '.caption'
            caption = self.mx(self.room(identity['address']) + '/send/m.room.message/' + caption_id, 'PUT',
                              {'msgtype': 'm.text', 'body': body}) if body else None
            stamp = int(time.time() * 1000)
            with self.store.db() as db:
                if not db.in_transaction:
                    db.execute('BEGIN')
                self.store.add_message(event, identity, self.owner, True, '', stamp,
                                       msgtype=msgtype, media=media, reply_to=reply_to, client_id=client_id)
                if caption:
                    self.store.add_message(caption['event_id'], identity, self.owner, True, body, stamp + 1, client_id=caption_id)
                # Sync may have inserted either event before the send receipts.
                for key, txn in [(event, client_id)] + ([(caption['event_id'], caption_id)] if caption else []):
                    db.execute('UPDATE message SET client_id=COALESCE(client_id,?) WHERE id=?', (txn, key))
            self.drop_upload(payload.get('upload_id'))
            rows = [self.row(event)] + ([self.row(caption['event_id'])] if caption else [])
            return {'state': 'sent', 'event_id': event, 'message': rows[0], 'messages': rows}
        if gallery:
            self.store_gallery(event, identity, self.owner, True, content, int(time.time() * 1000), reply_to=reply_to, client_id=client_id)
            for key in upload_ids:
                self.drop_upload(key)
            return {'state': 'sent', 'event_id': event, 'message': self.row(event), 'messages': self.album_rows(event)}
        self.store.add_message(event, identity, self.owner, True, body if upload is None else (body or ''), int(time.time() * 1000),
                               msgtype=msgtype, media=media, reply_to=reply_to, client_id=client_id)
        if upload:
            self.drop_upload(payload.get('upload_id'))
        return {'state': 'sent', 'event_id': event, 'message': self.row(event)}

    def album_rows(self, message_id):
        message = self.store.message(message_id)
        if not message.get('album'):
            return [self.row(message_id)]
        with self.store.db() as db:
            ids = [r[0] for r in db.execute('SELECT id FROM message WHERE album=? AND identity_id=? AND sender=? ORDER BY timestamp,rowid',
                                          (message['album'], message['identity_id'], message['sender']))]
        return [self.row(key) for key in ids]

    def store_gallery(self, event_id, identity, sender, outgoing, content, stamp, reply_to=None, client_id=None):
        # All N items (including item zero) are in the extension. Stable per-photo rows
        # reuse media proxy/viewer/forwarding; source_event is the one transport event.
        items = content.get('org.wizard.gallery')
        if not isinstance(items, list) or not 2 <= len(items) <= 10:
            fail('invalid_album', 'Invalid photo album')
        with self.store.db() as db:
            # Explicit BEGIN makes the store's nested db() calls join one transaction.
            if not db.in_transaction:
                db.execute('BEGIN')
            for i, item in enumerate(items):
                if not isinstance(item, dict) or not isinstance(item.get('url'), str):
                    fail('invalid_album', 'Invalid photo album')
                parts = message_parts({'type': 'm.room.message', 'content': dict(item, msgtype='m.image')})
                if not parts:
                    fail('invalid_album', 'Invalid photo album')
                _, caption, media, _ = parts
                self.store.add_message(event_id if i == 0 else event_id + '#photo:%02d' % i, identity, sender, outgoing,
                                       caption if i == 0 else '', stamp, msgtype='m.image', media=media,
                                       reply_to=reply_to if i == 0 else None, client_id=client_id if i == 0 else None,
                                       album='matrix:' + event_id, source_event=event_id)

    def media_content(self, upload, caption, payload):
        info = {'mimetype': upload['mime'], 'size': upload['size']}
        if upload['kind'] == 'file':
            media = {k: upload[k] for k in ('mxc', 'mime', 'size', 'filename')}
            content = {'msgtype': 'm.file', 'body': upload['filename'], 'filename': upload['filename'], 'url': upload['mxc'], 'info': info}
            return 'm.file', content, media
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

    def upload(self, person_id, kind, data, name=''):
        """Owner upload → Synapse media repo. Returns an opaque, person-bound id."""
        if kind not in ('image', 'voice', 'file'):
            fail('invalid_upload', 'Choose a photo, voice note or file')
        person, identity = self.channel(person_id)
        # A merged chat can reply on either side, so keep what each side needs: a Synapse copy for the
        # bridges, a private local copy for Wizard chats (encrypted and sent to Blossom only at send time).
        bridged = any(i['network'] in MATRIX_NETWORKS for i in person['identities'])
        marmot = any(i['network'] == 'messenger' for i in person['identities'])
        if not bridged and not marmot:
            fail('media_unsupported', 'Photos, voice notes and files are not available on Messenger yet', 409)
        if kind == 'voice' and not bridged:
            fail('media_unsupported', 'Voice notes are not available in Wizard chats yet', 409)
        if not 0 < len(data) <= UPLOAD_MAX:
            fail('too_large', 'Files up to 25 MB can be sent', 413)
        mime = sniff(data)
        if kind == 'file':
            # Original names stay in the message, not the upload URL (James, 26 Oct 2026).
            mime, filename = mime or 'application/octet-stream', file_name(name)
        else:
            if kind == 'voice' and mime == 'video/mp4':
                mime = 'audio/mp4'  # Safari records voice into an mp4 container
            ok = {'image': ('image/jpeg', 'image/png', 'image/gif', 'image/webp'), 'voice': ('audio/ogg', 'audio/webm', 'audio/mp4')}[kind]
            if mime not in ok:
                fail('invalid_upload', 'That file type is not supported here', 415)
            ext = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a'}[mime]
            filename = ('voice-message.' if kind == 'voice' else 'photo.') + ext
        mxc = path = None
        if bridged:
            started = time.time()
            mxc = self.matrix_upload(data, 'attachment' if kind == 'file' else filename, mime)['content_uri']
            self.timing('upload', started)
        upload_id = secrets.token_hex(16)
        now = time.time()
        self.prune_uploads(now)
        if marmot:
            # wnd names the attachment after the file, so the file keeps its display name inside a per-upload folder.
            folder = self.outbox() / upload_id
            folder.mkdir(mode=0o700)
            path = folder / filename
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
            path = str(path)
        self.uploads[upload_id] = {'mxc': mxc, 'path': path, 'mime': mime, 'size': len(data), 'kind': kind, 'filename': filename, 'person_id': person_id, 'expires': now + 3600}
        result = {'upload_id': upload_id, 'mime': mime, 'size': len(data)}
        if kind == 'file':
            result['name'] = filename
        return result

    def outbox(self):
        folder = self.root / 'marmot-outbox'
        folder.mkdir(mode=0o700, exist_ok=True)
        return folder

    def prune_uploads(self, now=None):
        now = now or time.time()
        self.uploads = {k: v for k, v in self.uploads.items() if v['expires'] > now}
        folder = self.root / 'marmot-outbox'
        if folder.exists():
            for entry in folder.iterdir():
                if entry.name not in self.uploads:
                    shutil.rmtree(entry, ignore_errors=True)

    def drop_upload(self, upload_id):
        upload = self.uploads.pop(upload_id, None)
        if upload and upload.get('path'):
            shutil.rmtree(Path(upload['path']).parent, ignore_errors=True)

    def send_marmot_media(self, identity, uploads, body, client_id, meta):
        """Wizard-to-Wizard photos and files: one encrypted kind-9 message (MIP-04 imeta per file)."""
        if any(not u.get('path') for u in uploads):
            fail('upload_expired', 'Attach the file again', 409)
        request_id = ('media-' + client_id).ljust(16, '0')[:64]
        result = self.engine.send_media(identity['address'], {'paths': [u['path'] for u in uploads], 'text': body or None, 'request_id': request_id})
        mid = result['message_ids'][0]
        attachments = result.get('attachments') or []
        items = []
        for i, u in enumerate(uploads):
            sent = attachments[i] if i < len(attachments) else {}
            item = {'sha256': sent.get('sha256'), 'mime': u['mime'], 'filename': u['filename'], 'size': u['size'], 'image': u['kind'] == 'image'}
            m = meta[i] if i < len(meta) and isinstance(meta[i], dict) else {}
            for key in ('w', 'h'):
                if isinstance(m.get(key), int) and 0 < m[key] < 10 ** 8:
                    item[key] = m[key]
            items.append(item)
        stamp = int(time.time() * 1000)
        self.store_marmot(mid, identity, self.owner, True, body, stamp, items, client_id=client_id)
        return 'messenger:' + mid, ('sent' if result.get('published') else 'queued')

    def store_marmot(self, mid, identity, sender, outgoing, body, stamp, items, client_id=None, push_live=False):
        """One row per attachment, the same ids whether the send receipt or the mirror sees it first."""
        event = 'messenger:' + mid
        album = 'marmot:' + mid if len(items) > 1 else None
        with self.store.db() as db:
            if not db.in_transaction:
                db.execute('BEGIN')
            for i, item in enumerate(items):
                mime = item.get('mime') or 'application/octet-stream'
                photo = mime in ('image/jpeg', 'image/png', 'image/gif', 'image/webp') and item.get('image', True)
                media = {'marmot': {'group': identity['address'], 'sha256': item.get('sha256')}, 'mime': mime,
                         'filename': item.get('filename') or ('photo' if photo else 'file')}
                for key in ('size', 'w', 'h'):
                    if item.get(key):
                        media[key] = item[key]
                self.store.add_message(event if i == 0 else event + '#photo:%02d' % i, identity, sender, outgoing, body if i == 0 else '', stamp,
                                       msgtype='m.image' if photo else 'm.file', media=media, client_id=client_id if i == 0 else None,
                                       album=album, source_event=event if album else None, push_live=push_live and i == 0)
        return event

    def marmot_media(self, message, media, kind):
        ref = media['marmot']
        group, digest = ref.get('group'), ref.get('sha256') or ''
        if group != message['address'] or not re.fullmatch(r'[0-9a-f]{64}', digest):
            fail('not_found', 'No media on that message', 404)
        if kind == 'thumb' and not (media.get('mime') or '').startswith('image/'):
            fail('not_found', 'No preview for that message', 404)
        cache = self.root / 'media-cache'
        cache.mkdir(mode=0o700, exist_ok=True)
        key = hashlib.sha256(('marmot|%s|%s' % (group, digest)).encode()).hexdigest()
        path, meta_path = cache / key, cache / (key + '.type')
        if not path.exists():
            started = time.time()
            tmp = cache / (key + '.part-' + secrets.token_hex(4))
            try:
                self.engine.media_download(group, digest, str(tmp))
                with tmp.open('rb') as f:
                    if hashlib.sha256(f.read()).hexdigest() != digest:
                        fail('upstream_unavailable', 'Could not load that media. Try again.', 503)
                    f.seek(0)
                    sniffed = sniff(f.read(64))
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
            # Never trust the sender's declared type for inline display: only sniffed bytes decide.
            meta_path.write_text(sniffed or 'application/octet-stream')
            os.replace(tmp, path)
            self.timing('media', started)
            self.evict(cache)
        else:
            os.utime(path)
        served = meta_path.read_text().strip() if meta_path.exists() else 'application/octet-stream'
        return Blob(path, served if served in INLINE_MIME else 'application/octet-stream', media.get('filename') or 'media', served in INLINE_MIME)

    def matrix_upload(self, data, filename, mime):
        req = Request(self.matrix.rstrip('/') + '/_matrix/media/v3/upload?' + urlencode({'filename': filename}), data=data, method='POST',
                      headers={'Authorization': 'Bearer ' + self.matrix_token(), 'Content-Type': mime})
        try:
            with urlopen(req, timeout=60) as response:
                return json.load(response)
        except (HTTPError, URLError, OSError, ValueError, KeyError):
            fail('upstream_unavailable', 'Upload failed. Please try again.', 503)

    def picture_blob(self, person_id, who=None):
        mxc = self.store.picture(person_id, who)
        if not mxc:
            fail('not_found', 'No picture', 404)
        return self.media_blob(mxc, 'image/jpeg', 'avatar', size=160)

    def media(self, message_id, kind):
        """Proxy a message's media from the private homeserver; mxc URIs and tokens never leave the box."""
        message = self.store.message(message_id)
        media = json.loads(message['media']) if message.get('media') else None
        if media and kind and kind.startswith('link') and media.get('links'):
            try:
                pick = media['links'][int(kind[4:] or 0)]
            except (ValueError, IndexError):
                fail('not_found', 'No link preview', 404)
            if not pick.get('mxc'):
                fail('not_found', 'No link preview', 404)
            return self.media_blob(pick['mxc'], 'image/jpeg', 'preview', thumb=True)
        if media and media.get('marmot') and message['network'] == 'messenger':
            return self.marmot_media(message, media, kind)
        if not media or not media.get('mxc'):
            fail('not_found', 'No media on that message', 404)
        thumb = kind == 'thumb'
        mime = media.get('mime') or 'application/octet-stream'
        if thumb and not (media.get('thumb') or mime.startswith('image/')):
            fail('not_found', 'No preview for that message', 404)
        mxc = (media.get('thumb') if thumb and media.get('thumb') else media['mxc'])
        if not re.fullmatch(r'mxc://([A-Za-z0-9.:_-]+)/([A-Za-z0-9_-]+)', mxc or ''):
            fail('not_found', 'No media on that message', 404)
        return self.media_blob(mxc, mime, media.get('filename') or 'media', thumb=thumb and not media.get('thumb'), raw_thumb=thumb)

    def media_blob(self, mxc, mime, name, *, thumb=False, raw_thumb=False, size=800):
        match = re.fullmatch(r'mxc://([A-Za-z0-9.:_-]+)/([A-Za-z0-9_-]+)', mxc or '')
        if not match:
            fail('not_found', 'No media', 404)
        thumb = thumb or size != 800
        cache = self.root / 'media-cache'
        cache.mkdir(mode=0o700, exist_ok=True)
        key = hashlib.sha256((mxc + '|' + (('thumb%d' % size if size != 800 else 'thumb') if (thumb or raw_thumb) else 'full')).encode()).hexdigest()
        path = cache / key
        meta_path = cache / (key + '.type')
        if not path.exists():
            server, media_id = match.groups()
            if thumb:
                url = '/_matrix/client/v1/media/thumbnail/%s/%s?%s' % (server, media_id, urlencode({'width': size, 'height': size, 'method': 'scale' if size == 800 else 'crop', 'animated': 'true'}))
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
        message_id = message.get('source_event') or message_id
        message = self.store.message(message_id)
        key = payload.get('key')
        if not isinstance(key, str) or not key or len(key) > 32:
            fail('invalid_input', 'Choose a reaction')
        if message['network'] not in MATRIX_NETWORKS:
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
        if not message['outgoing'] or message['deleted'] or message['network'] not in MATRIX_NETWORKS or message['msgtype'] != 'm.text':
            fail('not_editable', 'Only your own text messages can be edited', 409)
        self.mx(self.room(message['address']) + '/send/m.room.message/' + secrets.token_hex(12), 'PUT',
                {'msgtype': 'm.text', 'body': '* ' + new, 'm.new_content': {'msgtype': 'm.text', 'body': new},
                 'm.relates_to': {'rel_type': 'm.replace', 'event_id': message_id}})
        self.store.bump(message_id, ',original=?,translated=NULL,edited=1', (new,))
        return {'message': self.row(message_id)}

    def delete(self, message_id, payload):
        message = self.store.message(message_id)
        everyone = payload.get('everyone') is True
        rows = self.album_rows(message_id)
        if everyone and (not message['outgoing'] or message['network'] not in MATRIX_NETWORKS):
            fail('not_deletable', 'Only your own messages can be deleted for everyone', 409)
        targets = list(dict.fromkeys(self.store.message(r['id']).get('source_event') or r['id'] for r in rows))
        for target in targets:
            if everyone:
                self.mx(self.room(message['address']) + '/redact/' + quote(target, safe='') + '/' + secrets.token_hex(8), 'PUT', {})
            self.store.redact(target)
        return {'message': self.row(message_id), 'messages': [self.row(r['id']) for r in rows]}

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
            if identity['network'] in MATRIX_NETWORKS:
                event_id = self.store.message(row[0]).get('source_event') or row[0]

                def receipt(address=identity['address'], event_id=event_id):
                    try:
                        self.mx(self.room(address) + '/receipt/m.read/' + quote(event_id, safe=''), 'POST', {})
                    except EngineError:
                        pass
                threading.Thread(target=receipt, daemon=True).start()
        return {'ok': True}

    def set_typing(self, person_id, payload):
        _, identity = self.channel(person_id)
        if identity['network'] in MATRIX_NETWORKS:
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
        if suffix == ['search'] and method == 'GET':
            if set(query) - {'q', 'network', 'thread', 'limit', 'cursor'} or any(len(v) != 1 for v in query.values()):
                fail('invalid_search', 'Invalid search scope')
            try:
                return self.store.search(q('q', ''), network=q('network'), thread=q('thread'),
                                         limit=int(q('limit', '50')), cursor=q('cursor'))
            except ValueError:
                fail('invalid_search', 'Invalid search query or cursor')
        if suffix == ['merge-suggestions'] and method == 'GET':
            return self.store.merge_suggestions()
        if suffix == ['merge-suggestions', 'dismiss'] and method == 'POST':
            return self.store.dismiss_merge(payload.get('id'))
        if suffix == ['directory'] and method == 'GET':
            return {'people': self.store.people('person', chats=False), 'groups': self.store.people('group', chats=False)}
        if len(suffix) == 2 and suffix[0] == 'media' and method == 'GET':
            return self.media(text(suffix[1], 300), q('kind') if q('kind') in ('thumb', 'link0', 'link1') else 'full')
        if len(suffix) >= 2 and suffix[0] == 'people':
            person_id = suffix[1]
            if len(suffix) == 2:
                if method == 'GET':
                    try:
                        before = q('cursor') or (int(q('before')) if q('before') else None)
                        limit = max(1, min(int(q('limit', '2000')), 2000))
                    except ValueError:
                        fail('invalid_cursor', 'Invalid message query')
                    return self.timeline(person_id, before, limit)
                if method == 'POST':
                    return self.store.update(person_id, payload)
            if len(suffix) == 3 and method == 'GET' and suffix[2] == 'avatar':
                return self.picture_blob(person_id, q('who') or None)
            if len(suffix) == 3 and method == 'PUT' and suffix[2] == 'upload':
                return self.upload(person_id, q('kind', 'image'), raw or b'', q('name', ''))
            if len(suffix) == 3 and method == 'POST':
                action = suffix[2]
                if action == 'merge': return self.store.merge(person_id, text(payload.get('source_id'), 24))
                if action == 'unmerge': return self.store.unmerge(person_id, payload.get('identity_id'))
                if action == 'preview': return self.preview(person_id, payload)
                if action == 'send': return self.send(person_id, payload)
                if action == 'read': return self.read(person_id, payload)
                if action == 'unread': return self.store.mark_unread(person_id)
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
