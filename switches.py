"""Messenger's own feature switches, kept on the box for its owner (wizard.app-switches/1).

The WizardOS Tracker's Try it toggle, Messenger's Settings and the agent all read and set the same state here, so a
switch no longer differs per device. Every switch is off until the owner turns it on. A switch that was approved
(Drafts at top, issue 150) leaves this list and its behaviour is simply on; a stored value for it is ignored.
"""
import json
import os
import tempfile
import threading
from pathlib import Path

CONTRACT = 'wizard.app-switches/1'

SWITCHES = (
    {'id': 'photo-warm', 'name': 'Photos ready on arrival',
     'description': 'The box fetches incoming photos, stickers, GIFs and videos as they arrive, so they open at once.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#162']},
    {'id': 'photo-instant', 'name': 'Photos open instantly',
     'description': 'A tapped photo shows its thumbnail at once and sharpens to a screen-size copy the box keeps; '
                    'zooming in loads the original.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#164']},
    {'id': 'viewer-placeholder', 'name': "Photos ready in Wizard's viewer",
     'description': "A photo opened in Wizard's shared viewer comes with a ready copy (the one this phone downloaded, "
                    'else its thumbnail) to show until the original is in. Save and Share still use the original.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#170']},
    {'id': 'photo-prefetch', 'name': 'Background photo download',
     'description': 'The phone quietly downloads recent photos from your newest chats, on Wi-Fi only unless you choose '
                    'Always, so they open at once.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#166']},
    {'id': 'photo-timings', 'name': 'Photo timings',
     'description': 'Messenger measures how fast photos appear (box ready on arrival, thumbnail, tap to picture, black '
                    'frames) per network and shows the numbers in Settings. Only times and sizes, never content.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#168']},
    {'id': 'row-tap-menu', 'name': 'Tap beside a message for its menu',
     'description': "On a phone, tapping the empty space to the right of someone's message opens that message's menu "
                    '(Reply, react, Select), the same one holding it opens. Tapping a photo still opens it.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#182']},
    {'id': 'list-draft-ready', 'name': 'Draft ready from the chat list',
     'description': 'Holding a chat in the list (or right-clicking it on a computer) also offers Agent keeps a draft '
                    'ready, or Stop keeping a draft ready, without opening the chat. An open chat shows a Drafts '
                    'toggle at the top, next to Catch me up.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#201']},
    {'id': 'agent-wake', 'name': 'Drafts without a schedule',
     'description': 'When someone writes in a chat with drafts on, Messenger wakes your agent (only agents with '
                    'Draft-only access) to write the draft, so no agent needs a schedule. The wake carries only which '
                    'chat, never the words. If no agent can be woken, the chat says Drafts paused.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#223']},
    {'id': 'transcript-paragraphs', 'name': 'Transcripts in paragraphs',
     'description': 'Transcribe on a voice note gives the text paragraph breaks, punctuation and capitals, through '
                    'Tinfoil. The words stay exactly as spoken; if anything would change them, the plain transcript '
                    'is saved instead. Transcripts already saved stay as they are.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#248']},
    {'id': 'reports-notifications', 'name': 'Notifications in Reports',
     'description': 'Every notification from the Notifications app (agent notes, scheduled jobs such as the Morning '
                    'Report, app alerts) also shows as a message in the pinned Reports chat, newest at the bottom, '
                    'with its title, text and link. Notifications keeps working as before; Reports stays read-only.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#276']},
    {'id': 'agent-chat-name', 'name': 'Agent chat with your agent\'s name',
     'description': 'The pinned Agent chat shows your agent\'s own name and picture, the way Wizard shows it '
                    'elsewhere, instead of the word Agent. With more than one agent, it is the one with Draft-only '
                    'access in Settings > Agents.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#277']},
    {'id': 'agent-rows-toggle', 'name': 'Hide Agent and Reports button',
     'description': 'A button beside My QR codes hides the pinned Agent and Reports chats from the list, and a second '
                    'tap shows them again. This device remembers your choice.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#291']},
    {'id': 'unread-count', 'name': 'Unread count on the phone icon',
     'description': 'Messenger tells the Wizard phone app how many chats are unread (a number only, never names or '
                    'messages), so the Messenger icon on your home screen can show it. Muted, Medium and Low '
                    'priority chats never count. Your private Messenger chats count too.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#296', 'humanitylabs-org/wizard-messenger#302']},
    {'id': 'phone-notifications', 'name': 'Messages on your phone',
     'description': 'Each new message (and an urgent ping in the Agent chat) also goes to Notifications, with the '
                    'chat name and the start of the message, so the Wizard phone app can show it as a Messenger '
                    'notification. A tap opens that chat. Muted, Medium and Low priority chats stay quiet.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#308']},
    {'id': 'share-files', 'name': 'Share files to Messenger',
     'description': 'Sharing a file from another Wizard app (a PDF, a note, a document from a chat) offers Messenger. '
                    'The file waits in the chosen chat\'s message box as an attachment, like one added with +, '
                    'until you tap Send. Files over 25 MB are too big.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#314']},
    {'id': 'video-prefetch', 'name': 'Background video download',
     'description': 'The phone also quietly downloads videos up to 25 MB from the newest messages of your newest chats, '
                    'on Wi-Fi only unless you chose Always for photos, so a tapped video plays at once from the phone. '
                    'Bigger videos still stream on tap.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#320']},
    {'id': 'agent-inbox-door', 'name': 'Agent chat through your agent inbox',
     'description': 'When your Wizard\'s agent inbox is on, the Agent chat uses it instead of its own list: each note '
                    'becomes a background task there (the tick shows once it is in), Sweep shows the same card as '
                    'Daily with one-tap answers, and urgent alerts arrive as one-line pings. With the inbox off, the '
                    'Agent chat works as before.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#325']},
)
_KNOWN = {s['id'] for s in SWITCHES}


VOTES = ('up', 'down')


class UnknownSwitch(KeyError):
    pass


class SwitchStore:
    """switches.json in Messenger's data dir: {"switches": {"<id>": true}, "feedback": {"<id>": {"tried": true,
    "vote": "up"}}}. Without a data dir, memory only. Feedback (issue 202, wizard-os 627) is what the owner did on Try
    new features: turned a switch on at least once, and an optional thumbs up or down. It stays on the box."""

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.lock = threading.Lock()
        self.memory = {}
        self.memory_feedback = {}

    def _raw(self):
        if self.path is None:
            return {'switches': dict(self.memory), 'feedback': dict(self.memory_feedback)}
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _read(self):
        values = self._raw().get('switches')
        if not isinstance(values, dict):
            return {}
        return {k: v for k, v in values.items() if k in _KNOWN and isinstance(v, bool)}

    def _feedback(self):
        values = self._raw().get('feedback')
        if not isinstance(values, dict):
            return {}
        out = {}
        for k, v in values.items():
            if k not in _KNOWN or not isinstance(v, dict):
                continue
            entry = {'tried': v.get('tried') is True}
            if v.get('vote') in VOTES:
                entry['vote'] = v['vote']
            out[k] = entry
        return out

    def _write(self, values, feedback=None):
        feedback = self._feedback() if feedback is None else feedback
        if self.path is None:
            self.memory = dict(values)
            self.memory_feedback = dict(feedback)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.switches-', dir=str(self.path.parent))
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump({'switches': values, 'feedback': feedback} if feedback else {'switches': values}, f,
                          sort_keys=True)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def is_on(self, switch_id):
        default = next((s['default'] for s in SWITCHES if s['id'] == switch_id), False)
        return self._read().get(switch_id, default)

    def listing(self):
        # Issue 217 (wizard-os docs/APP_SWITCHES.md, optional feedback fields): each switch also carries `tried` and
        # `vote` (null = no vote), so the shared Try new features section shows thumbs. The top-level `feedback` map
        # stays for Messenger's own section.
        values, feedback = self._read(), self._feedback()
        return {'contract': CONTRACT, 'switches': [
            {'id': s['id'], 'name': s['name'], 'description': s['description'],
             'on': values.get(s['id'], s['default']), 'default': s['default'], 'issues': list(s['issues']),
             'tried': feedback.get(s['id'], {}).get('tried') is True, 'vote': feedback.get(s['id'], {}).get('vote')}
            for s in SWITCHES], 'feedback': feedback}

    def vote(self, switch_id, vote):
        """Thumbs up or down (or None to take it back) for a switch on Try new features."""
        if switch_id not in _KNOWN:
            raise UnknownSwitch(switch_id)
        if vote is not None and vote not in VOTES:
            raise ValueError('vote')
        with self.lock:
            feedback = self._feedback()
            entry = dict(feedback.get(switch_id) or {'tried': False})
            entry.pop('vote', None)
            if vote:
                entry['vote'] = vote
            feedback[switch_id] = entry
            self._write(self._read(), feedback)
        return self.listing()

    def set(self, switch_id, on):
        if switch_id not in _KNOWN:
            raise UnknownSwitch(switch_id)
        with self.lock:
            values = self._read()
            default = next(s['default'] for s in SWITCHES if s['id'] == switch_id)
            if on == default:
                values.pop(switch_id, None)
            else:
                values[switch_id] = on
            feedback = self._feedback()
            if on:
                feedback[switch_id] = {**feedback.get(switch_id, {}), 'tried': True}
            self._write(values, feedback)
        return self.listing()
