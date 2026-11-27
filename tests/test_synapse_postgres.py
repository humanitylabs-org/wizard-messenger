"""Issue 451 (switch synapse-postgres): Synapse moves from SQLite to Postgres once, then history caps rise.

Offline: the setup half and the checks of the move. The move itself runs against the real Synapse and Postgres images
(see the PR's Verified section); here the failure path is proved to leave SQLite and homeserver.yaml untouched."""
import json
import os
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import synapse_postgres
from connector_setup import setup_connectors
from connector_inbox import ConnectorInbox
from unified_setup import setup

ROOT = Path(__file__).resolve().parents[1]


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def run_init(self):
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '12345', 'TELEGRAM_API_HASH': 'a' * 32}):
            setup(self.root)
        setup_connectors(self.root)

    def switch(self, on):
        (self.root / 'switches.json').write_text(json.dumps({'switches': {'synapse-postgres': on}}))

    def moved(self, state='moved'):
        (self.root / 'matrix' / 'postgres-move.json').write_text(json.dumps({'state': state, 'tries': 1}))

    def home(self):
        return json.loads((self.root / 'matrix' / 'homeserver.yaml').read_text())

    def caps(self):
        import yaml
        tg = yaml.safe_load((self.root / 'telegram' / 'config.yaml').read_text())
        wa = yaml.safe_load((self.root / 'whatsapp' / 'config.yaml').read_text())
        return (tg['network']['sync']['create_limit'], tg['network']['sync']['login_sync_limit'],
                tg['backfill']['max_initial_messages'], tg['backfill']['threads']['max_initial_messages'],
                wa['backfill']['max_initial_messages'], wa['backfill']['threads']['max_initial_messages'])

    def assert_as_before(self):
        self.assertEqual(self.home()['database'], {'name': 'sqlite3', 'args': {'database': '/data/homeserver.db'}})
        self.assertFalse((self.root / 'matrix' / 'synapse_start.py').exists())
        self.assertFalse((self.root / 'postgres' / 'enabled').exists())
        self.assertEqual(self.caps(), (50, 50, 200, 50, 100, 50))
        self.assertEqual(ConnectorInbox(self.root, Mock(), sender=Mock()).history_pages, 5)

    def test_switch_off_changes_nothing(self):
        self.run_init()
        self.assert_as_before()
        self.switch(False)
        self.run_init()
        self.assert_as_before()

    def test_switch_on_wakes_postgres_and_hands_synapse_the_mover(self):
        self.switch(True)
        self.run_init()
        start = self.root / 'matrix' / 'synapse_start.py'
        self.assertEqual(start.read_bytes(), (ROOT / 'synapse_postgres.py').read_bytes())
        self.assertTrue((self.root / 'postgres' / 'enabled').exists())
        word = (self.root / 'postgres' / 'password').read_text()
        self.assertGreaterEqual(len(word), 32)
        passfile = self.root / 'matrix' / 'postgres.pass'
        self.assertEqual(passfile.read_text(), 'postgres:5432:synapse:synapse:%s\n' % word)
        for secret in (passfile, self.root / 'postgres' / 'password'):
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        # Not moved yet: Synapse still names SQLite until the move has checked every row. The bridges start after
        # Synapse, so their caps already count on the move.
        self.assertEqual(self.home()['database']['name'], 'sqlite3')
        self.assertEqual(self.caps(), (200, 200, 500, 100, 500, 100))
        self.run_init()
        self.assertEqual((self.root / 'postgres' / 'password').read_text(), word)

    def test_moved_names_postgres_without_its_password_and_raises_history(self):
        self.switch(True)
        self.run_init()
        self.moved()
        self.run_init()
        home = self.home()
        self.assertEqual(home['database'], synapse_postgres.POSTGRES)
        word = (self.root / 'postgres' / 'password').read_text()
        self.assertNotIn(word, (self.root / 'matrix' / 'homeserver.yaml').read_text())
        self.assertEqual(self.caps(), (200, 200, 500, 100, 500, 100))
        self.assertEqual(ConnectorInbox(self.root, Mock(), sender=Mock()).history_pages, 10)

    def test_off_after_the_move_stays_on_postgres(self):
        self.switch(True)
        self.run_init()
        self.moved()
        self.switch(False)
        self.run_init()
        self.assertEqual(self.home()['database']['name'], 'psycopg2')
        self.assertTrue((self.root / 'matrix' / 'synapse_start.py').exists())
        self.assertTrue((self.root / 'postgres' / 'enabled').exists())

    def test_a_failed_move_keeps_the_sqlite_caps(self):
        self.switch(True)
        self.run_init()
        self.moved('failed')
        self.run_init()
        self.assertEqual(self.home()['database']['name'], 'sqlite3')
        self.assertEqual(self.caps(), (50, 50, 200, 50, 100, 50))
        self.assertEqual(ConnectorInbox(self.root, Mock(), sender=Mock()).history_pages, 5)
        self.assertTrue((self.root / 'matrix' / 'synapse_start.py').exists())

    def test_off_after_failed_tries_goes_back_to_sleep_and_resets_them(self):
        self.switch(True)
        self.run_init()
        self.moved('failed')
        self.switch(False)
        self.run_init()
        self.assertFalse((self.root / 'matrix' / 'postgres-move.json').exists())
        self.assert_as_before()


class MoveChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name)

    def test_every_carried_table_must_match(self):
        before = {'events': 10, 'rooms': 2, 'event_search_content': 9, 'sent_transactions': 4, 'user_directory': 1}
        self.assertEqual(synapse_postgres.compare(before, {'events': 10, 'rooms': 2}, {'user_directory'}), (2, 12))
        with self.assertRaisesRegex(RuntimeError, 'events 10->9'):
            synapse_postgres.compare(before, {'events': 9, 'rooms': 2}, {'user_directory'})
        with self.assertRaisesRegex(RuntimeError, 'rooms 2->None'):
            synapse_postgres.compare(before, {'events': 10}, {'user_directory'})

    def test_integrity_and_counts_read_sqlite(self):
        path = self.data / 'homeserver.db'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE events (id TEXT)')
        db.executemany('INSERT INTO events VALUES (?)', [('a',), ('b',)])
        db.commit()
        db.close()
        synapse_postgres.integrity(path)
        self.assertEqual(synapse_postgres.sqlite_counts(path), {'events': 2})
        path.write_bytes(b'SQLite format 3\x00' + b'\x00' * 200)
        with self.assertRaises(Exception):
            synapse_postgres.integrity(path)

    def test_a_failed_move_keeps_sqlite_and_the_config(self):
        db = sqlite3.connect(self.data / 'homeserver.db')
        db.execute('CREATE TABLE events (id TEXT)')
        db.execute("INSERT INTO events VALUES ('a')")
        db.commit()
        db.close()
        config = {'database': synapse_postgres.SQLITE, 'server_name': 'messenger.internal'}
        (self.data / 'homeserver.yaml').write_text(json.dumps(config))
        original = (self.data / 'homeserver.db').read_bytes()
        with patch.object(synapse_postgres, 'DATA', self.data), \
                patch.object(synapse_postgres, '_pg', Mock(side_effect=RuntimeError('Postgres did not answer: x'))):
            state = synapse_postgres.move({})
            self.assertEqual(synapse_postgres.status(self.data), state)
        self.assertEqual((state['state'], state['tries']), ('failed', 1))
        self.assertIn('Postgres did not answer', state['error'])
        self.assertEqual((self.data / 'homeserver.db').read_bytes(), original)
        self.assertEqual(json.loads((self.data / 'homeserver.yaml').read_text()), config)
        self.assertFalse((self.data / 'homeserver.db.pre-postgres').exists())
        self.assertFalse((self.data / 'homeserver-postgres.yaml').exists())

    def test_sequences_left_by_the_port_tool_report_the_true_position(self):
        # synapse_port_db: ALTER SEQUENCE ... RESTART WITH max + 1 leaves is_called false, and Synapse's writer reads
        # last_value as its position, so the first new event after the move was skipped by Messenger's sync.
        seqs = {'events_stream_seq': (512, False), 'receipts_sequence': (2, False), 'cache_invalidation_stream_seq':
                (40, True), 'fresh_seq': (1, False)}
        calls = []

        class Cur:
            def execute(self, sql, args=()):
                calls.append((sql, args))
                self.last = sql

            def fetchall(self):
                return [(n,) for n in seqs]

            def fetchone(self):
                return seqs[self.last.split('"')[1]]

        conn = Mock()
        conn.cursor.return_value = Cur()
        self.assertEqual(synapse_postgres.settle_sequences(conn), 2)
        self.assertEqual([a for s, a in calls if 'setval' in s],
                         [('"events_stream_seq"', 511), ('"receipts_sequence"', 1)])
        conn.commit.assert_called_once()

    def test_main_stops_trying_after_three_failures(self):
        (self.data / 'postgres-move.json').write_text(json.dumps({'state': 'failed', 'tries': 3}))
        (self.data / 'homeserver.yaml').write_text(json.dumps({'database': synapse_postgres.SQLITE}))
        with patch.object(synapse_postgres, 'DATA', self.data), patch.object(synapse_postgres, 'move') as move, \
                patch.object(synapse_postgres.os, 'execv') as execv:
            synapse_postgres.main()
        move.assert_not_called()
        self.assertEqual(execv.call_args[0][1][1:], ['-m', 'synapse.app.homeserver', '--config-path',
                                                     str(self.data / 'homeserver.yaml')])


class RecipeTests(unittest.TestCase):
    def test_postgres_sleeps_until_asked_and_only_synapse_reaches_it(self):
        import yaml
        compose = yaml.safe_load((ROOT / 'runtipi' / 'docker-compose.yml').read_text())
        services, networks = compose['services'], compose['networks']
        pg = services['postgres']
        self.assertRegex(pg['image'], r'^postgres:17-alpine@sha256:[0-9a-f]{64}$')
        self.assertIn('until [ -f /pg/enabled ]', pg['command'][0])
        self.assertEqual((pg['user'], pg['read_only'], pg['cap_drop']), ('1000:1000', True, ['ALL']))
        self.assertEqual(networks['postgres-lane'], {'internal': True})
        self.assertEqual(sorted(n for n, s in services.items() if 'postgres-lane' in (s.get('networks') or [])),
                         ['matrix', 'postgres'])
        self.assertEqual(pg['volumes'], ['${APP_DATA_DIR}/data/postgres:/pg'])
        matrix = services['matrix']
        self.assertIn('if [ -f /data/synapse_start.py ]; then exec python /data/synapse_start.py; fi; exec python -m '
                      'synapse.app.homeserver --config-path /data/homeserver.yaml', matrix['command'][0])
        self.assertEqual(matrix['mem_limit'], '768m')


if __name__ == '__main__':
    unittest.main()
