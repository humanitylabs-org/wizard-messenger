"""Standalone owner-scoped background push foundation. No routes mounted by default."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from typing import Protocol
from .security import EndpointPolicy, InvalidSubscription, PyWebPushTransport


class Transport(Protocol):
    def send(self, subscription: dict, payload: str, ttl: int) -> int: ...


class Store:
    def __init__(self, directory, policy, clock=time.time):
        self.policy, self.clock = policy, clock
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or self.directory.stat().st_uid != os.getuid():
            raise ValueError('Unsafe push storage directory')
        os.chmod(self.directory, 0o700)
        self.path = self.directory / 'push.sqlite3'
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        self.lock = threading.RLock()
        with self.db() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS subscription (
              id TEXT PRIMARY KEY, owner TEXT NOT NULL, endpoint TEXT UNIQUE NOT NULL,
              json TEXT NOT NULL, created REAL NOT NULL DEFAULT 0, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS outbox (
              owner TEXT NOT NULL, message TEXT NOT NULL, subscription TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
              due REAL NOT NULL, expires REAL NOT NULL, lease TEXT, lease_until REAL,
              error TEXT, PRIMARY KEY(owner,message,subscription));
            ''')

            if 'created' not in {r[1] for r in db.execute('PRAGMA table_info(subscription)')}:
                db.execute('ALTER TABLE subscription ADD COLUMN created REAL NOT NULL DEFAULT 0')

    @contextmanager
    def db(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                db.execute('BEGIN IMMEDIATE')
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()

    def subscribe(self, owner, value, lifetime=30*86400):
        subscription = self.policy.subscription(value)
        now = self.clock()
        expires = now + min(max(lifetime, 1), 30*86400)
        browser_expiry = value.get('expirationTime')
        if browser_expiry is not None:
            if isinstance(browser_expiry, bool) or not isinstance(browser_expiry, (int, float)) or not now < browser_expiry / 1000 <= now + 366*86400:
                raise InvalidSubscription('Invalid subscription expiry')
            expires = min(expires, browser_expiry / 1000)
        identifier = hashlib.sha256(subscription['endpoint'].encode()).hexdigest()
        with self.db() as db:
            old = db.execute('SELECT * FROM subscription WHERE id=?', (identifier,)).fetchone()
            if old and old['owner'] != owner:
                raise PermissionError('Subscription belongs to another owner')
            db.execute('''INSERT INTO subscription(id,owner,endpoint,json,expires,created) VALUES(?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET json=excluded.json,expires=excluded.expires,
                created=CASE WHEN subscription.revoked=1 OR subscription.expires<=? THEN excluded.created ELSE subscription.created END,revoked=0''',
                       (identifier, owner, subscription['endpoint'], json.dumps(subscription), expires, now, now))
        return {'id': identifier, 'expires': expires}

    def revoke(self, owner, identifier):
        with self.db() as db:
            db.execute('UPDATE subscription SET revoked=1 WHERE owner=? AND id=?', (owner, identifier))
            db.execute("UPDATE outbox SET state='cancelled',lease=NULL WHERE owner=? AND subscription=? AND state IN ('pending','sending')", (owner, identifier))
        return {'ok': True}

    def received(self, owner, message_id, *, outgoing, live, ttl=86400, created=None):
        # Caller uses authoritative stored outgoing flag, not untrusted HTTP input.
        if outgoing is not False or live is not True:
            return 0
        if not isinstance(message_id, str) or not 0 < len(message_id) <= 1024:
            raise ValueError('Stable incoming message identifier required')
        now = self.clock()
        created = now if created is None else created
        expires = created + min(max(ttl, 1), 86400)
        if expires <= now:
            return 0
        with self.db() as db:
            before = db.total_changes
            db.execute('''INSERT OR IGNORE INTO outbox(owner,message,subscription,due,expires)
                SELECT owner,?,id,?,? FROM subscription
                WHERE owner=? AND revoked=0 AND expires>? AND created<=?''',
                       (message_id, now, expires, owner, now, created))
            return db.total_changes - before


class OwnerAPI:
    """Inject only behind existing cookie authentication AND CSRF verification.

    authorize(request) must verify both on every mutation and return the stable
    authenticated owner ID or raise. Never take owner identity from request JSON.
    No generic webhook, enqueue, send, or unauthenticated HTTP surface is provided.
    """
    def __init__(self, store, authorize):
        self.store, self.authorize = store, authorize

    def handle(self, request, action, body):
        owner = self.authorize(request)
        if not isinstance(owner, str) or not owner:
            raise PermissionError('Owner authentication and CSRF required')
        if not isinstance(body, dict):
            raise ValueError('JSON object required')
        if action == 'subscribe':
            return self.store.subscribe(owner, body)
        if action == 'unsubscribe':
            identifier = body.get('id')
            if not isinstance(identifier, str) or len(identifier) != 64:
                raise ValueError('Subscription ID required')
            return self.store.revoke(owner, identifier)
        raise ValueError('Unknown push operation')


class Worker:
    MAX_ATTEMPTS = 5
    def __init__(self, store, transport: Transport):
        self.store, self.transport = store, transport

    def run_once(self):
        """Drain one due row. Call on a local timer; no HTTP sender endpoint.

        Lease recovery is at-least-once after a crash; Web Push has no exactly-once
        receipt API. Stable notification tag collapses duplicates on each device.
        """
        now = self.store.clock()
        token = secrets.token_hex(16)
        with self.store.db() as db:
            db.execute("""UPDATE outbox SET state='expired',lease=NULL
                WHERE state IN ('pending','sending') AND (expires<=? OR EXISTS
                (SELECT 1 FROM subscription s WHERE s.id=outbox.subscription
                 AND s.owner=outbox.owner AND s.expires<=?))""", (now, now))
            db.execute("""UPDATE outbox SET state='cancelled',lease=NULL
                WHERE state IN ('pending','sending') AND EXISTS
                (SELECT 1 FROM subscription s WHERE s.id=outbox.subscription
                 AND s.owner=outbox.owner AND s.revoked=1)""")
            db.execute("UPDATE outbox SET state='failed',error='attempts_exhausted',lease=NULL WHERE state IN ('pending','sending') AND attempts>=? AND (lease_until IS NULL OR lease_until<=?)", (self.MAX_ATTEMPTS, now))
            row = db.execute('''SELECT o.*,s.json FROM outbox o JOIN subscription s ON s.id=o.subscription
                AND s.owner=o.owner WHERE s.revoked=0 AND s.expires>? AND o.expires>?
                AND o.attempts<? AND o.due<=? AND (o.state='pending' OR (o.state='sending' AND o.lease_until<=?))
                ORDER BY o.due LIMIT 1''', (now, now, self.MAX_ATTEMPTS, now, now)).fetchone()
            if row is None:
                return False
            key = (row['owner'], row['message'], row['subscription'])
            db.execute("UPDATE outbox SET state='sending',attempts=attempts+1,lease=?,lease_until=? WHERE owner=? AND message=? AND subscription=?", (token, now+60, *key))
        # No sender, body, network, conversation, or raw message IDs in payload/logs.
        tag = hashlib.sha256((row['owner'] + '\0' + row['message']).encode()).hexdigest()
        payload = json.dumps({'v': 1, 'tag': tag})
        try:
            status = self.transport.send(json.loads(row['json']), payload, max(1, int(row['expires']-now)))
        except Exception:
            # Never persist/log upstream exceptions (may include credentials/body).
            status = 503
        attempt = row['attempts'] + 1
        if 200 <= status < 300:
            state, error = 'sent', None
        elif status in (404, 410):
            state, error = 'revoked', 'subscription_gone'
        elif status in (408, 425, 429) or 500 <= status <= 599:
            state, error = ('pending' if attempt < self.MAX_ATTEMPTS else 'failed'), 'transient'
        else:
            state, error = 'failed', 'permanent'
        with self.store.db() as db:
            db.execute('''UPDATE outbox SET state=?,error=?,due=?,lease=NULL,lease_until=NULL
                WHERE owner=? AND message=? AND subscription=? AND lease=? AND state='sending' ''',
                       (state, error, self.store.clock()+min(3600, 30*2**(attempt-1)), *key, token))
            if state == 'revoked':
                db.execute('UPDATE subscription SET revoked=1 WHERE id=? AND owner=?', (row['subscription'], row['owner']))
                db.execute("UPDATE outbox SET state='cancelled',lease=NULL WHERE subscription=? AND owner=? AND state IN ('pending','sending')", (row['subscription'], row['owner']))
        return True
