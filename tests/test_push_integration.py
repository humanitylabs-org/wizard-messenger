"""Real local HTTP + durable inbox/worker fixtures; never contacts push services."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from web import ViewServer
from unified import UnifiedInbox
from push_notifications.runtime import PushRuntime, OWNER
from push_notifications.tests.test_push import subscription


class PushIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        engine = Mock(); engine.data = Path(self.tmp.name)
        with patch.dict(os.environ, {'UNIFIED_ENABLED': '0', 'MESSENGER_PUSH_ENABLED': '0', 'MESSENGER_PUBLIC_PATH': '/apps/messenger/'}):
            self.server = ViewServer(('127.0.0.1', 0), engine, 'a'*48, ['https://wizard.example'])
        self.inbox = UnifiedInbox(engine.data, engine)
        self.transport = Mock(); self.transport.send.return_value = 201
        with patch.dict(os.environ, {'MESSENGER_PUSH_PUBLIC_KEY': 'fixture-public', 'MESSENGER_PUSH_PRIVATE_KEY': 'fixture-private', 'MESSENGER_PUSH_SUBJECT': 'mailto:fixture@example.com', 'MESSENGER_PUSH_HOSTS': 'fcm.googleapis.com'}):
            self.push = PushRuntime(engine.data, self.inbox, '/apps/messenger/', transport=self.transport)
        self.server.push = self.push
        token, session = self.server.auth.create()
        self.owner = {'Cookie': 'wizard_messenger_session='+token, 'Origin': 'https://wizard.example', 'X-Messenger-CSRF': session['csrf']}
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.inbox.close(); self.inbox.store._conn.close(); self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        h = dict(headers or {})
        if body is not None: body = json.dumps(body); h['Content-Type'] = 'application/json'
        c.request(method, path, body, h); r = c.getresponse(); result = (r.status, dict(r.getheaders()), r.read()); c.close(); return result

    def test_http_owner_csrf_and_scope(self):
        self.server.agent_access.configure({'mode': 'full_access', 'minutes': 60})
        for path in ('/api/view/push', '/api/view/push/subscribe', '/api/view/push/unsubscribe'):
            status, _, _ = self.request('GET' if path.endswith('push') else 'POST', path, {} if not path.endswith('push') else None, {'Authorization': 'Bearer '+'a'*48})
            self.assertEqual(status, 403)
        self.assertEqual(self.request('POST', '/api/view/push/subscribe', {}, {k:v for k,v in self.owner.items() if k != 'X-Messenger-CSRF'})[0], 403)
        self.assertEqual(self.request('POST', '/api/view/push/subscribe', {}, {**self.owner, 'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/view/push')[0], 401)
        self.assertEqual(self.request('POST', '/api/view/push/subscribe', {}, self.owner)[0], 400)
        status, _, raw = self.request('POST', '/api/view/push/subscribe', subscription('https://fcm.googleapis.com/fixture-token'), self.owner)
        self.assertEqual(status, 200); identifier = json.loads(raw)['result']['id']
        self.assertEqual(self.request('POST', '/api/view/push/unsubscribe', {'id': identifier}, self.owner)[0], 200)
        with self.push.store.db() as db: self.assertEqual(db.execute('SELECT revoked FROM subscription').fetchone()[0], 1)
        status, headers, raw = self.request('GET', '/push-service-worker.js')
        self.assertEqual(status, 200); self.assertEqual(headers['Service-Worker-Allowed'], '/apps/messenger/')
        self.assertEqual(headers['Cache-Control'], 'no-store'); self.assertIn(b'const APP_PATH = "/apps/messenger/";', raw)

    def test_durable_new_message_only_and_reconcile_restart(self):
        identity = self.inbox.store.identity('telegram', '!room:fixture', 'Fixture')
        sub = subscription('https://fcm.googleapis.com/fixture-token'); self.push.store.subscribe(OWNER, sub)
        def ingest(identifier, outgoing=False, live=True, **extra):
            self.inbox.store.add_message(identifier, identity, 'fixture', outgoing, 'private body never pushed', 1, push_live=live, **extra)
        ingest('$new'); ingest('$new'); ingest('$self', outgoing=True); ingest('$history', live=False)
        ingest('$new', msgtype='m.image', media={'url':'fixture'})
        with self.inbox.store.db() as db: self.assertEqual(db.execute('SELECT count(*) FROM push_intent').fetchone()[0], 1)
        original = self.push.store.received
        def crash(*args, **kwargs):
            original(*args, **kwargs); raise RuntimeError('crash after durable enqueue')
        with patch.object(self.push.store, 'received', side_effect=crash):
            with self.assertRaises(RuntimeError): self.push.reconcile()
        self.push.reconcile(); self.push.reconcile()
        with self.push.store.db() as db: self.assertEqual(db.execute('SELECT count(*) FROM outbox').fetchone()[0], 1)
        self.assertTrue(self.push.worker.run_once()); self.assertFalse(self.push.worker.run_once())
        self.assertEqual(self.transport.send.call_count, 1)
        self.assertNotIn('private', self.transport.send.call_args.args[1])
        self.push.start(); self.push.close(); self.assertFalse(self.push.thread.is_alive())

    def test_shipping_sync_ingestion_initial_history_echo_edit_replay(self):
        from connector_inbox import ConnectorInbox
        # Exercise both shipping receive implementations, not just the queue helper.
        for cls in (UnifiedInbox, ConnectorInbox):
            receiver = cls(Path(self.tmp.name) / cls.__name__, self.server.engine)
            receiver.store.push_enabled = True
            receiver.owner = '@owner:fixture'
            receiver.learn_me = lambda: None
            receiver.is_me = lambda sender: sender == '@owner:fixture'
            receiver.room_meta = lambda *a: {'telegram': True, 'network':'telegram', 'label':'Fixture', 'kind':'person'}
            def event(identifier, sender='@other:fixture', **content):
                return {'event_id':identifier,'sender':sender,'type':'m.room.message','origin_server_ts':1,'content':{'msgtype':'m.text','body':'fixture',**content}}
            batch = {'next_batch':'first','rooms':{'join':{'!fixture':{'timeline':{'events':[event('$history')]}}}}}
            receiver.mx = lambda *a, **k: batch
            receiver.sync()
            batch['next_batch'] = 'second'
            batch['rooms']['join']['!fixture']['timeline']['events'] = [event('$new'),event('$history'),event('$self','@owner:fixture'),event('$edit', **{'m.relates_to':{'rel_type':'m.replace','event_id':'$new'},'m.new_content':{'msgtype':'m.text','body':'edited'}})]
            receiver.sync(); receiver.sync()
            with receiver.store.db() as db:
                self.assertEqual([r[0] for r in db.execute('SELECT message FROM push_intent')], ['matrix:$new'])
            receiver.close(); receiver.store._conn.close()

    def test_no_subscription_no_send_and_no_historical_delivery_to_new_subscriber(self):
        identity = self.inbox.store.identity('telegram', '!room:fixture', 'Fixture')
        self.inbox.store.add_message('$before-opt-in', identity, 'fixture', False, 'body', 1, push_live=True)
        self.push.store.subscribe(OWNER, subscription('https://fcm.googleapis.com/fixture-token'))
        self.push.reconcile(); self.assertFalse(self.push.worker.run_once()); self.transport.send.assert_not_called()

    def test_marmot_mirror_baseline_self_history_and_live(self):
        identity = self.inbox.store.identity('messenger', 'fixture-group', 'Fixture')
        rows = [{'message_id':'old', 'direction':'received', 'created_at':1000, 'text':'history'}]
        self.inbox.engine.messages.return_value = {'messages': rows}
        self.inbox.import_marmot(identity, live=True)
        rows.extend([{'message_id':'new', 'direction':'received', 'created_at':1001},
                     {'message_id':'self', 'direction':'sent', 'created_at':1002},
                     {'message_id':'unknown', 'created_at':1003},
                     {'message_id':'older', 'direction':'received', 'created_at':999}])
        self.inbox.import_marmot(identity, live=True); self.inbox.import_marmot(identity, live=True)
        with self.inbox.store.db() as db:
            self.assertEqual([r[0] for r in db.execute('SELECT message FROM push_intent')], ['messenger:new'])

    def test_view_server_configured_lifecycle(self):
        with patch.dict(os.environ, {'UNIFIED_ENABLED':'1', 'MESSENGER_PUSH_ENABLED':'1',
                'MESSENGER_PUSH_PUBLIC_KEY':'fixture', 'MESSENGER_PUSH_PRIVATE_KEY':'fixture',
                'MESSENGER_PUSH_SUBJECT':'mailto:fixture@example.com', 'MESSENGER_PUSH_HOSTS':'fcm.googleapis.com'}), patch.object(UnifiedInbox, 'start'):
            server = ViewServer(('127.0.0.1', 0), self.server.engine, 'b'*48, [])
        self.assertTrue(server.push.thread.is_alive())
        server.server_close()
        self.assertFalse(server.push.thread.is_alive())
        server.unified.store._conn.close()

    def test_default_import_is_dormant_without_optional_dependencies(self):
        code = '''import sys, os, tempfile
from pathlib import Path
from unittest.mock import Mock
class Block:
 def find_spec(self, fullname, *args):
  if fullname.startswith(('push_notifications', 'pywebpush', 'cryptography')): raise AssertionError(fullname)
sys.meta_path.insert(0, Block())
from web import ViewServer
with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
 e=Mock(); e.data=Path(root)
 s=ViewServer(('127.0.0.1',0),e,'a'*48,[])
 assert s.push is None
 assert not (Path(root)/'private-push').exists()
 s.server_close()
'''
        env = {**os.environ, 'MESSENGER_PUSH_ENABLED':'0', 'UNIFIED_ENABLED':'0', 'CONNECTORS_ENABLED':'0'}
        subprocess.run([sys.executable, '-c', code], check=True, env=env)
