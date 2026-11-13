"""Agent keeps a draft ready (issue 178, on for everyone). Synthetic chats only; nothing here may send."""
import json
import time
import unittest
from unittest.mock import Mock

import test_web as fixtures
from drafts import Drafts
from unified import UnifiedInbox
import agent_tools
import draft_watch

NOW = lambda: int(time.time() * 1000)


class DraftWatch(unittest.TestCase):
    setUp_base = fixtures.ViewBoundary.setUp
    tearDown = fixtures.ViewBoundary.tearDown
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
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Oscar'}, self.owner)
        self.assertEqual(status, 200, data)
        ident = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.assertEqual(self.request('POST', '/api/view/agents/' + ident, {'level': 'draft_only'}, self.owner)[0], 200)
        self.msg = 0

    def chat(self, name, network='telegram'):
        identity = self.inbox.store.identity(network, '!' + name + ':messenger.internal', name)
        return identity

    def say(self, identity, text, outgoing=False, at=None):
        self.msg += 1
        self.inbox.store.add_message('$m%d' % self.msg, identity, '@me' if outgoing else '@them', outgoing, text,
                                     at if at is not None else NOW() - 60000)

    def mcp(self, name, args=None, method='tools/call'):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if method == 'tools/call':
            body['params'] = {'name': name, 'arguments': args or {}}
        status, _, data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.key})
        self.assertEqual(status, 200, data)
        if method != 'tools/call':
            return data['result']
        return json.loads(data['result']['content'][0]['text']), data['result'].get('isError', False)

    def watch(self, body, headers=None):
        return self.request('POST', '/api/unified/draft-watch', body, headers or self.owner)

    def needing(self):
        result, error = self.mcp('messenger_chats_needing_draft')
        self.assertFalse(error, result)
        return result

    def owner_delete(self, draft, **extra):
        row = self.server.drafts.get(draft['id'])
        return self.server.drafts.dispatch('DELETE', [draft['id']], {'revision': row['revision'], **extra}, self.inbox, owner=True)

    def test_on_for_everyone_with_no_switch(self):
        # Issue 178 approved: no agent-drafts switch any more; the tools are listed and the owner can pick chats at once.
        self.assertNotIn('agent-drafts', [s['id'] for s in __import__('switches').SWITCHES])
        names = [t['name'] for t in self.mcp(None, method='tools/list')['tools']]
        self.assertTrue({'messenger_chats_needing_draft', 'messenger_draft_feedback'} <= set(names))
        a = self.chat('Anna')
        status, _, data = self.watch({'person_id': a['person_id'], 'on': True})
        self.assertEqual(status, 200, data)
        self.assertEqual(data['result']['on'], True)

    def test_watched_chat_needs_a_draft_until_the_agent_writes_one(self):
        names = [t['name'] for t in self.mcp(None, method='tools/list')['tools']]
        self.assertTrue({'messenger_chats_needing_draft', 'messenger_draft_feedback'} <= set(names))
        a, b, c = self.chat('Anna'), self.chat('Ben'), self.chat('Cai')
        self.say(a, 'Can you do Tuesday?')
        self.say(b, 'See you then', outgoing=True)
        self.say(c, 'Unwatched chat')
        for ident in (a, b):
            status, _, data = self.watch({'person_id': ident['person_id'], 'on': True})
            self.assertEqual(status, 200, data)
        self.assertEqual(sorted(data['result']['watched']), sorted([a['person_id'], b['person_id']]))
        # Agents can never change what is watched.
        self.assertEqual(self.watch({'person_id': c['person_id'], 'on': True}, self.key)[0], 403)
        out = self.needing()
        self.assertEqual([x['id'] for x in out['chats']], [a['person_id']])
        self.assertEqual(out['chats'][0]['reason'], 'watched')
        self.assertNotIn('draft', out['chats'][0])
        made, error = self.mcp('messenger_create_draft', {'chat_id': a['person_id'], 'text': 'Tuesday works, 3pm?'})
        self.assertFalse(error, made)
        self.assertEqual(self.needing()['chats'], [])
        # A new message while the draft waits: the same draft comes back to be updated, never a second one.
        time.sleep(0.01)
        self.say(a, 'Or Wednesday?', at=NOW())
        out = self.needing()
        self.assertEqual(out['chats'][0]['draft']['id'], made['draft']['id'])
        updated, error = self.mcp('messenger_update_draft', {'draft_id': made['draft']['id'], 'revision': out['chats'][0]['draft']['revision'],
                                                             'text': 'Wednesday is better, 3pm?'})
        self.assertFalse(error, updated)
        self.assertEqual(self.needing()['chats'], [])
        # Unwatching takes it off the list.
        self.say(a, 'Hello?', at=NOW() + 10000)
        self.assertEqual(self.watch({'person_id': a['person_id'], 'on': False})[0], 200)
        self.assertEqual(self.needing()['chats'], [])
        self.inbox.mx.assert_not_called()

    def test_every_unread_chat_but_never_muted_or_where_the_owner_writes(self):
        a, b, c = self.chat('Anna'), self.chat('Ben'), self.chat('Cai')
        for ident in (a, b, c):
            self.say(ident, 'Hi from ' + ident['person_id'])
        self.assertEqual(self.needing()['chats'], [])
        self.assertEqual(self.watch({'all_unread': True})[0], 200)
        self.inbox.store.update(b['person_id'], {'muted': True})
        self.server.drafts.dispatch('POST', [], {'person_id': c['person_id'], 'identity_id': c['id'], 'text': 'my own reply'},
                                    self.inbox, owner=True)
        out = self.needing()
        self.assertEqual([(x['id'], x['reason']) for x in out['chats']], [(a['person_id'], 'unread')])
        self.assertEqual(self.request('GET', '/api/unified/draft-watch', None, self.owner)[2]['result']['all_unread'], True)
        self.assertEqual(self.watch({'all_unread': 'yes'})[0], 400)

    def test_feedback_pairs_what_was_drafted_with_what_was_sent(self):
        a, b, c = self.chat('Anna'), self.chat('Ben', 'whatsapp'), self.chat('Cai')
        for ident in (a, b, c):
            self.say(ident, 'When?')
        drafts = {}
        for ident, text in ((a, 'Tuesday at 3?'), (b, 'Tomorrow works'), (c, 'Let me check')):
            drafts[ident['person_id']] = self.mcp('messenger_create_draft', {'chat_id': ident['person_id'], 'text': text})[0]['draft']
        # Anna: the owner edits the agent's words in the composer, then sends.
        row = self.server.drafts.get(drafts[a['person_id']]['id'])
        self.server.drafts.dispatch('POST', [row['id']], {'revision': row['revision'], 'person_id': a['person_id'],
                                                          'identity_id': a['id'], 'text': 'Tues 3pm ok?'}, self.inbox, owner=True)
        self.owner_delete(drafts[a['person_id']], outcome='sent', sent_text='Tues 3pm ok? 🙂')
        self.owner_delete(drafts[b['person_id']], outcome='sent', sent_text='Tomorrow  works')
        self.owner_delete(drafts[c['person_id']], outcome='discarded')
        result, error = self.mcp('messenger_draft_feedback')
        self.assertFalse(error, result)
        got = [(r['chat_id'], r['outcome'], r['drafted'], r['sent'], r['agent']) for r in result['feedback']]
        self.assertEqual(got, [(c['person_id'], 'discarded', 'Let me check', None, 'Oscar'),
                               (b['person_id'], 'sent_as_drafted', 'Tomorrow works', 'Tomorrow  works', 'Oscar'),
                               (a['person_id'], 'edited', 'Tuesday at 3?', 'Tues 3pm ok? 🙂', 'Oscar')])
        self.assertEqual(result['feedback'][1]['network'], agent_tools._net('whatsapp'))
        self.assertEqual(result['stats'], {'sent_as_drafted': 1, 'edited': 1, 'discarded': 1, 'total': 3})
        one, _ = self.mcp('messenger_draft_feedback', {'chat_id': a['person_id']})
        self.assertEqual([r['outcome'] for r in one['feedback']], ['edited'])
        self.assertEqual(self.request('GET', '/api/unified/draft-watch', None, self.owner)[2]['result']['stats']['total'], 3)

    def test_no_feedback_without_an_outcome_or_an_agent(self):
        a = self.chat('Anna')
        self.say(a, 'When?')
        mine = self.server.drafts.dispatch('POST', [], {'person_id': a['person_id'], 'identity_id': a['id'], 'text': 'Mine'},
                                           self.inbox, owner=True)['draft']
        self.owner_delete(mine, outcome='sent', sent_text='Mine')  # the owner's own draft: nothing to learn
        agent = self.mcp('messenger_create_draft', {'chat_id': a['person_id'], 'text': 'Agent'})[0]['draft']
        self.owner_delete(agent)  # an older view that does not say why
        self.assertEqual(draft_watch.feedback(self.inbox.store), [])


class ToolList(unittest.TestCase):
    def test_every_tool_is_listed_with_no_switch_on(self):
        handler = Mock(); handler.service.unified.switches.is_on = lambda sid: False
        names = {t['name'] for t in agent_tools.listed(handler)}
        self.assertEqual(agent_tools.SWITCHED, {})
        self.assertTrue({'messenger_chats_needing_draft', 'messenger_draft_feedback', 'messenger_start_draft'} <= names)
        self.assertEqual(agent_tools.ROUTES['messenger_chats_needing_draft'], ('GET', '/api/unified/people'))
        self.assertEqual(agent_tools.ROUTES['messenger_draft_feedback'], ('GET', '/api/drafts'))


if __name__ == '__main__':
    unittest.main()
