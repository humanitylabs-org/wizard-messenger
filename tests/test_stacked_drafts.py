"""Issue 353: with the stacked-drafts switch on, an agent can line up several drafts in one chat."""
import tempfile
import unittest

from drafts import Drafts, STACK_MAX
from engine import EngineError
from switches import SwitchStore


class Inbox:
    def __init__(self, on):
        self.switches = SwitchStore()
        if on: self.switches.set('stacked-drafts', True)

    def switch_on(self, switch_id):
        return self.switches.is_on(switch_id)


class StackedDrafts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ds = Drafts(self.tmp.name)
        self.agent = {'id': 'agent:oscar', 'name': 'Oscar'}

    def create(self, unified, text, owner=False, person='alice'):
        body = {'person_id': person, 'identity_id': 'telegram', 'text': text}
        return self.ds.dispatch('POST', [], body, unified, owner=owner, actor=None if owner else self.agent)['draft']

    def test_switch_off_keeps_one_draft_per_chat(self):
        for unified in (None, Inbox(False)):
            ds = Drafts(self.tmp.name + '/' + ('none' if unified is None else 'off'))
            self.ds = ds
            self.create(unified, 'First')
            with self.assertRaises(EngineError) as ctx:
                self.create(unified, 'Second')
            self.assertEqual(ctx.exception.code, 'draft_exists')

    def test_switch_on_lines_up_drafts_in_creation_order(self):
        unified = Inbox(True)
        made = [self.create(unified, 'Part %d' % i) for i in range(1, STACK_MAX + 1)]
        self.assertEqual(STACK_MAX, 5)
        listed = [d for d in self.ds.dispatch('GET', [], {}, unified, owner=False, actor=self.agent)['drafts']
                  if d['person_id'] == 'alice']
        self.assertEqual([d['text'] for d in listed], ['Part 1', 'Part 2', 'Part 3', 'Part 4', 'Part 5'])
        with self.assertRaises(EngineError) as ctx:
            self.create(unified, 'Part 6')
        self.assertEqual(ctx.exception.code, 'draft_stack_full')
        # Another chat is not affected, and the owner's composer may still start one beside the stack.
        self.create(unified, 'Bob', person='bob')
        self.create(unified, 'Owner types', owner=True)
        with self.assertRaises(EngineError):
            self.create(unified, 'Owner again', owner=True)
        # Each draft keeps working by its own id: update one in the middle, then the order stays.
        middle = made[2]
        self.ds.dispatch('POST', [middle['id']], {'revision': middle['revision'], 'person_id': 'alice',
                                                  'identity_id': 'telegram', 'text': 'Part 3 (better)'},
                         unified, owner=False, actor=self.agent)
        self.ds.dispatch('DELETE', [made[0]['id']], {'revision': made[0]['revision']}, unified, owner=False, actor=self.agent)
        listed = [d['text'] for d in self.ds.dispatch('GET', [], {}, unified)['drafts'] if d['person_id'] == 'alice']
        self.assertEqual(listed, ['Part 2', 'Part 3 (better)', 'Part 4', 'Part 5', 'Owner types'])

    def test_order_survives_a_restart(self):
        unified = Inbox(True)
        for t in ('A', 'B', 'C'): self.create(unified, t)
        again = Drafts(self.tmp.name)
        self.assertEqual([d['text'] for d in again.dispatch('GET', [], {}, unified)['drafts']], ['A', 'B', 'C'])

    def test_switching_off_keeps_waiting_drafts_but_adds_no_more(self):
        unified = Inbox(True)
        self.create(unified, 'A'); self.create(unified, 'B')
        unified.switches.set('stacked-drafts', False)
        with self.assertRaises(EngineError) as ctx:
            self.create(unified, 'C')
        self.assertEqual(ctx.exception.code, 'draft_exists')
        self.assertEqual(len(self.ds.dispatch('GET', [], {}, unified)['drafts']), 2)


if __name__ == '__main__':
    unittest.main()
