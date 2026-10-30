"""Per-agent keys with one owner-chosen level each.

App-agnostic on purpose: Messenger uses it today and a future Wizard Mail can import the
same module with its own file name and its own route/tool map. The model is:

- The owner (signed-in browser session only) adds an agent. The key is shown ONCE; only its
  SHA-256 is stored. A new agent starts at No access: adding an agent is never a grant.
- Each agent has exactly one level: no_access, read_only, draft_only, draft_and_send.
- Levels map to generic capabilities (read, draft, send). Each app decides which of its own
  routes and tools need which capability; the app server enforces it on every request.
- Draft-only never includes 'send': provider writes for that key are impossible server-side.
  Only the owner's browser session sends a draft.

Key format: ``wzak_<12 hex id>_<secret>``. Application defense in depth, not protection
against host root or an agent that also has host-admin tools.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

LEVELS = ('no_access', 'read_only', 'draft_only', 'draft_and_send')
LABELS = dict(zip(LEVELS, ('No access', 'Read-only', 'Draft-only', 'Draft-and-send')))
RECOMMENDED = 'draft_only'
CAPABILITIES = {'no_access': frozenset(), 'read_only': frozenset({'read'}),
                'draft_only': frozenset({'read', 'draft'}),
                'draft_and_send': frozenset({'read', 'draft', 'send'})}
PREFIX = 'wzak_'
KEY_RE = re.compile(r'wzak_([0-9a-f]{12})_([A-Za-z0-9_-]{32,64})')
MAX_AGENTS = 32


class AgentKeyError(ValueError):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def allows(level, capability):
    return capability in CAPABILITIES.get(level, frozenset())


def _digest(secret):
    return hashlib.sha256(secret.encode()).hexdigest()


class AgentKeys:
    def __init__(self, root=None, app='messenger', filename='agent-keys.json'):
        self.app = app
        self.path = Path(root) / filename if root else None
        self.lock = threading.RLock()
        self.agents = {}
        if self.path and self.path.exists():
            try:
                data = json.loads(self.path.read_text())
                if data.get('version') == 1 and isinstance(data.get('agents'), dict):
                    for ident, row in data['agents'].items():
                        if (re.fullmatch(r'[0-9a-f]{12}', ident) and isinstance(row, dict)
                                and row.get('level') in LEVELS and isinstance(row.get('hash'), str)):
                            self.agents[ident] = row
            except (OSError, ValueError, TypeError, AttributeError):
                self.agents = {}  # Corrupt file: every key fails closed until the owner re-adds.

    # ---- persistence ----
    def _save(self):
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        with open(tmp, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
            os.chmod(tmp, 0o600)
            json.dump({'version': 1, 'app': self.app, 'agents': self.agents}, f)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)

    @staticmethod
    def public(row):
        return {'id': row['id'], 'name': row['name'], 'level': row['level'], 'label': LABELS[row['level']],
                'created': row.get('created'), 'last_used': row.get('last_used'),
                'key_hint': PREFIX + row['id'] + '_…'}

    # ---- owner operations (the caller must already be the owner's browser session) ----
    def list(self):
        with self.lock:
            return sorted((self.public(r) for r in self.agents.values()), key=lambda r: (r['created'] or 0, r['id']))

    def create(self, name):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 60 or any(ord(c) < 32 for c in name):
            raise AgentKeyError('invalid_agent', 'Give the agent a name (up to 60 characters)')
        with self.lock:
            if len(self.agents) >= MAX_AGENTS:
                raise AgentKeyError('agent_limit', 'Remove an agent first', 429)
            ident = secrets.token_hex(6)
            while ident in self.agents:
                ident = secrets.token_hex(6)
            secret = secrets.token_urlsafe(32)
            row = {'id': ident, 'name': name.strip(), 'level': 'no_access', 'hash': _digest(secret),
                   'created': int(time.time() * 1000), 'last_used': None}
            self.agents[ident] = row
            self._save()
            # The only time the key exists outside the agent's own configuration.
            return {'agent': self.public(row), 'key': PREFIX + ident + '_' + secret}

    def set_level(self, ident, level):
        if level not in LEVELS:
            raise AgentKeyError('invalid_policy', 'Choose No access, Read-only, Draft-only or Draft-and-send')
        with self.lock:
            row = self.agents.get(ident)
            if row is None:
                raise AgentKeyError('not_found', 'Agent not found', 404)
            row['level'] = level
            self._save()
            return self.public(row)

    def remove(self, ident):
        with self.lock:
            if self.agents.pop(ident, None) is None:
                raise AgentKeyError('not_found', 'Agent not found', 404)
            self._save()
            return {'removed': True}

    # ---- request authentication ----
    def lookup(self, authorization):
        """'Bearer wzak_…' -> public agent row, or None. Constant-time on the secret."""
        if not isinstance(authorization, str) or not authorization.startswith('Bearer '):
            return None
        match = KEY_RE.fullmatch(authorization[7:])
        if not match:
            return None
        with self.lock:
            row = self.agents.get(match.group(1))
            if row is None or not hmac.compare_digest(_digest(match.group(2)), row['hash']):
                return None
            now = int(time.time() * 1000)
            if not row.get('last_used') or now - row['last_used'] > 60000:
                row['last_used'] = now
                try: self._save()
                except OSError: pass
            return self.public(row)


if __name__ == '__main__':
    # Trusted local operator hook (inside the container). Prints the key once; the new agent
    # starts at No access, so this is never a grant. The owner picks the level in Messenger.
    import argparse
    parser = argparse.ArgumentParser(description='Add or list Messenger agents')
    parser.add_argument('command', choices=['add', 'list'])
    parser.add_argument('--name', default='Agent')
    parser.add_argument('--data', default=os.environ.get('MESSENGER_DATA', '/data'))
    args = parser.parse_args()
    os.umask(0o077)
    keys = AgentKeys(args.data)
    if args.command == 'add':
        print(json.dumps(keys.create(args.name)))
    else:
        print(json.dumps(keys.list(), indent=1))
