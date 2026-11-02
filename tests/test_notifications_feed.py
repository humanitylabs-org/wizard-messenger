"""Messenger -> Notifications phone feed: synthetic chats only; the 'Notifications' end is a local stand-in server.

Covers: the feed sent is exactly GET /api/inbox's items; a write the feed doesn't show sends nothing; a new unread
message reaches Notifications at once through the store's change signal (no polling); reading the chat sends the
emptied feed (that is what clears the phone notification); Notifications missing or refusing = quiet backoff, never
an exception in Messenger; the wire format; off switch and ViewServer wiring.
"""
import http.server
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest.mock import Mock, patch

from unified import UnifiedInbox
import inbox_feed
import notifications_feed


def now_ms(offset=0):
    return int(time.time() * 1000) + offset


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.store = self.inbox.store
        self.addCleanup(lambda: self.store._conn and self.store._conn.close())
        self.posts = []
        self.failure = None

    def post(self, url, payload):
        if self.failure:
            raise self.failure
        self.posts.append(payload)
        return 200, {'ok': True}

    def chat(self, address, name):
        ident = self.store.identity('telegram', address, name, 'person')
        self.inbox.rooms[address] = {'telegram': True, 'kind': 'person', 'label': name, 'names': {}}
        return ident


class OnceTests(Fixture):
    def test_sends_the_inbox_feed_once_per_change(self):
        p = notifications_feed.FeedPusher(self.inbox, post=self.post)
        p.once()
        self.assertEqual(self.posts, [{'inbox': 1, 'items': [], 'version': inbox_feed.feed(self.inbox)['version']}])
        p.once()
        self.assertEqual(len(self.posts), 1, 'unchanged feed: nothing sent')
        amy = self.chat('!amy', 'Amy')
        self.store.add_message('$a1', amy, 'Amy', False, 'See you at 5', now_ms())
        p.once()
        self.assertEqual(len(self.posts), 2)
        self.assertEqual(self.posts[-1]['items'], inbox_feed.feed(self.inbox)['items'], 'exactly what GET /api/inbox shows')
        self.assertEqual(self.posts[-1]['items'][0]['title'], 'Amy')
        self.assertTrue(any(a.get('input') for a in self.posts[-1]['items'][0]['actions']), 'Reply travels with it')
        # A message in a muted chat changes the store but not the feed (nor the badge): nothing sent.
        bob = self.chat('!bob', 'Bob')
        self.store.update(bob['person_id'], {'muted': True})
        self.store.add_message('$b1', bob, 'Bob', False, 'spam', now_ms(1))
        p.once()
        self.assertEqual(len(self.posts), 2)
        # Replying from Messenger reads the chat: the feed empties and that goes out too.
        self.store.add_message('$a2', amy, 'me', True, 'ok!', now_ms(2))
        p.once()
        self.assertEqual(self.posts[-1]['items'], [])

    def test_refresh_resends_unchanged_feed_for_a_restarted_notifications(self):
        p = notifications_feed.FeedPusher(self.inbox, post=self.post, refresh=0)
        p.once(); p.once()
        self.assertEqual(len(self.posts), 2)

    def test_missing_or_refusing_notifications_is_quiet(self):
        p = notifications_feed.FeedPusher(self.inbox, post=self.post)
        self.failure = urllib.error.URLError('name does not resolve')
        self.assertIsNone(p.once())
        self.assertEqual((p.last, p.failures), ('unreachable', 1))
        self.failure = urllib.error.HTTPError('u', 403, 'no link', {}, None)
        self.assertIsNone(p.once())
        self.assertEqual((p.last, p.failures), ('refused', 2))
        self.failure = None
        self.assertIsNotNone(p.once())
        self.assertEqual((p.last, p.failures), ('sent', 0))


class RunTests(Fixture):
    def test_new_message_reaches_notifications_at_once_and_reading_clears_it(self):
        got = threading.Event()

        def post(url, payload):
            self.posts.append((time.monotonic(), payload))
            got.set()
            return 200, {'ok': True}

        p = notifications_feed.FeedPusher(self.inbox, post=post, refresh=3600)
        p.start()
        self.addCleanup(self.inbox.close)
        self.assertTrue(got.wait(2)); got.clear()           # the start-up feed (empty)
        amy = self.chat('!amy', 'Amy')
        t0 = time.monotonic()
        self.store.add_message('$a1', amy, 'Amy', False, 'Running late', now_ms())
        self.assertTrue(got.wait(2), 'woken by the store change, not a poll')
        deadline = time.monotonic() + 2
        while not self.posts[-1][1]['items'] and time.monotonic() < deadline:
            time.sleep(0.02)
        sent_at, payload = self.posts[-1]
        self.assertEqual(payload['items'][0]['text'], 'Running late')
        self.assertLess(sent_at - t0, 1.0)
        # Read on any device: the chat leaves the feed, and the empty feed goes out (the phone notification clears).
        got.clear()
        self.store.touch_identity(amy['id'], last_read_ts=now_ms(10))   # what every read path ends in
        self.assertTrue(got.wait(2))
        deadline = time.monotonic() + 2
        while self.posts[-1][1]['items'] and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.posts[-1][1]['items'], [])

    def test_backs_off_while_notifications_is_missing(self):
        calls = []

        def post(url, payload):
            calls.append(time.monotonic())
            raise urllib.error.URLError('no notifications')

        p = notifications_feed.FeedPusher(self.inbox, post=post, backoff=(0.2, 0.4))
        p.start()
        time.sleep(1.0)
        self.inbox.close()
        self.assertGreaterEqual(len(calls), 2)
        self.assertLessEqual(len(calls), 5, 'backs off, never spins')


class WireTests(Fixture):
    def test_posts_json_to_the_notifications_router(self):
        seen = {}

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen['path'] = self.path
                seen['type'] = self.headers.get('Content-Type')
                seen['body'] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                out = b'{"ok": true, "app": "messenger", "events": 1, "route": "chats"}'
                self.send_response(200); self.send_header('Content-Length', str(len(out))); self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        url = 'http://127.0.0.1:%d/notifications/api/app-feed' % srv.server_port
        p = notifications_feed.FeedPusher(self.inbox, url=url)
        self.assertIsNotNone(p.once())
        self.assertEqual(seen['path'], '/notifications/api/app-feed')
        self.assertEqual(seen['type'], 'application/json')
        self.assertEqual(seen['body']['inbox'], 1)
        self.assertEqual(notifications_feed.URL, 'http://notifications:8080/notifications/api/app-feed',
                         'box-local service name only: nothing leaves the box')

    def test_off_switch(self):
        with patch.dict(os.environ, {'MESSENGER_NOTIFICATIONS_FEED': 'off'}):
            self.assertFalse(notifications_feed.enabled())
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('MESSENGER_NOTIFICATIONS_FEED', None)
            self.assertTrue(notifications_feed.enabled())


class ServerWiringTests(unittest.TestCase):
    """ViewServer starts the pusher beside the unified inbox (normal app), and not when switched off."""

    def server(self, extra):
        from web import ViewServer
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        env = {'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0', 'UNIFIED_ENABLED': '1',
               'MESSENGER_REMOTE_AUTHORITY_URL': '', 'MESSENGER_TRUST_WIZARD_OWNER': '0',
               'MESSENGER_NOTIFICATIONS_FEED_URL': 'http://127.0.0.1:9/notifications/api/app-feed', **extra}
        p = patch.dict(os.environ, env); p.start(); self.addCleanup(p.stop)
        engine = Mock(); engine.status.return_value = {'state': 'locked'}; engine.relays = []; engine.data = tmp.name
        with patch('unified.UnifiedInbox.start'):
            srv = ViewServer(('127.0.0.1', 0), engine, 'synthetic-machine-token-' + 'c' * 40, ['https://wizard.example.com'])
        self.addCleanup(srv.server_close)
        return srv

    def test_started_with_the_unified_inbox(self):
        srv = self.server({})
        self.assertIsInstance(srv.notifications_feed, notifications_feed.FeedPusher)
        self.assertIs(srv.notifications_feed.unified, srv.unified)
        self.assertTrue(srv.notifications_feed.thread.daemon)

    def test_off(self):
        self.assertIsNone(self.server({'MESSENGER_NOTIFICATIONS_FEED': 'off'}).notifications_feed)


if __name__ == '__main__':
    unittest.main()
