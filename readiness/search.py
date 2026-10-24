"""Stdlib-only FTS5 mirror for normalized stored messages, never a provider client.

Caller authenticates and derives account/thread scope; IDs are not authorization.
Text queries are literal AND tokens, not FTS syntax. Results are plain text.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import threading


def identifier(value):
    if not isinstance(value, str) or not value or len(value) > 512 or any(ord(c) < 32 for c in value):
        raise ValueError('invalid identifier')
    return value


class SearchStore:
    MAX_PAGE = 100

    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        os.chmod(path, 0o600)
        self.db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS normalized_message(
                rowid INTEGER PRIMARY KEY,
                account TEXT NOT NULL, network TEXT NOT NULL, thread TEXT NOT NULL,
                message_id TEXT NOT NULL, timestamp INTEGER NOT NULL,
                original TEXT NOT NULL, translated TEXT NOT NULL,
                UNIQUE(account, network, thread, message_id));
            CREATE INDEX IF NOT EXISTS normalized_scope
                ON normalized_message(account,network,thread,timestamp,rowid);
            CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
                original,translated,content='normalized_message',content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2');
            CREATE TRIGGER IF NOT EXISTS normalized_insert AFTER INSERT ON normalized_message BEGIN
                INSERT INTO message_fts(rowid,original,translated) VALUES(new.rowid,new.original,new.translated);
            END;
            CREATE TRIGGER IF NOT EXISTS normalized_delete AFTER DELETE ON normalized_message BEGIN
                INSERT INTO message_fts(message_fts,rowid,original,translated)
                VALUES('delete',old.rowid,old.original,old.translated);
            END;
            CREATE TRIGGER IF NOT EXISTS normalized_update AFTER UPDATE ON normalized_message BEGIN
                INSERT INTO message_fts(message_fts,rowid,original,translated)
                VALUES('delete',old.rowid,old.original,old.translated);
                INSERT INTO message_fts(rowid,original,translated) VALUES(new.rowid,new.original,new.translated);
            END;
        ''')

    def close(self):
        with self.lock:
            self.db.close()

    def upsert(self, *, account, network, thread, message_id, timestamp, original, translated='', deleted=False):
        scope = tuple(identifier(x) for x in (account, network, thread, message_id))
        if type(timestamp) is not int or not 0 <= timestamp <= 9223372036854775807:
            raise ValueError('invalid timestamp')
        if not all(isinstance(x, str) and len(x) <= 100000 for x in (original, translated)):
            raise ValueError('invalid message text')
        if type(deleted) is not bool:
            raise ValueError('invalid tombstone')
        with self.lock, self.db:
            if deleted:
                self.db.execute('DELETE FROM normalized_message WHERE account=? AND network=? AND thread=? AND message_id=?', scope)
            else:
                self.db.execute('''INSERT INTO normalized_message(account,network,thread,message_id,timestamp,original,translated)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(account,network,thread,message_id) DO UPDATE SET
                    timestamp=excluded.timestamp,original=excluded.original,translated=excluded.translated''',
                    (*scope, timestamp, original, translated))

    def forget_account(self, account):
        with self.lock, self.db:
            self.db.execute('DELETE FROM normalized_message WHERE account=?', (identifier(account),))

    def forget_thread(self, *, account, network, thread):
        scope = tuple(identifier(x) for x in (account, network, thread))
        with self.lock, self.db:
            self.db.execute('DELETE FROM normalized_message WHERE account=? AND network=? AND thread=?', scope)

    def search(self, *, account, query, network=None, thread=None, limit=50, cursor=None):
        identifier(account)
        for value in (network, thread):
            if value is not None:
                identifier(value)
        if type(limit) is not int or not 1 <= limit <= self.MAX_PAGE:
            raise ValueError('limit must be 1..100')
        if not isinstance(query, str) or not query.strip() or len(query) > 512:
            raise ValueError('query must be 1..512 characters')
        tokens = re.findall(r'[^\W_]+', query, flags=re.UNICODE)
        if not tokens or len(tokens) > 32:
            raise ValueError('query requires 1..32 words')
        match = ' AND '.join('"' + token + '"' for token in tokens)
        binding = hashlib.sha256(json.dumps([account, network, thread, match], ensure_ascii=False).encode()).hexdigest()
        before = None
        if cursor is not None:
            try:
                if not isinstance(cursor, str) or len(cursor) > 512:
                    raise ValueError()
                data = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
                if (not isinstance(data, list) or len(data) != 3 or data[0] != binding
                        or any(type(x) is not int or not 0 <= x <= 9223372036854775807 for x in data[1:])):
                    raise ValueError()
                before = data[1:]
            except (ValueError, TypeError, UnicodeError):
                raise ValueError('invalid or differently scoped cursor') from None
        where = ['message_fts MATCH ?', 'm.account=?']
        args = [match, account]
        for column, value in (('network', network), ('thread', thread)):
            if value is not None:
                where.append('m.' + column + '=?')
                args.append(value)
        if before is not None:
            where.append('(m.timestamp,m.rowid)<(?,?)')
            args.extend(before)
        with self.lock:
            rows = self.db.execute('SELECT m.* FROM normalized_message m JOIN message_fts ON message_fts.rowid=m.rowid WHERE '
                + ' AND '.join(where) + ' ORDER BY m.timestamp DESC,m.rowid DESC LIMIT ?', (*args, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = [dict(r) for r in rows[:limit]]
        next_cursor = None
        if more:
            last = rows[-1]
            next_cursor = base64.urlsafe_b64encode(json.dumps([binding, last['timestamp'], last['rowid']]).encode()).decode()
        for row in rows:
            row.pop('rowid')
        return {'messages': rows, 'next_cursor': next_cursor, 'has_more': more}
