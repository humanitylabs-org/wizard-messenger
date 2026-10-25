"""Draft-only HTTPS adapter. Independent host/credential separation is the boundary.

No owner credential, approval, full-send, redirect, proxy or local-send capability.
Configuration is host-owned, never accepted in an HTTP request. stdlib only.
"""
import json
import os
from pathlib import Path
import re
import ssl
import sqlite3
from http.client import HTTPSConnection
from urllib.parse import urlsplit
from engine import EngineError


def unavailable():
    raise EngineError('authority_unavailable', 'Independent review unavailable; no local fallback. Retry this frozen revision.', 503)


class RemoteAuthority:
    def __init__(self, config=None):
        self.config = config
        self.endpoint = None
        if config is not None:
            allowed = {'independent_endpoint', 'wizard_origin', 'owner_verified_independent_host', 'draft_key_file', 'accounts'}
            if set(config) != allowed or config['owner_verified_independent_host'] is not True:
                raise ValueError('Independent endpoint must be explicitly owner-attested')
            endpoint = config['independent_endpoint']
            remote, local = urlsplit(endpoint), urlsplit(config['wizard_origin'])
            if (remote.scheme != 'https' or not remote.hostname or remote.port not in (443, None)
                    or remote.path or remote.query or remote.fragment or remote.username or remote.password
                    or remote.hostname == local.hostname or remote.hostname in ('localhost', '127.0.0.1', '::1')
                    or not re.fullmatch(r'[a-zA-Z0-9.-]+', remote.hostname)):
                raise ValueError('Dedicated independent HTTPS origin required')
            if not Path(config['draft_key_file']).is_absolute():
                raise ValueError('Absolute draft-only key file required')
            if not isinstance(config['accounts'], dict) or not config['accounts']:
                raise ValueError('Explicit network to independent account map required')
            for network, account in config['accounts'].items():
                if not isinstance(network, str) or not isinstance(account, str) or not account.strip():
                    raise ValueError('Invalid independent account mapping')
            self.endpoint = endpoint
            self.hostname = remote.hostname

    @classmethod
    def from_environment(cls):
        path = os.environ.get('MESSENGER_AUTHORITY_CONFIG')
        return cls(json.loads(Path(path).read_text()) if path else None)

    def _request(self, method, path, payload=None):
        if not self.endpoint:
            unavailable()
        # Direct connection: HTTPSConnection never reads proxy environment, follows
        # redirects, or disables certificate/hostname verification. No tunable CA/TLS.
        conn = HTTPSConnection(self.hostname, 443, timeout=15,
                                           context=ssl.create_default_context())
        try:
            headers = {'Accept': 'application/json'}
            if path != '/health':
                key = Path(self.config['draft_key_file']).read_text().strip()
                if not re.fullmatch(r'[A-Za-z0-9_\-]{32,256}', key):
                    unavailable()
                headers['Authorization'] = 'Bearer ' + key
            body = json.dumps(payload).encode() if payload is not None else None
            if body is not None:
                headers['Content-Type'] = 'application/json'
            conn.request(method, path, body, headers)
            response = conn.getresponse()
            if response.status != 200:
                unavailable()  # Includes redirects and all auth/protocol failures.
            raw = response.read(131073)
            if len(raw) > 131072:
                unavailable()
            return json.loads(raw)
        except Exception:
            unavailable()  # Never leak key, payload or provider errors.
        finally:
            conn.close()

    def state(self):
        if not self.endpoint:
            return {'ready': False, 'reason': 'Owner has not configured a trusted independent HTTPS authority.'}
        try:
            status = self._request('GET', '/health')
            if status != {'service': 'independent-owner-authority', 'backend': 'matrix', 'production_send': True}:
                return {'ready': False, 'reason': 'Independent authority does not advertise the Matrix sender backend.'}
            return {'ready': True, 'review_origin': self.endpoint,
                    'reason': 'Owner-attested separate host; independent passkey review required. Not proof of host separation.'}
        except EngineError:
            return {'ready': False, 'reason': 'Independent authority unavailable. No local fallback.'}

    def exact(self, row, unified):
        if not self.endpoint:
            unavailable()
        _, identity = unified.channel(row['person_id'], row['identity_id'])
        account = self.config['accounts'].get(identity['network'])
        room = identity['address']
        if not account or not isinstance(room, str) or not re.fullmatch(r'![^\s:]+:[^\s]+', room):
            raise EngineError('authority_destination', 'This local identity has no configured independent Matrix account/room.', 409)
        return {'account': account, 'recipient': room, 'body': row['text'], 'attachments': []}

    def submit(self, export):
        if export['authority_origin'] != self.endpoint:
            unavailable()
        if not self.state()['ready']:
            unavailable()
        result = self._request('POST', '/agent/drafts', export['payload'])
        return self._result(result, export)

    def refresh(self, export):
        if export['authority_origin'] != self.endpoint:
            unavailable()
        result = self._request('GET', '/agent/drafts/' + export['remote_id'])
        return self._result(result, export)

    def _result(self, result, export):
        ident = result.get('id', '')
        if (not re.fullmatch(r'[A-Za-z0-9_-]{16,128}', ident)
                or result.get('request_id') != export['payload']['request_id']
                or ('remote_id' in export and ident != export['remote_id'])):
            unavailable()
        try:
            exact = json.loads(result['payload'])
            expected = export['payload']
            if any(exact.get(k) != expected[k] for k in ('account', 'recipient', 'body', 'attachments')):
                unavailable()
            if result.get('status') not in ('pending', 'matrix-queued', 'matrix-delivered'):
                unavailable()
        except (KeyError, TypeError, ValueError):
            unavailable()
        # Link only a configured standalone origin: no secrets, query, fragments or
        # caller-/server-supplied URLs. Owner UI lists pending drafts after unlock.
        return {'remote_id': ident, 'remote_status': result.get('status'),
                'review_origin': self.endpoint}


def remote_required_gate(method, path):
    """Explicit allowlist BEFORE every legacy app/provider dispatcher, including GET provisioning."""
    safe = {'/healthz', '/api/status', '/api/identity', '/api/view/session', '/api/view/authority'}
    if path == '/api/view/agent-access':
        return  # Owner/CSRF enforced downstream; this cannot override this gate.
    if path.startswith('/api/view/passkey') or path == '/api/view/unlock':
        return  # Local browser authentication only; OfflineEngine has no provider operations.
    if method == 'GET' and (path in safe or path in ('/api/unified/directory', '/api/unified/status')):
        return
    if path == '/api/drafts' or path.startswith('/api/drafts/'):
        if path.endswith('/send') or path.endswith('/preview'):
            raise EngineError('remote_required', 'Only the independent authority may review and send.', 403)
        return
    raise EngineError('remote_required', 'Local provider operations and provisioning disabled. Live restricted read facade is not implemented.', 403)


class OfflineEngine:
    """No local engine process/provider callbacks in remote-required deployment."""
    def __init__(self, data):
        if not data:
            raise ValueError('Persistent credential-free directory required')
        self.data = Path(data)
        allowed = {'unified', 'agent-drafts.json', 'browser-auth.json', 'passkeys.json', 'agent-access.json', 'agent-access-log.jsonl'}
        if any(p.name not in allowed for p in self.data.glob('*')):
            raise ValueError('remote-required rejects legacy engine/provider data; provision fresh credential-free snapshot')
        self.relays = []

    def status(self):
        return {'state': 'ready', 'account_configured': True, 'remote_required': True,
                'live_read_facade': False}

    def identity(self):
        return {'identity': None}

    def setup(self, payload):
        if payload.get('action') != 'unlock':
            raise EngineError('remote_required', 'No local engine provisioning', 403)
        return self.status()

    def lock(self):
        pass


class CachedDirectory:
    """Offline identity snapshot only; NOT a live restricted provider read facade."""
    def __init__(self, data):
        from unified import PeopleStore
        root = Path(data) / 'unified'
        # Do not silently reuse any normal local deployment directory. Operators
        # must provision a credential-free snapshot in a fresh data directory.
        if any(p.name != 'people.sqlite3' and not p.name.startswith('people.sqlite3-') for p in root.glob('*')):
            raise ValueError('remote-required needs a fresh credential-free offline directory')
        path = root / 'people.sqlite3'
        if path.exists():
            with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
                if db.execute('SELECT 1 FROM kv LIMIT 1').fetchone():
                    raise ValueError('Local Matrix/bridge credentials forbidden in remote-required mode')
        if any(k.startswith(('MATRIX_', 'TELEGRAM_BRIDGE_', 'MESSENGER_BRIDGE_')) for k in os.environ):
            raise ValueError('Local provider configuration forbidden in remote-required mode')
        self.store = PeopleStore(path)

    def channel(self, person_id, identity_id):
        person = self.store.person(person_id)
        identity = next((i for i in person['identities'] if i['id'] == identity_id), None)
        if identity is None:
            raise EngineError('invalid_identity', 'Choose this person’s channel', 400)
        return person, identity

    def start(self):
        pass

    def close(self):
        if self.store._conn:
            self.store._conn.close()

    def dispatch(self, method, path, payload, query=None, raw=None):
        if method == 'GET' and path == '/api/unified/directory':
            return {'people': self.store.people('person', chats=False),
                    'groups': self.store.people('group', chats=False)}
        if method == 'GET' and path == '/api/unified/status':
            return {'state': 'offline', 'reason': 'Credential-free snapshot only; live restricted read facade missing.'}
        raise EngineError('remote_required', 'Live restricted read facade is not implemented', 403)
