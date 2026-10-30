"""Application-level defense in depth, not a boundary against host administrators."""
import json
import math
import os
from pathlib import Path
import re
import threading
import time
from engine import EngineError
from agent_keys import CAPABILITIES

MODES = ('no_access', 'read_only', 'draft_only', 'draft_and_send')
LABELS = dict(zip(MODES, ('No access', 'Read-only', 'Draft-only', 'Draft-and-send')))
PUBLIC = {('GET', '/healthz'), ('GET', '/api/status'), ('GET', '/api/identity'),
          ('POST', '/api/view/ticket'), ('POST', '/mcp')}
READS = [r'/api/(?:setup|contacts|invites|dms)', r'/api/dms/[^/]+/messages',
         r'/api/unified/(?:people|groups|directory|updates)',
         r'/api/unified/people/[^/]+', r'/api/unified/people/[^/]+/avatar', r'/api/unified/media/[^/]+',
         r'/api/drafts(?:/[^/]+)?', r'/api/drafts/[^/]+/attachments/[^/]+']
WRITES = [r'/api/dms/[^/]+/(?:messages|retry)', r'/api/dms/[^/]+/messages/[0-9a-f]{64}/(?:edit|delete|react)',
          r'/api/unified/people/[^/]+/(?:preview|send|read|typing)',
          r'/api/unified/messages/[^/]+/(?:translate|react|edit|delete)',
          r'/api/drafts/[^/]+/(?:preview|send)']
# Draft routes an agent may use at Draft-only: create, update and discard its OWN draft
# (ownership is checked in drafts.py). Preview/send stay 'send', never 'draft'.
DRAFT_WRITES = [(r'POST', r'/api/drafts(?:/[^/]+)?'), (r'DELETE', r'/api/drafts/[^/]+'),
                (r'PUT', r'/api/drafts/[^/]+/attachments'), (r'DELETE', r'/api/drafts/[^/]+/attachments/[^/]+')]

def capability_for(method, path):
    """Route -> 'read' | 'draft' | 'send' | None (None = never for any bearer)."""
    if method == 'GET' and matches(path, READS): return 'read'
    if any(method == m and re.fullmatch(p, path) for m, p in DRAFT_WRITES): return 'draft'
    if method == 'POST' and matches(path, WRITES): return 'send'
    return None

WORDS = set('api setup contacts invites dms messages retry accept decline unified people groups directory updates media drafts agents mcp preview send read unread typing merge unmerge avatar merge-suggestions dismiss translate react edit delete labels sync view session ticket agent-access attachments'.split())
def route_shape(path):
    return '/' + '/'.join(p if p in WORDS else ':id' for p in path.split('/') if p)

def matches(path, patterns):
    return any(re.fullmatch(p, path) for p in patterns)

class AgentAccess:
    def __init__(self, root=None):
        self.root = Path(root) if root else None
        self.lock = threading.Lock()
        self.mode = 'no_access'; self.until = None; self.memory_log = []
        if self.root:
            try:
                data = json.loads((self.root / 'agent-access.json').read_text())
                # Old broad grants are deliberately NOT migrated to full access.
                if data.get('version') == 2 and data.get('mode') in MODES:
                    until = data.get('until')
                    if until is None or (type(until) in (int, float) and math.isfinite(until) and until > 0):
                        self.mode, self.until = data['mode'], until
            except (OSError, ValueError, TypeError, AttributeError):
                pass
    def effective_mode(self):
        return self.mode if self.until is None or self.until > time.time() else 'no_access'
    def active(self):
        return self.effective_mode() != 'no_access'
    def state(self, limit=50):
        return {'mode': self.effective_mode(), 'enabled': self.active(),
                'until': int(self.until * 1000) if self.until and self.active() else None,
                'log': self.recent(limit), 'label': LABELS[self.effective_mode()], 'boundary': 'Application defense in depth; not protection against host root.'}
    def configure(self, payload):
        mode = payload.get('mode')
        # Compatibility spelling narrows to messaging, never administrative access.
        if mode == 'full_access': mode = 'draft_and_send'
        # Legacy clients may revoke, never enable a broad time-limited grant.
        if mode is None and type(payload.get('minutes')) is int and payload['minutes'] == 0:
            mode = 'no_access'
        if mode not in MODES:
            raise EngineError('invalid_policy', 'Choose No access, Read-only, Draft-only or Draft-and-send', 400)
        minutes = payload.get('minutes')
        if minutes is not None and (type(minutes) is not int or not 1 <= minutes <= 1440):
            if not (mode == 'no_access' and minutes == 0):
                raise EngineError('invalid_policy', 'Expiry must be between 1 and 1440 minutes', 400)
        with self.lock:
            self.mode = mode
            self.until = time.time() + minutes * 60 if minutes and mode != 'no_access' else None
            if self.root:
                self.root.mkdir(parents=True, exist_ok=True)
                tmp = self.root / 'agent-access.tmp'
                with tmp.open('w') as f:
                    os.chmod(tmp, 0o600)
                    json.dump({'version': 2, 'mode': self.mode, 'until': self.until}, f)
                    f.flush(); os.fsync(f.fileno())
                os.replace(tmp, self.root / 'agent-access.json')
        self.record('OWNER', '/agent-access', 'changed')
        return self.state()
    def permits(self, method, path, mode=None):
        """One table for every caller. `mode` is a per-agent key's level; None means the
        legacy machine key, which uses the owner's global setting."""
        if (method, path) in PUBLIC:
            return True
        return capability_for(method, path) in CAPABILITIES.get(self.effective_mode() if mode is None else mode, ())
    def record(self, method, route, outcome, agent=None):
        entry = {'t': int(time.time()*1000), 'method': method, 'route': route, 'outcome': outcome}
        if agent: entry['agent'] = agent
        with self.lock:
            if not self.root:
                self.memory_log = (self.memory_log + [entry])[-500:]; return
            path = self.root / 'agent-access-log.jsonl'
            lines = path.read_text().splitlines()[-499:] if path.exists() else []
            lines.append(json.dumps(entry))
            tmp = self.root / 'agent-access-log.tmp'
            with tmp.open('w') as f:
                os.chmod(tmp, 0o600); f.write('\n'.join(lines) + '\n')
            os.replace(tmp, path)
    def recent(self, limit=50):
        with self.lock:
            if not self.root: return list(reversed(self.memory_log[-limit:]))
            path = self.root / 'agent-access-log.jsonl'
            if not path.exists(): return []
            return [json.loads(line) for line in reversed(path.read_text().splitlines()[-limit:]) if line.strip()]
