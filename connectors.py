"""Owner-only Matrix bridgev2 adapters. No account auth or network I/O on import.

Inject an authorized writer for *every* upstream mutation. In strong mode that
writer must be an external owner-controlled sender; same-host root can steal
bridge/Matrix credentials, so this module does not certify isolation.
"""
from dataclasses import dataclass
import json
from pathlib import Path
import re
import time
import threading
from urllib.parse import urlencode
from unified import fail, http
from engine import EngineError

# LINE's pinned QR poll can outlive 150s; a short HTTP timeout is not QR expiry.
LOGIN_TIMEOUT = 620
STEP_RESPONSE_WAIT = 0.25


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    port: int = 0
    flows: tuple = ()
    reason: str = ''

    @property
    def supported(self):
        return bool(self.port)


PROVIDERS = {p.id: p for p in (
    Provider('telegram', 'Telegram', 29317, ('qr', 'phone')),
    Provider('whatsapp', 'WhatsApp', 29318, ('qr', 'phone')),
    Provider('signal', 'Signal', 29328, ('qr',)),
    # Personal email/code/workspace flow from the pinned upstream; app is bot-only.
    Provider('slack', 'Slack', 29335, ('email',)),
    Provider('line', 'LINE', 29322, ('dev.highest.matrix.line.qr_login', 'dev.highest.matrix.line.email_login')),
    Provider('instagram', 'Instagram DMs', 29330, ('android', 'instagram-password')),
    Provider('kakaotalk', 'KakaoTalk', reason='No maintained compatible bridge selected; personal-account bridge support is unverified.'),
)}
MATRIX_NETWORKS = frozenset(k for k, p in PROVIDERS.items() if p.supported)
TOKEN = re.compile(r'[A-Za-z0-9_.-]{1,160}\Z')


def room_network(state):
    """Reject ambiguous bridge metadata; never classify by display name."""
    values = {e.get('content', {}).get('protocol', {}).get('id') for e in state
              if e.get('type') in ('m.bridge', 'uk.half-shot.bridge')}
    values.discard(None)
    return next(iter(values)) if len(values) == 1 and values <= MATRIX_NETWORKS else None


class Connectors:
    def __init__(self, root, owner='@owner:messenger.internal', reader=http,
                 writer=None, ensure_owner=None):
        self.root, self.owner = Path(root), owner
        self.reader, self.writer, self.ensure_owner = reader, writer, ensure_owner
        self.pending = {}
        self._lock = threading.RLock()
        self._jobs = {}
        self._starting = set()

    def provider(self, network):
        if network not in PROVIDERS:
            fail('unknown_network', 'Unknown network', 404)
        return PROVIDERS[network]

    def config(self, network):
        p = self.provider(network)
        if not p.supported:
            fail('unsupported_network', p.reason, 409)
        try:
            conf = json.loads((self.root / 'connectors.json').read_text())[network]
            token = json.loads((self.root / 'connector-secrets.json').read_text())[network]['provisioning']
            if conf.get('enabled') is not True or not isinstance(token, str) or len(token) < 16:
                raise ValueError()
            # Operator-controlled configuration, never a URL supplied by a request.
            return conf['url'], token
        except (OSError, ValueError, KeyError, TypeError):
            fail('connector_not_configured', p.label + ' is disabled or missing private provisioning configuration', 409)

    def request(self, network, path, method='GET', body=None, txn_id=''):
        base, token = self.config(network)
        query = {'user_id': self.owner}
        if txn_id:
            query['txn_id'] = txn_id
        path = '/_matrix/provision/v3' + path + '?' + urlencode(query)
        if method != 'GET':
            if self.writer is None:
                fail('sender_required', 'An authorized owner sender is required for network writes', 403)
            # The sender must enforce actor, approval, destination and intent itself.
            return self.writer(network=network, base=base, path=path,
                               method=method, body=body, token=token,
                               timeout=LOGIN_TIMEOUT if path.startswith('/_matrix/provision/v3/login/step/') else 65)
        return self.reader(base, path, method, body, token, 15)

    def status(self, network):
        p = self.provider(network)
        base = {'network': network, 'label': p.label, 'supported': p.supported,
                'state': 'unsupported' if not p.supported else 'not_configured',
                'message': p.reason, 'flows': [], 'logins': [],
                'capabilities': {'transport': 'matrix' if p.supported else None,
                                 'login_adapter': p.supported,
                                 'writer_configured': self.writer is not None,
                                 'bridge_live': False,
                                 'account_connected': False,
                                 'live_parity_verified': False,
                                 'external_sender_required_for_strong_mode': True}}
        if not p.supported:
            return base
        try:
            self.config(network)
            result = self.request(network, '/whoami')
            logins = result.get('logins') or []
            # Existing credentials aren't proof the remote account is connected.
            connected = any((l.get('state') or {}).get('state_event', l.get('state_event')) == 'CONNECTED' for l in logins)
            base['capabilities'].update(bridge_live=True, account_connected=connected)
            base.update(state='connected' if connected else ('degraded' if logins else 'disconnected'),
                        flows=[{'id': f['id'], 'name': f.get('name', f['id'])} for f in result.get('login_flows', []) if f.get('id') in p.flows],
                        logins=[{'id': l.get('id'), 'name': l.get('name'), 'state': (l.get('state') or {}).get('state_event', l.get('state_event'))} for l in logins])
        except EngineError as e:
            if e.code != 'connector_not_configured':
                base.update(state='unavailable', message='Private bridge unavailable')
        return base

    def health(self):
        """Local/dormant status only: does not start workers or contact a bridge."""
        states = {}
        for network, p in PROVIDERS.items():
            try:
                self.config(network)
                states[network] = 'configured_unprobed'
            except EngineError:
                states[network] = 'not_configured' if p.supported else 'unsupported'
        return {'state': 'ok', 'account_authentication_attempted': False, 'providers': states}

    def remember(self, network, result):
        if not isinstance(result, dict) or result.get('type') not in ('user_input', 'display_and_wait', 'complete', 'cookies', 'webauthn', 'client_http'):
            fail('unsupported_login_step', 'This upstream login step requires a newer owner UI', 409)
        # Never persist submitted fields, login tokens or QR provisioning data.
        if result['type'] == 'complete':
            self.pending.pop(network, None)
        else:
            values = [result.get(k) for k in ('login_id', 'step_id', 'type')]
            if not all(isinstance(v, str) and TOKEN.fullmatch(v) for v in values):
                fail('invalid_upstream_step', 'Invalid upstream login step', 502)
            txn_id = result.get('txn_id', '')
            if txn_id and (not isinstance(txn_id, str) or not TOKEN.fullmatch(txn_id)):
                fail('invalid_upstream_step', 'Invalid upstream login transaction', 502)
            self.pending[network] = (time.monotonic() + 900, tuple(values), txn_id)
        # Only the owner's authenticated, no-store view receives this short-lived data.
        allowed = ('login_id', 'step_id', 'txn_id', 'type', 'instructions', 'user_input', 'display_and_wait')
        if result['type'] in ('cookies', 'webauthn', 'client_http'):
            # Do not expose challenge URLs, cookies, scripts or arbitrary HTTP requests.
            return {**{k: result[k] for k in ('login_id', 'step_id', 'txn_id') if k in result},
                    'type': 'challenge', 'challenge': result['type']}
        return {k: result[k] for k in allowed if k in result}

    def advance(self, network, pending, values, fields, txn_id):
        """One upstream submission, short owner HTTP polls; no secret replay.

        Pinned bridgev2 executes the step independently of the HTTP waiter. Keep
        that waiter alive past LINE's phone poll, without holding the browser or
        proxy socket open. Cancellation invalidates locally before remote I/O.
        """
        with self._lock:
            if self.pending.get(network) is not pending:
                fail('invalid_step', 'This login was cancelled or replaced; start again', 409)
            job = self._jobs.get(network)
            if job is None:
                job = {'done': threading.Event(), 'pending': pending}
                self._jobs[network] = job
                fields = dict(fields)
                def run():
                    try:
                        job['result'] = self.request(network, '/login/step/' + '/'.join(values), 'POST', fields, txn_id)
                    except EngineError as error:
                        job['error'] = (error.code, error.message, error.status)
                    except Exception:
                        job['error'] = ('connector_failed', 'Private bridge login failed; start again', 502)
                    finally:
                        fields.clear()
                        job['done'].set()
                threading.Thread(target=run, daemon=True, name='connector-login').start()
            elif job['pending'] is not pending:
                fail('invalid_step', 'This login step was replaced; start again', 409)
        job['done'].wait(STEP_RESPONSE_WAIT)
        with self._lock:
            if self.pending.get(network) is not pending:
                fail('invalid_step', 'This login was cancelled or replaced; start again', 409)
            if not job['done'].is_set():
                return {'type': 'pending', 'login_id': values[0], 'step_id': values[1],
                        'step_type': values[2], 'txn_id': txn_id}
            if self._jobs.get(network) is not job:
                fail('invalid_step', 'This login step was already consumed', 409)
            if 'error' in job:
                # Keep only the terminal error until cancel/restart, so a browser
                # retry cannot accidentally submit credentials to a failed process.
                fail(*job['error'])
            self._jobs.pop(network, None)
            return self.remember(network, job['result'])

    def dispatch(self, method, suffix, payload):
        """Mount AFTER existing owner auth, CSRF/origin and agent-mode checks.

        GET /api/unified/connectors; GET .../<network>/status;
        POST .../<network>/{start,step,cancel,disconnect}.
        """
        if suffix == [] and method == 'GET':
            return {'providers': [self.status(n) for n in PROVIDERS]}
        if len(suffix) != 2:
            fail('not_found', 'Unknown connector route', 404)
        network, action = suffix
        p = self.provider(network)
        if method == 'GET' and action == 'status':
            return self.status(network)
        if method != 'POST':
            fail('not_found', 'Unknown connector route', 404)
        if not isinstance(payload, dict):
            fail('invalid_input', 'Expected an object')
        # Gate before owner bootstrap, which itself may mutate Matrix.
        self.config(network)
        if self.writer is None:
            fail('sender_required', 'An authorized owner sender is required for network writes', 403)
        if action == 'start':
            flow = payload.get('flow')
            if not isinstance(flow, str) or flow not in p.flows:
                fail('invalid_flow', 'Unsupported login flow')
            with self._lock:
                if network in self._starting:
                    fail('login_in_progress', 'A login is already starting. Wait before trying again.', 409)
                self._starting.add(network)
                previous = self.pending.get(network)
            try:
                if previous:
                    # A refresh can lose the browser's process ID. Retire that
                    # exact process before creating another, never orphan it.
                    try:
                        self.dispatch('POST', [network, 'cancel'], {'login_id': previous[1][0]})
                    except EngineError as error:
                        if error.code not in ('login_expired', 'login_cancelled'):
                            raise
                if self.ensure_owner:
                    self.ensure_owner()
                result = self.request(network, '/login/start/' + flow, 'POST', {})
                with self._lock:
                    return self.remember(network, result)
            finally:
                with self._lock:
                    self._starting.discard(network)
        if action == 'step':
            values = tuple(payload.get(k) for k in ('login_id', 'step_id', 'type'))
            pending = self.pending.get(network)
            if pending and pending[0] < time.monotonic():
                fail('login_expired', 'This login has expired. Start a new login.', 409)
            if not pending or pending[1] != values:
                fail('invalid_step', 'Start or resume the current owner login first', 409)
            if values[2] not in ('user_input', 'display_and_wait'):
                fail('unsupported_login_challenge', 'This verification requires a secure browser integration not available here. Finish verification in the provider app, then start again.', 409)
            fields = payload.get('fields', {})
            if not isinstance(fields, dict) or len(fields) > 16 or not all(isinstance(k, str) and TOKEN.fullmatch(k) and isinstance(v, str) and len(v) <= 4096 for k, v in fields.items()):
                fail('invalid_step', 'Invalid login input')
            txn_id = pending[2]
            if txn_id and payload.get('txn_id') != txn_id:
                fail('invalid_step', 'Login transaction changed; use the current step', 409)
            return self.advance(network, pending, values, fields, txn_id)
        if action == 'cancel':
            pending = self.pending.get(network)
            if not pending or payload.get('login_id') != pending[1][0]:
                fail('invalid_step', 'No matching login', 409)
            with self._lock:
                if self.pending.get(network) is not pending:
                    fail('invalid_step', 'This login was replaced', 409)
                self.pending.pop(network, None)
                self._jobs.pop(network, None)
            return self.request(network, '/login/cancel/' + pending[1][0], 'POST', {})
        if action == 'disconnect':
            with self._lock:
                self.pending.pop(network, None)
                self._jobs.pop(network, None)
            return self.request(network, '/logout/all', 'POST', {})
        fail('not_found', 'Unknown connector route', 404)
