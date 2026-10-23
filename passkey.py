"""Fingerprint / face unlock for the Messenger view (WebAuthn platform passkeys).

Stdlib only: a small CBOR reader and signature *verification* (ES256 / RS256).
Verification handles only public data, so plain-integer arithmetic is safe here.
A passkey proves the owner is back on a device they set up; it opens a browser
session. It never unlocks the encrypted Marmot vault: after a server restart
the passphrase is still required once.
"""
import base64
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path


class PasskeyError(Exception):
    pass


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64u(text):
    if not isinstance(text, str) or len(text) > 8192:
        raise PasskeyError('bad_encoding')
    try:
        return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
    except ValueError:
        raise PasskeyError('bad_encoding') from None


# ---------- CBOR (only what WebAuthn attestation uses) ----------
def cbor(data, i=0, depth=0):
    if depth > 8 or i >= len(data):
        raise PasskeyError('bad_cbor')
    major, info = data[i] >> 5, data[i] & 31
    i += 1
    if info < 24:
        n = info
    elif info in (24, 25, 26, 27):
        size = 1 << (info - 24)
        n = int.from_bytes(data[i:i + size], 'big')
        i += size
    else:
        raise PasskeyError('bad_cbor')
    if major == 0:
        return n, i
    if major == 1:
        return -1 - n, i
    if major in (2, 3):
        chunk = data[i:i + n]
        if len(chunk) != n:
            raise PasskeyError('bad_cbor')
        return (chunk if major == 2 else chunk.decode()), i + n
    if major == 4:
        out = []
        for _ in range(n):
            v, i = cbor(data, i, depth + 1)
            out.append(v)
        return out, i
    if major == 5:
        out = {}
        for _ in range(n):
            k, i = cbor(data, i, depth + 1)
            v, i = cbor(data, i, depth + 1)
            out[k] = v
        return out, i
    if major == 7 and info in (20, 21, 22):
        return {20: False, 21: True, 22: None}[info], i
    raise PasskeyError('bad_cbor')


# ---------- signature verification ----------
P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
A = P - 3
B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551
G = (0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296,
     0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + A) * pow(2 * p[1], -1, P) % P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, P) % P
    x = (lam * lam - p[0] - q[0]) % P
    return x, (lam * (p[0] - x) - p[1]) % P


def _mul(k, p):
    r = None
    while k:
        if k & 1:
            r = _add(r, p)
        p = _add(p, p)
        k >>= 1
    return r


def _der_sig(sig):
    # SEQUENCE { INTEGER r, INTEGER s }
    if len(sig) < 8 or sig[0] != 0x30 or sig[1] != len(sig) - 2:
        raise PasskeyError('bad_signature')
    out, i = [], 2
    for _ in range(2):
        if sig[i] != 0x02:
            raise PasskeyError('bad_signature')
        n = sig[i + 1]
        out.append(int.from_bytes(sig[i + 2:i + 2 + n], 'big'))
        i += 2 + n
    if i != len(sig):
        raise PasskeyError('bad_signature')
    return out


def verify_es256(x, y, message, sig):
    if not (0 <= x < P and 0 <= y < P) or (y * y - (x * x * x + A * x + B)) % P:
        raise PasskeyError('bad_key')
    r, s = _der_sig(sig)
    if not (1 <= r < N and 1 <= s < N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), 'big')
    w = pow(s, -1, N)
    pt = _add(_mul(e * w % N, G), _mul(r * w % N, (x, y)))
    return pt is not None and pt[0] % N == r


def verify_rs256(n, e, message, sig):
    k = (n.bit_length() + 7) // 8
    if n.bit_length() < 2048 or len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, 'big'), e, n).to_bytes(k, 'big')
    digest_info = bytes.fromhex('3031300d060960864801650304020105000420') + hashlib.sha256(message).digest()
    return em == b'\x00\x01' + b'\xff' * (k - len(digest_info) - 3) + b'\x00' + digest_info


def verify(cose, message, sig):
    kty, alg = cose.get(1), cose.get(3)
    if kty == 2 and alg == -7 and cose.get(-1) == 1:
        return verify_es256(int.from_bytes(cose[-2], 'big'), int.from_bytes(cose[-3], 'big'), message, sig)
    if kty == 3 and alg == -257:
        return verify_rs256(int.from_bytes(cose[-1], 'big'), int.from_bytes(cose[-2], 'big'), message, sig)
    raise PasskeyError('unsupported_key')


# ---------- store + ceremonies ----------
class Passkeys:
    CHALLENGE_TTL = 300

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.lock = threading.RLock()
        self.challenges = {}
        self.keys = []
        self.prf_salt = None
        if self.path and self.path.exists():
            data = json.loads(self.path.read_text())
            self.keys = data.get('keys', []); self.prf_salt = data.get('prf_salt')
        if not self.prf_salt:
            self.prf_salt = b64u(secrets.token_bytes(32))

    def _save(self):
        if not self.path:
            return
        tmp = self.path.with_suffix('.tmp')
        with tmp.open('w') as f:
            os.chmod(tmp, 0o600)
            json.dump({'keys': self.keys, 'prf_salt': self.prf_salt}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def _challenge(self, kind):
        now = time.time()
        self.challenges = {k: v for k, v in self.challenges.items() if v[1] > now}
        if len(self.challenges) > 64:
            raise PasskeyError('busy')
        c = secrets.token_bytes(32)
        self.challenges[b64u(c)] = (kind, now + self.CHALLENGE_TTL)
        return b64u(c)

    def _take(self, client, kind, origin):
        try:
            data = json.loads(client)
        except ValueError:
            raise PasskeyError('bad_client_data') from None
        entry = self.challenges.pop(data.get('challenge', ''), None)
        if not entry or entry[0] != kind or entry[1] < time.time():
            raise PasskeyError('expired')
        if data.get('type') != ('webauthn.create' if kind == 'register' else 'webauthn.get') or data.get('origin') != origin:
            raise PasskeyError('wrong_origin')

    @staticmethod
    def _auth_data(raw, rp_id):
        if len(raw) < 37 or raw[:32] != hashlib.sha256(rp_id.encode()).digest():
            raise PasskeyError('wrong_site')
        flags = raw[32]
        if not flags & 0x01 or not flags & 0x04:
            raise PasskeyError('not_verified')  # user present + verified (fingerprint/face/PIN)
        return flags, int.from_bytes(raw[33:37], 'big')

    def state(self):
        with self.lock:
            return {'enabled': bool(self.keys), 'count': len(self.keys)}

    def register_options(self, rp_id):
        with self.lock:
            return {'challenge': self._challenge('register'), 'rp': {'id': rp_id, 'name': 'Messenger'},
                    'user': {'id': b64u(b'messenger-owner'), 'name': 'Messenger', 'displayName': 'Messenger'},
                    'pubKeyCredParams': [{'type': 'public-key', 'alg': -7}, {'type': 'public-key', 'alg': -257}],
                    'authenticatorSelection': {'authenticatorAttachment': 'platform', 'userVerification': 'required', 'residentKey': 'preferred'},
                    'excludeCredentials': [{'type': 'public-key', 'id': k['id']} for k in self.keys],
                    'attestation': 'none', 'timeout': 60000}

    def register(self, payload, rp_id, origin, label=''):
        with self.lock:
            self._take(unb64u(payload.get('clientDataJSON')), 'register', origin)
            att, _ = cbor(unb64u(payload.get('attestationObject')))
            raw = att.get('authData') if isinstance(att, dict) else None
            if not isinstance(raw, bytes):
                raise PasskeyError('bad_attestation')
            flags, count = self._auth_data(raw, rp_id)
            if not flags & 0x40 or len(raw) < 55:
                raise PasskeyError('bad_attestation')
            n = int.from_bytes(raw[53:55], 'big')
            cred_id = raw[55:55 + n]
            cose, _ = cbor(raw, 55 + n)
            if not isinstance(cose, dict) or not cred_id:
                raise PasskeyError('bad_attestation')
            if (cose.get(1), cose.get(3)) not in ((2, -7), (3, -257)) or (cose.get(3) == -7 and not (len(cose.get(-2) or b'') == len(cose.get(-3) or b'') == 32)):
                raise PasskeyError('unsupported_key')
            if len(self.keys) >= 10:
                raise PasskeyError('too_many')
            self.keys = [k for k in self.keys if k['id'] != b64u(cred_id)] + [{
                'id': b64u(cred_id), 'cose': b64u(raw[55 + n:]), 'count': count,
                'label': str(label)[:60], 'added': int(time.time())}]
            self._save()
            return self.state()

    def unlock_options(self, rp_id):
        with self.lock:
            if not self.keys:
                raise PasskeyError('none')
            # prf: the phone derives a secret from this salt with its fingerprint key. Each wrap is the passphrase
            # sealed by the phone under that secret; the server can never open it, only the phone with a fingerprint.
            return {'challenge': self._challenge('unlock'), 'rpId': rp_id, 'userVerification': 'required', 'timeout': 60000,
                    'allowCredentials': [{'type': 'public-key', 'id': k['id']} for k in self.keys],
                    'prf': {'salt': self.prf_salt, 'wraps': {k['id']: k['wrap'] for k in self.keys if k.get('wrap')}}}

    def set_wrap(self, cred_id, wrap):
        with self.lock:
            key = next((k for k in self.keys if k['id'] == cred_id), None)
            if not key:
                raise PasskeyError('unknown_key')
            if wrap is None:
                key.pop('wrap', None)
            else:
                if not isinstance(wrap, str) or not 40 <= len(wrap) <= 2048 or not set(wrap) <= set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'):
                    raise PasskeyError('bad_wrap')
                key['wrap'] = wrap
            self._save()
            return self.state()

    def unlock(self, payload, rp_id, origin):
        with self.lock:
            client = unb64u(payload.get('clientDataJSON'))
            self._take(client, 'unlock', origin)
            key = next((k for k in self.keys if k['id'] == payload.get('id')), None)
            if not key:
                raise PasskeyError('unknown_key')
            raw = unb64u(payload.get('authenticatorData'))
            _, count = self._auth_data(raw, rp_id)
            cose, _ = cbor(unb64u(key['cose']))
            if not verify(cose, raw + hashlib.sha256(client).digest(), unb64u(payload.get('signature'))):
                raise PasskeyError('bad_signature')
            if count and count <= key['count']:
                raise PasskeyError('cloned_key')
            key['count'] = count
            self._save()

    def clear(self):
        with self.lock:
            self.keys = []
            self.challenges = {}
            self.prf_salt = b64u(secrets.token_bytes(32))
            self._save()
            return self.state()
