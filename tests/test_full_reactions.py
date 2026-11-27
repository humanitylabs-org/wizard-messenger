"""Issue 471 (switch full-reactions): the box keeps reactions inside what the chat's network takes."""
import tempfile
import unittest
from unittest.mock import Mock

import unified
from engine import EngineError
from unified import UnifiedInbox, reaction_allowed, reaction_rules

LIMITED = ['\u2764\ufe0f', '\U0001F44D', '\U0001F525']
FEATURES = {'type': 'com.beeper.room_features', 'state_key': 'fi.mau.telegram://telegram/9',
            'content': {'reaction': 2, 'reaction_count': 1, 'allowed_reactions': LIMITED}}


class RuleTests(unittest.TestCase):
    def test_rules_from_the_bridges_room_features(self):
        self.assertEqual(reaction_rules([{'type': 'm.room.name', 'content': {'name': 'x'}}]), {'reactions': True, 'allowed': None, 'custom': False})
        self.assertEqual(reaction_rules([FEATURES])['allowed'], LIMITED)
        # Telegram Premium: any emoji goes (the bridge sends a custom emoji for one it lacks).
        premium = dict(FEATURES, content=dict(FEATURES['content'], custom_emoji_reactions=True))
        self.assertEqual(reaction_rules([premium]), {'reactions': True, 'allowed': None, 'custom': True})
        # A chat with reactions turned off.
        self.assertFalse(reaction_rules([dict(FEATURES, content={'reaction': -2})])['reactions'])

    def test_compared_without_variation_selectors(self):
        rules = reaction_rules([FEATURES])
        self.assertTrue(reaction_allowed(rules, '\u2764'))
        self.assertTrue(reaction_allowed(rules, '\U0001F44D\ufe0f'))
        self.assertFalse(reaction_allowed(rules, '\u26a1'))
        self.assertTrue(reaction_allowed(reaction_rules([]), '\u26a1'))
        self.assertFalse(reaction_allowed({'reactions': False, 'allowed': None}, '\u26a1'))


class ReactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        engine = Mock()
        engine.status.return_value = {'state': 'locked'}
        self.inbox = UnifiedInbox(self.tmp.name, engine)
        self.inbox.matrix_token = lambda: 'x'
        self.a = self.inbox.store.identity('telegram', '!zoe', 'Zoe')
        self.inbox.rooms['!zoe'] = {'network': 'telegram', 'kind': 'person', 'label': 'Zoe', 'names': {}}
        self.state = [FEATURES]
        self.calls = []

        def mx(path, method='GET', body=None, timeout=15):
            self.calls.append((method, path, body))
            if method == 'GET' and path.endswith('/state'):
                return self.state
            return {'event_id': '$r%d' % len(self.calls)}
        self.inbox.mx = mx
        self.inbox.ingest(self.a, self.inbox.rooms['!zoe'], {'event_id': '$m', 'type': 'm.room.message', 'sender': '@telegram_9:messenger.internal',
                                                             'origin_server_ts': 1000, 'content': {'msgtype': 'm.text', 'body': 'hi'}})

    def sent(self):
        return [c for c in self.calls if c[0] == 'PUT' and '/send/m.reaction/' in c[1]]

    def test_switch_off_sends_any_reaction_as_before(self):
        self.inbox.react('$m', {'key': '\u26a1'})
        self.assertEqual([c[2]['m.relates_to']['key'] for c in self.sent()], ['\u26a1'])
        self.assertFalse(any(c[1].endswith('/state') for c in self.calls), 'off: never reads the rules')
        with self.assertRaises(EngineError) as e:
            self.inbox.dispatch('GET', '/api/unified/messages/$m/reactions', {})
        self.assertEqual(e.exception.status, 404)

    def test_switch_on_refuses_one_the_chat_does_not_take_before_sending(self):
        self.inbox.switches.set('full-reactions', True)
        with self.assertRaises(EngineError) as e:
            self.inbox.react('$m', {'key': '\u26a1'})
        self.assertEqual((e.exception.code, e.exception.status), ('reaction_not_allowed', 409))
        self.assertEqual(e.exception.message, 'Telegram only allows some reactions in this chat')
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.inbox.row('$m')['reactions'], [])
        # One it takes goes through, then taking it back is never refused.
        self.inbox.react('$m', {'key': '\U0001F525'})
        self.assertEqual([c[2]['m.relates_to']['key'] for c in self.sent()], ['\U0001F525'])
        self.state = [dict(FEATURES, content={'reaction': -2})]
        self.inbox.react('$m', {'key': '\U0001F525'})
        self.assertEqual(self.inbox.row('$m')['reactions'], [])

    def test_rules_are_read_once_per_room_for_a_while(self):
        self.inbox.switches.set('full-reactions', True)
        for key in ('\U0001F525', '\U0001F44D', '\u2764'):
            self.inbox.react('$m', {'key': key})
        self.assertEqual(sum(1 for c in self.calls if c[1].endswith('/state')), 1)

    def test_no_reactions_at_all(self):
        self.inbox.switches.set('full-reactions', True)
        self.state = [dict(FEATURES, content={'reaction': -2})]
        with self.assertRaises(EngineError) as e:
            self.inbox.react('$m', {'key': '\U0001F44D'})
        self.assertEqual(e.exception.message, "Telegram doesn't allow reactions in this chat")

    def test_the_view_gets_the_chats_rules(self):
        self.inbox.switches.set('full-reactions', True)
        r = self.inbox.dispatch('GET', '/api/unified/messages/$m/reactions', {})
        self.assertEqual(r, {'reactions': True, 'allowed': LIMITED, 'custom': False, 'network': 'Telegram'})
        self.state = []
        self.inbox._reaction_rules.clear()
        self.assertIsNone(self.inbox.dispatch('GET', '/api/unified/messages/$m/reactions', {})['allowed'])

    def test_an_unreadable_room_state_lets_reactions_through(self):
        self.inbox.switches.set('full-reactions', True)

        def broken(path, method='GET', body=None, timeout=15):
            if method == 'GET':
                raise EngineError('matrix_unavailable', 'down', 502)
            self.calls.append((method, path, body))
            return {'event_id': '$x'}
        self.inbox.mx = broken
        self.inbox.react('$m', {'key': '\u26a1'})
        self.assertEqual(len(self.sent()), 1)


if __name__ == '__main__':
    unittest.main()
