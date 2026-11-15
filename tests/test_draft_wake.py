"""Messenger wakes the owner's agent when a chat needs a draft (issue 223, switch agent-wake).

Synthetic chats and a local event inbox that checks the signature the way Hermes' generic webhook route does
(X-Webhook-Signature-V2 = hex HMAC-SHA256 of "<timestamp>.<body>"). Nothing here may send.
"""
import hashlib
import hmac
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import test_web as fixtures
from drafts import Drafts
from unified import UnifiedInbox
import draft_wake

NOW = lambda: int(time.time() * 1000)
SECRET = 'wake-secret-0123456789abcdef'


class Inbox:
    """A local stand-in for a Hermes webhook route: 202 for a good signature, 401 otherwise."""

    def __init__(self):
        self.events, self.bad = [], 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                stamp = self.headers.get('X-Webhook-Timestamp', '')
                want = hmac.new(SECRET.encode(), stamp.encode() + b'.' + body, hashlib.sha256).hexdigest()
                fresh = stamp.isdigit() and abs(time.time() - int(stamp)) < 300
                if fresh and hmac.compare_digest(want, self.headers.get('X-Webhook-Signature-V2', '')):
                    outer.events.append(json.loads(body))
                    self.send_response(202)
                else:
                    outer.bad += 1
                    self.send_response(401)
                self.send_header('Content-Length', '0')
                self.end_headers()

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d/webhooks/messenger-drafts' % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class DraftWake(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    tearDown_base = fixtures.ViewBoundary.tearDown
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers

    def setUp(self):
        self.setUp_base()
        self.inbox = UnifiedInbox(self.temp.name, self.server.engine)
        self.server.unified = self.inbox
        self.inbox.mx = Mock(return_value={})
        self.server.drafts = Drafts(self.temp.name)
        self.inbox.store.draft_people = self.server.drafts.waiting_people
        # The same wiring the view server does at start (web.py).
        self.inbox.wake_drafts = lambda: self.server.drafts.dispatch('GET', [], {}, self.inbox, owner=True)['drafts']
        self.inbox.wake_levels = self.server.wake_levels
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Oscar'}, self.owner)
        self.assertEqual(status, 200, data)
        self.agent_id = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.level('draft_only')
        self.events = Inbox()
        self.msg = 0

    def tearDown(self):
        self.events.close()
        waker = getattr(self.inbox, 'waker', None)
        if waker:
            waker.close()
        self.tearDown_base()

    def level(self, level):
        self.assertEqual(self.request('POST', '/api/view/agents/' + self.agent_id, {'level': level}, self.owner)[0], 200)

    def switch(self, on):
        self.inbox.switches.set('agent-wake', on)

    def chat(self, name):
        return self.inbox.store.identity('telegram', '!' + name + ':messenger.internal', name)

    def incoming(self, identity, text, at=None):
        """What ingest does for a live message from someone else."""
        self.msg += 1
        self.inbox.store.add_message('$w%d' % self.msg, identity, '@them', False, text, at if at is not None else NOW())
        self.inbox.draft_wake_incoming(identity['person_id'])

    def mcp(self, name, args=None, method='tools/call'):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if method == 'tools/call':
            body['params'] = {'name': name, 'arguments': args or {}}
        status, _, data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.key})
        self.assertEqual(status, 200, data)
        if method != 'tools/call':
            return data['result']
        return json.loads(data['result']['content'][0]['text']), data['result'].get('isError', False)

    def watch(self, body):
        status, _, data = self.request('POST', '/api/unified/draft-watch', body, self.owner)
        self.assertEqual(status, 200, data)
        return data['result']

    def state(self):
        return self.request('GET', '/api/unified/draft-watch', None, self.owner)[2]['result']

    def fast(self, delay=0.2, max_wait=0.6):
        self.inbox.waker = draft_wake.Waker(self.inbox, delay=delay, max_wait=max_wait)

    def wait_for(self, check, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            if check():
                return True
            time.sleep(0.05)
        return False

    def test_switch_off_means_no_tool_and_no_wake(self):
        names = [t['name'] for t in self.mcp(None, method='tools/list')['tools']]
        self.assertNotIn('messenger_wake_me', names)
        refused, error = self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'feature_off')
        a = self.chat('Anna')
        self.watch({'person_id': a['person_id'], 'on': True})
        self.incoming(a, 'Dinner?')
        self.assertIsNone(getattr(self.inbox, 'waker', None))
        self.assertNotIn('paused', self.state())

    def test_a_new_message_in_a_drafts_on_chat_wakes_the_agent_once_with_only_the_chat_id(self):
        self.switch(True)
        self.assertIn('messenger_wake_me', [t['name'] for t in self.mcp(None, method='tools/list')['tools']])
        made, error = self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        self.assertFalse(error, made)
        self.assertTrue(made['woken'])
        self.assertNotIn('secret', json.dumps(made))
        a, b = self.chat('Anna'), self.chat('Ben')
        self.watch({'person_id': a['person_id'], 'on': True})
        self.fast()
        # A burst of three messages is one wake; an unwatched chat is never one.
        for text in ('Dinner tonight?', 'At 8?', 'The usual place'):
            self.incoming(a, text)
        self.incoming(b, 'Not watched')
        self.assertTrue(self.wait_for(lambda: self.events.events), 'no wake arrived')
        time.sleep(0.5)
        self.assertEqual(len(self.events.events), 1, self.events.events)
        event = self.events.events[0]
        self.assertEqual(set(event), {'event', 'chat_id', 'reason', 'at'})
        self.assertEqual((event['event'], event['chat_id'], event['reason']), ('messenger.draft_needed', a['person_id'], 'watched'))
        self.assertNotIn('Dinner', json.dumps(event))
        self.assertEqual(self.events.bad, 0)
        self.assertEqual(self.state()['paused'], {})
        checked, _ = self.mcp('messenger_wake_me', {'check': True})
        self.assertTrue(checked['woken'])
        self.assertIsNotNone(checked['wake']['last_wake'])
        # The woken agent then does what it does today, and the chat no longer needs a wake.
        needing, _ = self.mcp('messenger_chats_needing_draft')
        self.assertEqual([c['id'] for c in needing['chats']], [a['person_id']])
        self.assertFalse(self.mcp('messenger_create_draft', {'chat_id': a['person_id'], 'text': 'Sure, 8 works'})[1])
        self.assertEqual(self.inbox.waker.wake(a['person_id']), 0)
        self.assertEqual(len(self.events.events), 1)
        self.inbox.mx.assert_not_called()

    def test_every_unread_chat_and_turning_the_toggle_off_stops_wakes(self):
        self.switch(True)
        self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        a = self.chat('Anna')
        self.fast()
        self.watch({'all_unread': True})
        self.incoming(a, 'Hi')
        self.assertTrue(self.wait_for(lambda: self.events.events))
        self.assertEqual(self.events.events[0]['reason'], 'unread')
        self.watch({'all_unread': False})
        self.incoming(a, 'Hello again')
        time.sleep(0.6)
        self.assertEqual(len(self.events.events), 1)

    def test_a_discard_sticks_until_the_next_incoming_message(self):
        self.switch(True)
        self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        a = self.chat('Anna')
        self.watch({'person_id': a['person_id'], 'on': True})
        self.incoming(a, 'Dinner?', at=NOW() - 5000)
        waker = draft_wake.Waker(self.inbox)
        self.assertEqual(waker.wake(a['person_id']), 1)
        draft = self.mcp('messenger_create_draft', {'chat_id': a['person_id'], 'text': 'Sure'})[0]['draft']
        row = self.server.drafts.get(draft['id'])
        self.server.drafts.dispatch('DELETE', [draft['id']], {'revision': row['revision'], 'outcome': 'discarded'}, self.inbox, owner=True)
        self.assertEqual(waker.wake(a['person_id']), 0)
        time.sleep(0.01)
        self.incoming(a, 'Or tomorrow?', at=NOW() + 1000)
        self.assertEqual(waker.wake(a['person_id']), 1)
        self.assertEqual(len(self.events.events), 2)

    def test_only_draft_access_agents_are_woken_and_otherwise_the_chat_is_paused(self):
        self.switch(True)
        self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        a = self.chat('Anna')
        self.watch({'person_id': a['person_id'], 'on': True})
        self.incoming(a, 'Dinner?')
        waker = draft_wake.Waker(self.inbox)
        # Turning the agent down to Read-only stops its wakes at once, and it can no longer ask to be woken.
        self.level('read_only')
        self.assertEqual(waker.wake(a['person_id']), 0)
        self.assertEqual(self.events.events, [])
        self.assertEqual(self.state()['paused'], {a['person_id']: draft_wake.PAUSED_TEXT['no_agent']})
        refused, error = self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'agent_permission_denied')
        # Back to Draft-only: the next wake gets through and the paused line goes.
        self.level('draft_only')
        self.assertEqual(waker.wake(a['person_id']), 1)
        self.assertEqual(self.state()['paused'], {})
        # An inbox that can't be reached pauses the chat too.
        self.assertFalse(self.mcp('messenger_wake_me', {'url': 'http://127.0.0.1:9/nowhere', 'secret': SECRET})[1])
        self.assertEqual(waker.wake(a['person_id']), 0)
        self.assertEqual(self.state()['paused'], {a['person_id']: draft_wake.PAUSED_TEXT['unreachable']})
        self.assertEqual(self.mcp('messenger_wake_me', {'check': True})[0]['wake']['last_error'], 'unreachable')
        # Unwatching the chat hides its paused line.
        self.watch({'person_id': a['person_id'], 'on': False})
        self.assertEqual(self.state()['paused'], {})
        # off stops the wakes.
        self.assertEqual(self.mcp('messenger_wake_me', {'off': True})[0]['woken'], False)
        self.assertEqual(self.mcp('messenger_wake_me', {'check': True})[0]['woken'], False)

    def test_bad_urls_and_secrets_are_refused(self):
        self.switch(True)
        for args in ({'url': 'file:///etc/passwd', 'secret': SECRET}, {'url': 'http://user:pw@host/x', 'secret': SECRET},
                     {'url': self.events.url, 'secret': 'short'}, {'url': self.events.url}):
            result, error = self.mcp('messenger_wake_me', args)
            self.assertTrue(error, args)
            self.assertIn(result['error']['code'], ('invalid_url', 'invalid_secret'))

    def test_a_chat_that_never_goes_quiet_is_still_woken(self):
        self.switch(True)
        self.mcp('messenger_wake_me', {'url': self.events.url, 'secret': SECRET})
        a = self.chat('Anna')
        self.watch({'person_id': a['person_id'], 'on': True})
        self.fast(delay=0.4, max_wait=0.8)
        start = time.time()
        while time.time() - start < 1.2 and not self.events.events:
            self.incoming(a, 'more')
            time.sleep(0.1)
        self.assertTrue(self.events.events, 'max wait did not fire')


if __name__ == '__main__':
    unittest.main()
