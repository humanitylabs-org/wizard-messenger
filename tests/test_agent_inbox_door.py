"""Issue 325 (switch agent-inbox-door): the Agent chat as a door to the box's one agent inbox.

Runs through the real view server (owner routes) and the real MCP endpoint, with a fake Agent Service that keeps
records and one sweep card the way wizard-agent-service's app doors do (docs/agent-inbox.md, "App doors")."""
import http.server
import json
import threading
import unittest

import agent_chat
import agent_inbox_door
from test_agent_chat import AgentChat, PNG, OGG

WAITING = 'needs_you'


class FakeService:
    """Records keyed by id; captures deduped on app + item id; one shared card per sweep event."""

    def __init__(self):
        self.on = True
        self.pings_on = False
        self.records = {}
        self.cards = []
        self.calls = []
        self.pings = []
        self.reachable = True

    def need(self, title, options=('yes', 'no'), default='yes', confirm=False, recommendation='Say yes'):
        rid = 'inbox_%024x' % (len(self.records) + 1)
        self.records[rid] = {'id': rid, 'kind': WAITING, 'state': 'new', 'title': title, 'ask': title + '?',
                             'recommendation': recommendation, 'options': {o: o for o in options},
                             'default_option': default, 'confirm': confirm}
        return rid

    def view(self, card):
        items = []
        for item in card['waiting']['items']:
            r = self.records[item['id']]
            items.append({**item, 'state': r['state'], **({'answer': r['answer']} if r.get('answer') else {})})
        yes = [i for i in items if not i['confirm'] and i['state'] in ('new', 'surfaced') and i['default_option']]
        return {**card, 'waiting': {**card['waiting'], 'items': items},
                'yes_to_all': {'count': len(yes), 'skipped': sum(1 for i in items if i['confirm'])}}

    def draw(self):
        waiting = [r for r in self.records.values() if r['kind'] == WAITING and r['state'] in ('new', 'surfaced')]
        for r in waiting:
            r['state'] = 'surfaced'
        card = {'schema': 'wizard.agent-sweep/1', 'id': 'sweep_%024x' % (len(self.cards) + 1), 'at': 1,
                'waiting': {'items': [{'id': r['id'], 'title': r['title'], 'ask': r['ask'],
                                       'recommendation': r['recommendation'],
                                       'options': [{'token': t} for t in r['options']],
                                       'default_option': r['default_option'], 'confirm': r['confirm'], 'seen': 1,
                                       'link': '/wizard-os-home/?session=t-' + r['id']} for r in waiting[:7]],
                            'more': max(0, len(waiting) - 7), 'link': '/wizard-os-home/?inbox=waiting'},
                'done': {'items': [{'id': 'inbox_done', 'title': 'Booked the dentist', 'link': '/wizard-os-home/?session=d'}],
                         'more': 0, 'link': '/wizard-os-home/?inbox=done'},
                'running': {'count': 2, 'stale': 0, 'link': '/wizard-os-home/?inbox=running'},
                'later': {'count': 1, 'link': '/wizard-os-home/?inbox=later'},
                'parked': {'count': 0, 'link': '/wizard-os-home/?inbox=parked'}}
        self.cards.insert(0, card)
        return card

    def answer(self, rid, option):
        r = self.records[rid]
        if option == 'later':
            r['state'] = 'snoozed'
        else:
            r['state'], r['answer'] = 'answered', option
        return r

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if not self.reachable:
            return 0, None
        if not self.on:
            return 404, {'error': 'not_found'}
        if path == '/doors':
            if method == 'POST':
                self.pings_on = body.get('pings') is True
            return 200, {'on': True, 'sweep_caps': {'waiting': 7, 'done': 10}, 'door': 'messenger', 'pings': self.pings_on}
        if path == '/pings':
            out, self.pings = self.pings, []
            return 200, {'pings': out}
        if path == '' and method == 'POST':
            if body['source']['app'] != 'messenger':
                return 403, {'error': 'wrong_app'}
            key = 'app:messenger/' + body['source']['item_id']
            found = next((r for r in self.records.values() if r.get('source') == key), None)
            if found:
                return 200, {'record': found, 'created': False}
            rid = 'inbox_%024x' % (len(self.records) + 1)
            self.records[rid] = {'id': rid, 'kind': 'note', 'state': 'running', 'source': key, 'ask': body['text']}
            return 201, {'record': self.records[rid], 'created': True}
        if path == '/sweep':
            if method == 'GET':
                return 200, {'card': self.view(self.cards[0]) if self.cards else None}
            return 201, {'card': self.view(self.draw()), 'shared': False}
        if path.endswith('/yes-to-all'):
            card = next(c for c in self.cards if c['id'] == path.split('/')[1])
            done = []
            for item in self.view(card)['waiting']['items']:
                if not item['confirm'] and item['state'] in ('new', 'surfaced'):
                    self.answer(item['id'], item['default_option'])
                    done.append({'id': item['id'], 'option': item['default_option']})
            return 200, {'answered': done, 'card': self.view(card)}
        if method == 'PATCH':
            rid = path[1:]
            if rid not in self.records:
                return 404, {'error': 'not_found'}
            if self.records[rid]['state'] not in ('new', 'surfaced'):
                return 403, {'error': 'not_on_door_card'}
            return 200, {'record': self.answer(rid, body['option'])}
        return 404, {'error': 'not_found'}


class AgentInboxDoor(AgentChat):
    def setUp(self):
        super().setUp()
        self.service = FakeService()
        self.door = agent_inbox_door.Door(self.inbox, call=self.service)
        self.door.kick = lambda force=False: None   # passes run by hand below
        self.inbox.agent_inbox_door = self.door

    def switch(self, on):
        self.inbox.switches.set('agent-inbox-door', on)

    def opened(self):
        self.switch(True)
        self.assertTrue(self.door.probe(force=True))
        return self.ok('GET')

    def test_switch_off_is_todays_chat_and_never_calls_the_inbox(self):
        state = self.ok('GET')
        self.assertNotIn('door', state)
        note = self.ok('POST', '', {'text': 'Buy dog food'})['entries'][-1]
        self.assertNotIn('door', note)
        self.assertEqual(self.ok('POST', '/sweep', {})['sweep_open'], True)
        self.assertEqual(self.service.calls, [])
        got, _ = self.mcp('messenger_agent_chat_inbox')
        self.assertEqual([n['text'] for n in got['notes']], ['Buy dog food'])
        # The door routes don't exist while the switch is off.
        self.assertEqual(self.owner_call('POST', '/door/answer', {'post_id': 'p1', 'record': 'x', 'option': 'yes'})[0], 404)

    def test_box_inbox_off_keeps_todays_chat(self):
        self.service.on = False
        self.switch(True)
        self.assertFalse(self.door.probe(force=True))
        self.assertEqual(self.ok('GET')['door'], {'on': False})
        note = self.ok('POST', '', {'text': 'Call the plumber'})['entries'][-1]
        self.assertNotIn('door', note)
        self.assertTrue(self.ok('POST', '/sweep', {})['sweep_open'])   # the agent writes the list, as today
        self.assertFalse([c for c in self.service.calls if c[1] == ''])

    def test_a_note_makes_exactly_one_record_and_then_its_tick(self):
        self.assertEqual(self.opened()['door'], {'on': True})
        note = self.ok('POST', '', {'text': 'Renew the passport https://gov.example/passport'})['entries'][-1]
        self.assertEqual((note['door'], note['seen']), ('pending', None))
        # Messenger's own agent tools never see a note the inbox handles.
        got, _ = self.mcp('messenger_agent_chat_inbox')
        self.assertEqual(got['notes'], [])
        self.door.run_pass()
        note = agent_chat._find(agent_chat._load(self.inbox.store), note['id'])
        self.assertEqual(note['seen']['by'], 'agent inbox')
        self.assertTrue(note['door']['record'].startswith('inbox_'))
        captures = [c for c in self.service.calls if c[1] == '' and c[0] == 'POST']
        self.assertEqual(captures[0][2]['source'], {'app': 'messenger', 'item_id': note['id']})
        self.assertEqual(captures[0][2]['text'], 'Renew the passport https://gov.example/passport')
        # A resend (e.g. after a lost answer) gives the same record, never a second one.
        self.door.capture({**note, 'door': 'pending'})
        self.door.run_pass()
        self.assertEqual(len([r for r in self.service.records.values() if r['kind'] == 'note']), 1)

    def test_an_unanswered_capture_is_sent_again_and_has_no_tick_yet(self):
        self.opened()
        self.service.reachable = False
        note = self.ok('POST', '', {'text': 'Pay rent'})['entries'][-1]
        self.door.run_pass()   # the probe is still fresh: the note waits, with no tick
        got = agent_chat._find(agent_chat._load(self.inbox.store), note['id'])
        self.assertEqual((got['door'], got['seen']), ('pending', None))
        self.service.reachable = True
        self.door.run_pass()
        got = agent_chat._find(agent_chat._load(self.inbox.store), note['id'])
        self.assertTrue(got['door']['record'].startswith('inbox_'))
        self.assertTrue(got['seen'])

    def test_inbox_turned_off_hands_unsent_notes_back(self):
        self.opened()
        note = self.ok('POST', '', {'text': 'Fix the bike'})['entries'][-1]
        self.service.on = False
        self.door.probed_at = 0
        self.door.run_pass()
        got = agent_chat._find(agent_chat._load(self.inbox.store), note['id'])
        self.assertNotIn('door', got)
        self.assertEqual(self.ok('GET')['door'], {'on': False})
        got, _ = self.mcp('messenger_agent_chat_inbox')
        self.assertEqual([n['id'] for n in got['notes']], [note['id']])

    def test_switching_off_hands_unsent_notes_back(self):
        self.opened()
        note = self.ok('POST', '', {'text': 'Water the plants'})['entries'][-1]
        self.switch(False)
        state = self.ok('GET')
        self.assertNotIn('door', state)
        self.assertNotIn('door', state['entries'][-1])
        got, _ = self.mcp('messenger_agent_chat_inbox')
        self.assertEqual([n['id'] for n in got['notes']], [note['id']])

    def test_photo_and_voice_notes_name_the_attachment_tool(self):
        self.opened()
        status, body = self.put_media('photo', PNG)
        self.assertEqual(status, 200, body)
        photo = body['result']['entries'][-1]
        status, body = self.put_media('voice', OGG, '&duration=4000')
        voice = body['result']['entries'][-1]
        self.assertEqual((photo['door'], voice['door']), ('pending', 'pending'))
        self.door.run_pass()
        sent = {c[2]['source']['item_id']: c[2]['text'] for c in self.service.calls if c[1] == '' and c[0] == 'POST'}
        self.assertIn('messenger_agent_chat_attachment, note_id ' + photo['id'], sent[photo['id']])
        self.assertNotIn(voice['id'], sent)   # waits for its words
        self.ok('POST', '/transcript', {'id': voice['id'], 'text': 'Remind me to call mum'})
        self.door.run_pass()
        sent = {c[2]['source']['item_id']: c[2]['text'] for c in self.service.calls if c[1] == '' and c[0] == 'POST'}
        self.assertTrue(sent[voice['id']].startswith('Remind me to call mum'))
        self.assertIn('note_id ' + voice['id'], sent[voice['id']])
        # Without words after a minute it goes anyway.
        late = {'id': 'n9', 'kind': 'note', 'text': '', 'at': 0, 'media': {'type': 'voice'}}
        self.assertIn('no transcript', agent_chat.door_text(late))

    def test_sweep_draws_the_box_card_and_answers_go_to_the_box(self):
        a = self.service.need('Pay the electricity bill')
        b = self.service.need('Send the contract', confirm=True)
        self.opened()
        state = self.ok('POST', '/sweep', {})
        self.assertFalse(state['sweep_open'])   # no agent-written list in door mode
        ask, post = state['entries'][-2:]
        self.assertEqual((ask['kind'], ask['done'], post['kind']), ('ask', post['id'], 'sweep'))
        card = post['card']
        self.assertEqual([i['id'] for i in card['waiting']['items']], [a, b])
        self.assertEqual(card['yes_to_all']['count'], 1)
        self.assertEqual(self.service.calls[-1], ('POST', '/sweep', {'door': 'messenger'}))
        # No sweep request reaches Messenger's own agent tools.
        got, _ = self.mcp('messenger_agent_chat_inbox')
        self.assertEqual(got['sweep_requests'], [])
        # A tap answers that record on the box.
        state = self.ok('POST', '/door/answer', {'post_id': post['id'], 'record': a, 'option': 'no'})
        item = state['entries'][-1]['card']['waiting']['items'][0]
        self.assertEqual((item['state'], item['answer']), ('answered', 'no'))
        self.assertEqual(self.service.records[a]['answer'], 'no')
        # A confirm item is never answered from here, and an unknown option is refused.
        self.assertEqual(self.owner_call('POST', '/door/answer', {'post_id': post['id'], 'record': b, 'option': 'yes'})[0], 409)
        self.assertEqual(self.owner_call('POST', '/door/answer', {'post_id': post['id'], 'record': a, 'option': 'maybe'})[0], 400)
        # Answered already (in Daily, say): the box refuses and the owner hears it plainly.
        self.assertEqual(self.owner_call('POST', '/door/answer', {'post_id': post['id'], 'record': a, 'option': 'yes'})[0], 409)

    def test_an_answer_in_daily_shows_as_answered_here(self):
        a = self.service.need('Book the car service')
        self.opened()
        post = self.ok('POST', '/sweep', {})['entries'][-1]
        self.service.answer(a, 'yes')   # the owner answered on the Daily card
        self.door.run_pass()
        item = agent_chat._find(agent_chat._load(self.inbox.store), post['id'])['card']['waiting']['items'][0]
        self.assertEqual((item['state'], item['answer']), ('answered', 'yes'))

    def test_yes_to_all_only_when_the_card_allows_it(self):
        self.service.need('Renew the domain')
        self.service.need('Wire the deposit', confirm=True)
        self.opened()
        post = self.ok('POST', '/sweep', {})['entries'][-1]
        state = self.ok('POST', '/door/yes-to-all', {'post_id': post['id']})
        items = state['entries'][-1]['card']['waiting']['items']
        self.assertEqual([i['state'] for i in items], ['answered', 'surfaced'])
        self.assertEqual(state['entries'][-1]['card']['yes_to_all']['count'], 0)
        self.assertEqual(self.owner_call('POST', '/door/yes-to-all', {'post_id': post['id']})[0], 409)

    def test_urgent_alerts_arrive_once_as_a_one_line_ping(self):
        self.opened()
        self.assertTrue(self.door.pings)
        self.assertIn(('POST', '/doors', {'pings': True}), self.service.calls)
        alert = {'id': 'inbox_a1', 'title': 'Card payment failed', 'ask': 'Netflix could not charge your card',
                 'severity': 'urgent', 'link': 'https://bank.example/card', 'at': 1}
        self.service.pings = [alert]
        self.door.run_pass()
        agent_chat.door_ping(self.inbox, alert)   # the same alert again never adds a second ping
        state = self.ok('GET')
        pings = [e for e in state['entries'] if e['kind'] == 'ping']
        self.assertEqual(len(pings), 1)
        self.assertEqual(pings[0]['text'], 'Card payment failed: Netflix could not charge your card')
        self.assertEqual(pings[0]['link'], 'https://bank.example/card')
        self.assertTrue(state['urgent'])
        long = agent_chat.door_ping(self.inbox, {'id': 'inbox_a2', 'title': 'x' * 400, 'link': '/wizard-os-home/'})
        entry = agent_chat._find(agent_chat._load(self.inbox.store), long)
        self.assertEqual((len(entry['text']), entry['link']), (200, None))


class RealHTTP(unittest.TestCase):
    """The door's own HTTP call: Messenger's app token as a Bearer, JSON both ways, no answer = status 0."""

    def test_bearer_and_json(self):
        seen = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen['auth'] = self.headers.get('Authorization')
                seen['path'] = self.path
                seen['body'] = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                out = json.dumps({'record': {'id': 'inbox_1'}}).encode()
                self.send_response(201)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = 'http://127.0.0.1:%d' % server.server_port
            status, body = agent_inbox_door.http_call(base, 'tok', 'POST', '/wizard/v1/agent-inbox', {'text': 'hi'})
            self.assertEqual((status, body), (201, {'record': {'id': 'inbox_1'}}))
            self.assertEqual((seen['auth'], seen['path'], seen['body']), ('Bearer tok', '/wizard/v1/agent-inbox', {'text': 'hi'}))
        finally:
            server.shutdown()
        self.assertEqual(agent_inbox_door.http_call(base, 'tok', 'GET', '/x')[0], 0)

    def test_no_token_means_no_door(self):
        class Inbox:
            def switch_on(self, _id):
                return True
        door = agent_inbox_door.Door(Inbox(), token='')
        self.assertFalse(door.probe(force=True))


# AgentInboxDoor also reruns every AgentChat test with the door switch off: today's Agent chat is unchanged.
del AgentChat

if __name__ == '__main__':
    unittest.main()
