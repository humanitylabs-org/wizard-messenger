"""The Messenger skill is found when the owner asks for a draft (wizard-os issue 800)."""
from pathlib import Path
import re
import unittest

SKILL = Path(__file__).resolve().parents[1] / 'skill' / 'SKILL.md'


def frontmatter(text):
    head = text.split('---', 2)[1]
    out = {}
    for line in head.strip().splitlines():
        key, _, value = line.partition(':')
        out[key.strip()] = value.strip().strip('"')
    return out


class SkillTriggerTests(unittest.TestCase):
    def test_description_names_drafting(self):
        meta = frontmatter(SKILL.read_text(encoding='utf-8'))
        self.assertEqual(meta['name'], 'messenger')
        description = meta['description']
        self.assertTrue(description.startswith('Use when the owner asks to draft, write, reply to or message anyone'))
        for network in ('WhatsApp', 'LINE', 'Telegram', 'Instagram', 'Slack'):
            self.assertIn(network, description)
        self.assertIn('never only in chat', description)
        self.assertLessEqual(len(description), 1024)

    def test_draft_rule_comes_first_and_names_both_tools(self):
        body = SKILL.read_text(encoding='utf-8').split('---', 2)[2]
        first = next(p for p in body.split('\n\n') if p.strip() and not p.startswith('#'))
        self.assertIn('Draft a message = save it in Messenger', first)
        self.assertRegex(first, re.compile(r'messenger_create_draft.*messenger_start_draft', re.S))
        self.assertIn('Text in the Wizard chat is not a draft.', first)


if __name__ == '__main__':
    unittest.main()
