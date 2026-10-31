"""The Wizard's own agents, each with one owner-chosen Messenger level. No keys to copy.

The Wizard Agent Service (the gateway every agent on this box uses for app tools) calls Messenger's
/mcp with its app grant key in X-Wizard-Grant (wizard-os spec/PERMISSIONS.md layer 2: the App
Manager mints it, keeps it in <wizard-os>/grants/agent-service.json and puts only its SHA-256 in the
`incoming` list of this app's grants file, $WIZARD_GRANTS_FILE, as `from: agent-service`). Only a
request carrying that key may name an agent in X-Wizard-Agent; Messenger then applies the level the
owner picked for that agent in Settings → Agents. The gateway authenticates each agent with the
agent's own gateway token, so an agent cannot speak as another one, and only the owner's signed-in
screen can change a level.

Levels for Wizard agents stop at Draft-only: nothing here lets an agent send. The main agent
('hermes', the Wizard's own agent) is always listed; other agents appear after their first call.
Application defense in depth, not protection against host root.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import threading
import time
from urllib.parse import unquote

LEVELS = ('no_access', 'read_only', 'draft_only')
LABELS = {'no_access': 'No access', 'read_only': 'Read-only', 'draft_only': 'Draft-only'}
MAIN = 'hermes'
AGENT_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,63}')
KEY_RE = re.compile(r'[A-Za-z0-9_-]{32,256}')
MAX_AGENTS = 32


class WizardAgentError(ValueError):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def clean_label(value, fallback):
    try:
        text = unquote(str(value or ''))
    except Exception:
        text = ''
    text = ' '.join(re.sub(r'[\x00-\x1f\x7f]', ' ', text).split())[:60]
    return text or fallback


GATEWAY = 'agent-service'
SHA256_HEX = re.compile(r'[0-9a-f]{64}')
MAX_GRANTS_FILE = 256 * 1024


class GatewayGrant:
    """The gateway's grant, from this app's grants file (only key hashes, never keys), re-read when it changes.

    A missing, oversized or malformed file holds no gateway row: the gateway is then an unknown caller.
    """
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.stamp = None
        self.hashes = ()
        self.lock = threading.Lock()

    def current(self):
        if not self.path:
            return ()
        try:
            st = self.path.stat()
        except OSError:
            return ()
        stamp = (st.st_mtime_ns, st.st_size, st.st_ino)
        with self.lock:
            if stamp != self.stamp:
                hashes = []
                try:
                    if st.st_size <= MAX_GRANTS_FILE:
                        doc = json.loads(self.path.read_text())
                        rows = doc.get('incoming') if isinstance(doc, dict) else None
                        for row in rows if isinstance(rows, list) else ():
                            if isinstance(row, dict) and row.get('from') == GATEWAY and isinstance(row.get('sha256'), str) \
                                    and SHA256_HEX.fullmatch(row['sha256']):
                                hashes.append(row['sha256'])
                except (OSError, ValueError, TypeError):
                    hashes = []
                self.hashes = tuple(hashes)
                self.stamp = stamp
            return self.hashes

    def matches(self, grant):
        hashes = self.current()
        if not hashes or not isinstance(grant, str) or not KEY_RE.fullmatch(grant):
            return False
        digest = hashlib.sha256(grant.encode()).hexdigest().encode()
        return any(hmac.compare_digest(digest, h.encode()) for h in hashes)


class WizardAgents:
    def __init__(self, root=None, filename='wizard-agents.json'):
        self.path = Path(root) / filename if root else None
        self.lock = threading.RLock()
        self.agents = {}
        if self.path and self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                rows = data.get('agents') if isinstance(data, dict) and data.get('version') == 1 else None
                for ident, row in (rows or {}).items():
                    if AGENT_ID.fullmatch(ident) and isinstance(row, dict) and row.get('level') in LEVELS:
                        self.agents[ident] = {'id': ident, 'label': clean_label(row.get('label'), ident), 'level': row['level'],
                                              'last_used': row.get('last_used') if isinstance(row.get('last_used'), int) else None}
            except (OSError, ValueError, TypeError, AttributeError):
                self.agents = {}  # Corrupt store fails closed: every agent is No access until the owner picks again.

    def _save(self):
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        with tmp.open('w') as f:
            os.chmod(tmp, 0o600)
            json.dump({'version': 1, 'agents': self.agents}, f)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def caller(self, agent_id, label=None):
        """The row a gateway call speaks for. Unknown agents are remembered at No access so the owner sees them."""
        ident = (agent_id or '').strip()
        if not AGENT_ID.fullmatch(ident):
            return None
        with self.lock:
            row = self.agents.get(ident)
            fresh = clean_label(label, 'Your Wizard agent' if ident == MAIN else ident)
            now = int(time.time() * 1000)
            if row is None:
                if len(self.agents) >= MAX_AGENTS:
                    return {'id': ident, 'label': fresh, 'level': 'no_access', 'last_used': now}
                row = self.agents[ident] = {'id': ident, 'label': fresh, 'level': 'no_access', 'last_used': now}
                self._save()
            else:
                changed = (label and row['label'] != fresh) or not row.get('last_used') or now - row['last_used'] > 60000
                if label:
                    row['label'] = fresh
                row['last_used'] = now
                if changed:
                    self._save()
            return dict(row)

    def set_level(self, agent_id, level):
        if level not in LEVELS:
            raise WizardAgentError('invalid_level', 'Choose No access, Read-only or Draft-only')
        ident = (agent_id or '').strip()
        if not AGENT_ID.fullmatch(ident):
            raise WizardAgentError('not_found', 'No such agent', 404)
        with self.lock:
            row = self.agents.get(ident)
            if row is None:
                if ident != MAIN:
                    raise WizardAgentError('not_found', 'No such agent', 404)
                row = self.agents[ident] = {'id': ident, 'label': 'Your Wizard agent', 'level': 'no_access', 'last_used': None}
            row['level'] = level
            self._save()
            return dict(row, label_level=LABELS[level])

    def list(self):
        with self.lock:
            rows = dict(self.agents)
        if MAIN not in rows:
            rows[MAIN] = {'id': MAIN, 'label': 'Your Wizard agent', 'level': 'no_access', 'last_used': None}
        out = [dict(r, main=r['id'] == MAIN, level_label=LABELS[r['level']]) for r in rows.values()]
        return sorted(out, key=lambda r: (not r['main'], r['label'].casefold()))
