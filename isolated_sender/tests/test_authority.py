"""Behavioral tests with real EC WebAuthn registration/signatures; no verifier mocks."""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import secrets
import struct
import time

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
import pytest

from isolated_sender.service import Config, canonical, create_app, digest

ORIGIN = "https://owner.example.test"
RP = "owner.example.test"
AGENT = "local-fixture-draft-key-not-a-real-account-00001"
HEADERS = {"origin": ORIGIN}
AGENT_HEADERS = {"authorization": "Bearer " + AGENT}


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


class Authenticator:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.id = secrets.token_bytes(32)
        self.counter = 0

    def client(self, ch, kind, origin=ORIGIN, challenge=None):
        return canonical({"type": kind, "challenge": challenge or ch["publicKey"]["challenge"],
                          "origin": origin, "crossOrigin": False}).encode()

    def register(self, ch, origin=ORIGIN, rp=RP, uv=True):
        n = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, 'big'), -3: n.y.to_bytes(32, 'big')})
        data = hashlib.sha256(rp.encode()).digest() + bytes([0x41 | (4 if uv else 0)]) + struct.pack('>I', 0)
        data += bytes(16) + struct.pack('>H', len(self.id)) + self.id + cose
        return {"id": b64(self.id), "rawId": b64(self.id), "type": "public-key", "response": {
            "clientDataJSON": b64(self.client(ch, "webauthn.create", origin)),
            "attestationObject": b64(cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": data}))}}

    def assertion(self, ch, origin=ORIGIN, rp=RP, uv=True, challenge=None):
        self.counter += 1
        client = self.client(ch, "webauthn.get", origin, challenge)
        data = hashlib.sha256(rp.encode()).digest() + bytes([1 | (4 if uv else 0)]) + struct.pack('>I', self.counter)
        signature = self.key.sign(data + hashlib.sha256(client).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64(self.id), "rawId": b64(self.id), "type": "public-key", "response": {
            "clientDataJSON": b64(client), "authenticatorData": b64(data), "signature": b64(signature)}}


@pytest.fixture
def env(tmp_path):
    config = Config(origin=ORIGIN, rp_id=RP, database=str(tmp_path / 'authority.db'),
                    agent_key_sha256=digest(AGENT), accounts=['test-owner'], independently_administered=True)
    app = create_app(config)
    client = TestClient(app, base_url=ORIGIN, headers=HEADERS)
    auth = Authenticator()
    token = app.state.authority.bootstrap()
    headers = {"authorization": "Bearer " + token}
    ch = client.post('/owner/register/begin', headers=headers, json={}).json()
    response = client.post('/owner/register/finish', headers=headers, json={"challenge_id": ch['challenge_id'], "credential": auth.register(ch)})
    assert response.status_code == 200, response.text
    login(client, auth)
    return config, app, client, auth


def login(client, auth):
    ch = client.post('/owner/begin', json={"action": "login"}).json()
    r = finish(client, ch, auth)
    assert r.status_code == 200, r.text
    assert 'HttpOnly' in r.headers['set-cookie'] and 'Secure' in r.headers['set-cookie']


def submit(client, **changes):
    value = {"request_id": secrets.token_hex(16), "account": "test-owner", "recipient": "test-recipient",
             "body": "Exact body\nWith unicode: \u00e9 and spaces  ", "attachments": []}
    value.update(changes)
    r = client.post('/agent/drafts', headers=AGENT_HEADERS, json=value)
    assert r.status_code == 200, r.text
    return r.json(), value


def begin(client, draft=None, **changes):
    value = {"action": "send", "draft_id": draft['id']} if draft else {}
    value.update(changes)
    r = client.post('/owner/begin', json=value)
    assert r.status_code == 200, r.text
    return r.json()


def finish(client, ch, auth, **changes):
    return client.post('/owner/finish', json={"challenge_id": ch['challenge_id'], "credential": auth.assertion(ch, **changes)})


def count(app, table='test_deliveries'):
    with app.state.authority.transaction() as db:
        return db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]


def test_real_webauthn_exact_send_and_replay(env):
    _, app, c, auth = env
    draft, value = submit(c, attachments=[{"name": "test.txt", "media_type": "text/plain", "data_base64": base64.b64encode(b'fixture bytes').decode()}])
    ch = begin(c, draft)
    exact = ch['binding']['exact']
    assert exact['body'] == value['body'] and exact['account'] == value['account']
    assert exact['attachments'][0]['sha256'] == hashlib.sha256(b'fixture bytes').hexdigest()
    credential = auth.assertion(ch)
    payload = {"challenge_id": ch['challenge_id'], "credential": credential}
    r = c.post('/owner/finish', json=payload)
    assert r.status_code == 200, r.text
    assert r.json()['production_send'] is False
    assert c.post('/owner/finish', json=payload).status_code == 403
    assert count(app) == 1
    # Durable readback is the real local backend result, not a fabricated provider reply.
    with app.state.authority.transaction() as db:
        row = db.execute('SELECT * FROM test_deliveries').fetchone()
        assert row['payload'] == draft['payload'] and row['payload_hash'] == draft['hash']
    assert c.get('/agent/drafts/' + draft['id'], headers=AGENT_HEADERS).json()['status'] == 'test-delivered'


@pytest.mark.parametrize('attack', ['credential', 'origin', 'rp', 'uv', 'challenge', 'signature'])
def test_real_verifier_rejects_invalid_assertions(env, attack):
    _, app, c, auth = env
    draft, _ = submit(c)
    ch = begin(c, draft)
    kwargs = {'origin': 'https://evil.example.test'} if attack == 'origin' else {'rp': 'evil.example.test'} if attack == 'rp' else {'uv': False} if attack == 'uv' else {'challenge': b64(secrets.token_bytes(64))} if attack == 'challenge' else {}
    credential = (Authenticator() if attack == 'credential' else auth).assertion(ch, **kwargs)
    if attack == 'signature':
        credential['response']['signature'] = b64(b'not a signature')
    r = c.post('/owner/finish', json={'challenge_id': ch['challenge_id'], 'credential': credential})
    assert r.status_code == 403
    assert count(app) == 0


@pytest.mark.parametrize('field,value', [('recipient', 'changed'), ('body', 'changed'), ('account', 'other-account'), ('attachments', [])])
def test_exact_binding_detects_trusted_store_mutation(env, field, value):
    _, app, c, auth = env
    draft, _ = submit(c, attachments=[{"name": "a", "media_type": "text/plain", "data_base64": "YQ=="}])
    ch = begin(c, draft)
    payload = json.loads(draft['payload'])
    payload[field] = value
    changed = canonical(payload)
    with app.state.authority.transaction() as db:
        db.execute('UPDATE drafts SET payload=?,hash=? WHERE id=?', (changed, digest(changed), draft['id']))
    assert finish(c, ch, auth).status_code == 409
    assert count(app) == 0


def test_expiry_and_duplicate_approvals(env):
    _, app, c, auth = env
    d, _ = submit(c)
    ch = begin(c, d)
    with app.state.authority.transaction() as db:
        db.execute('UPDATE challenges SET expires=? WHERE id=?', (time.time() - 1, ch['challenge_id']))
    assert finish(c, ch, auth).status_code == 403
    a, b = begin(c, d), begin(c, d)
    assert finish(c, a, auth).status_code == 200
    assert finish(c, b, auth).status_code == 409
    assert count(app) == 1


def test_concurrent_same_assertion_across_service_instances(env):
    config, app, c, auth = env
    d, _ = submit(c)
    ch = begin(c, d)
    payload = {'challenge_id': ch['challenge_id'], 'credential': auth.assertion(ch)}
    clients = [TestClient(create_app(config), base_url=ORIGIN, headers=HEADERS) for _ in range(8)]
    for client in clients:
        client.cookies.update(c.cookies)
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(lambda client: client.post('/owner/finish', json=payload).status_code, clients))
    assert sorted(codes) == [200] + [403] * 7
    assert count(app) == 1


def test_restart_retry_idempotency_and_conflict(env):
    config, app, c, auth = env
    d, value = submit(c)
    ch = begin(c, d)
    payload = {'challenge_id': ch['challenge_id'], 'credential': auth.assertion(ch)}
    restarted = TestClient(create_app(config), base_url=ORIGIN, headers=HEADERS)
    restarted.cookies.update(c.cookies)
    assert restarted.post('/owner/finish', json=payload).status_code == 200
    again = TestClient(create_app(config), base_url=ORIGIN, headers=HEADERS)
    again.cookies.update(c.cookies)
    assert again.post('/owner/finish', json=payload).status_code == 403
    retried = again.post('/agent/drafts', headers=AGENT_HEADERS, json=value)
    assert retried.json()['id'] == d['id'] and retried.json()['status'] == 'test-delivered'
    assert count(app) == 1
    value['body'] = 'mutated request'
    assert again.post('/agent/drafts', headers=AGENT_HEADERS, json=value).status_code == 409


def test_atomic_rollback_at_delivery_boundary(env, monkeypatch):
    _, app, c, auth = env
    d, _ = submit(c)
    ch = begin(c, d)
    payload = {'challenge_id': ch['challenge_id'], 'credential': auth.assertion(ch)}
    authority = app.state.authority
    original = authority.deliver_test
    def crash(db, did):
        original(db, did)
        raise RuntimeError('injected crash before transaction commit')
    monkeypatch.setattr(authority, 'deliver_test', crash)
    with pytest.raises(RuntimeError):
        c.post('/owner/finish', json=payload)
    assert count(app) == 0
    monkeypatch.setattr(authority, 'deliver_test', original)
    assert c.post('/owner/finish', json=payload).status_code == 200
    assert count(app) == 1


def test_agent_has_no_owner_authority(env):
    config, app, c, auth = env
    attacker = TestClient(app, base_url=ORIGIN, headers={**HEADERS, **AGENT_HEADERS})
    d, _ = submit(c)
    assert attacker.get('/owner/drafts').status_code == 401
    assert attacker.post('/owner/begin', json={'action': 'send', 'draft_id': d['id']}).status_code == 401
    assert attacker.post('/owner/begin', json={'action': 'mode', 'mode': 'full-access'}).status_code == 401
    assert attacker.post('/owner/register/begin', json={}).status_code == 403
    assert attacker.post('/agent/full-send/' + d['id']).status_code == 403
    assert attacker.post('/owner/session', json={}).status_code == 404
    # Login options are public, but agent cannot finish them or mint a session.
    login_ch = attacker.post('/owner/begin', json={'action': 'login'}).json()
    assert finish(attacker, login_ch, Authenticator()).status_code == 403
    assert not attacker.cookies
    assert count(app) == 0


def test_mode_switch_owner_only_invalidates_old_authorizations(env):
    config, app, c, auth = env
    d, _ = submit(c)
    old = begin(c, d)
    assert c.post('/owner/begin', json={'action': 'mode', 'mode': 'full-access'}).status_code == 403
    # Full access requires a separately edited independent-host config AND owner UV.
    enabled = config.model_copy(update={'allow_full_access': True})
    other_app = create_app(enabled)
    full = TestClient(other_app, base_url=ORIGIN, headers=HEADERS)
    full.cookies.update(c.cookies)
    mode = begin(full, action='mode', mode='full-access')
    assert finish(full, mode, auth).status_code == 200
    assert finish(c, old, auth).status_code == 403
    assert full.post('/agent/full-send/' + d['id'], headers=AGENT_HEADERS).status_code == 200
    assert full.post('/agent/full-send/' + d['id'], headers=AGENT_HEADERS).status_code == 200
    assert count(app) == 1
    back = begin(full, action='mode', mode='draft-only')
    assert finish(full, back, auth).status_code == 200
    assert full.post('/agent/full-send/' + d['id'], headers=AGENT_HEADERS).status_code == 403
    assert c.get('/owner/drafts').json()['mode'] == 'draft-only'


def test_tls_origin_host_and_embedded_ui_guards(env):
    _, app, c, _ = env
    assert c.get('/').status_code == 200
    response = c.get('/')
    assert "frame-ancestors 'none'" in response.headers['content-security-policy']
    assert response.headers['cache-control'] == 'no-store'
    assert c.post('/owner/begin', headers={'origin': 'https://wizard.example.test'}, json={'action': 'login'}).status_code == 403
    plain = TestClient(app, base_url='http://' + RP, headers={'x-forwarded-proto': 'https', **HEADERS})
    assert plain.get('/').status_code == 403
    assert c.get('/', headers={'host': 'evil.example.test'}).status_code == 403
    assert c.get('/owner.js').status_code == 200
    assert c.get('/owner.css').status_code == 200


@pytest.mark.parametrize('change', [{'origin': 'http://' + RP}, {'rp_id': 'example.test'}, {'independently_administered': False}, {'backend': 'matrix'}, {'agent_key_sha256': 'unset'}])
def test_config_fails_closed(env, change):
    config, _, _, _ = env
    with pytest.raises(ValueError):
        create_app(config.model_copy(update=change))


def test_invalid_attachment_unknown_account_and_unapproved_fields(env):
    _, app, c, _ = env
    _, value = submit(c)
    value['account'] = 'unconfigured'
    assert c.post('/agent/drafts', headers=AGENT_HEADERS, json=value).status_code == 403
    value['account'] = 'test-owner'
    value['attachments'] = [{'name': 'x', 'media_type': 'text/plain', 'data_base64': 'not base64'}]
    assert c.post('/agent/drafts', headers=AGENT_HEADERS, json=value).status_code == 422
    value['attachments'] = []
    value['approved'] = True
    assert c.post('/agent/drafts', headers=AGENT_HEADERS, json=value).status_code == 422
    assert count(app) == 0


@pytest.mark.parametrize('bad', [{'origin': 'https://evil.example.test'}, {'rp': 'evil.example.test'}, {'uv': False}])
def test_registration_uses_real_origin_rp_uv_verifier(tmp_path, bad):
    config = Config(origin=ORIGIN, rp_id=RP, database=str(tmp_path / 'db'), agent_key_sha256=digest(AGENT), accounts=['test-owner'], independently_administered=True)
    app = create_app(config)
    c = TestClient(app, base_url=ORIGIN, headers=HEADERS)
    token = app.state.authority.bootstrap()
    headers = {'authorization': 'Bearer ' + token}
    ch = c.post('/owner/register/begin', headers=headers, json={}).json()
    result = c.post('/owner/register/finish', headers=headers, json={'challenge_id': ch['challenge_id'], 'credential': Authenticator().register(ch, **bad)})
    assert result.status_code == 403
    assert count(app, 'credentials') == 0


def test_enrollment_is_one_time_and_no_remote_reset(env):
    _, app, c, _ = env
    with pytest.raises(ValueError, match='already enrolled'):
        app.state.authority.bootstrap()
    assert c.post('/owner/register/begin', headers={'authorization': 'Bearer ' + AGENT}, json={}).status_code == 403


def test_oversized_chunked_body_rejected(env):
    _, _, c, _ = env
    response = c.post('/agent/drafts', headers=AGENT_HEADERS, content=iter([b'x' * 800001, b'x' * 800001]))
    assert response.status_code == 413
