"""Messages on the phone (issue 308, on for everyone: the switch was removed).

A real UnifiedInbox ingests synthetic live messages; a local stand-in for the Notifications app's MCP front records
each `notify` tools/call the way the real one receives it (title, message, priority, link, app).
"""
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import agent_chat
import phone_notify
from engine import EngineError
from unified import UnifiedInbox

BASE = 'https://box.example.ts.net/messenger/'
ME = '@telegram_1:messenger.internal'


class FakeNotifications:
    """Answers tools/call notify like the Notifications app's MCP front (JSON-RPC result, content text)."""

    def __init__(self, fail=False):
        self.calls = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
                outer.calls.append(body)
                if fail:
                    answer = {'jsonrpc': '2.0', 'id': body.get('id'), 'result': {'isError': True, 'content': []}}
                else:
                    answer = {'jsonrpc': '2.0', 'id': body.get('id'),
                              'result': {'content': [{'type': 'text', 'text': '{"sent": true}'}]}}
                raw = json.dumps(answer).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d/mcp' % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def args(self):
        return [c['params']['arguments'] for c in self.calls]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class PhoneNotify(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.a = self.inbox.store.identity('telegram', '!a', 'Alice')
        self.inbox.rooms['!a'] = {'telegram': True, 'kind': 'person', 'label': 'Alice', 'names': {ME: 'Alice'}}
        self.fake = FakeNotifications()
        self.addCleanup(self.fake.close)
        self.inbox.phone_notifier = phone_notify.Notifier(self.inbox, send=lambda args: phone_notify.post(args, self.fake.url))
        self.n = 0

    def on(self):
        pass  # issue 308: always on, nothing to switch

    def message(self, body='See you at 8?', live=True, ts=None, sender=ME, msgtype='m.text'):
        self.n += 1
        event = {'event_id': '$m%d' % self.n, 'type': 'm.room.message', 'sender': sender,
                 'origin_server_ts': int(time.time() * 1000) if ts is None else ts,
                 'content': {'msgtype': msgtype, 'body': body}}
        self.inbox.ingest(self.a, self.inbox.rooms['!a'], event, live=live)
        return event['event_id']

    def wait(self, n):
        until = time.time() + 5
        while len(self.fake.calls) < n and time.time() < until:
            time.sleep(0.02)
        time.sleep(0.1)  # nothing more may follow
        return self.fake.args()

    def test_on_without_any_switch_even_with_a_stale_stored_off(self):
        self.inbox.switches.path.write_text('{"switches": {"phone-notifications": false}}')
        self.message('See you at 8?')
        self.assertEqual(self.wait(1), [{'title': 'Alice', 'message': 'See you at 8?', 'priority': 'default',
                                         'app': 'messenger'}])

    def test_a_new_message_goes_to_notifications_as_messenger(self):
        self.on()
        self.assertEqual(self.inbox.dispatch('POST', '/api/unified/phone-notify', {'base': BASE + 'index.html'}),
                         {'ok': True, 'base': BASE})
        self.message('See you at 8?')
        got = self.wait(1)
        self.assertEqual(got, [{'title': 'Alice', 'message': 'See you at 8?', 'priority': 'default', 'app': 'messenger',
                                'link': BASE + '#chat=' + self.a['person_id']}])
        self.assertEqual(self.fake.calls[0]['method'], 'tools/call')
        self.assertEqual(self.fake.calls[0]['params']['name'], 'notify')

    def test_without_a_known_address_the_item_has_no_link(self):
        self.on()
        self.message('hello')
        got = self.wait(1)
        self.assertEqual(len(got), 1)
        self.assertNotIn('link', got[0])

    def test_one_item_per_message_and_never_twice(self):
        self.on()
        first = self.message('one')
        self.message('two')
        # The same event seen again (a resync) is not a new message.
        self.inbox.ingest(self.a, self.inbox.rooms['!a'], {'event_id': first, 'type': 'm.room.message', 'sender': ME,
                          'origin_server_ts': int(time.time() * 1000), 'content': {'msgtype': 'm.text', 'body': 'one'}}, live=True)
        self.assertEqual([a['message'] for a in self.wait(2)], ['one', 'two'])

    def test_quiet_cases_post_nothing(self):
        self.on()
        self.message('from me', sender=self.inbox.owner)
        self.message('history', live=False)
        self.message('old backlog', ts=int(time.time() * 1000) - 11 * 60 * 1000)
        with self.inbox.store.db() as db:
            db.execute('UPDATE person SET muted=1 WHERE id=?', (self.a['person_id'],))
        self.message('muted chat')
        self.assertEqual(self.wait(0), [])

    def test_medium_and_low_priority_chats_stay_quiet(self):
        self.on()
        for column in ('medium_priority', 'low_priority'):
            with self.inbox.store.db() as db:
                db.execute('UPDATE person SET muted=0,medium_priority=0,low_priority=0 WHERE id=?', (self.a['person_id'],))
                db.execute('UPDATE person SET %s=1 WHERE id=?' % column, (self.a['person_id'],))
            self.message(column)
        self.assertEqual(self.wait(0), [])

    def test_a_photo_says_photo(self):
        self.on()
        self.message('IMG_1.jpg', msgtype='m.image')
        got = self.wait(1)
        self.assertEqual(len(got), 1)
        self.assertIn('Photo', got[0]['message'])

    def test_long_text_is_only_the_start(self):
        self.on()
        self.message('word ' * 200)
        got = self.wait(1)
        self.assertLessEqual(len(got[0]['message']), phone_notify.TEXT_MAX)
        self.assertTrue(got[0]['message'].endswith('…'))

    def test_an_urgent_agent_ping_is_high_and_opens_the_agent_chat(self):
        self.on()
        self.inbox.dispatch('POST', '/api/unified/phone-notify', {'base': BASE})
        agent_chat.post(self.inbox, 'hermes', 'report', 'A long report')
        agent_chat.post(self.inbox, 'hermes', 'ping', 'Your flight moved to 9:40')
        self.assertEqual(self.wait(1), [{'title': 'Agent', 'message': 'Your flight moved to 9:40', 'priority': 'high',
                                         'app': 'messenger', 'link': BASE + '#chat=agent:notes'}])

    def test_a_failed_post_is_counted_and_never_blocks_the_next(self):
        bad = FakeNotifications(fail=True)
        self.addCleanup(bad.close)
        self.inbox.phone_notifier = phone_notify.Notifier(self.inbox, send=lambda args: phone_notify.post(args, bad.url))
        self.on()
        self.message('one')
        self.message('two')
        until = time.time() + 5
        while len(bad.calls) < 2 and time.time() < until:
            time.sleep(0.02)
        self.assertEqual(self.inbox.phone_notifier.stats['failed'], 2)

    def test_unreachable_notifications_never_stalls_sync(self):
        self.inbox.phone_notifier = phone_notify.Notifier(self.inbox, send=lambda args: phone_notify.post(args, 'http://127.0.0.1:9/mcp', 1))
        self.on()
        started = time.time()
        self.message('hi')
        self.assertLess(time.time() - started, 0.5)

    def test_the_route_only_takes_a_plain_https_address(self):
        for bad in ('http://box/messenger/', 'javascript:alert(1)', 'https://u:p@box/messenger/', 'https://box/m/?x=1',
                    'https://box/m/#chat=x', '', None, 'https://box/' + 'a' * 600, 'https://bo x/'):
            with self.assertRaises(EngineError, msg=bad):
                self.inbox.dispatch('POST', '/api/unified/phone-notify', {'base': bad})
        self.assertEqual(self.inbox.dispatch('GET', '/api/unified/phone-notify', {}), {'on': True, 'base': None})
        self.on()
        self.inbox.dispatch('POST', '/api/unified/phone-notify', {'base': 'https://box:8443/messenger/'})
        self.assertEqual(self.inbox.dispatch('GET', '/api/unified/phone-notify', {}),
                         {'on': True, 'base': 'https://box:8443/messenger/'})

    def test_no_agent_capability_reaches_the_route(self):
        import permissions
        for method in ('GET', 'POST'):
            self.assertIsNone(permissions.capability_for(method, '/api/unified/phone-notify'))

    def test_the_switch_is_gone(self):
        from switches import SWITCHES
        self.assertNotIn('phone-notifications', [s['id'] for s in SWITCHES])

if __name__ == '__main__':
    unittest.main()
