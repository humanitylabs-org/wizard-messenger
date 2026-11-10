"""Messenger's own feature switches, kept on the box for its owner (wizard.app-switches/1).

The WizardOS Tracker's Try it toggle, Messenger's Settings and the agent all read and set the same state here, so a
switch no longer differs per device. Every switch is off until the owner turns it on.
"""
import json
import os
import tempfile
import threading
from pathlib import Path

CONTRACT = 'wizard.app-switches/1'

SWITCHES = (
    {'id': 'drafts-first', 'name': 'Drafts at top',
     'description': 'Chats with a waiting draft lead the Inbox, newest draft first.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#133', 'humanitylabs-org/wizard-messenger#150']},
    {'id': 'photo-warm', 'name': 'Photos ready on arrival',
     'description': 'The box fetches incoming photos, stickers, GIFs and videos as they arrive, so they open at once.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#162']},
)
_KNOWN = {s['id'] for s in SWITCHES}


class UnknownSwitch(KeyError):
    pass


class SwitchStore:
    """switches.json in Messenger's data dir: {"switches": {"<id>": true}}. Without a data dir, memory only."""

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.lock = threading.Lock()
        self.memory = {}

    def _read(self):
        if self.path is None:
            return dict(self.memory)
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}
        values = raw.get('switches') if isinstance(raw, dict) else None
        if not isinstance(values, dict):
            return {}
        return {k: v for k, v in values.items() if k in _KNOWN and isinstance(v, bool)}

    def _write(self, values):
        if self.path is None:
            self.memory = dict(values)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.switches-', dir=str(self.path.parent))
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump({'switches': values}, f, sort_keys=True)
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
        values = self._read()
        return {'contract': CONTRACT, 'switches': [
            {'id': s['id'], 'name': s['name'], 'description': s['description'],
             'on': values.get(s['id'], s['default']), 'default': s['default'], 'issues': list(s['issues'])}
            for s in SWITCHES]}

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
            self._write(values)
        return self.listing()
