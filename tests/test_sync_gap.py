"""Issue 444: Synapse housekeeping that is a bug.

- A limited /sync (more than the 100-event timeline arrived since the last sync) must not
  lose the skipped messages: Messenger reads them back from prev_batch to the last sync point.
- homeserver.yaml holds no secret; the registration secret sits in its own 0600 file.
- Synapse is pinned to v1.166.0 by tag and multi-arch digest.
Synthetic fixtures only."""
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import EngineError
from unified_setup import setup
from connector_inbox import ConnectorInbox
import unified

ROOT = Path(__file__).resolve().parents[1]
SERVER = 'messenger.internal'
ROOM = '!wa:' + SERVER
PEER = '@whatsapp_4915550001:' + SERVER
STATE = [{'type': 'm.bridge', 'state_key': 'x', 'sender': '@whatsappbot:' + SERVER,
          'content': {'protocol': {'id': 'whatsapp'}, 'com.beeper.room_type.v2': 'dm'}},
         {'type': 'm.room.name', 'content': {'name': 'Pat'}},
         {'type': 'm.room.member', 'state_key': '@owner:' + SERVER, 'content': {'membership': 'join'}},
         {'type': 'm.room.member', 'state_key': PEER, 'content': {'membership': 'join', 'displayname': 'Pat'}}]


def msg(i, now):
    return {'type': 'm.room.message', 'event_id': '$m%d' % i, 'sender': PEER, 'origin_server_ts': now + i,
            'content': {'msgtype': 'm.text', 'body': 'message %d' % i}}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(self.root)


class LimitedSyncGapTests(Base):
    def inbox(self):
        engine = Mock()
        engine.status.return_value = {'state': 'dormant'}
        inbox = ConnectorInbox(self.root, engine)
        self.addCleanup(inbox.close)
        self.addCleanup(inbox.store._conn.close)
        inbox.store.put('matrix_token', 'synthetic-read-token')
        inbox.history_sync = True
        inbox.learn_me = lambda: None
        inbox.store.put('history_imported:' + ROOM, '1')  # a chat Messenger already follows
        inbox.store.put('sync_token', 's_prev')
        return inbox

    def run_sync(self, inbox, total, page_error=False, pages_seen=None):
        """Synapse holds `total` new messages; /sync shows the newest 100 and says limited."""
        now = int(time.time() * 1000)
        events = [msg(i, now) for i in range(total)]
        timeline, skipped = events[-100:], events[:-100]

        def matrix(path, *a, **k):
            if path.startswith('/sync?'):
                self.assertEqual(parse_qs(urlparse(path).query)['since'], ['s_prev'])
                return {'next_batch': 's_next', 'rooms': {'join': {ROOM: {'timeline': {
                    'events': timeline, 'limited': True, 'prev_batch': 't_gap'}}}}}
            if path.endswith('/state'):
                return STATE
            if '/messages?' in path:
                q = {k: v[0] for k, v in parse_qs(urlparse(path).query).items()}
                if page_error:
                    raise EngineError('matrix_unavailable', 'down', 502)
                self.assertEqual((q['dir'], q['to']), ('b', 's_prev'))
                if pages_seen is not None:
                    pages_seen.append(q['from'])
                # Pages back from prev_batch to the last sync point, newest first.
                end = len(skipped) if q['from'] == 't_gap' else int(q['from'][2:])
                start = max(0, end - int(q['limit']))
                chunk = list(reversed(skipped[start:end]))
                return {'chunk': chunk, 'start': q['from'], **({'end': 'p_%d' % start} if chunk else {})}
            raise AssertionError(path)
        with patch.object(inbox, 'mx', side_effect=matrix):
            self.assertEqual(inbox.sync()['state'], 'ready')
        return events

    def stored(self, inbox):
        with inbox.store.db() as db:
            return [r[0] for r in db.execute('SELECT original FROM message ORDER BY timestamp')]

    def test_every_skipped_message_shows_and_the_warning_clears(self):
        inbox = self.inbox()
        inbox.store.put('history_gap:' + ROOM, 'Earlier history may be incomplete')
        inbox.store.push_enabled = True
        events = self.run_sync(inbox, 130)
        self.assertEqual(self.stored(inbox), [e['content']['body'] for e in events])
        self.assertFalse(inbox.store.get('history_gap:' + ROOM))
        person = inbox.store.people()[0]
        self.assertIsNone(inbox.timeline(person['id'])['history_warning'])
        with inbox.store.db() as db:  # the read-back lines never notify; the live 100 do as before
            pushed = {r[0] for r in db.execute('SELECT message FROM push_intent')}
        self.assertFalse(pushed & {e['event_id'] for e in events[:30]})

    def test_a_long_gap_is_read_over_several_pages(self):
        inbox = self.inbox()
        pages = []
        events = self.run_sync(inbox, 450, pages_seen=pages)
        self.assertEqual(len(self.stored(inbox)), 450)
        self.assertEqual(self.stored(inbox), [e['content']['body'] for e in events])
        self.assertEqual(pages[0], 't_gap')
        self.assertGreaterEqual(len(pages), 4)

    def test_an_unreadable_gap_keeps_the_warning_and_the_live_lines(self):
        inbox = self.inbox()
        self.run_sync(inbox, 130, page_error=True)
        self.assertEqual(len(self.stored(inbox)), 100)
        self.assertEqual(inbox.store.get('history_gap:' + ROOM), 'Earlier history may be incomplete')

    def test_a_gap_longer_than_the_cap_keeps_the_warning(self):
        inbox = self.inbox()
        with patch.object(unified, 'GAP_PAGES', 2):
            self.run_sync(inbox, 450)
        self.assertEqual(len(self.stored(inbox)), 300)
        self.assertEqual(inbox.store.get('history_gap:' + ROOM), 'Earlier history may be incomplete')


class SecretAndPinTests(Base):
    def test_homeserver_yaml_holds_no_secret(self):
        home = (self.root / 'matrix' / 'homeserver.yaml').read_text()
        keys = json.loads((self.root / 'unified' / 'secrets.json').read_text())
        config = json.loads(home)
        self.assertNotIn('registration_shared_secret', config)
        for value in keys.values():
            self.assertNotIn(value, home)
        self.assertEqual(config['registration_shared_secret_path'], '/data/registration_shared_secret')
        secret = self.root / 'matrix' / 'registration_shared_secret'
        self.assertEqual(secret.read_text(), keys['registration'])
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)

    def test_an_existing_box_moves_the_secret_on_its_next_start(self):
        home = self.root / 'matrix' / 'homeserver.yaml'
        old = json.loads(home.read_text())
        old.pop('registration_shared_secret_path')
        old['registration_shared_secret'] = json.loads((self.root / 'unified/secrets.json').read_text())['registration']
        home.write_text(json.dumps(old))
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(self.root)
        self.assertNotIn('registration_shared_secret', json.loads(home.read_text()))

    def test_synapse_is_pinned_to_the_current_release_by_digest(self):
        import yaml
        image = yaml.safe_load((ROOT / 'runtipi' / 'docker-compose.yml').read_text())['services']['matrix']['image']
        self.assertRegex(image, r'^ghcr\.io/element-hq/synapse:v1\.166\.0@sha256:[0-9a-f]{64}$')
        self.assertIn(image, (ROOT / 'tools' / 'prove_connector_stack.py').read_text())
        bot = (ROOT / '.github' / 'dependabot.yml').read_text()
        self.assertIn('element-hq/synapse', bot)


if __name__ == '__main__':
    unittest.main()
