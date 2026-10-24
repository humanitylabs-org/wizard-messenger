"""Local SQLite and real HTTP boundary behavior; no provider/account evidence."""
import tempfile
import unittest
from unittest.mock import Mock
from urllib.parse import urlencode
from pathlib import Path
from engine import EngineError
from unified import UnifiedInbox, PeopleStore
from test_agent_permissions import HTTPFixture


class HistorySearch(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.inbox = UnifiedInbox(tmp.name, Mock())
        self.store = self.inbox.store
        self.addCleanup(self.store._conn.close)
        self.addCleanup(self.inbox.close)
        self.a = self.store.identity('telegram', '!one', 'Alice')
        self.b = self.store.identity('messenger', 'other', 'Other')

    def ids(self, query, **scope):
        return [m['message_id'] for m in self.store.search(query, **scope)['messages']]

    def test_shipping_js_paging_and_search_contracts(self):
        import subprocess
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(['node', '--test', 'tests/test_history_search_view.cjs'], cwd=root,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout)

    def test_history_pages_all_ties_merged_networks_and_bound_cursors(self):
        pid = self.a['person_id']
        self.store.merge(pid, self.b['person_id'])
        expected = []
        for n in range(131):
            mid = '$%03d' % n; expected.append(mid)
            self.store.add_message(mid, self.a if n % 2 else self.b, 'sender', False, 'needle', 100)
        seen, cursor = [], None
        while True:
            page = self.inbox.dispatch('GET', '/api/unified/people/' + pid, {},
                {'limit': ['17'], **({'cursor': [cursor]} if cursor else {})})
            seen = [m['id'] for m in page['messages']] + seen
            cursor = page['next_cursor']
            if not page['has_more']: break
        self.assertEqual(seen, expected)
        other = self.store.identity('telegram', '!unrelated', 'Unrelated')
        cursor = self.inbox.timeline(pid, limit=1)['next_cursor']
        for bad in ('!', cursor):
            with self.assertRaises(EngineError):
                self.inbox.timeline(other['person_id'], before=bad, limit=1)

    def test_search_ingest_edit_translation_redaction_forget_reconcile(self):
        event = {'type': 'm.room.message', 'event_id': '$one', 'sender': '@peer:x',
                 'origin_server_ts': 100, 'content': {'msgtype': 'm.text', 'body': 'original needle'}}
        self.inbox.ingest(self.a, {}, event)
        self.assertEqual(self.ids('needle'), ['$one'])
        edit = {**event, 'event_id': '$edit', 'content': {'m.relates_to': {'rel_type': 'm.replace', 'event_id': '$one'},
                   'm.new_content': {'msgtype': 'm.text', 'body': 'replacement phrase'}}}
        self.inbox.ingest(self.b, {}, edit)  # foreign thread cannot edit
        self.assertEqual(self.ids('needle'), ['$one'])
        self.inbox.ingest(self.a, {}, edit)
        self.assertEqual(self.ids('needle'), [])
        self.assertEqual(self.ids('replacement'), ['$one'])
        self.store.bump('$one', ',translated=?', ('translated words',))
        self.assertEqual(self.ids('translated'), ['$one'])
        redaction = {'type': 'm.room.redaction', 'redacts': '$one'}
        self.inbox.ingest(self.b, {}, redaction)
        self.assertEqual(self.ids('replacement'), ['$one'])
        self.inbox.ingest(self.a, {}, redaction)
        self.assertEqual(self.ids('replacement'), [])
        self.inbox.ingest(self.a, {}, event)
        self.assertEqual(self.ids('needle'), [])
        self.inbox.ingest(self.a, {}, {'type': 'm.room.redaction', 'redacts': '$late'})
        self.inbox.ingest(self.a, {}, {**event, 'event_id': '$late'})
        self.assertEqual(self.ids('needle'), [])
        self.store.add_message('$two', self.b, 'peer', False, 'needle', 100)
        self.store.search_index.upsert(account='owner', network='telegram', thread='stale', message_id='ghost', timestamp=1, original='needle')
        self.store.rebuild_search()
        self.assertEqual(self.ids('needle'), ['$two'])
        self.store.forget(self.b['network'], self.b['address'])
        self.assertEqual(self.ids('needle'), [])
        again = PeopleStore(self.store.path)
        self.addCleanup(again._conn.close)
        self.assertEqual(again.search('needle')['messages'], [])

    def test_scoped_early_redaction_does_not_poison_other_threads(self):
        self.inbox.ingest(self.a, {}, {'type':'m.room.redaction', 'redacts':'$future'})
        event = {'type':'m.room.message', 'event_id':'$future', 'sender':'@peer:x',
                 'origin_server_ts':100, 'content':{'msgtype':'m.text', 'body':'needle'}}
        self.inbox.ingest(self.b, {}, event)
        self.assertEqual(self.ids('needle'), ['$future'])
        reaction = {'type':'m.reaction', 'event_id':'$reaction', 'sender':'@peer:x',
                    'content':{'m.relates_to':{'rel_type':'m.annotation', 'event_id':'$future', 'key':'OK'}}}
        self.inbox.ingest(self.a, {}, reaction)
        self.assertEqual(self.store.messages(self.b['person_id'])[0]['reactions'], [])
        self.inbox.ingest(self.b, {}, reaction)
        self.inbox.ingest(self.a, {}, {'type':'m.room.redaction', 'redacts':'$reaction'})
        self.assertEqual(len(self.store.messages(self.b['person_id'])[0]['reactions']), 1)
        self.inbox.ingest(self.b, {}, {'type':'m.room.redaction', 'redacts':'$reaction'})
        self.assertEqual(self.store.messages(self.b['person_id'])[0]['reactions'], [])
        self.inbox.ingest(self.b, {}, reaction)
        self.assertEqual(self.store.messages(self.b['person_id'])[0]['reactions'], [])

    def test_search_rebuild_and_edits_keep_paging_positions(self):
        for mid in ('z', 'a', 'x', 'b'):
            self.store.add_message(mid, self.a, 'peer', False, 'needle', 100)
        first = self.store.search('needle', limit=2)
        self.store.bump('z', ',original=?', ('edited needle',))
        again = PeopleStore(self.store.path)
        self.addCleanup(again._conn.close)
        second = again.search('needle', limit=2, cursor=first['next_cursor'])
        ids = [m['message_id'] for m in first['messages'] + second['messages']]
        self.assertEqual(len(ids), 4); self.assertEqual(set(ids), {'z','a','x','b'})

    def test_search_scope_cursor_validation_atomic_rollback_and_account_isolation(self):
        for mid, identity in (('$a', self.a), ('$b', self.b), ('$c', self.a)):
            self.store.add_message(mid, identity, 'peer', False, 'needle', 100)
        self.assertEqual(set(self.ids('needle', network='telegram')), {'$a', '$c'})
        self.assertEqual(self.ids('needle', thread=self.b['id']), ['$b'])
        page = self.store.search('needle', network='telegram', limit=1)
        self.assertTrue(page['has_more'])
        cursor = page['next_cursor']
        self.assertEqual(len(self.store.search('needle', network='telegram', limit=1, cursor=cursor)['messages']), 1)
        with self.assertRaises(ValueError): self.store.search('different', network='telegram', cursor=cursor)
        with self.assertRaises(ValueError): self.store.search('needle', network='messenger', cursor=cursor)
        with self.assertRaises(EngineError): self.store.search('needle', network='messenger', thread=self.a['id'])
        with self.assertRaises(RuntimeError):
            with self.store.db() as db:
                db.execute('BEGIN')
                self.store.bump('$a', ',original=?', ('rolledback',))
                raise RuntimeError('rollback')
        self.assertEqual(self.ids('rolledback'), [])
        self.assertIn('$a', self.ids('needle'))
        self.store.search_index.upsert(account='other-owner', network='telegram', thread=self.a['id'], message_id='private', timestamp=1, original='needle')
        self.assertNotIn('private', self.ids('needle'))
        for query in ({'q':['needle'], 'account':['other-owner']}, {'q':['needle'], 'limit':['101']}, {'q':['needle'], 'cursor':['!']}, {'q':['needle','other']}):
            with self.assertRaises(EngineError): self.inbox.dispatch('GET','/api/unified/search',{},query)


class SearchHTTP(HTTPFixture):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.server.unified = UnifiedInbox(self.tmp.name, self.server.engine)
        self.addCleanup(self.server.unified.store._conn.close)
        a = self.server.unified.store.identity('telegram', '!one', 'Alice')
        for n in range(3): self.server.unified.store.add_message('$' + str(n), a, 'peer', False, 'historic needle', 100)
        self.pid = a['person_id']

    def test_real_authenticated_http_search_and_history_validation(self):
        path = '/api/unified/search?q=historic&limit=1'
        self.assertEqual(self.request('GET', path)[0], 401)
        self.assertEqual(self.request('GET', path, headers=self.bearer)[0], 403)
        owner = self.owner_headers()
        status, _, data = self.request('GET', path, headers=owner)
        self.assertEqual(status, 200, data)
        result = data['result']; self.assertTrue(result['has_more'])
        self.assertEqual(result['messages'][0]['display_name'], 'Alice')
        status, _, data = self.request('GET', path + '&' + urlencode({'cursor':result['next_cursor']}), headers=owner)
        self.assertEqual(status, 200, data)
        self.assertNotEqual(data['result']['messages'][0]['message_id'], result['messages'][0]['message_id'])
        for suffix in ('&account=other', '&cursor=!', '&limit=500'):
            self.assertEqual(self.request('GET', path + suffix, headers=owner)[0], 400)
        path = '/api/unified/people/' + self.pid + '?limit=2'
        first = self.request('GET',path,headers=owner)[2]['result']
        second = self.request('GET',path + '&' + urlencode({'cursor': first['next_cursor']}),headers=owner)[2]['result']
        self.assertEqual(len(first['messages']) + len(second['messages']), 3)
        self.assertFalse(second['has_more']); self.assertIsNone(second['next_cursor'])


if __name__ == '__main__': unittest.main()
