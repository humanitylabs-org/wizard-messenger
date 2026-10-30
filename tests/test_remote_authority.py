"""Real main HTTP -> TLS socket -> actual independent ASGI protocol fixtures.

Fixture-only routing/CA and fake Matrix server; no live accounts or messages.
"""
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import ssl
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'isolated_sender/tests'))
from test_authority import env, begin, finish, AGENT, ORIGIN
from test_matrix import protocol, ROOM
from drafts import Drafts
from remote_authority import RemoteAuthority, CachedDirectory, OfflineEngine
from unified import PeopleStore
from web import ViewServer


@pytest.fixture
def integrated(tmp_path, monkeypatch, protocol):
    matrix_state, conf, authority_app, authority_client, authenticator, _ = protocol
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'owner.example.test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([
                x509.DNSName('owner.example.test')]), critical=False).sign(key, hashes.SHA256()))
    cp, kp = tmp_path / 'owner.pem', tmp_path / 'owner.key'
    cp.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    kp.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    from fastapi.testclient import TestClient
    wire_client = TestClient(authority_app, base_url=ORIGIN)
    state = {'drop': False, 'down': False, 'redirect': False, 'requests': []}

    class Bridge(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def handle_request(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            state['requests'].append((self.command, self.path, raw))
            if state['down'] or state['redirect']:
                self.send_response(307 if state['redirect'] else 503)
                self.send_header('Location', ORIGIN + '/forbidden'); self.send_header('Content-Length', '0'); self.end_headers(); return
            # No owner cookies/Origin from the main app. Request traverses the actual
            # authority middleware, authentication, schema, SQLite and idempotency.
            headers = {'host': 'owner.example.test', 'content-type': 'application/json'}
            if self.headers.get('Authorization'): headers['authorization'] = self.headers['Authorization']
            response = wire_client.request(self.command, self.path, content=raw, headers=headers)
            if self.command == 'POST' and state['drop']:
                state['drop'] = False
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            self.send_response(response.status_code); self.send_header('Content-Length', str(len(response.content)))
            self.end_headers(); self.wfile.write(response.content)
        do_GET = do_POST = handle_request

    remote = ThreadingHTTPServer(('127.0.0.1', 0), Bridge)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cp, kp)
    remote.socket = context.wrap_socket(remote.socket, server_side=True)
    worker = threading.Thread(target=remote.serve_forever, daemon=True); worker.start()
    trust = ssl.create_default_context(cafile=str(cp))
    original = http.client.HTTPSConnection

    class FixtureHTTPS(original):
        def connect(self):
            assert self.host == 'owner.example.test' and self.port == 443
            raw = socket.create_connection(('127.0.0.1', remote.server_port), timeout=3)
            self.sock = trust.wrap_socket(raw, server_hostname=self.host)
    monkeypatch.setattr('remote_authority.HTTPSConnection', FixtureHTTPS)
    # Proxy environment cannot divert the direct stdlib connection.
    monkeypatch.setenv('HTTPS_PROXY', 'http://127.0.0.1:1')
    data = tmp_path / 'main'; data.mkdir()
    store = PeopleStore(data / 'unified/people.sqlite3')
    identity = store.identity('telegram', ROOM, 'Fixture recipient')
    other = store.identity('telegram', '!other:matrix.example.test', 'Other recipient')
    store._conn.close()
    narrow = tmp_path / 'draft.key'; narrow.write_text(AGENT)
    config = {'independent_endpoint': ORIGIN, 'wizard_origin': 'https://wizard.example.test',
              'owner_verified_independent_host': True, 'draft_key_file': str(narrow),
              'accounts': {'telegram': 'test-owner'}}
    cf = tmp_path / 'remote.json'; cf.write_text(json.dumps(config))
    monkeypatch.setenv('MESSENGER_AUTHORITY_CONFIG', str(cf)); monkeypatch.setenv('MESSENGER_REMOTE_REQUIRED', '1')
    trap = Mock(); trap.data = data
    main = ViewServer(('127.0.0.1', 0), trap, 'main-fixture-key-00000000000000000000000', ['https://wizard.example.test'])
    main.agent_access.configure({'mode': 'draft_only'})
    token, session = main.auth.create()
    owner = {'Cookie': 'wizard_messenger_session=' + token, 'Origin': 'https://wizard.example.test',
             'X-Messenger-CSRF': session['csrf']}
    bearer = {'Authorization': 'Bearer main-fixture-key-00000000000000000000000'}
    main_thread = threading.Thread(target=main.serve_forever, daemon=True); main_thread.start()

    def request(method, path, value=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', main.server_port, timeout=20)
        conn.request(method, path, json.dumps(value) if value is not None else None,
                     dict({'Content-Type': 'application/json'}, **(headers if headers is not None else owner)))
        response = conn.getresponse(); body = json.loads(response.read()); conn.close()
        return response.status, body
    try:
        yield SimpleNamespace(**locals())
    finally:
        main.shutdown(); main.server_close(); main_thread.join(5)
        remote.shutdown(); remote.server_close(); worker.join(5)


def create(f, **changes):
    fields = {'person_id': f.identity['person_id'], 'identity_id': f.identity['id'], 'text': 'Exact text\n  '}
    fields.update(changes)
    status, value = f.request('POST', '/api/drafts', fields, f.bearer)
    assert status == 200, value
    return value['result']['draft']


def test_actual_export_retry_restart_freeze_and_uv_delivery(integrated):
    f = integrated
    draft = create(f); path = '/api/drafts/' + draft['id']
    assert f.request('GET', '/api/view/authority')[1]['result']['ready'] is True
    f.state['drop'] = True
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 503
    disk = Drafts(f.data).get(draft['id'])
    assert disk['state'] == 'exported' and disk['revision'] == 1
    rid = disk['export']['payload']['request_id']
    # A fresh server object must accept its own persisted drafts/policy/audit state.
    restarted = ViewServer(('127.0.0.1', 0), SimpleNamespace(data=f.data),
                           'main-fixture-key-00000000000000000000000', ['https://wizard.example.test'])
    try:
        assert restarted.drafts.get(draft['id'])['export']['payload']['request_id'] == rid
        f.main.drafts = restarted.drafts
    finally:
        restarted.server_close()
    for method, tail, body in [('POST', '', {'revision': 1, 'text': 'changed'}), ('DELETE', '', {'revision': 1}),
                                ('POST', '/send', {'revision': 1}), ('POST', '/preview', {'revision': 1})]:
        assert f.request(method, path + tail, body)[0] in (403, 409)
    status, value = f.request('POST', path + '/export', {'revision': 1, 'text': 'forged', 'recipient': '!forged:bad'})
    assert status == 200, value
    exported = value['result']['draft']['export']
    assert value['result']['review_origin'] == ORIGIN
    assert exported['payload'] == {'request_id': rid, 'account': 'test-owner', 'recipient': ROOM,
                                   'body': 'Exact text\n  ', 'attachments': []}
    posts = [json.loads(raw) for method, path, raw in f.state['requests'] if method == 'POST']
    assert len(posts) == 2 and posts[0] == posts[1]
    assert f.matrix_state['requests'] == []
    did = exported['remote_id']
    with f.authority_app.state.authority.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM drafts').fetchone()[0] == 1
        remote_draft = dict(db.execute('SELECT * FROM drafts WHERE id=?', (did,)).fetchone())
    assert f.authority_client.post('/agent/full-send/' + did, headers={'authorization': 'Bearer ' + AGENT}).status_code == 403
    challenge = begin(f.authority_client, remote_draft)
    assert finish(f.authority_client, challenge, f.authenticator, uv=False).status_code == 403
    assert f.matrix_state['requests'] == []
    challenge = begin(f.authority_client, remote_draft)
    assert finish(f.authority_client, challenge, f.authenticator).status_code == 200
    assert len(f.matrix_state['events']) == 1
    assert f.request('POST', path + '/authority-status', {'revision': 1})[1]['result']['draft']['state'] == 'sent'
    assert f.request('DELETE', path, {'revision': 1})[0] == 200
    f.trap.assert_not_called()
    assert f.trap.method_calls == []


def test_changed_recipient_body_revision_and_unauthorized_exports(integrated):
    f = integrated
    draft = create(f); path = '/api/drafts/' + draft['id']
    changed = {'revision': 1, 'person_id': f.other['person_id'], 'identity_id': f.other['id'], 'text': 'Changed exact text'}
    status, value = f.request('POST', path, changed, f.bearer)
    assert status == 200
    assert value['result']['draft']['revision'] == 2
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 409
    for headers in (f.bearer, {'Authorization': 'Bearer wrong'}, {},
                    {'Cookie': f.owner['Cookie'], 'Origin': 'https://evil.test', 'X-Messenger-CSRF': f.session['csrf']},
                    {'Cookie': f.owner['Cookie'], 'Origin': 'https://wizard.example.test'}):
        assert f.request('POST', path + '/export', {'revision': 2}, headers)[0] in (401, 403)
    assert f.matrix_state['requests'] == [] and f.state['requests'] == []
    # Authority independently refuses a mapped local room outside its configured account room list.
    assert f.request('POST', path + '/export', {'revision': 2})[0] == 503
    persisted = Drafts(f.data).get(draft['id'])
    assert persisted['export']['payload']['recipient'] == '!other:matrix.example.test'
    assert persisted['export']['payload']['body'] == 'Changed exact text'
    assert persisted['state'] == 'exported'


def test_down_redirect_bad_key_fail_closed_and_no_legacy_callbacks(integrated):
    f = integrated
    draft = create(f); path = '/api/drafts/' + draft['id']
    for mode in ('down', 'redirect'):
        f.state[mode] = True
        assert f.request('POST', path + '/export', {'revision': 1})[0] == 503
        f.state[mode] = False
    f.narrow.write_text('wrong-narrow-key-000000000000000000000000')
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 503
    assert not any(path == '/forbidden' for _, path, _ in f.state['requests'])
    # Full access must not bypass required independent authority.
    f.main.agent_access.configure({'mode': 'full_access', 'expires_in': 900})
    for route in ('/api/contacts', '/api/invites', '/api/invites/x/accept', '/api/dms/x/messages',
                  '/api/setup', '/api/unified/telegram/login', '/api/unified/connectors/telegram/login',
                  '/api/unified/people/x/send', '/api/unified/people/x/read', '/api/unified/people/x/typing',
                  '/api/unified/people/x/react', '/api/unified/people/x/edit', '/api/unified/media'):
        for method in ('GET', 'POST', 'PUT', 'DELETE'):
            assert f.request(method, route, {}, f.owner)[0] == 403, (method, route)
    from server import Handler
    f.main.RequestHandlerClass = Handler  # API-only legacy handler must not bypass the gate.
    for route in ('/api/contacts', '/api/invites/a/accept', '/api/dms/a/messages', '/api/setup'):
        assert f.request('POST', route, {}, f.bearer)[0] == 403
    assert f.matrix_state['requests'] == [] and f.trap.method_calls == []


@pytest.mark.parametrize('endpoint', ['http://owner.example.test', 'https://wizard.example.test', 'https://localhost',
    'https://owner.example.test/proxy', 'https://a:b@owner.example.test', 'https://owner.example.test:8443',
    'https://owner.example.test?token=foo'])
def test_invalid_configuration(endpoint, tmp_path):
    with pytest.raises(ValueError):
        RemoteAuthority({'independent_endpoint': endpoint, 'wizard_origin': 'https://wizard.example.test',
                         'owner_verified_independent_host': True, 'draft_key_file': str(tmp_path / 'key'),
                         'accounts': {'telegram': 'test-owner'}})


def test_origin_and_identity_remapping_cannot_reroute_frozen_export(integrated):
    f = integrated
    draft = create(f); path = '/api/drafts/' + draft['id']
    f.state['drop'] = True
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 503
    with f.main.unified.store.db() as db:
        db.execute('UPDATE identity SET address=? WHERE id=?', ('!changed:matrix.example.test', f.identity['id']))
    f.main.remote_authority.config['accounts']['telegram'] = 'different-account'
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 200
    persisted = Drafts(f.data).get(draft['id'])
    assert persisted['export']['payload']['account'] == 'test-owner'
    assert persisted['export']['payload']['recipient'] == ROOM
    before = len(f.state['requests'])
    f.main.remote_authority.endpoint = 'https://different.example.test'
    assert f.request('POST', path + '/export', {'revision': 1})[0] == 503
    assert len(f.state['requests']) == before


def test_tls_validation_cannot_be_disabled(integrated, monkeypatch):
    f = integrated
    class UntrustedFixtureHTTPS(f.original):
        def connect(self):
            raw = socket.create_connection(('127.0.0.1', f.remote.server_port), timeout=3)
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
    monkeypatch.setattr('remote_authority.HTTPSConnection', UntrustedFixtureHTTPS)
    draft = create(f)
    assert f.request('GET', '/api/view/authority')[1]['result']['ready'] is False
    assert f.request('POST', '/api/drafts/' + draft['id'] + '/export', {'revision': 1})[0] == 503
    assert f.state['requests'] == [] and f.matrix_state['requests'] == []


def test_disabled_and_local_credentials_rejected(tmp_path, monkeypatch):
    assert RemoteAuthority().state()['ready'] is False
    root = tmp_path / 'unified'; store = PeopleStore(root / 'people.sqlite3')
    store.put('matrix_token', 'fixture-send-capable-token'); store._conn.close()
    with pytest.raises(ValueError): CachedDirectory(tmp_path)
    (tmp_path / 'engine-secret').write_text('fixture')
    with pytest.raises(ValueError): OfflineEngine(tmp_path)
