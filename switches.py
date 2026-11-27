"""Messenger's own feature switches, kept on the box for its owner (wizard.app-switches/1).

The WizardOS Tracker's Try it toggle, Messenger's Settings and the agent all read and set the same state here, so a
switch no longer differs per device. Every switch is off until the owner turns it on. A switch that was approved
(Drafts at top, issue 150; the photo speed switches, issue 468; New group, issue 397; Add contact on Telegram, issue 399) leaves this list and its behaviour is simply on; a stored value for it is ignored.
"""
import json
import os
import tempfile
import threading
from pathlib import Path

CONTRACT = 'wizard.app-switches/1'

SWITCHES = (
    {'id': 'photo-timings', 'name': 'Photo timings',
     'description': 'Messenger measures how fast photos appear (box ready on arrival, thumbnail, tap to picture, black '
                    'frames) per network and shows the numbers in Settings. Only times and sizes, never content.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#168']},
    {'id': 'synapse-postgres', 'name': 'Postgres message store and longer history',
     'description': 'The next time Messenger starts (its next update or a restart), the box checks and backs up the '
                    'store behind your bridged chats and moves it from SQLite to Postgres. After that it brings in up '
                    'to 200 Telegram chats and up to 500 earlier messages for each new or reconnected chat. Chats '
                    'already there keep the history they have. Once moved, it stays on Postgres.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#451']},
    {'id': 'calls', 'name': 'Calls',
     'description': 'Encrypted voice and video calls from your own Wizard. Turning it on starts the call server on '
                    'your box (LiveKit); turning it off stops it again.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#445']},
    {'id': 'full-reactions', 'name': 'Any emoji as a reaction',
     'description': 'The ＋ next to the reactions on a message opens the full emoji panel (search, categories, Recent), '
                    'so any emoji can be a reaction, like Telegram. The quick row shows the reactions you use most. '
                    'Chats that only allow some reactions show only those.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#471']},
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
        # Issue 445: what runs when a switch is set (id -> fn(on)), e.g. the calls switch starts or stops LiveKit.
        self.changed = {}

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
            if switch_id in self.changed:
                self.changed[switch_id](values.get(switch_id, default))
        return self.listing()
