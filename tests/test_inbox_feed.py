"""Wizard OS inbox feed: synthetic chats only (no real contacts, nothing leaves the process)."""
import http.client
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from engine import EngineError
from unified import UnifiedInbox
import inbox_feed
from trusted_owner import HEADER, sign_request
from web import ViewServer

ORIGIN = 'https://wizard.example.com'
TOKEN = 'synthetic-machine-token-' + 'b' * 40


def now_ms(offset=0):
    return int(time.time() * 1000) + offset


class FeedFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.engine = Mock()
        self.engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, self.engine)
        self.inbox.matrix_token = lambda: 'x'
        self.inbox.mx = Mock(return_value={'event_id': '$sent'})
        self.store = self.inbox.store
        self.addCleanup(lambda: self.store._conn and self.store._conn.close())

    def chat(self, address, name, kind='person'):
        ident = self.store.identity('telegram', address, name, kind)
        self.inbox.rooms[address] = {'telegram': True, 'kind': kind, 'label': name, 'names': {}}
        return ident

    def badge(self):
        """The app badge (static/unified.js syncBadge): unread chats, never muted, Medium or Low priority."""
        rows = self.store.people('person') + self.store.people('group')
        return len({p['id'] for p in rows if p.get('unread', 0) > 0 and not p['muted'] and not p['low_priority'] and not p['medium_priority']})


class FeedTests(FeedFixture):
    def test_medium_priority_is_not_in_the_feed_or_badge(self):
        amy, news = self.chat('!amy', 'Amy'), self.chat('!news', 'News', 'group')
        t = now_ms()
        self.store.add_message('$a1', amy, 'Amy', False, 'hi', t - 1000)
        self.store.add_message('$n1', news, 'News', False, 'headline', t)
        self.store.update(news['person_id'], {'medium_priority': True})
        feed = inbox_feed.items(self.store)
        self.assertEqual([i['title'] for i in feed['items']], ['Amy'])
        self.assertEqual(len(feed['items']), self.badge())
        self.store.update(news['person_id'], {'medium_priority': False})
        self.assertEqual(len(inbox_feed.items(self.store)['items']), 2)

    def test_one_item_per_unread_chat_matching_the_badge(self):
        amy, bob, team, quiet, low, done = (self.chat('!amy', 'Amy'), self.chat('!bob', 'Bob'), self.chat('!team', 'Team', 'group'),
                                            self.chat('!quiet', 'Quiet'), self.chat('!low', 'Shop'), self.chat('!done', 'Done'))
        t = now_ms()
        self.store.add_message('$a1', amy, 'Amy', False, 'first', t - 3000)
        self.store.add_message('$a2', amy, 'Amy', False, 'second', t - 2000)
        self.store.add_message('$a3', amy, 'Amy', False, 'see [the doc](https://ex.com/x)', t - 1000)
        self.store.add_message('$b1', bob, 'Bob', False, 'hi', t - 5000)
        self.store.add_message('$t1', team, 'Carol', False, '', t - 4000, msgtype='m.image')
        self.store.add_message('$q1', quiet, 'Q', False, 'shh', t)
        self.store.add_message('$l1', low, 'Shop', False, 'sale', t)
        self.store.add_message('$d1', done, 'D', False, 'old', t - 9000)
        self.store.add_message('$d2', done, 'me', True, 'answered', t - 8000)
        self.store.update(quiet['person_id'], {'muted': True})
        self.store.update(low['person_id'], {'low_priority': True})
        self.inbox.read(done['person_id'], {'timestamp': t})
        feed = inbox_feed.items(self.store)
        self.assertEqual(feed['inbox'], 1)
        self.assertEqual([i['title'] for i in feed['items']], ['Amy', 'Team', 'Bob'])
        self.assertEqual(len(feed['items']), self.badge())
        amy_item = feed['items'][0]
        self.assertEqual(amy_item['key'], 'chat:' + amy['person_id'])
        self.assertEqual(amy_item['text'], '3 new · see the doc')
        self.assertEqual(amy_item['time'], (t - 1000) // 1000)
        self.assertEqual(amy_item['priority'], 3)
        self.assertEqual(amy_item['open'], '#chat=' + amy['person_id'])
        self.assertEqual([a['id'] for a in amy_item['actions']], ['reply', 'draft', 'read'])
        self.assertTrue(amy_item['actions'][0]['input'])
        self.assertIn('Do not send', amy_item['actions'][1]['ask'])
        self.assertEqual(feed['items'][1]['text'], 'Carol: 📷 Photo')
        self.assertEqual(feed['items'][2]['text'], 'hi')
        json.dumps(feed)  # plain JSON data only

    def test_reading_anywhere_drops_the_item(self):
        amy = self.chat('!amy', 'Amy')
        t = now_ms()
        self.store.add_message('$a1', amy, 'Amy', False, 'hello', t)
        self.assertEqual(len(inbox_feed.items(self.store)['items']), 1)
        # Same route the open chat calls (markRead -> people/<id>/read).
        self.inbox.dispatch('POST', '/api/unified/people/%s/read' % amy['person_id'], {'timestamp': t})
        self.assertEqual(inbox_feed.items(self.store)['items'], [])
        self.store.add_message('$a2', amy, 'Amy', False, 'again', t + 10)
        self.assertEqual(inbox_feed.items(self.store)['items'][0]['text'], 'again')


class WaitTests(FeedFixture):
    """The shell's change signal: GET api/inbox/wait?v=<version> returns as soon as the feed changes."""

    def waiter(self, version, hold=5):
        out = {}
        def run():
            t = time.monotonic()
            out['result'] = inbox_feed.wait(self.inbox, version, hold)
            out['took'] = time.monotonic() - t
        th = threading.Thread(target=run, daemon=True); th.start()
        time.sleep(0.2)  # parked on the condition
        return th, out

    def test_feed_carries_version_and_watch(self):
        f = inbox_feed.feed(self.inbox)
        self.assertEqual((f['inbox'], f['items'], f['watch']), (1, [], 'api/inbox/wait'))
        self.assertIsInstance(f['version'], str)
        self.assertIs(inbox_feed.feed(self.inbox), f)  # cached while nothing was written

    def test_stale_version_answers_at_once(self):
        r = inbox_feed.wait(self.inbox, 'old', 5)
        self.assertTrue(r['changed']); self.assertEqual(r['items'], [])

    def test_wakes_on_a_new_incoming_message(self):
        amy = self.chat('!amy', 'Amy')
        v = inbox_feed.feed(self.inbox)['version']
        th, out = self.waiter(v)
        with patch.object(self.store, 'db', wraps=self.store.db) as db:
            time.sleep(0.3)
            self.assertEqual(db.call_count, 0)  # no DB work while it waits
        self.store.add_message('$a1', amy, 'Amy', False, 'hello', now_ms())
        th.join(3)
        r = out['result']
        self.assertTrue(r['changed']); self.assertLess(out['took'], 1.5)
        self.assertEqual([i['title'] for i in r['items']], ['Amy'])
        self.assertNotEqual(r['version'], v)
        self.assertEqual(self.inbox.inbox_waiters, 0)

    def test_wakes_when_the_chat_is_read(self):
        amy = self.chat('!amy', 'Amy'); t = now_ms()
        self.store.add_message('$a1', amy, 'Amy', False, 'hello', t)
        v = inbox_feed.feed(self.inbox)['version']
        th, out = self.waiter(v)
        self.inbox.dispatch('POST', '/api/unified/people/%s/read' % amy['person_id'], {'timestamp': t})
        th.join(3)
        self.assertTrue(out['result']['changed']); self.assertEqual(out['result']['items'], [])

    def test_ignores_writes_the_feed_does_not_show_and_times_out_cleanly(self):
        amy = self.chat('!amy', 'Amy'); quiet = self.chat('!quiet', 'Quiet')
        self.store.update(quiet['person_id'], {'muted': True})
        v = inbox_feed.feed(self.inbox)['version']
        th, out = self.waiter(v, hold=1.2)
        self.store.add_message('$o1', amy, 'me', True, 'outgoing', now_ms())   # own message
        self.store.add_message('$q1', quiet, 'Q', False, 'muted', now_ms())     # muted chat
        th.join(4)
        r = out['result']
        self.assertEqual(r, {'inbox': 1, 'changed': False, 'version': v, 'watch': 'api/inbox/wait'})
        self.assertGreaterEqual(out['took'], 1.1); self.assertLess(out['took'], 2.0)
        self.assertEqual(self.inbox.inbox_waiters, 0)

    def test_stop_ends_waits_and_too_many_waiters_get_429(self):
        v = inbox_feed.feed(self.inbox)['version']
        threads = [self.waiter(v, hold=10) for _ in range(inbox_feed.WAITERS_MAX)]
        with self.assertRaises(EngineError) as err:
            inbox_feed.wait(self.inbox, v, 10)
        self.assertEqual(err.exception.status, 429)
        self.inbox.stop.set(); self.inbox.notify()
        for th, out in threads:
            th.join(3); self.assertFalse(out['result']['changed'])
        self.assertEqual(self.inbox.inbox_waiters, 0)
        with self.assertRaises(EngineError):
            inbox_feed.wait(self.inbox, v, 'soon')
        with self.assertRaises(EngineError):
            inbox_feed.wait(self.inbox, 'x' * 65, 1)


class ActTests(FeedFixture):
    def setUp(self):
        super().setUp()
        self.amy = self.chat('!amy', 'Amy')
        self.t = now_ms()
        self.store.add_message('$a1', self.amy, 'Amy', False, 'hello', self.t - 1000)
        self.store.add_message('$a2', self.amy, 'Amy', False, 'there?', self.t)
        self.key = 'chat:' + self.amy['person_id']

    def test_read_marks_the_chat_read_like_opening_it(self):
        self.assertEqual(inbox_feed.act(self.inbox, {'key': self.key, 'action': 'read'}), {'ok': True})
        self.assertEqual(inbox_feed.items(self.store)['items'], [])
        self.assertEqual(self.badge(), 0)
        self.assertEqual(self.store.person(self.amy['person_id'])['identities'][0]['last_read_ts'], self.t)

    def test_reply_uses_the_view_send_route_and_marks_read(self):
        calls = []
        real = self.inbox.dispatch
        self.inbox.dispatch = lambda m, p, b, *a: (calls.append((m, p, dict(b))), real(m, p, b, *a))[1]
        result = inbox_feed.act(self.inbox, {'key': self.key, 'action': 'reply', 'text': '  On my way  '})
        self.assertEqual(result['ok'], True)
        self.assertEqual(result['state'], 'sent')
        send = calls[0]
        self.assertEqual(send[:2], ('POST', '/api/unified/people/%s/send' % self.amy['person_id']))
        self.assertEqual(send[2]['text'], 'On my way')
        self.assertEqual(calls[1][:2], ('POST', '/api/unified/people/%s/read' % self.amy['person_id']))
        self.assertEqual(self.inbox.mx.call_args_list[0].args[2]['body'], 'On my way')
        self.assertEqual(inbox_feed.items(self.store)['items'], [])
        # A retried tap for the same unread state never sends a second message.
        sends = sum('/send/' in c.args[0] for c in self.inbox.mx.call_args_list)
        inbox_feed.act(self.inbox, {'key': self.key, 'action': 'reply', 'text': 'On my way'})
        self.assertEqual(sum('/send/' in c.args[0] for c in self.inbox.mx.call_args_list), sends)

    def test_rejects_everything_else(self):
        bad = [{'key': self.key, 'action': 'draft'}, {'key': self.key, 'action': 'done'}, {'key': self.key},
               {'key': self.key, 'action': 'reply'}, {'key': self.key, 'action': 'reply', 'text': '   '},
               {'key': self.key, 'action': 'reply', 'text': 7}, {'key': 'room:x', 'action': 'read'},
               {'key': 'chat:../x', 'action': 'read'}, {'action': 'read'},
               {'key': self.key, 'action': 'read', 'extra': 1}]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(EngineError) as err:
                inbox_feed.act(self.inbox, body)
            self.assertEqual(err.exception.status, 400)
        with self.assertRaises(EngineError) as err:
            inbox_feed.act(self.inbox, {'key': 'chat:' + 'f' * 24, 'action': 'read'})
        self.assertEqual(err.exception.status, 404)
        self.inbox.mx.assert_not_called()
        self.assertEqual(len(inbox_feed.items(self.store)['items']), 1)


class FeedHTTP(unittest.TestCase):
    """Route boundary on a trusted-owner install (Miguel's box) and a passphrase install."""
    trusted = True

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.data = self.root / 'data'; self.data.mkdir()
        self.proof = secrets.token_bytes(32)
        for name, key in [('proof', self.proof), ('wrap', secrets.token_bytes(32))]:
            path = self.root / name; path.write_bytes(key); path.chmod(0o600)
        env = {'MESSENGER_REMOTE_REQUIRED': '0', 'CONNECTORS_ENABLED': '0', 'UNIFIED_ENABLED': '0',
               'MESSENGER_REMOTE_AUTHORITY_URL': '', 'MESSENGER_TRUST_WIZARD_OWNER': '1' if self.trusted else '0',
               'MESSENGER_OWNER_PROOF_KEY_FILE': str(self.root / 'proof'),
               'MESSENGER_OWNER_WRAP_KEY_FILE': str(self.root / 'wrap')}
        self.env = patch.dict(os.environ, env); self.env.start()
        engine = Mock(); engine.status.return_value = {'state': 'ready'}; engine.relays = []; engine.data = self.data
        self.server = ViewServer(('127.0.0.1', 0), engine, TOKEN, [ORIGIN])
        self.server.unified = self.unified = Mock()
        self.unified.store = Mock()
        self.unified.store.seq = 1
        self.feed = patch('inbox_feed.items', side_effect=lambda store: {'inbox': 1, 'items': []}); self.items = self.feed.start()
        self.waitp = patch('inbox_feed.wait', return_value={'inbox': 1, 'changed': False, 'version': 'v1', 'watch': 'api/inbox/wait'}); self.waitf = self.waitp.start()
        self.actp = patch('inbox_feed.act', return_value={'ok': True}); self.act = self.actp.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.feed.stop(); self.actp.stop(); self.waitp.stop(); self.env.stop(); self.temp.cleanup()

    def request(self, method, target, body=None, *, proof=True, headers=None, raw=None, ctype='application/json'):
        h = dict(headers or {})
        if proof: h[HEADER] = sign_request(self.proof, method, target)
        data = raw if raw is not None else (json.dumps(body) if body is not None else None)
        if data is not None: h['Content-Type'] = ctype
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        c.request(method, target, data, h)
        r = c.getresponse(); out = (r.status, r.getheader('Content-Type'), json.loads(r.read())); c.close()
        return out

    def owner(self):
        token, session = self.server.auth.create()
        return {'Cookie': 'wizard_messenger_session=' + token, 'Origin': ORIGIN, 'X-Messenger-CSRF': session['csrf']}

    def test_get_feed(self):
        status, ctype, body = self.request('GET', '/api/inbox')
        self.assertEqual((status, body['inbox'], body['items'], body['watch']), (200, 1, [], 'api/inbox/wait'))
        self.assertEqual(body['version'], inbox_feed.version([]))
        self.assertTrue(ctype.startswith('application/json'))
        self.items.assert_called_once_with(self.unified.store)

    def test_wait_route(self):
        status, _, body = self.request('GET', '/api/inbox/wait?v=v1&hold=3')
        self.assertEqual((status, body['changed']), (200, False))
        self.waitf.assert_called_once_with(self.unified, 'v1', '3')
        self.assertEqual(self.request('GET', '/api/inbox/wait?v=v1', proof=False)[0], 403 if self.trusted else 401)
        self.assertEqual(self.request('POST', '/api/inbox/wait', {}, headers={'Origin': ORIGIN})[0], 405)

    def test_owner_proof_required_and_bearers_refused(self):
        status, _, body = self.request('GET', '/api/inbox', proof=False)
        self.assertEqual(status, 403); self.assertIsInstance(body['error'], str)
        status, _, _ = self.request('GET', '/api/inbox', headers={'Authorization': 'Bearer ' + TOKEN})
        self.assertEqual(status, 403)
        self.items.assert_not_called()

    def test_act_needs_json_origin_and_bounded_body(self):
        ok = {'key': 'chat:abc', 'action': 'read'}
        status, _, body = self.request('POST', '/api/inbox/act', ok, headers={'Origin': ORIGIN})
        self.assertEqual((status, body), (200, {'ok': True}))
        self.act.assert_called_once_with(self.unified, ok)
        self.act.reset_mock()
        self.assertEqual(self.request('POST', '/api/inbox/act', raw=json.dumps(ok), ctype='text/plain', headers={'Origin': ORIGIN})[0], 415)
        self.assertEqual(self.request('POST', '/api/inbox/act', ok)[0], 403)  # no Origin
        self.assertEqual(self.request('POST', '/api/inbox/act', ok, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('POST', '/api/inbox/act', ok, headers={'Origin': ORIGIN, 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.request('POST', '/api/inbox/act', raw='{"key":"' + 'x' * 70000 + '"}', headers={'Origin': ORIGIN})[0], 413)
        self.assertEqual(self.request('POST', '/api/inbox/act', raw='[]', headers={'Origin': ORIGIN})[0], 400)
        self.assertEqual(self.request('GET', '/api/inbox/act')[0], 405)
        self.act.assert_not_called()

    def test_act_errors_use_the_contract_shape(self):
        self.act.side_effect = EngineError('unsupported_action', 'That action is not available here', 400)
        status, _, body = self.request('POST', '/api/inbox/act', {'key': 'chat:abc', 'action': 'x'}, headers={'Origin': ORIGIN})
        self.assertEqual((status, body['error'], body['code']), (400, 'That action is not available here', 'unsupported_action'))


class FeedHTTPPassphrase(FeedHTTP):
    """Without the trusted Wizard ingress the feed needs the owner's view session (and CSRF to act)."""
    trusted = False

    def request(self, method, target, body=None, *, proof=True, headers=None, raw=None, ctype='application/json'):
        h = dict(headers or {})
        if proof:
            o = self.owner(); o.update(h); h = o
        return super().request(method, target, body, proof=False, headers=h, raw=raw, ctype=ctype)

    def test_owner_proof_required_and_bearers_refused(self):
        status, _, _ = FeedHTTP.request(self, 'GET', '/api/inbox', proof=False)
        self.assertEqual(status, 401)
        status, _, _ = self.request('GET', '/api/inbox', headers={'Authorization': 'Bearer ' + TOKEN})
        self.assertEqual(status, 403)
        status, _, _ = self.request('POST', '/api/inbox/act', {'key': 'chat:a', 'action': 'read'}, headers={'X-Messenger-CSRF': 'wrong'})
        self.assertEqual(status, 403)
        self.items.assert_not_called(); self.act.assert_not_called()

    def test_act_needs_json_origin_and_bounded_body(self):
        ok = {'key': 'chat:abc', 'action': 'read'}
        self.assertEqual(self.request('POST', '/api/inbox/act', ok)[0], 200)
        self.assertEqual(self.request('POST', '/api/inbox/act', raw=json.dumps(ok), ctype='text/plain')[0], 415)
        self.assertEqual(self.request('POST', '/api/inbox/act', ok, headers={'Origin': 'https://evil.example'})[0], 403)


if __name__ == '__main__':
    unittest.main()
