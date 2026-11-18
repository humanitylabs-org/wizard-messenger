"""The owner's agent chat (issue 265, on for everyone): notes to self, Sweep with one-tap answers, urgent pings and
reports. Runs through the real view server (owner routes) and the real MCP endpoint (agent key)."""
import base64
import io
import json
import time
import unittest
from unittest.mock import Mock

import test_web as fixtures
from drafts import Drafts
from unified import UnifiedInbox
import agent_chat
from test_draft_wake import Inbox as EventInbox, SECRET

TOOLS = ('messenger_agent_chat_inbox', 'messenger_agent_chat_ack', 'messenger_agent_chat_post',
         'messenger_agent_chat_done', 'messenger_agent_chat_attachment', 'messenger_agent_chat_wake_me')
PNG = (b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89'
       b'\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82')
OGG = b'OggS' + b'\x00' * 60


class AgentChat(unittest.TestCase):
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
        self.owner = self.owner_headers()
        status, _, data = self.request('POST', '/api/view/agents', {'name': 'Oscar'}, self.owner)
        self.assertEqual(status, 200, data)
        self.agent_id = data['result']['agent']['id']
        self.key = {'Authorization': 'Bearer ' + data['result']['key']}
        self.level('draft_only')

    def tearDown(self):
        waker = self.inbox.__dict__.get('agent_chat_waker')
        if waker:
            waker.close()
        self.tearDown_base()

    def put_media(self, kind, data, extra='', headers=None):
        status, _, body = self.request('PUT', '/api/unified/agent-chat/media?kind=' + kind + extra, data,
                                       {**(headers or self.owner), 'Content-Type': 'application/octet-stream'})
        return status, body

    def wait_for(self, check, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            if check():
                return True
            time.sleep(0.05)
        return False

    def level(self, level):
        self.assertEqual(self.request('POST', '/api/view/agents/' + self.agent_id, {'level': level}, self.owner)[0], 200)

    def mcp(self, name, args=None, method='tools/call'):
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method}
        if method == 'tools/call':
            body['params'] = {'name': name, 'arguments': args or {}}
        status, _, data = self.request('POST', '/mcp', body, {'Origin': fixtures.ORIGIN, **self.key})
        self.assertEqual(status, 200, data)
        if method != 'tools/call':
            return data['result']
        return json.loads(data['result']['content'][0]['text']), data['result'].get('isError', False)

    def owner_call(self, method, path, body=None, headers=None):
        status, _, data = self.request(method, '/api/unified/agent-chat' + path, body, headers or self.owner)
        return status, data

    def ok(self, method, path='', body=None):
        status, data = self.owner_call(method, path, body)
        self.assertEqual(status, 200, data)
        return data['result']

    def test_always_on_tools_and_chat_with_no_switch(self):
        # Issue 265: the Agent chat was approved, so it has no switch any more: the tools are listed and the owner's
        # chat answers on a box with no switch stored, and an old stored value is ignored.
        names = {t['name'] for t in self.mcp(None, method='tools/list')['tools']}
        self.assertTrue(set(TOOLS) <= names)
        self.assertNotIn('agent-chat', [s['id'] for s in self.inbox.switches.listing()['switches']])
        got, error = self.mcp('messenger_agent_chat_inbox')
        self.assertFalse(error, got)
        self.assertEqual(self.ok('GET')['entries'], [])

    def test_a_note_is_ticked_never_answered(self):
        state = self.ok('POST', '', {'text': 'Buy dog food https://shop.example/food'})
        note = state['entries'][-1]
        self.assertEqual((note['kind'], note['by'], note['seen']), ('note', 'owner', None))
        # The header can say whether anyone listens: no agent has checked yet.
        self.assertEqual(state['agent'], {'woken': False, 'checked': False})
        got, error = self.mcp('messenger_agent_chat_inbox')
        self.assertFalse(error, got)
        self.assertEqual([n['text'] for n in got['notes']], ['Buy dog food https://shop.example/food'])
        done, error = self.mcp('messenger_agent_chat_ack', {'ids': [note['id'], 'n999']})
        self.assertFalse(error, done)
        self.assertEqual(done, {'picked_up': [note['id']], 'unknown': ['n999']})
        state = self.ok('GET')
        self.assertEqual(state['entries'][-1]['seen']['by'], 'Oscar')
        self.assertEqual(state['agent'], {'woken': False, 'checked': True})
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['notes'], [])
        # Quiet mode: there is no reply kind, a sweep needs the owner's Sweep tap, and a ping is one short line.
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'reply', 'text': 'On it!'})
        self.assertTrue(error)
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'sweep', 'text': 'Got your note'})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'no_sweep_asked')
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'x' * 201})
        self.assertTrue(error)
        self.assertEqual([e['kind'] for e in self.ok('GET')['entries']], ['note'])

    def test_sweep_with_one_tap_answers(self):
        self.ok('POST', '/sweep', {})
        state = self.ok('POST', '/sweep', {})  # a second tap while one is open asks nothing new
        self.assertEqual([e['kind'] for e in state['entries']], ['ask'])
        self.assertTrue(state['sweep_open'])
        got = self.mcp('messenger_agent_chat_inbox')[0]
        self.assertEqual(len(got['sweep_requests']), 1)
        self.assertIsNone(got['sweep_requests'][0]['since'])
        items = [{'text': "Buddy's comment on your post", 'recommendation': 'Reply with thanks',
                  'buttons': [{'label': 'Yes', 'value': 'yes'}, {'label': 'Skip', 'value': 'skip'},
                              {'label': 'Later', 'value': 'later'}]},
                 {'text': 'Dentist wants a date', 'buttons': [{'label': 'Tue'}, {'label': 'Wed'}]}]
        posted, error = self.mcp('messenger_agent_chat_post', {'kind': 'sweep', 'items': items})
        self.assertFalse(error, posted)
        state = self.ok('GET')
        ask, sweep = state['entries']
        self.assertEqual(ask['done'], posted['posted'])
        self.assertFalse(state['sweep_open'])
        self.assertEqual(state['unread'], 1)
        self.assertEqual([i['n'] for i in sweep['items']], [1, 2])
        self.assertEqual(sweep['items'][1]['buttons'], [{'label': 'Tue', 'value': 'Tue'}, {'label': 'Wed', 'value': 'Wed'}])
        # A tap answers one item; a value that is not one of its buttons is refused.
        status, data = self.owner_call('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'maybe'})
        self.assertEqual(status, 400, data)
        self.ok('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'skip'})
        self.ok('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'yes'})  # changed before pick-up
        answers = self.mcp('messenger_agent_chat_inbox')[0]['answers']
        self.assertEqual([(a['id'], a['answer']) for a in answers], [(sweep['id'] + '/1', 'yes')])
        self.mcp('messenger_agent_chat_ack', {'ids': [answers[0]['id']]})
        status, data = self.owner_call('POST', '/answer', {'post_id': sweep['id'], 'item': 1, 'value': 'skip'})
        self.assertEqual(status, 409, data)
        done, error = self.mcp('messenger_agent_chat_done', {'post_id': sweep['id'], 'item': 1, 'result': 'Replied to Buddy'})
        self.assertFalse(error, done)
        item = self.ok('GET')['entries'][-1]['items'][0]
        self.assertEqual((item['answer']['label'], item['result']), ('Yes', 'Replied to Buddy'))
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['answers'], [])
        # The next Sweep tells the agent where the last one ended.
        self.ok('POST', '/read', {})
        self.ok('POST', '/sweep', {})
        self.assertEqual(self.mcp('messenger_agent_chat_inbox')[0]['sweep_requests'][0]['since'], sweep['at'])

    def test_urgent_ping_and_reports(self):
        posted, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': "Buddy's comment\nneeds a reply",
                                                                'link': 'https://social.example/p/1'})
        self.assertFalse(error, posted)
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'x', 'link': 'javascript:alert(1)'})
        self.assertTrue(error)
        self.mcp('messenger_agent_chat_post', {'kind': 'report', 'text': 'Weekly stats\n\nFollowers +12'})
        state = self.ok('GET')
        self.assertEqual(state['entries'][0]['text'], "Buddy's comment needs a reply")
        self.assertEqual((state['unread'], state['urgent'], state['reports_unread']), (1, True, 1))
        state = self.ok('POST', '/read', {})
        self.assertEqual((state['unread'], state['urgent'], state['reports_unread']), (0, False, 1))
        state = self.ok('POST', '/read', {'reports': True})
        self.assertEqual(state['reports_unread'], 0)

    def test_notes_and_reports_answer_with_notifications_in_reports_off(self):
        # Issue 265: with the Agent chat always on, the Notifications in Reports switch only adds notifications to
        # Reports; notes, Sweep and both read marks answer whether it is on or off.
        for on in (False, True):
            self.inbox.switches.set('reports-notifications', on)
            self.ok('POST', '', {'text': 'a note'})
            self.ok('POST', '/read', {})
            self.assertGreater(self.ok('POST', '/read', {'reports': True})['reports_read_at'], 0)
        # An agent key still can't use the owner's routes.
        status, data = self.owner_call('GET', '', headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, data)

    def test_owner_only_and_levels(self):
        # An agent key can never use the owner's routes.
        status, data = self.owner_call('GET', '', headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, data)
        status, data = self.owner_call('POST', '', {'text': 'fake note'}, headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, data)
        self.level('read_only')
        self.assertFalse(self.mcp('messenger_agent_chat_inbox')[1])
        refused, error = self.mcp('messenger_agent_chat_post', {'kind': 'ping', 'text': 'hi'})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'agent_permission_denied')

    def test_store_keeps_a_bounded_history(self):
        for i in range(agent_chat.MAX_ENTRIES + 5):
            agent_chat.note(self.inbox, {'text': 'n%d' % i})
        data = agent_chat._load(self.inbox.store)
        self.assertEqual(len(data['entries']), agent_chat.MAX_ENTRIES)
        self.assertEqual(len(agent_chat.state(self.inbox)['entries']), agent_chat.SHOWN)


    # ---- issue 266: photos and voice notes, and waking the agent ----
    def test_photo_and_voice_notes_reach_the_agent(self):
        status, body = self.put_media('photo', PNG)
        self.assertEqual(status, 200, body)
        photo = body['result']['entries'][-1]
        self.assertEqual((photo['kind'], photo['by'], photo['media']['type'], photo['media']['mime']),
                         ('note', 'owner', 'photo', 'image/png'))
        status, body = self.put_media('voice', OGG, '&duration=4200')
        self.assertEqual(status, 200, body)
        voice = body['result']['entries'][-1]
        self.assertEqual((voice['media']['type'], voice['media']['duration']), ('voice', 4200))
        # The owner's view shows its own file back.
        status, headers, data = self.request('GET', '/api/unified/agent-chat/media/' + photo['id'], None, self.owner)
        self.assertEqual((status, headers['Content-Type'], data), (200, 'image/png', PNG))
        # Wizard's transcription of the voice note is kept for the agent.
        self.ok('POST', '/transcript', {'id': voice['id'], 'text': 'Remind me to call the vet'})
        status, data = self.owner_call('POST', '/transcript', {'id': photo['id'], 'text': 'x'})
        self.assertEqual(status, 404, data)
        got = self.mcp('messenger_agent_chat_inbox')[0]
        self.assertEqual([n['attachment']['type'] for n in got['notes']], ['photo', 'voice'])
        self.assertEqual(got['notes'][1]['attachment']['transcript'], 'Remind me to call the vet')
        self.assertEqual(got['notes'][0]['attachment']['fetch'], {'tool': 'messenger_agent_chat_attachment',
                                                                  'note_id': photo['id']})
        # The photo comes back as an image block, the voice note as an audio resource.
        status, _, data = self.request('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'messenger_agent_chat_attachment', 'arguments': {'note_id': photo['id']}}},
            {'Origin': fixtures.ORIGIN, **self.key})
        content = data['result']['content']
        self.assertEqual(content[1]['type'], 'image')
        self.assertEqual(base64.b64decode(content[1]['data']), PNG)
        status, _, data = self.request('POST', '/mcp', {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
            'name': 'messenger_agent_chat_attachment', 'arguments': {'note_id': voice['id']}}},
            {'Origin': fixtures.ORIGIN, **self.key})
        content = data['result']['content']
        meta = json.loads(content[0]['text'])
        self.assertEqual((meta['type'], meta['transcript']), ('voice', 'Remind me to call the vet'))
        self.assertEqual((content[1]['type'], content[1]['resource']['mimeType']), ('resource', 'audio/ogg'))
        self.assertEqual(base64.b64decode(content[1]['resource']['blob']), OGG)
        # A text note has nothing to fetch.
        text = self.ok('POST', '', {'text': 'plain'})['entries'][-1]
        refused, error = self.mcp('messenger_agent_chat_attachment', {'note_id': text['id']})
        self.assertTrue(error)
        self.assertEqual(refused['error']['code'], 'not_found')

    def test_media_notes_are_checked_and_owner_only(self):
        self.assertEqual(self.put_media('photo', b'<svg onload=alert(1)>')[0], 415)
        self.assertEqual(self.put_media('voice', PNG)[0], 415)
        self.assertEqual(self.put_media('file', PNG)[0], 400)
        status, body = self.put_media('photo', PNG, headers={'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200, body)
        self.assertEqual(self.ok('GET')['entries'], [])
        photo = self.put_media('photo', PNG)[1]['result']['entries'][-1]
        status, _, _ = self.request('GET', '/api/unified/agent-chat/media/' + photo['id'], None,
                                    {'Origin': fixtures.ORIGIN, **self.key})
        self.assertNotEqual(status, 200)
        status, _, _ = self.request('GET', '/api/unified/agent-chat/media/' + photo['id'], None, self.owner)
        self.assertEqual(status, 200)

    def test_a_dropped_entry_takes_its_file_with_it(self):
        photo = self.put_media('photo', PNG)[1]['result']['entries'][-1]
        path = agent_chat._media_path(self.inbox, photo['media'])
        self.assertTrue(path.is_file())
        for i in range(agent_chat.MAX_ENTRIES):
            agent_chat.note(self.inbox, {'text': 'n%d' % i})
        self.assertFalse(path.exists())

    def test_a_note_a_sweep_and_an_answer_wake_the_agent(self):
        self.server.unified.wake_levels = self.server.wake_levels
        events = EventInbox()
        self.addCleanup(events.close)
        self.inbox.agent_chat_waker = agent_chat.Waker(self.inbox, delay=0.1)
        refused, error = self.mcp('messenger_agent_chat_wake_me', {'url': 'ftp://x', 'secret': SECRET})
        self.assertTrue(error)
        made, error = self.mcp('messenger_agent_chat_wake_me', {'url': events.url, 'secret': SECRET})
        self.assertFalse(error, made)
        self.assertTrue(made['woken'])
        self.ok('POST', '', {'text': 'Buy dog food'})
        self.put_media('photo', PNG)
        self.assertTrue(self.wait_for(lambda: events.events), 'no wake')
        time.sleep(0.3)
        self.assertEqual(len(events.events), 1)  # a burst is one wake
        event = events.events[0]
        self.assertEqual((event['event'], event['reason'], event['waiting']),
                         ('messenger.agent_chat', 'note', {'notes': 2, 'sweep_requests': 0, 'answers': 0}))
        self.assertNotIn('Buy dog food', json.dumps(event))  # never the words
        self.assertEqual(events.bad, 0)
        self.assertTrue(self.mcp('messenger_agent_chat_wake_me', {'check': True})[0]['wake']['last_wake'])
        self.ok('POST', '/sweep', {})
        self.assertTrue(self.wait_for(lambda: len(events.events) == 2))
        self.assertEqual(events.events[1]['reason'], 'sweep')
        # Read-only now: no more wakes (ticking needs Draft-only); and off stops them too.
        self.level('read_only')
        self.ok('POST', '', {'text': 'another'})
        time.sleep(0.4)
        self.assertEqual(len(events.events), 2)
        self.level('draft_only')
        self.mcp('messenger_agent_chat_wake_me', {'off': True})
        self.ok('POST', '', {'text': 'and another'})
        time.sleep(0.4)
        self.assertEqual(len(events.events), 2)


if __name__ == '__main__':
    unittest.main()
