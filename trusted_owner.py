"""Opt-in, installation-local owner handoff. Never an agent capability.

Gateway authenticates the outer Wizard owner BEFORE signing each forwarded
request, strips client proof headers, and never signs agent/bearer ingress.
Keys are independent private files mounted outside Messenger's data volume.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import stat
import threading
import time
from engine import EngineError, vault_password

HEADER = 'X-Messenger-Owner-Proof'
DOMAIN = 'wizard-messenger-owner-v1'


def private_key(path):
    # Refuse symlinks and permissive credentials, including manager chmod damage.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError('Trusted owner key must be a private regular file')
        raw = os.read(fd, 33)
        if len(raw) != 32:
            raise ValueError('Trusted owner key must contain exactly 32 bytes')
        return raw
    finally:
        os.close(fd)


def sign_request(key, method, target, *, now=None, nonce=None):
    """Gateway integration helper; call only AFTER authenticated-owner resolution."""
    timestamp = str(int(time.time() if now is None else now))
    nonce = nonce or secrets.token_hex(24)
    message = '\n'.join((DOMAIN, timestamp, nonce, method, target)).encode()
    signature = hmac.new(key, message, hashlib.sha256).hexdigest()
    return '.'.join((timestamp, nonce, signature))


class TrustedOwner:
    def __init__(self, data, *, enabled=False, proof_file=None, wrap_file=None):
        self.enabled = enabled
        self.lock = threading.Lock()
        self.seen = {}
        if not enabled:
            return
        if not data or not proof_file or not wrap_file:
            raise ValueError('Trusted owner requires persistent data and independent proof/wrapping keys')
        if any(Path(path).resolve().is_relative_to(Path(data).resolve()) for path in (proof_file, wrap_file)):
            raise ValueError('Trusted owner keys must be outside the Messenger data volume')
        self.proof_key = private_key(proof_file)
        self.wrap_key = private_key(wrap_file)
        if hmac.compare_digest(self.proof_key, self.wrap_key):
            raise ValueError('Trusted owner proof and wrapping keys must differ')
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.cipher = AESGCM(self.wrap_key)
        self.path = Path(data) / 'trusted-owner-unlock.json'

    @classmethod
    def from_environment(cls, data):
        return cls(data, enabled=os.environ.get('MESSENGER_TRUST_WIZARD_OWNER') == '1',
                   proof_file=os.environ.get('MESSENGER_OWNER_PROOF_KEY_FILE'),
                   wrap_file=os.environ.get('MESSENGER_OWNER_WRAP_KEY_FILE'))

    def require(self, handler):
        if not self.enabled:
            raise EngineError('trusted_owner_disabled', 'Wizard owner access is not enabled', 403)
        # A bearer can NEVER borrow browser authority, even with a valid proof.
        if handler.headers.get('Authorization'):
            raise EngineError('owner_only', 'Owner browser access is required', 403)
        handler._origin(required=handler.command not in ('GET', 'HEAD'))
        values = handler.headers.get_all(HEADER, [])
        try:
            if len(values) != 1:
                raise ValueError()
            timestamp, nonce, signature = values[0].split('.')
            if not timestamp.isdigit() or len(nonce) != 48 or any(c not in '0123456789abcdef' for c in nonce):
                raise ValueError()
            now = time.time()
            if abs(now - int(timestamp)) > 30:
                raise ValueError()
            expected = sign_request(self.proof_key, handler.command, handler.path, now=int(timestamp), nonce=nonce)
            if not hmac.compare_digest(expected, values[0]):
                raise ValueError()
            with self.lock:
                self.seen = {k: v for k, v in self.seen.items() if v > now}
                if nonce in self.seen or len(self.seen) >= 8192:
                    raise ValueError()
                self.seen[nonce] = now + 61
        except (ValueError, TypeError, OverflowError):
            raise EngineError('trusted_gateway_required', 'Open Messenger through your authenticated Wizard', 403) from None

    def remember(self, password, credential):
        """Called only after successful owner password verification + vault unlock."""
        vault_password(password)
        nonce = secrets.token_bytes(12)
        aad = json.dumps(credential, sort_keys=True).encode()
        encrypted = self.cipher.encrypt(nonce, password.encode(), aad)
        payload = json.dumps({'version': 1, 'nonce': base64.b64encode(nonce).decode(),
                              'ciphertext': base64.b64encode(encrypted).decode()}).encode()
        temp = self.path.with_name('.trusted-owner-' + secrets.token_hex(12))
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload); stream.flush(); os.fsync(stream.fileno())
            os.replace(temp, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(directory)
            finally: os.close(directory)
        finally:
            temp.unlink(missing_ok=True)

    def password(self, credential):
        if not self.path.exists():
            return None
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    raise ValueError()
                if info.st_mode & 0o077:
                    # App Manager backups widen app-data to 0777 while Messenger keeps running. Our own file
                    # (same uid, regular, not a symlink): tighten it back instead of locking the owner out.
                    os.fchmod(stream.fileno(), 0o600)
                value = json.loads(stream.read(8193))
            if value['version'] != 1:
                raise ValueError()
            aad = json.dumps(credential, sort_keys=True).encode()
            password = self.cipher.decrypt(base64.b64decode(value['nonce'], validate=True),
                base64.b64decode(value['ciphertext'], validate=True), aad).decode()
            return vault_password(password)
        except Exception:
            # Never replace, clear or log a failed envelope, nor touch account data.
            raise EngineError('remembered_unlock_unavailable', 'Unlock once with your existing passphrase to remember this Wizard again.', 401) from None

    def forget(self):
        self.path.unlink(missing_ok=True)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
