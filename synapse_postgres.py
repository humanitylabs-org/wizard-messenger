"""Synapse on Postgres (issue 451; on for everyone since its switch `synapse-postgres` was approved).

Two halves in one file:

* `prepare(root)` runs in unified-init (Messenger's image, no network). It wakes the Postgres container, writes its
  password into owner-only files and copies this file next to Synapse's data as `synapse_start.py`.
  `database(root)` says which database homeserver.yaml names.

* `main()` runs as `synapse_start.py` inside Synapse's own container (the pinned Synapse image: its Python, psycopg2
  and `synapse_port_db`), right before Synapse itself. Only there is it certain that no Synapse is writing the SQLite
  file: on a restart or update Compose recreates Synapse after its dependencies, so a separate porting container could
  run while the old Synapse still writes. The move: integrity check of the SQLite file, a backup with SQLite's backup
  API, integrity check of the backup, `synapse_port_db` from the backup into an empty Postgres, then the row count of
  every ported table compared between both. Only when all of it holds does Synapse start on Postgres; on any failure it
  starts on SQLite as before and `postgres-move.json` says why (at most TRIES tries).

Once moved, Synapse stays on Postgres. The pre-move backup stays on the box as `homeserver.db.pre-postgres`. No secret is ever written to
homeserver.yaml, the status file or the log.
"""
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

TRIES = 3
PG_HOST, PG_PORT, PG_USER, PG_DB = 'postgres', 5432, 'synapse', 'synapse'
# What homeserver.yaml names once moved. The password stays in a libpq passfile next to Synapse's data.
POSTGRES = {'name': 'psycopg2', 'args': {'user': PG_USER, 'dbname': PG_DB, 'host': PG_HOST, 'port': PG_PORT,
                                         'passfile': '/data/postgres.pass', 'cp_min': 1, 'cp_max': 5}}
SQLITE = {'name': 'sqlite3', 'args': {'database': '/data/homeserver.db'}}
# Issue 451 ask 2: history once Synapse no longer runs on SQLite. Stock Synapse can't put older messages into a chat
# that already exists (the bridges' backward queue needs batch sending), so these reach new and rebuilt chats.
HISTORY = {'chats': 200, 'first_messages': 500, 'thread_messages': 100, 'import_pages': 10}
# Tables Synapse's own port tool leaves out or rebuilds (its IGNORED_TABLES plus SQLite's full-text shadow tables and
# its bookkeeping), so their counts may differ. Every other table must match row for row.
SKIP_COUNT = {'sqlite_sequence', 'sqlite_stat1', 'sent_transactions', 'applied_schema_deltas', 'schema_version',
              'applied_module_schemas', 'background_updates', 'schema_compat_version'}
SKIP_PREFIXES = ('sqlite_', 'event_search_', 'user_directory_search_')


# ---------- unified-init side (Messenger image) ----------
def status(matrix_dir):
    try:
        value = json.loads((Path(matrix_dir) / 'postgres-move.json').read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def moved(root):
    """True once Synapse runs on Postgres. Messenger reads the same file for its own history pages."""
    return status(Path(root) / 'matrix').get('state') == 'moved'


def database(root):
    return json.loads(json.dumps(POSTGRES if moved(root) else SQLITE))


def history(root):
    """The raised caps, or None. The bridges' configs are written before Synapse's container moves the database, so
    they already count on the move unless it failed; once a move failed they are back to the SQLite caps until it
    succeeds. Messenger starts after Synapse, so it sees the outcome."""
    if status(Path(root) / 'matrix').get('state') == 'failed':
        return None
    return dict(HISTORY)


def _secret_file(path, text):
    tmp = path.with_name(path.name + '.new')
    with tmp.open('w') as f:
        os.chmod(tmp, 0o600)
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def prepare(root):
    """Wake the Postgres side and hand Synapse its mover. Returns True (Synapse goes through synapse_start.py)."""
    root = Path(root)
    matrix, pg = root / 'matrix', root / 'postgres'
    pg.mkdir(mode=0o700, exist_ok=True)
    os.chmod(pg, 0o700)
    start = matrix / 'synapse_start.py'
    password = pg / 'password'
    if not password.exists():
        _secret_file(password, secrets.token_urlsafe(32))
    word = password.read_text().strip()
    _secret_file(matrix / 'postgres.pass', '%s:%d:%s:%s:%s\n' % (PG_HOST, PG_PORT, PG_DB, PG_USER, word))
    shutil.copyfile(Path(__file__), start)
    os.chmod(start, 0o600)
    (pg / 'enabled').touch(mode=0o600)
    return True


# ---------- Synapse container side (pinned Synapse image) ----------
DATA = Path(os.environ.get('SYNAPSE_DATA', '/data'))


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _save(state):
    tmp = DATA / 'postgres-move.json.new'
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
    os.chmod(tmp, 0o600)
    tmp.replace(DATA / 'postgres-move.json')


def _log(line):
    with (DATA / 'postgres-move.log').open('a') as f:
        f.write('%s %s\n' % (_now(), line))


def _pg(timeout=180):
    import psycopg2
    args = {k: v for k, v in POSTGRES['args'].items() if k not in ('cp_min', 'cp_max')}
    args['passfile'] = str(DATA / 'postgres.pass')
    deadline, last = time.time() + timeout, None
    while time.time() < deadline:
        try:
            return psycopg2.connect(connect_timeout=5, **args)
        except psycopg2.OperationalError as e:
            last = e
            time.sleep(2)
    raise RuntimeError('Postgres did not answer: %s' % str(last).strip()[:200])


def integrity(path):
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        rows = [r[0] for r in db.execute('PRAGMA integrity_check')]
    finally:
        db.close()
    if rows != ['ok']:
        raise RuntimeError('SQLite integrity check failed for %s: %s' % (Path(path).name, '; '.join(rows[:3])))


def _no_journal(path):
    """The backup is a plain single file: fold any WAL back in and drop the -wal/-shm sidecars."""
    db = sqlite3.connect(str(path))
    try:
        db.execute('PRAGMA journal_mode=DELETE')
    finally:
        db.close()


def _drop(path):
    for suffix in ('', '-wal', '-shm', '-journal'):
        Path(str(path) + suffix).unlink(missing_ok=True)


def sqlite_counts(path):
    db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
    try:
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        return {n: db.execute('SELECT count(*) FROM "%s"' % n.replace('"', '""')).fetchone()[0] for n in names}
    finally:
        db.close()


def countable(name, ignored=()):
    return name not in SKIP_COUNT and name not in ignored and not name.startswith(SKIP_PREFIXES)


def compare(before, after, ignored=()):
    """Every table the port tool carries must hold the same rows on both sides. Returns (tables, rows)."""
    wrong = []
    tables = rows = 0
    for name, n in sorted(before.items()):
        if not countable(name, ignored):
            continue
        if after.get(name) != n:
            wrong.append('%s %s->%s' % (name, n, after.get(name)))
        tables, rows = tables + 1, rows + n
    if wrong:
        raise RuntimeError('Row counts differ after the move: ' + ', '.join(wrong[:5]))
    return tables, rows


def pg_counts(conn, names):
    cur = conn.cursor()
    cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    present = {r[0] for r in cur.fetchall()}
    out = {}
    for n in names:
        if n in present:
            cur.execute('SELECT count(*) FROM "%s"' % n.replace('"', '""'))
            out[n] = cur.fetchone()[0]
    return out


def _empty(conn):
    cur = conn.cursor()
    cur.execute("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
    if cur.fetchone()[0]:
        # A half-finished earlier try: start over from an empty schema.
        cur.execute('DROP SCHEMA public CASCADE')
        cur.execute('CREATE SCHEMA public')
    conn.commit()


def settle_sequences(conn):
    """synapse_port_db leaves each stream sequence as `RESTART WITH max + 1` (is_called false). Synapse's writer then
    reads `last_value` as its current position (storage/util/id_generators.py), one ahead of what is stored, so the
    first new event of each stream already counts as seen and a client syncing from that token never gets it (seen
    here: the first message after the move did not reach Messenger). Marking max as the last value handed out gives
    the same next value and the true position. Returns how many sequences it settled."""
    cur = conn.cursor()
    cur.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relkind = 'S' AND n.nspname = 'public' ORDER BY c.relname")
    names = [r[0] for r in cur.fetchall()]
    settled = 0
    for name in names:
        cur.execute('SELECT last_value, is_called FROM "%s"' % name.replace('"', '""'))
        last, called = cur.fetchone()
        if not called and last > 1:
            cur.execute('SELECT setval(%s, %s, true)', ('"%s"' % name.replace('"', '""'), last - 1))
            settled += 1
    conn.commit()
    return settled


def _config(db):
    path = DATA / 'homeserver.yaml'
    config = json.loads(path.read_text())
    config['database'] = json.loads(json.dumps(db))
    return path, config


def _write_config(path, config):
    tmp = path.with_name(path.name + '.new')
    tmp.write_text(json.dumps(config, indent=2))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def _run(args):
    _log(args[0])
    with (DATA / 'postgres-move.log').open('a') as log:
        done = subprocess.run(args, stdout=log, stderr=subprocess.STDOUT, timeout=6 * 3600)
    if done.returncode:
        raise RuntimeError('%s stopped with code %d (see postgres-move.log)' % (args[0], done.returncode))


def move(state):
    started = time.time()
    state = {'state': 'moving', 'tries': int(state.get('tries') or 0) + 1, 'started': _now()}
    _save(state)
    source, backup = DATA / 'homeserver.db', DATA / 'homeserver.db.pre-postgres'
    part = DATA / 'homeserver.db.pre-postgres.part'
    port_config, backup_config = DATA / 'homeserver-postgres.yaml', DATA / 'homeserver-backup.yaml'
    try:
        conn = _pg()
        if not source.exists():
            # A fresh Synapse: nothing to carry, it starts on Postgres from the first event.
            conn.close()
            state.update(fresh=True, tables=0, rows=0)
        else:
            state['sqlite_bytes'] = source.stat().st_size
            _log('integrity check of the SQLite database')
            integrity(source)
            _log('backup')
            part.unlink(missing_ok=True)
            src, dst = sqlite3.connect(str(source)), sqlite3.connect(str(part))
            with dst:
                src.backup(dst)
            src.close()
            dst.close()
            _no_journal(part)
            os.chmod(part, 0o600)
            integrity(part)
            if sqlite_counts(part) != sqlite_counts(source):
                raise RuntimeError('The backup does not hold the same rows as the database')
            part.replace(backup)
            _empty(conn)
            conn.close()
            # A Synapse update in the same start leaves schema changes and background updates the port tool refuses
            # to carry ("Pending background updates exist"): finish them on the backup first.
            path, config = _config({'name': 'sqlite3', 'args': {'database': str(backup)}})
            _write_config(backup_config, config)
            _run(['update_synapse_database', '--database-config', str(backup_config), '--run-background-updates'])
            path, config = _config(POSTGRES)
            _write_config(port_config, config)
            _run(['synapse_port_db', '--sqlite-database', str(backup), '--postgres-config', str(port_config)])
            # The port tool brings the backup up to this Synapse's schema first; check it again afterwards.
            _no_journal(backup)
            integrity(backup)
            before = sqlite_counts(backup)
            try:
                from synapse._scripts.synapse_port_db import IGNORED_TABLES as ignored
            except Exception:
                ignored = ()
            conn = _pg(30)
            after = pg_counts(conn, before)
            tables, rows = compare(before, after, ignored)
            state.update(tables=tables, rows=rows, sequences=settle_sequences(conn))
            conn.close()
        # Synapse is pointed at Postgres before the old file goes, so no start ever finds neither.
        path, config = _config(POSTGRES)
        _write_config(path, config)
        state['state'] = 'moved'
        _save(state)
        _drop(source)
        state.update(seconds=round(time.time() - started, 1), at=_now())
        _log('moved: %s tables, %s rows in %ss' % (state['tables'], state['rows'], state['seconds']))
    except Exception as e:  # noqa: BLE001 - any failure keeps SQLite and Synapse starts as before
        _drop(part)
        if source.exists():
            _drop(backup)
        state.update(state='failed', error=str(e)[:400], seconds=round(time.time() - started, 1), at=_now())
        _log('failed, staying on SQLite: %s' % state['error'])
    finally:
        port_config.unlink(missing_ok=True)
        backup_config.unlink(missing_ok=True)
    _save(state)
    return state


def main():
    state = status(DATA)
    if state.get('state') != 'moved' and int(state.get('tries') or 0) < TRIES:
        state = move(state)
    if state.get('state') == 'moved':
        path, config = _config(POSTGRES)
        if config.get('database') != POSTGRES:
            _write_config(path, config)
        _pg().close()  # Postgres is up before Synapse needs it
    args = [sys.executable, '-m', 'synapse.app.homeserver', '--config-path', str(DATA / 'homeserver.yaml')]
    os.execv(args[0], args)


if __name__ == '__main__':
    os.umask(0o077)
    main()
