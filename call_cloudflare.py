"""The guests' public door for calls (issue 445, switch `calls`): the owner's own Cloudflare account.

Nothing listens on the box for guests (James, 27 Nov 2026: "we don't want to open the box"). When the owner has given
Messenger a Cloudflare API token, and while the `calls` switch is on, Messenger makes in that account:

- a Cloudflare Tunnel (remotely configured) whose only route is `call-<id>.<owner's domain>` -> the guests' call-only
  listener (call_door.CALL_PORT). The recipe's `call-tunnel` container runs cloudflared with the tunnel's token; it only
  dials out, so no port opens on the box. Nothing else of Messenger or Synapse is behind that route.
- the DNS record for that name (a proxied CNAME to the tunnel);
- a Cloudflare Realtime TURN key. LiveKit hands short-lived TURN logins made from it to every caller, so a guest's
  media relays through the owner's Cloudflare account to LiveKit, which only sends outbound.

Turning the switch off removes all three from the account and forgets the tunnel token and TURN logins; the API token
stays, so turning it on again makes them anew. Forgetting Cloudflare (DELETE) removes them and the token.

Needs a domain on the Cloudflare account (a tunnel's public name lives in one of the owner's zones). Without a token or
without a domain, calls stay on the owner's own devices and the call button says so.

Never print or log the files kept here: they hold the API token, the tunnel token and the TURN key.
"""
import json
import secrets
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

import calls

API = 'https://api.cloudflare.com/client/v4'
RTC = 'https://rtc.live.cloudflare.com/v1'
SERVICE = 'http://messenger:%d' % 8790  # call_door.CALL_PORT, reached over the recipe's tunnel-lane only
TURN_TTL = 48 * 3600
TURN_REFRESH = 20 * 3600
RETRY = 60
STOP_WAIT = 3  # cloudflared notices its token is gone within 2 s (the recipe's loop) before the tunnel is deleted
# The token the owner makes, pre-filled on Cloudflare's own page (their template URL). `calls` is Realtime (TURN).
PERMISSIONS = [{'key': 'argotunnel', 'type': 'edit'}, {'key': 'dns', 'type': 'edit'}, {'key': 'zone', 'type': 'read'},
               {'key': 'calls', 'type': 'edit'}]
TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens?' + urlencode({
    'permissionGroupKeys': json.dumps(PERMISSIONS, separators=(',', ':')), 'accountId': '*', 'zoneId': 'all',
    'name': 'Wizard calls'})
PERMISSION_NAMES = ['Account · Cloudflare Tunnel · Edit', 'Account · Calls · Edit', 'Zone · DNS · Edit',
                    'Zone · Zone · Read']


class CloudflareError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def http(method, url, token, body=None, timeout=20):
    """One Cloudflare API call. Returns the parsed answer; raises CloudflareError with Cloudflare's own words."""
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Content-Type', 'application/json')
    req.add_header('User-Agent', 'wizard-messenger-calls')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    except (OSError, ValueError) as e:
        raise CloudflareError(502, 'cloudflare_unreachable', 'Cloudflare could not be reached (%s)' % type(e).__name__) from None
    try:
        data = json.loads(raw or b'{}')
    except ValueError:
        data = {}
    if status >= 400 or (isinstance(data, dict) and data.get('success') is False):
        errors = data.get('errors') if isinstance(data, dict) else None
        words = '; '.join(str(e.get('message', ''))[:200] for e in errors if isinstance(e, dict)) if isinstance(errors, list) else ''
        raise CloudflareError(status if status >= 400 else 502, 'cloudflare_refused', words or 'Cloudflare said no (%d)' % status)
    return data


def ice_to_livekit(ice):
    """Cloudflare's generated iceServers -> LiveKit's rtc.turn_servers (UDP 3478, TCP 3478 and TLS 443)."""
    out = []
    for server in ice if isinstance(ice, list) else []:
        if not isinstance(server, dict) or not server.get('username'):
            continue
        urls = server.get('urls')
        for url in [urls] if isinstance(urls, str) else urls or []:
            scheme, _, rest = str(url).partition(':')
            hostport, _, query = rest.partition('?')
            host, _, port = hostport.rpartition(':')
            transport = query.partition('transport=')[2] or 'udp'
            proto = 'tls' if scheme == 'turns' else transport
            if scheme not in ('turn', 'turns') or not port.isdigit() or not host:
                continue
            if (proto, int(port)) not in (('udp', 3478), ('tcp', 3478), ('tls', 443)):
                continue
            out.append({'host': host, 'port': int(port), 'protocol': proto,
                        'username': server['username'], 'credential': server.get('credential', '')})
    return out


class Cloudflare:
    """The owner's Cloudflare link for calls. State: <data>/calls/cloudflare.json (0600)."""

    def __init__(self, root, request=http, idle=None):
        self.root = Path(root)
        self.folder = self.root / 'calls'
        self.path = self.folder / 'cloudflare.json'
        self.request = request
        self.idle = idle or (lambda: True)  # no call running: LiveKit may restart for new TURN logins
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.problem = None

    # -- state ---------------------------------------------------------------------------------------------------
    def _load(self):
        try:
            state = json.loads(self.path.read_text())
        except (OSError, ValueError):
            state = {}
        return state if isinstance(state, dict) else {}

    def _save(self, state):
        calls._write(self.path, json.dumps(state, indent=1))

    def _api(self, state, method, path, body=None):
        return self.request(method, API + path, state['token'], body)

    def status(self):
        state = self._load()
        made = state.get('made') or {}
        zone = state.get('zone') or {}
        return {
            'connected': bool(state.get('token')),
            'zone': zone.get('name'),
            'zones': [{'id': z['id'], 'name': z['name']} for z in state.get('zones') or []],
            'host': made.get('host') if made.get('tunnel') else None,
            'reach': 'everyone' if calls_public(self.root) else 'tailnet',
            'problem': self.problem,
            'token_page': TOKEN_PAGE, 'permissions': PERMISSION_NAMES,
        }

    # -- the owner's choices ---------------------------------------------------------------------------------------
    def connect(self, token):
        """Check a new API token, find its account and domains, and keep it. Then make the door if calls are on."""
        token = token.strip() if isinstance(token, str) else ''
        if not 20 <= len(token) <= 200 or not token.isprintable() or ' ' in token:
            raise CloudflareError(400, 'invalid_token', 'Paste the API token Cloudflare showed you')
        probe = {'token': token}
        accounts = [a for a in self._api(probe, 'GET', '/accounts?per_page=50').get('result') or [] if isinstance(a, dict)]
        if not accounts:
            raise CloudflareError(400, 'no_account', 'That token reaches no Cloudflare account. Make it with every account included.')
        zones = [z for z in self._api(probe, 'GET', '/zones?status=active&per_page=50').get('result') or []
                 if isinstance(z, dict) and z.get('id') and z.get('name')]
        if not zones:
            raise CloudflareError(400, 'no_domain', 'That Cloudflare account has no active domain. Calls need one for the link (add a site in Cloudflare first).')
        with self.lock:
            old = self._load()
            if old.get('made'):
                self._down(old)
            pick = zones[0] if len(zones) == 1 else None
            account = (pick or {}).get('account', {}).get('id') or accounts[0].get('id')
            self._save({'token': token, 'account': account, 'zones': [{'id': z['id'], 'name': z['name'], 'account': (z.get('account') or {}).get('id') or account} for z in zones],
                        'zone': {'id': pick['id'], 'name': pick['name']} if pick else None})
        self.problem = None
        self.kick()
        return self.status()

    def choose(self, zone_id):
        with self.lock:
            state = self._load()
            zone = next((z for z in state.get('zones') or [] if z['id'] == zone_id), None)
            if not state.get('token') or not zone:
                raise CloudflareError(400, 'unknown_domain', 'Pick one of your domains')
            if state.get('made'):
                self._down(state)
            state['zone'] = {'id': zone['id'], 'name': zone['name']}
            state['account'] = zone.get('account') or state.get('account')
            self._save(state)
        self.kick()
        return self.status()

    def forget(self):
        """Remove the door from the account and forget the token."""
        with self.lock:
            state = self._load()
            if state.get('made'):
                self._down(state)
            self.path.unlink(missing_ok=True)
        self.problem = None
        return self.status()

    # -- making and removing the door ------------------------------------------------------------------------------
    def sync(self, on=None):
        """Make the door (switch on, token and domain kept) or remove it (anything else). Idempotent."""
        on = calls.switch_on(self.root) if on is None else on
        with self.lock:
            state = self._load()
            ready = state.get('token') and state.get('zone')
            if on and ready:
                self._up(state)
                self._turn(state)
            elif state.get('made'):
                self._down(state)
            else:
                self._clear_files()
        self.problem = None

    def _up(self, state):
        made = state.setdefault('made', {})
        account, zone = state['account'], state['zone']
        if not made.get('host'):
            made['host'] = 'call-%s.%s' % (secrets.token_hex(3), zone['name'])
            made['zone'] = zone['id']
            self._save(state)
        if not made.get('tunnel'):
            tunnel = self._api(state, 'POST', '/accounts/%s/cfd_tunnel' % account,
                               {'name': 'wizard-messenger-calls-' + made['host'].split('.')[0][5:], 'config_src': 'cloudflare'})['result']
            made['tunnel'] = tunnel['id']
            self._save(state)
        if not made.get('routed'):
            self._api(state, 'PUT', '/accounts/%s/cfd_tunnel/%s/configurations' % (account, made['tunnel']), {'config': {'ingress': [
                {'hostname': made['host'], 'service': SERVICE, 'originRequest': {}},
                {'service': 'http_status:404'}]}})
            made['routed'] = True
            self._save(state)
        if not made.get('dns'):
            record = self._api(state, 'POST', '/zones/%s/dns_records' % made['zone'], {
                'type': 'CNAME', 'name': made['host'], 'content': made['tunnel'] + '.cfargotunnel.com', 'proxied': True,
                'comment': 'Wizard Messenger calls: removed when calls are turned off'})['result']
            made['dns'] = record['id']
            self._save(state)
        if not (self.folder / 'tunnel-token').exists():
            token = self._api(state, 'GET', '/accounts/%s/cfd_tunnel/%s/token' % (account, made['tunnel']))['result']
            calls._write(self.folder / 'tunnel-token', str(token))
        calls._write(self.folder / 'public.json', json.dumps({'origin': 'https://' + made['host']}))

    def _turn(self, state, force=False):
        made = state['made']
        if not made.get('turn'):
            key = self._api(state, 'POST', '/accounts/%s/calls/turn_keys' % state['account'],
                            {'name': 'wizard-messenger-calls'})['result']
            made['turn'] = key['uid']
            made['turn_key'] = key.get('key') or key.get('secret')
            made.pop('ice_at', None)
            self._save(state)
        fresh = time.time() - made.get('ice_at', 0) < TURN_REFRESH
        if fresh and not force and (self.folder / 'ice.json').exists():
            return False
        if made.get('ice_at') and not force and not self.idle():
            return False  # a call is running: its LiveKit keeps the logins it has (they last TURN_TTL)
        answer = self.request('POST', '%s/turn/keys/%s/credentials/generate-ice-servers' % (RTC, made['turn']),
                              made['turn_key'], {'ttl': TURN_TTL})
        servers = ice_to_livekit(answer.get('iceServers'))
        if not servers:
            raise CloudflareError(502, 'turn_unavailable', 'Cloudflare gave no TURN login')
        calls._write(self.folder / 'ice.json', json.dumps({'turn_servers': servers}))
        made['ice_at'] = time.time()
        self._save(state)
        calls.write_livekit(self.root)
        return True

    def _down(self, state):
        """Remove what this box made in the account. Things already gone count as removed."""
        made = state.get('made') or {}
        self._clear_files()
        if made.get('tunnel'):
            time.sleep(STOP_WAIT)
        account = state.get('account')
        steps = [('dns', lambda: self._api(state, 'DELETE', '/zones/%s/dns_records/%s' % (made['zone'], made['dns']))),
                 ('tunnel', lambda: (self._gone(lambda: self._api(state, 'DELETE', '/accounts/%s/cfd_tunnel/%s/connections' % (account, made['tunnel']))),
                                     self._api(state, 'DELETE', '/accounts/%s/cfd_tunnel/%s' % (account, made['tunnel'])))),
                 ('turn', lambda: self._api(state, 'DELETE', '/accounts/%s/calls/turn_keys/%s' % (account, made['turn'])))]
        for name, step in steps:
            if made.get(name):
                self._gone(step)
                made.pop(name, None)
                if name == 'tunnel':
                    made.pop('routed', None)
                if name == 'turn':
                    made.pop('turn_key', None)
                    made.pop('ice_at', None)
                self._save(state)
        state.pop('made', None)
        self._save(state)

    @staticmethod
    def _gone(step):
        try:
            step()
        except CloudflareError as e:
            if e.status != 404:
                raise

    def _clear_files(self):
        had = (self.folder / 'ice.json').exists()
        for name in ('tunnel-token', 'public.json', 'ice.json'):
            (self.folder / name).unlink(missing_ok=True)
        if had:
            calls.write_livekit(self.root)

    # -- the keeper thread -------------------------------------------------------------------------------------------
    def kick(self):
        self.wake.set()

    def run(self, every=600):
        """Keep the account in step with the switch: at start, on every switch change, and every `every` seconds
        (TURN logins). A failure is retried after RETRY seconds and shown to the owner."""
        while not self.stop.is_set():
            self.wake.clear()
            try:
                self.sync()
                wait = every
            except CloudflareError as e:
                self.problem = e.message
                wait = RETRY
            except Exception as e:  # never let the keeper die
                self.problem = 'Could not update Cloudflare (%s)' % type(e).__name__
                wait = RETRY
            self.wake.wait(wait)

def calls_public(root):
    try:
        origin = json.loads((Path(root) / 'calls' / 'public.json').read_text()).get('origin')
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(origin, str) and origin.startswith('https://')

