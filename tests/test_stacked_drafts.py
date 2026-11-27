"""Issue 353: an agent can line up several drafts in one chat (on for everyone, no switch)."""
import json
import tempfile
from pathlib import Path
import unittest

from drafts import Drafts, STACK_MAX
from engine import EngineError
from switches import SwitchStore


class Inbox:
    """A box whose switches.json still holds the removed stacked-drafts switch as off."""
    def __init__(self, path):
        self.switches = SwitchStore(path)
        self.switches.path.write_text(json.dumps({'switches': {'stacked-drafts': False}}))

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

    def test_a_stale_stored_off_value_changes_nothing(self):
        stale = Inbox(Path(self.tmp.name) / 'switches.json')
        self.assertNotIn('stacked-drafts', [s['id'] for s in stale.switches.listing()['switches']])
        for unified in (None, stale):
            self.ds = Drafts(self.tmp.name + '/' + ('none' if unified is None else 'stale'))
            self.create(unified, 'First')
            self.assertEqual(self.create(unified, 'Second')['text'], 'Second')

    def test_agents_line_up_drafts_in_creation_order(self):
        unified = None
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
        unified = None
        for t in ('A', 'B', 'C'): self.create(unified, t)
        again = Drafts(self.tmp.name)
        self.assertEqual([d['text'] for d in again.dispatch('GET', [], {}, unified)['drafts']], ['A', 'B', 'C'])


if __name__ == '__main__':
    unittest.main()
