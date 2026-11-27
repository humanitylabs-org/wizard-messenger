"""The call door (issue 445, switch `calls`): Element Call, served from the owner's own box.

Element Call (the pinned embedded build, which works under any path) is the call screen. It speaks Matrix to the box's
own Synapse and media to the box's own LiveKit, and this door is the only way in for both:

- The owner reaches it inside Messenger at `<app path>call/` (web.py, behind the owner's Messenger session).
- A guest reaches it on its own call-only listener (CALL_PORT), which serves nothing of Messenger. A guest gets in only
  through a call's join link (`/c/<key>`), which leaves a cookie for that one call; Element Call then asks for a name
  and the door makes a guest account, puts it in that one call room and nothing else.

Every Matrix request passes `allowed()`: only what a call needs, only the caller's own call room, and only for accounts
the door made itself (owner or guest). Admin, directory, room-creation and every other room's endpoints never pass.
LiveKit's signalling is passed on as a WebSocket at `<door>/livekit/`; its media never comes through here.

A call ends when nobody has been in it for IDLE seconds (or after MAX_AGE): its guest accounts are then deactivated.
With the switch off the door answers 404 to everything and LiveKit is stopped (calls.py).

Never log tokens, keys or the link: they are the guests' only credentials.
"""
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast
from urllib.parse import quote, unquote, urlsplit

import calls

MATRIX_URL = os.environ.get('MATRIX_URL', 'http://matrix:8008')
LIVEKIT = (os.environ.get('MESSENGER_LIVEKIT_HOST', 'livekit'), 7880)
APP_DIR = Path(os.environ.get('MESSENGER_CALL_APP', '/opt/element-call'))
CALL_PORT = 8790
IDLE = 600          # a call nobody is in for 10 minutes has ended
MAX_AGE = 12 * 3600  # and no call lasts longer than this
MAX_GUESTS = 8
BOT = 'calls'
MEMBER_TYPES = ('m.rtc.member', 'org.matrix.msc3401.call.member')

CLIENT = re.compile(r'/_matrix/client/(v1|v3|r0|unstable/[A-Za-z0-9._-]+)/(.+)')
ROOM_ID = r'![^/]+'
# Every account the door makes (callers and its own bot); nothing else on the box is visible to a caller.
DOOR_USER = r'@(?:(?:guest|owner)-[0-9a-f]{12}|%s(?:-[0-9a-f]{8})?):%s' % (BOT, re.escape(calls.SERVER_NAME))


def callers_only(rest, body):
    """Key look-ups, key claims and to-device messages may name only door accounts (other callers)."""
    if rest not in ('keys/query', 'keys/claim') and not rest.startswith('sendToDevice/'):
        return True
    try:
        data = json.loads(body or b'{}')
    except ValueError:
        return False
    if not isinstance(data, dict):
        return False
    if rest in ('keys/query', 'keys/claim'):
        users = (data.get('device_keys') if rest == 'keys/query' else data.get('one_time_keys')) or {}
    else:
        users = data.get('messages') or {}
    return isinstance(users, dict) and all(isinstance(u, str) and re.fullmatch(DOOR_USER, u) for u in users)


class DoorError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _hs(method, path, body=None, token=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(MATRIX_URL + path, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b'{}')
        except ValueError:
            return e.code, {}


def allowed(method, rest, user, room):
    """May `user` (a door account in call room `room`) make this client-API request? `rest` is the path after
    `/_matrix/client/<version>/`, still URL-encoded."""
    segments = [unquote(x) for x in rest.split('/')]
    if any('/' in x or x in ('.', '..') for x in segments):
        return False  # an encoded slash or a dot segment never names a call path
    path = '/'.join(segments)
    me = re.escape(user)
    if method == 'GET' and re.fullmatch(r'(?:account/whoami|capabilities|sync|voip/turnServer|pushrules/?.*|'
                                        r'room_keys/version|devices|media/config|thirdparty/protocols)', path):
        return True
    if re.fullmatch(r'keys/(?:upload|query|claim|changes|signatures/upload|device_signing/upload)', path):
        return True
    if re.fullmatch(r'sendToDevice/[^/]+/[^/]+', path) and method == 'PUT':
        return True
    if re.fullmatch(r'rtc/.+', path):
        return True  # MatrixRTC: transports, LiveKit tokens (checked by lk-jwt-service against room membership)
    if re.fullmatch(r'delayed_events(?:/.*)?', path):
        return True  # a dropped caller leaves the call (MSC4140); only the caller's own delayed events
    if re.fullmatch(r'user/%s/(?:filter(?:/[^/]+)?|account_data/[^/]+|rooms/%s/account_data/[^/]+)' % (me, re.escape(room)), path):
        return True
    if re.fullmatch(r'profile/%s(?:/displayname|/avatar_url)?' % me, path):
        return True
    if method == 'GET' and re.fullmatch(r'profile/%s(?:/displayname|/avatar_url)?' % DOOR_USER, path):
        return True  # other callers' names; never the owner's chat contacts
    if re.fullmatch(r'presence/%s/status' % me, path):
        return True
    if method == 'POST' and path in ('join/' + room, 'rooms/%s/join' % room, 'logout'):
        return True
    m = re.fullmatch(r'rooms/(%s)/(.+)' % ROOM_ID, path)
    if m and m.group(1) == room and not re.match(r'(?:invite|ban|kick|unban|upgrade|forget)\b', m.group(2)):
        return True
    return False


class Door:
    """Calls on this box: their rooms, links and accounts. State is in <data>/calls/door.json (0600)."""

    def __init__(self, root, app=APP_DIR):
        self.root = Path(root)
        self.app = Path(app)
        self.path = self.root / 'calls' / 'door.json'
        self.lock = threading.RLock()
        self.who = {}  # access-token digest -> (user id, until)
        self.stop = threading.Event()

    # -- state ---------------------------------------------------------------------------------------------------
    def on(self):
        return calls.switch_on(self.root)

    def _load(self):
        try:
            state = json.loads(self.path.read_text())
        except (OSError, ValueError):
            state = {}
        if not isinstance(state, dict):
            state = {}
        state.setdefault('calls', {})
        state.setdefault('accounts', {})
        return state

    def _save(self, state):
        calls._write(self.path, json.dumps(state, indent=1))

    def _shared_key(self):
        return (self.root / 'matrix' / 'registration_shared_secret').read_text().strip()

    def _register(self, localpart, admin=False):
        """A new account on the box's Synapse through the shared-secret admin registration. Returns the login."""
        status, nonce = _hs('GET', '/_synapse/admin/v1/register')
        if status != 200:
            raise DoorError(503, 'M_UNKNOWN', 'The call server is starting, try again in a moment')
        # The account signs in with the access token it gets here; its login word is random and never kept.
        throwaway = secrets.token_urlsafe(24)
        # Synapse's shared-secret registration is an HMAC-SHA1 over these fields (its protocol, not a stored hash).
        mac = hmac.new(self._shared_key().encode(), b'\x00'.join([
            nonce['nonce'].encode(), localpart.encode(), throwaway.encode(), b'admin' if admin else b'notadmin']),
            hashlib.sha1).hexdigest()
        status, login = _hs('POST', '/_synapse/admin/v1/register', {
            'nonce': nonce['nonce'], 'username': localpart, 'password': throwaway, 'admin': admin, 'mac': mac})
        if status != 200 or not login.get('access_token'):
            raise DoorError(503, 'M_UNKNOWN', 'Could not make a call account')
        return login

    def bot(self):
        """The door's own admin account: it makes call rooms, invites callers and ends calls."""
        with self.lock:
            state = self._load()
            token = state.get('door_bot')
            if token and _hs('GET', '/_matrix/client/v3/account/whoami', token=token)[0] == 200:
                return token
            try:
                login = self._register(BOT, admin=True)
            except DoorError:
                # Its first account exists already but this box lost its token (a restored backup): a new one.
                login = self._register(BOT + '-' + secrets.token_hex(4), admin=True)
            state = self._load()
            state['door_bot'] = login['access_token']
            self._save(state)
            return login['access_token']

    # -- calls ---------------------------------------------------------------------------------------------------
    def start(self, title='Call'):
        """A new call: its room (no one else in it), its join-link key and its media key. Returns the call."""
        if not self.on():
            raise DoorError(404, 'M_NOT_FOUND', 'Calls are off')
        token = self.bot()
        status, made = _hs('POST', '/_matrix/client/v3/createRoom', {
            'name': str(title)[:80] or 'Call', 'preset': 'private_chat', 'visibility': 'private',
            'creation_content': {'m.federate': False},
            'power_level_content_override': {
                'users_default': 0, 'events_default': 0, 'state_default': 50,
                'events': {t: 0 for t in MEMBER_TYPES}, 'invite': 100, 'kick': 100, 'ban': 100, 'redact': 100}},
            token=token)
        if status != 200:
            raise DoorError(503, 'M_UNKNOWN', 'Could not start the call')
        call = {'id': secrets.token_hex(8), 'room': made['room_id'], 'key': secrets.token_urlsafe(24),
                'owner_key': secrets.token_urlsafe(24),
                'password': secrets.token_urlsafe(18), 'title': str(title)[:80] or 'Call', 'created': time.time(),
                'active': time.time(), 'ended': None}
        with self.lock:
            state = self._load()
            state['calls'][call['id']] = call
            self._save(state)
        return call

    def call(self, call_id):
        with self.lock:
            call = self._load()['calls'].get(call_id)
        return call if call and not call.get('ended') else None

    def by_key(self, key, owner=False):
        """The live call whose guest key (or, inside Messenger, owner key) this is."""
        if not isinstance(key, str) or not key:
            return None
        field = 'owner_key' if owner else 'key'
        with self.lock:
            for call in self._load()['calls'].values():
                if not call.get('ended') and isinstance(call.get(field), str) and hmac.compare_digest(call[field], key):
                    return call
        return None

    def join(self, call, display_name, owner=False):
        """Make a call account for one person and put it in the call's room. Returns Element Call's session."""
        if not self.on():
            raise DoorError(404, 'M_NOT_FOUND', 'Calls are off')
        with self.lock:
            state = self._load()
            guests = [a for a in state['accounts'].values() if a['call'] == call['id'] and not a.get('owner')]
            if not owner and len(guests) >= MAX_GUESTS:
                raise DoorError(403, 'M_LIMIT_EXCEEDED', 'This call is full')
        login = self._register(('owner-' if owner else 'guest-') + secrets.token_hex(6))
        user = login['user_id']
        name = ' '.join(str(display_name or '').split())[:60] or ('Owner' if owner else 'Guest')
        _hs('PUT', '/_matrix/client/v3/profile/%s/displayname' % quote(user), {'displayname': name},
            token=login['access_token'])
        status, _ = _hs('POST', '/_matrix/client/v3/rooms/%s/invite' % quote(call['room']), {'user_id': user},
                        token=self.bot())
        if status != 200:
            raise DoorError(503, 'M_UNKNOWN', 'Could not add you to the call')
        with self.lock:
            state = self._load()
            state['accounts'][user] = {'call': call['id'], 'owner': bool(owner), 'made': time.time()}
            self._save(state)
        return {'user_id': user, 'access_token': login['access_token'], 'device_id': login['device_id']}

    def account(self, token):
        """(user id, call) for a door account's access token, else None. Cached for a minute."""
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        user, until = self.who.get(digest, (None, 0))
        if until < time.time():
            status, who = _hs('GET', '/_matrix/client/v3/account/whoami', token=token)
            user = who.get('user_id') if status == 200 else None
            self.who[digest] = (user, time.time() + 60)
        if not user:
            return None
        with self.lock:
            state = self._load()
            acc = state['accounts'].get(user)
            call = state['calls'].get(acc['call']) if acc else None
        if not call or call.get('ended'):
            return None
        return user, call

    def members(self, call):
        """How many people are in the call now (their MatrixRTC memberships in the room)."""
        status, events = _hs('GET', '/_matrix/client/v3/rooms/%s/state' % quote(call['room']), token=self.bot())
        if status != 200 or not isinstance(events, list):
            return None
        return sum(1 for e in events if e.get('type') in MEMBER_TYPES and e.get('content'))

    def end(self, call_id):
        """End a call: its accounts are deactivated (and so signed out) and its link stops working."""
        with self.lock:
            state = self._load()
            call = state['calls'].get(call_id)
            if not call:
                return False
            call['ended'] = call.get('ended') or time.time()
            users = [u for u, a in state['accounts'].items() if a['call'] == call_id]
            self._save(state)
        token = self.bot()
        for user in users:
            status, _ = _hs('POST', '/_synapse/admin/v1/deactivate/%s' % quote(user), {'erase': True}, token=token)
            if status == 200:
                with self.lock:
                    state = self._load()
                    state['accounts'].pop(user, None)
                    self._save(state)
        self.who.clear()
        return True

    def sweep(self, now=None):
        """End calls nobody is in (IDLE), calls past MAX_AGE, and every call once the switch is off."""
        now = now or time.time()
        with self.lock:
            live = [c for c in self._load()['calls'].values() if not c.get('ended')]
        on = self.on()
        for call in live:
            if not on or now - call['created'] > MAX_AGE:
                self.end(call['id'])
                continue
            n = self.members(call)
            if n:
                with self.lock:
                    state = self._load()
                    if call['id'] in state['calls']:
                        state['calls'][call['id']]['active'] = now
                        self._save(state)
            elif n == 0 and now - call.get('active', call['created']) > IDLE:
                self.end(call['id'])

    def busy(self):
        """A call is going on (not ended yet)."""
        with self.lock:
            return any(not c.get('ended') for c in self._load()['calls'].values())

    def guest_link(self, call):
        """The join link to send to the other person, when guests can reach this box (public_origin)."""
        origin = public_origin(self.root)
        return '%s/c/%s' % (origin, call['key']) if origin else None

    def run_sweeper(self, every=60):
        while not self.stop.wait(every):
            try:
                if self._load()['calls']:
                    self.sweep()
            except Exception:
                pass  # Synapse restarting; next round

    # -- what the browser gets -----------------------------------------------------------------------------------
    def config(self, base_url):
        """Element Call's config.json: this door is the homeserver."""
        return {'default_server_config': {'m.homeserver': {'base_url': base_url, 'server_name': calls.SERVER_NAME}},
                'features': {'feature_use_device_session_member_events': True},
                'ssla': '', 'eula': ''}

    def link(self, call, origin, prefix='', owner=False):
        """Where Element Call opens this call (the media key stays in the fragment, never sent to a server)."""
        return '%s%s/k/%s/join/#/%s?roomId=%s&password=%s&confineToRoom=true&lang=en' % (
            origin, prefix, call['owner_key' if owner else 'key'], quote(call['title'][:40] or 'call'), quote(call['room']), quote(call['password']))


def public_origin(root):
    """The guests' public address (the owner's own Cloudflare tunnel, call_cloudflare.py), or None: calls then stay on the
    owner's own devices."""
    try:
        origin = json.loads((Path(root) / 'calls' / 'public.json').read_text()).get('origin')
    except (OSError, ValueError, AttributeError):
        return None
    return origin if isinstance(origin, str) and re.fullmatch(r'https://[a-z0-9.-]+', origin) else None


def serve(handler, door, prefix, owner, target):
    """Answer one request for the door. `prefix` is the public path the door is at ('' on the guests' listener,
    '<app path>call' inside Messenger) and `target` the request path and query below it. Everything of a call is
    below `/k/<key>`, so every request names its call (Element Call sends no cookies). The guests' listener takes
    a call's guest key (its join link); inside Messenger only its owner key works, which only the owner's own
    session gets (web.py /api/view/calls). Whoever holds the key may make one call account for that call."""
    parts = urlsplit(target)
    method = handler.command
    if not door.on():
        return _json(handler, 404, {'errcode': 'M_NOT_FOUND', 'error': 'Calls are off'})
    try:
        m = re.fullmatch(r'/k/([A-Za-z0-9_-]{16,64})(/.*)?', parts.path)
        call = door.by_key(m.group(1), owner=owner) if m else None
        if not call:
            if re.search(r'/assets/[A-Za-z0-9._-]+$', parts.path) and method == 'GET':
                return _file(handler, door.app, 'assets/' + parts.path.rsplit('/', 1)[1], immutable=True)
            return _json(handler, 404, {'errcode': 'M_NOT_FOUND', 'error': 'This call has ended'})
        prefix += '/k/' + m.group(1)
        path = m.group(2) or '/'
        if path.startswith('/livekit/') or path == '/livekit':
            return _livekit(handler, path[len('/livekit'):] or '/', parts.query)
        m = CLIENT.fullmatch(path)
        if m:
            return _matrix(handler, door, prefix, owner, m.group(1), m.group(2), call, parts.query)
        if path == '/_matrix/client/versions':
            return _pass(handler, door, '/_matrix/client/versions', None)
        if method != 'GET':
            return _json(handler, 405, {'errcode': 'M_UNRECOGNIZED', 'error': 'Not here'})
        name = path.rsplit('/', 1)[-1]
        if name == 'config.json':
            return _json(handler, 200, door.config(_origin(handler) + prefix))
        m = re.search(r'/assets/([A-Za-z0-9._-]+)$', path)
        if m:
            return _file(handler, door.app, 'assets/' + m.group(1), immutable=True)
        if path.startswith('/join/') or path == '/join':
            return _file(handler, door.app, 'index.html')
        return _json(handler, 404, {'errcode': 'M_NOT_FOUND', 'error': 'Not here'})
    except DoorError as e:
        return _json(handler, e.status, {'errcode': e.code, 'error': e.message})
    except (BrokenPipeError, ConnectionResetError):
        return None


def _origin(handler):
    host = handler.headers.get('Host', 'localhost')
    proto = handler.headers.get('X-Forwarded-Proto')
    if proto not in ('http', 'https'):
        bare = host.rsplit(':', 1)[0] if not host.endswith(']') else host
        proto = 'http' if bare in ('localhost', '127.0.0.1', '[::1]') else 'https'
    return proto + '://' + host


def _json(handler, status, data, extra=()):
    body = json.dumps(data).encode()
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    for k, v in extra:
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; "
       "connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'")


def _file(handler, app, name, immutable=False):
    try:
        root = app.resolve()
        resolved = (root / name).resolve()
        if root not in resolved.parents or not resolved.is_file():
            raise OSError
        body = resolved.read_bytes()
    except OSError:
        return _json(handler, 404, {'errcode': 'M_NOT_FOUND', 'error': 'Not here'})
    mime = mimetypes.guess_type(resolved.name)[0] or 'application/octet-stream'
    if resolved.suffix == '.wasm':
        mime = 'application/wasm'
    elif resolved.suffix == '.tflite':
        mime = 'application/octet-stream'
    handler.send_response(200)
    handler.send_header('Content-Type', mime)
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'public, max-age=31536000, immutable' if immutable else 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('Referrer-Policy', 'no-referrer')
    handler.send_header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)')
    handler.send_header('Content-Security-Policy', CSP)
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler, limit=1 << 20):
    if handler.headers.get('Transfer-Encoding'):
        raise DoorError(400, 'M_BAD_JSON', 'Chunked bodies are not supported')
    try:
        length = int(handler.headers.get('Content-Length') or 0)
    except ValueError:
        length = -1
    if not 0 <= length <= limit:
        raise DoorError(413, 'M_TOO_LARGE', 'Too large')
    return handler.rfile.read(length) if length else b''


def _token(handler):
    auth = handler.headers.get('Authorization', '')
    return auth[7:] if auth.startswith('Bearer ') else None


def _matrix(handler, door, prefix, owner, version, rest, call, query):
    method = handler.command
    if rest == 'register' and method == 'POST':
        return _register(handler, door, owner, call)
    if rest == 'login' and method == 'GET':
        return _json(handler, 200, {'flows': []})
    found = door.account(_token(handler))
    if not found or found[1]['id'] != call['id']:
        return _json(handler, 401, {'errcode': 'M_UNKNOWN_TOKEN', 'error': 'This call has ended', 'soft_logout': False})
    user, call = found
    if not allowed(method, rest, user, call['room']):
        return _json(handler, 403, {'errcode': 'M_FORBIDDEN', 'error': 'Not part of this call'})
    upstream = '/_matrix/client/%s/%s%s' % (version, rest, '?' + query if query else '')
    return _pass(handler, door, upstream, _token(handler), rewrite=True, prefix=prefix, rest=rest)


def _register(handler, door, owner, call):
    """Element Call's own sign-up (it asks only for a name, which it then sets itself). The account is made for
    exactly this call, as a guest, or as the owner when it came in by the owner key inside Messenger."""
    try:
        body = json.loads(_read_body(handler, 8192) or b'{}')
    except ValueError:
        body = {}
    if not isinstance(body, dict) or not body.get('username'):
        # Element Call's first, empty request asks which steps sign-up needs: none it has to show.
        return _json(handler, 401, {'session': secrets.token_hex(8), 'flows': [{'stages': ['m.login.dummy']}], 'params': {}})
    session = door.join(call, 'Me' if owner else 'Guest', owner=owner)
    return _json(handler, 200, session)


def _swap(value, old, new):
    """`value` (parsed JSON) with every string equal to `old` replaced by `new`."""
    if isinstance(value, dict):
        return {k: _swap(v, old, new) for k, v in value.items()}
    if isinstance(value, list):
        return [_swap(v, old, new) for v in value]
    return new if value == old else value


def _swap_raw(raw, old, new):
    try:
        return json.dumps(_swap(json.loads(raw), old, new)).encode()
    except ValueError:
        return raw


def _pass(handler, door, upstream, token, rewrite=False, prefix='', rest=''):
    body = _read_body(handler) if handler.command in ('POST', 'PUT') else None
    if not callers_only(unquote(rest), body if body is not None else b'{}'):
        return _json(handler, 403, {'errcode': 'M_FORBIDDEN', 'error': 'Not part of this call'})
    if rewrite:
        # MatrixRTC names LiveKit by its address inside the box (calls.LIVEKIT_WS), and Element Call connects to the
        # address it is given. Each caller reaches it through the door it came in by (the owner inside Messenger, a
        # guest on its own listener), so each sees its own door's address: in the transports list, in the other
        # callers' memberships and in its token requests. Synapse and the token service only ever see the box's own
        # address, so every caller's membership names the same LiveKit.
        origin = _origin(handler)
        public = ('wss' if origin.startswith('https') else 'ws') + origin[origin.index(':'):] + prefix + '/livekit'
        if body:
            body = _swap_raw(body, public, calls.LIVEKIT_WS)
    req = urllib.request.Request(MATRIX_URL + upstream, data=body, method=handler.command)
    req.add_header('Content-Type', handler.headers.get('Content-Type') or 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    timeout = 45 if '/sync' in upstream else 20
    if '/sync' in upstream:
        handler.connection.settimeout(60)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError):
        return _json(handler, 502, {'errcode': 'M_UNKNOWN', 'error': 'The call server is not answering'})
    if rewrite and status == 200:
        raw = _swap_raw(raw, calls.LIVEKIT_WS, public)
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(raw)))
    handler.send_header('Cache-Control', 'no-store')
    handler.end_headers()
    handler.wfile.write(raw)


HOP = {'connection', 'upgrade', 'host', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer',
       'cookie', 'authorization', 'x-forwarded-for', 'forwarded'}


def _livekit(handler, rest, query):
    """LiveKit's signalling (WebSocket /rtc and its /rtc/validate check), passed on to the box's LiveKit."""
    if handler.command != 'GET' or not re.fullmatch(r'/rtc(?:/v1)?(?:/validate)?', urlsplit(rest).path):
        return _json(handler, 404, {'error': 'Not here'})
    try:
        up = socket.create_connection(LIVEKIT, timeout=10)
    except OSError:
        return _json(handler, 502, {'error': 'The call server is not answering'})
    lines = ['GET %s%s HTTP/1.1' % (urlsplit(rest).path, '?' + query if query else ''), 'Host: %s:%d' % LIVEKIT]
    websocket = handler.headers.get('Upgrade', '').lower() == 'websocket'
    for k, v in handler.headers.items():
        if k.lower() not in HOP:
            lines.append('%s: %s' % (k, v))
    lines += ['Connection: Upgrade', 'Upgrade: websocket'] if websocket else ['Connection: close']
    up.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))
    handler.close_connection = True
    client = handler.connection
    client.settimeout(None)
    up.settimeout(None)
    try:
        handler.wfile.flush()
    except OSError:
        pass

    def pump(src, dst):
        try:
            while True:
                chunk = src.recv(65536)
                if not chunk:
                    break
                dst.sendall(chunk)
        except OSError:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    t = threading.Thread(target=pump, args=(client, up), daemon=True)
    t.start()
    pump(up, client)
    t.join(5)
    up.close()
    return None


# -- the call-only listener for guests ---------------------------------------------------------------------------

class GuestHandler(BaseHTTPRequestHandler):
    """Everything a guest can reach: the join link, Element Call and the scoped Matrix and LiveKit passes."""
    protocol_version = 'HTTP/1.1'
    server_version = 'WizardCall'

    def log_message(self, format, *args):
        pass  # links and tokens never reach a log

    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    @property
    def door(self) -> Door:
        return cast(GuestServer, self.server).door

    def _handle(self):
        door = self.door
        path = urlsplit(self.path).path
        m = re.fullmatch(r'/c/([A-Za-z0-9_-]{16,64})', path)
        if m and self.command == 'GET':
            # A join link: open the call. The key is the link's only secret; it never leaves this origin.
            call = door.by_key(m.group(1)) if door.on() else None
            if not call:
                return _json(self, 404, {'error': 'This call has ended'})
            self.send_response(302)
            self.send_header('Location', door.link(call, '', ''))
            self.send_header('Content-Length', '0')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            return None
        # Anyone holding the link may join as a guest, with the name they give Element Call.
        return serve(self, door, '', False, self.path)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_DELETE(self):
        self._handle()


class GuestServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, door, address=('0.0.0.0', CALL_PORT)):
        self.door = door
        super().__init__(address, GuestHandler)


def start_guests(door, address=('0.0.0.0', CALL_PORT)):
    """Start the guests' call-only listener and the call sweeper (web.py, when Messenger starts)."""
    server = GuestServer(door, address)
    threading.Thread(target=server.serve_forever, daemon=True, name='call-door').start()
    threading.Thread(target=door.run_sweeper, daemon=True, name='call-sweeper').start()
    return server


def start(root, address=('0.0.0.0', CALL_PORT)):
    door = Door(root)
    return door, start_guests(door, address)
