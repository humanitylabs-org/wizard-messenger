"""Fixed Matrix client-server adapter, not a provisioning or HTTP proxy.

Only owner-local configuration supplies hosts, pinned DNS addresses and tokens.
No environment proxies, redirects, arbitrary methods/URLs, or media downloads.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import json
from pathlib import Path
import re
import socket
import ssl
import stat
from urllib.parse import quote, urlsplit

from pydantic import BaseModel, ConfigDict, Field


class MatrixError(Exception):
    """Deliberately redacted: remote responses/tokens never enter public errors."""


class MatrixAccount(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)
    homeserver: str
    user_id: str
    token_file: str
    rooms: list[str] = Field(min_length=1)

    def checked(self):
        u = urlsplit(self.homeserver)
        if (u.scheme != 'https' or not u.hostname or u.username or u.password
                or u.port not in (None, 443) or u.path or u.query or u.fragment
                or not re.fullmatch(r'[A-Za-z0-9.-]+', u.hostname)):
            raise ValueError('Matrix requires a fixed HTTPS origin on port 443')
        if not self.user_id.startswith('@') or ':' not in self.user_id:
            raise ValueError('Matrix user ID required')
        if any(not r.startswith('!') or ':' not in r or len(r) > 500 for r in self.rooms):
            raise ValueError('explicit Matrix room IDs required; aliases are forbidden')
        if not Path(self.token_file).is_absolute():
            raise ValueError('absolute owner-host token file required')
        return self


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, 443, timeout=15, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # DNS is never consulted here. SNI/certificate validation uses the fixed host.
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class MatrixSender:
    def __init__(self, accounts):
        self.accounts = accounts
        self.addresses = {}
        self.token_hashes = {}
        for name, account in accounts.items():
            account.checked()
            self.addresses[name] = self.resolve(urlsplit(account.homeserver).hostname)
            self.token_hashes[name] = hashlib.sha256(self.token(account).encode()).hexdigest()

    @staticmethod
    def token(account):
        p = Path(account.token_file)
        st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
            raise MatrixError('Matrix token file must be private regular file')
        token = p.read_text().strip()
        if not token or len(token) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise MatrixError('invalid Matrix token file')
        return token

    @staticmethod
    def resolve(host):
        addresses = sorted({a[4][0] for a in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
        if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise ValueError('Matrix DNS must resolve only to public global addresses; private/link-local/loopback forbidden')
        return addresses[0]  # pinned until restart, no DNS rebinding or fallback

    def destination(self, payload):
        account = self.accounts.get(payload['account'])
        if account is None or payload['recipient'] not in account.rooms:
            raise ValueError('Matrix account/room not configured')
        return {'homeserver': account.homeserver, 'user_id': account.user_id,
                'room_id': payload['recipient'], 'token_sha256': self.token_hashes[payload['account']]}

    def validate(self, payload):
        if payload.get('destination') != self.destination(payload):
            raise MatrixError('Matrix destination changed')
        for item in payload['attachments']:
            raw = base64.b64decode(item['data_base64'], validate=True)
            if (hashlib.sha256(raw).hexdigest() != item['sha256'] or len(raw) != item['size']
                    or not re.fullmatch(r'[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+', item['media_type'])):
                raise MatrixError('invalid exact attachment')

    def request(self, name, method, path, body=None, media_type='application/json', missing_encryption=False):
        account = self.accounts[name]
        try:
            token = self.token(account)
            if hashlib.sha256(token.encode()).hexdigest() != self.token_hashes[name]:
                raise MatrixError('Matrix token changed; restart and reconcile queued drafts')
            connection = PinnedHTTPS(urlsplit(account.homeserver).hostname, self.addresses[name])
            try:
                data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=True).encode() if body is not None else None
                connection.request(method, path, body=data, headers={
                    'Authorization': 'Bearer ' + token, 'Content-Type': media_type,
                    'Accept': 'application/json'})
                response = connection.getresponse()
                data = response.read(65537)
                if missing_encryption and response.status == 404 and len(data) <= 65536:
                    value = json.loads(data)
                    if isinstance(value, dict) and value.get('errcode') == 'M_NOT_FOUND':
                        return {'unencrypted': True}
                if len(data) > 65536 or response.status < 200 or response.status >= 300:
                    raise MatrixError('Matrix response rejected')
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise MatrixError('invalid Matrix response')
                return value
            finally:
                connection.close()
        except Exception:
            raise MatrixError('Matrix request failed; retry exact approved draft only') from None

    def identity(self, name):
        value = self.request(name, 'GET', '/_matrix/client/v3/account/whoami')
        if value.get('user_id') != self.accounts[name].user_id:
            raise MatrixError('Matrix token identity mismatch')

    def unencrypted(self, name, room):
        value = self.request(name, 'GET', '/_matrix/client/v3/rooms/' + quote(room, safe='')
                             + '/state/m.room.encryption', missing_encryption=True)
        if value != {'unencrypted': True}:
            raise MatrixError('encrypted rooms require a separately reviewed E2EE client')

    def upload(self, name, attachment):
        value = self.request(name, 'POST', '/_matrix/media/v3/upload?filename=' + quote(attachment['name'], safe=''),
                             base64.b64decode(attachment['data_base64'], validate=True), attachment['media_type'])
        uri = value.get('content_uri', '')
        if not isinstance(uri, str) or not re.fullmatch(r'mxc://[A-Za-z0-9.:-]+/[A-Za-z0-9_-]+', uri):
            raise MatrixError('invalid Matrix media identifier')
        return uri  # opaque value only, never fetched

    @staticmethod
    def txn(draft_id, payload_hash, part):
        return 'isolated_' + hashlib.sha256(json.dumps([draft_id, payload_hash, part], separators=(',', ':')).encode()).hexdigest()

    def send(self, name, room, txn, content):
        path = '/_matrix/client/v3/rooms/' + quote(room, safe='') + '/send/m.room.message/' + txn
        value = self.request(name, 'PUT', path, content)
        event = value.get('event_id')
        if not isinstance(event, str) or not event.startswith('$') or len(event) > 500:
            raise MatrixError('invalid Matrix event response')
        return event
