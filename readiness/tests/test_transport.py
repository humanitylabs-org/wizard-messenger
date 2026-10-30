"""Real loopback transport exercises production sync; no account or provider calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import Mock
from unified import UnifiedInbox


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.requests = []
        self.responses = []
        case = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args): pass
            def do_GET(self):
                case.requests.append(self.path)
                if urlsplit(self.path).path.endswith('/sync'):
                    status, body = case.responses.pop(0)
                elif self.path.endswith('/state'):
                    status, body = 200, [
                        {'type': 'm.bridge', 'content': {'protocol': {'id': 'telegram'}, 'com.beeper.room_type.v2': 'dm'}},
                        {'type': 'm.room.name', 'content': {'name': 'Disposable fixture'}}]
                else:
                    status, body = 404, {'errcode': 'fixture_only'}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers(); self.wfile.write(data)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.shutdown)
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = self.make_inbox()
        self.addCleanup(self.close_inbox)

    def close_inbox(self):
        self.inbox.close()
        assert self.inbox.store._conn is not None
        self.inbox.store._conn.close()

    def shutdown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def make_inbox(self):
        inbox = UnifiedInbox(self.tmp.name, self.engine)
        inbox.matrix = 'http://127.0.0.1:' + str(self.server.server_port)
        inbox._token = 'disposable-fixture-not-a-provider-token'
        return inbox

    def batch(self, token, ids, limited=False):
        return {'next_batch': token, 'rooms': {'join': {'!fixture': {'timeline': {
            'limited': limited, 'events': [{'event_id': mid, 'type': 'm.room.message',
            'sender': '@fixture:messenger.internal', 'origin_server_ts': 100,
            'content': {'msgtype': 'm.text', 'body': 'fixture ' + mid}} for mid in ids]}}}}}

    def test_failed_sync_preserves_cursor_restart_replay_is_deduplicated(self):
        self.responses.extend([(200, self.batch('cursor-one', ['$1'])),
                               (503, {'errcode': 'fixture_outage'}),
                               (200, self.batch('cursor-two', ['$1', '$2']))])
        self.assertEqual(self.inbox.sync()['state'], 'ready')
        self.assertEqual(self.inbox.sync()['state'], 'unavailable')
        self.assertEqual(self.inbox.store.get('sync_token'), 'cursor-one')
        self.assertTrue(self.inbox.store.get('sync_error'))
        self.close_inbox()
        self.inbox = self.make_inbox()
        self.assertEqual(self.inbox.sync()['state'], 'ready')
        self.assertEqual(self.inbox.store.get('sync_token'), 'cursor-two')
        self.assertEqual(self.inbox.store.get('sync_error'), '')
        person = self.inbox.store.people()[0]
        self.assertEqual([m['id'] for m in self.inbox.store.messages(person['id'])], ['$1', '$2'])
        syncs = [parse_qs(urlsplit(p).query) for p in self.requests if '/sync?' in p]
        self.assertNotIn('since', syncs[0])
        self.assertEqual([x['since'][0] for x in syncs[1:]], ['cursor-one', 'cursor-one'])
        self.engine.send.assert_not_called()

    def test_limited_sync_warns_history_incomplete(self):
        self.responses.append((200, self.batch('limited', ['$1'], limited=True)))
        self.assertEqual(self.inbox.sync()['state'], 'ready')
        pid = self.inbox.store.people()[0]['id']
        self.assertIn('incomplete', self.inbox.timeline(pid)['history_warning'])

    def test_composite_history_cursor_preserves_ties(self):
        # Former timestamp-only regression, now required to pass normally.
        identity = self.inbox.store.identity('telegram', '!ties', 'Ties')
        for mid in ('$a', '$b', '$c'):
            self.inbox.store.add_message(mid, identity, 'fixture', False, 'text', 100)
        first = self.inbox.timeline(identity['person_id'], limit=2)
        second = self.inbox.timeline(identity['person_id'], before=first['next_cursor'], limit=2)
        self.assertEqual(len(first['messages']) + len(second['messages']), 3)


if __name__ == '__main__': unittest.main()
