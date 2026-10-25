"""Normal owner-app transport, NOT an isolation boundary or public forwarding API.

Parent must authorize the actor before invoking inbox methods. Do not inject this
in secure/external-sender mode. Endpoints are fixed at construction, never taken
from an HTTP request, and redirects are refused (including credential redirects).
"""
import hashlib
import hmac
import json
import re
from types import MappingProxyType
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from unified import fail, http
from engine import EngineError
from connectors import PROVIDERS


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalOwnerSender:
    """Narrow callback; not a general proxy. Bases are deployment constants."""
    def __init__(self, matrix='http://matrix:8008', *, bases=None):
        targets = {n: 'http://%s:%s' % (n, p.port) for n, p in PROVIDERS.items() if p.supported}
        targets['matrix'] = matrix
        if bases:
            if not set(bases) <= set(targets):
                raise ValueError('Unknown provider base')
            targets.update(bases)
        for value in targets.values():
            u = urlsplit(value)
            if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
                raise ValueError('A base must be an operator-pinned origin')
        self.bases = MappingProxyType(targets)
        self.opener = build_opener(NoRedirect)

    def __call__(self, *, network, base, path, method, body, token='', timeout=15, content_type=None):
        if base != self.bases.get(network) or method not in ('POST', 'PUT'):
            fail('sender_route_denied', 'Unapproved owner transport destination', 403)
        u = urlsplit(path)
        if u.scheme or u.netloc or u.fragment or not path.startswith('/') or '..' in path or re.search(r'%2f|%5c|%2e', path, re.I):
            # Matrix identifiers legitimately contain encoded slashes; fail closed
            # rather than let an identifier turn into a route segment.
            fail('sender_route_denied', 'Invalid owner transport route', 403)
        q = parse_qs(u.query, keep_blank_values=True)
        if network == 'matrix':
            route = u.path.removeprefix('/_matrix/client/v3')
            allowed = (
                method == 'PUT' and re.fullmatch(r'/rooms/[^/]+/(?:send/(?:m\.room\.message|m\.reaction)/[^/]+|redact/[^/]+/[^/]+|typing/%40owner%3Amessenger\.internal)', route)
                or method == 'POST' and re.fullmatch(r'/(?:join/[^/]+|rooms/[^/]+/receipt/m\.read/[^/]+)', route)
                or method == 'POST' and u.path in ('/_synapse/admin/v1/register', '/_matrix/client/v3/login')
                or method == 'POST' and u.path == '/_matrix/media/v3/upload' and set(q) == {'filename'} and q['filename'] in (['photo.jpg'], ['photo.png'], ['photo.gif'], ['photo.webp'], ['voice-message.ogg'], ['voice-message.webm'], ['voice-message.m4a'])
            )
            if u.path == '/_synapse/admin/v1/register' and (not isinstance(body, dict) or body.get('username') != 'owner' or body.get('admin') is not False):
                allowed = False
            if u.path == '/_matrix/client/v3/login' and (not isinstance(body, dict) or body.get('type') != 'm.login.password' or body.get('identifier') != {'type': 'm.id.user', 'user': '@owner:messenger.internal'}):
                allowed = False
            if u.path != '/_matrix/media/v3/upload' and q:
                allowed = False
            if not u.path.startswith('/_matrix/client/v3/') and u.path not in ('/_synapse/admin/v1/register', '/_matrix/media/v3/upload'):
                allowed = False
        else:
            route = u.path.removeprefix('/_matrix/provision/v3')
            allowed = method == 'POST' and u.path.startswith('/_matrix/provision/v3/') and (
                re.fullmatch(r'/login/(?:start/[A-Za-z0-9_.-]+|step/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:user_input|display_and_wait)|cancel/[A-Za-z0-9_.-]+)', route)
                or route == '/logout/all')
            allowed = allowed and set(q) <= {'user_id', 'txn_id'} and q.get('user_id') == ['@owner:messenger.internal']
        if not allowed:
            fail('sender_route_denied', 'Unapproved owner transport operation', 403)
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if isinstance(body, bytes):
            if u.path != '/_matrix/media/v3/upload' or content_type not in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/ogg', 'audio/webm', 'audio/mp4'):
                fail('sender_route_denied', 'Unapproved upload', 403)
            encoded = body
            headers['Content-Type'] = content_type
        else:
            encoded = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        try:
            with self.opener.open(Request(base + path, data=encoded, headers=headers, method=method), timeout=min(timeout, 65)) as response:
                return json.loads(response.read(8 * 1024 * 1024))
        except HTTPError as error:
            error.close()
            fail('owner_transport_failed', 'Private owner transport failed', 502)
        except (URLError, ValueError, OSError):
            # No raw upstream response, URL, submitted secret or QR in diagnostics.
            fail('owner_transport_failed', 'Private owner transport failed', 502)

    def bootstrap(self, inbox):
        """Local normal mode only: register or log in to the fixed private owner."""
        with inbox.lock:
            if inbox.store.get('matrix_token'):
                return inbox.store.get('matrix_token')
            keys = inbox.keys()
            nonce = http(self.bases['matrix'], '/_synapse/admin/v1/register')['nonce']
            mac = hmac.new(keys['registration'].encode(), '\0'.join([nonce, 'owner', keys['owner_password'], 'notadmin']).encode(), hashlib.sha1).hexdigest()
            try:
                result = self(network='matrix', base=inbox.matrix, path='/_synapse/admin/v1/register', method='POST', body={'nonce': nonce, 'username': 'owner', 'password': keys['owner_password'], 'admin': False, 'mac': mac})
            except EngineError:
                result = self(network='matrix', base=inbox.matrix, path='/_matrix/client/v3/login', method='POST', body={'type': 'm.login.password', 'identifier': {'type': 'm.id.user', 'user': inbox.owner}, 'password': keys['owner_password']})
            inbox.store.put('matrix_token', result['access_token'])
            return result['access_token']
