import base64
import json
from pathlib import Path
import tempfile
import unittest
from typing import Any
from readiness.search import SearchStore


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'search.db'
        self.store = SearchStore(self.path)
        self.addCleanup(lambda: self.store.close())

    def put(self, mid='one', **kw):
        fields: dict[str, Any] = dict(account='owner', network='telegram', thread='a', message_id=mid,
                      timestamp=100, original='café meeting 東京', translated='')
        fields.update(kw)
        self.store.upsert(**fields)

    def search(self, **kw):
        args: dict[str, Any] = dict(account='owner', query='meeting')
        args.update(kw)
        return self.store.search(**args)

    def test_real_fts_unicode_translated_and_literal_not_operators(self):
        self.put(translated='réunion tomorrow')
        self.assertEqual(len(self.search(query='cafe')['messages']), 1)
        self.assertEqual(len(self.search(query='東京')['messages']), 1)
        self.assertEqual(len(self.search(query='reunion')['messages']), 1)
        self.assertEqual(self.search(query='meeting OR nonexistent')['messages'], [])
        with self.assertRaises(ValueError): self.search(query='"*()')

    def test_account_thread_network_isolation_with_colliding_ids(self):
        self.put()
        self.put(account='other', original='meeting secret')
        self.put(thread='b')
        self.put(network='slack')
        self.assertEqual(len(self.search()['messages']), 3)
        scoped = self.search(thread='a', network='telegram')['messages']
        self.assertEqual(len(scoped), 1)
        self.assertEqual(scoped[0]['original'], 'café meeting 東京')
        self.assertEqual(self.search(account='nobody')['messages'], [])
        with self.assertRaises(ValueError): self.search(account='')

    def test_keyset_pagination_no_loss_for_equal_timestamps(self):
        for n in range(207): self.put(str(n))
        seen, cursor = [], None
        while True:
            result = self.search(limit=23, cursor=cursor)
            self.assertLessEqual(len(result['messages']), 23)
            seen.extend(m['message_id'] for m in result['messages'])
            cursor = result['next_cursor']
            self.assertEqual(result['has_more'], cursor is not None)
            if not cursor: break
        self.assertEqual(len(seen), 207)
        self.assertEqual(len(set(seen)), 207)

    def test_cursor_scope_replay_invalid_input_and_page_bounds(self):
        self.put('1'); self.put('2')
        cursor = self.search(limit=1)['next_cursor']
        for kw in ({'account': 'other'}, {'thread': 'a'}, {'network': 'slack'}, {'query': 'cafe'}):
            with self.assertRaises(ValueError): self.search(cursor=cursor, **kw)
        for bad in ('garbage', 'x'*513, base64.urlsafe_b64encode(json.dumps({}).encode()).decode()):
            with self.assertRaises(ValueError): self.search(cursor=bad)
        for bad in (0, -1, 101, True, '5'):
            with self.assertRaises(ValueError): self.search(limit=bad)
        with self.assertRaises(ValueError): self.search(query='word '*200)

    def test_upsert_edit_redaction_disconnect_and_restart(self):
        self.put(); self.put()
        self.assertEqual(len(self.search()['messages']), 1)
        self.put(original='replacement')
        self.assertEqual(self.search()['messages'], [])
        self.assertEqual(len(self.search(query='replacement')['messages']), 1)
        self.store.close()
        self.store = SearchStore(self.path)
        self.assertEqual(len(self.search(query='replacement')['messages']), 1)
        self.put(deleted=True)
        self.assertEqual(self.search(query='replacement')['messages'], [])
        self.put('one'); self.put('two', account='other')
        self.store.forget_account('owner')
        self.assertEqual(self.search()['messages'], [])
        self.assertEqual(len(self.search(account='other')['messages']), 1)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_thread_teardown_does_not_delete_other_scopes(self):
        self.put()
        self.put(account='other')
        self.put(thread='b')
        self.put(network='slack')
        self.store.forget_thread(account='owner', network='telegram', thread='a')
        self.assertEqual(self.search(thread='a', network='telegram')['messages'], [])
        self.assertEqual(len(self.search()['messages']), 2)
        self.assertEqual(len(self.search(account='other')['messages']), 1)

    def test_query_and_message_input_are_data_not_sql(self):
        self.put(original="Robert'); DROP TABLE normalized_message; --")
        self.assertEqual(len(self.search(query='Robert')['messages']), 1)
        self.assertEqual(self.search(account="' OR 1=1 --")['messages'], [])
        self.assertEqual(self.search(query="' OR 1=1 --")['messages'], [])
        with self.assertRaises(ValueError): self.put(timestamp=True)
        with self.assertRaises(ValueError): self.put(deleted='yes')


if __name__ == '__main__': unittest.main()
