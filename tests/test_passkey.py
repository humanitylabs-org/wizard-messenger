import hashlib, json, secrets, tempfile, unittest
from pathlib import Path
import passkey as pk
from passkey import Passkeys, PasskeyError, b64u

RP, ORIGIN = 'wizard.example.com', 'https://wizard.example.com'

def cbor_enc(v):
    def head(major, n):
        if n < 24: return bytes([major << 5 | n])
        for info, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
            if n < 1 << (8 * size): return bytes([major << 5 | info]) + n.to_bytes(size, 'big')
    if isinstance(v, bool): return bytes([0xf5 if v else 0xf4])
    if isinstance(v, int): return head(0, v) if v >= 0 else head(1, -1 - v)
    if isinstance(v, bytes): return head(2, len(v)) + v
    if isinstance(v, str): return head(3, len(v.encode())) + v.encode()
    if isinstance(v, dict): return head(5, len(v)) + b''.join(cbor_enc(k) + cbor_enc(x) for k, x in v.items())
    raise TypeError(v)

class Phone:
    """A test authenticator: real P-256 ECDSA (test-only signing)."""
    def __init__(self):
        self.d = secrets.randbelow(pk.N - 1) + 1
        self.x, self.y = pk._mul(self.d, pk.G)
        self.cred = secrets.token_bytes(16); self.count = 0
    def sign(self, msg):
        e = int.from_bytes(hashlib.sha256(msg).digest(), 'big')
        while True:
            k = secrets.randbelow(pk.N - 1) + 1
            r = pk._mul(k, pk.G)[0] % pk.N
            s = pow(k, -1, pk.N) * (e + r * self.d) % pk.N
            if r and s: break
        def i(n):
            b = n.to_bytes((n.bit_length() + 8) // 8, 'big'); return b'\x02' + bytes([len(b)]) + b
        body = i(r) + i(s); return b'\x30' + bytes([len(body)]) + body
    def auth(self, flags=0x05, rp=RP, extra=b''):
        self.count += 1
        return hashlib.sha256(rp.encode()).digest() + bytes([flags]) + self.count.to_bytes(4, 'big') + extra
    def create(self, options, origin=ORIGIN):
        client = json.dumps({'type': 'webauthn.create', 'challenge': options['challenge'], 'origin': origin}).encode()
        cose = cbor_enc({1: 2, 3: -7, -1: 1, -2: self.x.to_bytes(32, 'big'), -3: self.y.to_bytes(32, 'big')})
        data = self.auth(0x45, extra=bytes(16) + len(self.cred).to_bytes(2, 'big') + self.cred + cose)
        return {'clientDataJSON': b64u(client), 'attestationObject': b64u(cbor_enc({'fmt': 'none', 'attStmt': {}, 'authData': data}))}
    def get(self, options, origin=ORIGIN, flags=0x05, rp=RP):
        client = json.dumps({'type': 'webauthn.get', 'challenge': options['challenge'], 'origin': origin}).encode()
        data = self.auth(flags, rp)
        return {'id': b64u(self.cred), 'clientDataJSON': b64u(client), 'authenticatorData': b64u(data), 'signature': b64u(self.sign(data + hashlib.sha256(client).digest()))}

class PasskeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.path = Path(self.tmp.name) / 'passkeys.json'
        self.keys = Passkeys(self.path); self.phone = Phone()
        self.keys.register(self.phone.create(self.keys.register_options(RP)), RP, ORIGIN)
    def tearDown(self): self.tmp.cleanup()
    def test_fingerprint_unlocks_and_survives_restart(self):
        self.assertEqual(self.keys.state(), {'enabled': True, 'count': 1})
        again = Passkeys(self.path)
        again.unlock(self.phone.get(again.unlock_options(RP)), RP, ORIGIN)
    def test_rejects_forgery_replay_other_sites_and_no_fingerprint(self):
        options = self.keys.unlock_options(RP); good = self.phone.get(options)
        bad = dict(good, signature=b64u(Phone().sign(b'x')))
        with self.assertRaises(PasskeyError): self.keys.unlock(bad, RP, ORIGIN)
        with self.assertRaises(PasskeyError): self.keys.unlock(good, RP, ORIGIN)  # challenge already used
        cases = [(self.phone.get(self.keys.unlock_options(RP), origin='https://evil.example'), 'wrong_origin'),
                 (self.phone.get(self.keys.unlock_options(RP), rp='evil.example'), 'wrong_site'),
                 (self.phone.get(self.keys.unlock_options(RP), flags=0x01), 'not_verified'),
                 (Phone().get(self.keys.unlock_options(RP)), 'unknown_key')]
        for payload, code in cases:
            with self.assertRaises(PasskeyError) as caught: self.keys.unlock(payload, RP, ORIGIN)
            self.assertEqual(str(caught.exception), code)
        self.keys.unlock(self.phone.get(self.keys.unlock_options(RP)), RP, ORIGIN)
    def test_turning_off_forgets_every_phone(self):
        self.keys.clear()
        self.assertFalse(Passkeys(self.path).state()['enabled'])
        with self.assertRaises(PasskeyError): self.keys.unlock_options(RP)
    def test_rs256_padding_check(self):
        self.assertFalse(pk.verify_rs256((1 << 2047) + 1, 65537, b'm', b'\x00' * 256))

if __name__ == '__main__': unittest.main()
