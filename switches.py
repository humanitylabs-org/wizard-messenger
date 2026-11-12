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
    {'id': 'new-contact-drafts', 'name': 'Drafts to new contacts',
     'description': 'Agents with Draft-only access, and you with New chat, can start a chat with a WhatsApp number, a '
                    'Telegram @username or a LINE ID. The chat waits with its draft; nothing is sent until you tap Send.',
     'default': False,
     'issues': ['humanitylabs-org/wizard-messenger#176']},
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
