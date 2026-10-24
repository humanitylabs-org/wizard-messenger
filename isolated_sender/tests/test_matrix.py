"""Loopback HTTPS fake-Matrix protocol fixtures, NOT live provider/network proof.

Real HTTP/TLS sockets and real WebAuthn verification; only test transport routing
and test CA trust are injected. Production has no loopback/CA bypass setting.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import ssl
import threading

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient
import pytest

from isolated_sender import matrix
from isolated_sender.service import create_app
from test_authority import env, begin, finish, submit, ORIGIN, HEADERS, AGENT_HEADERS

ROOM = '!fixture:matrix.example.test'
USER = '@fixture:matrix.example.test'


@pytest.fixture
def protocol(tmp_path, monkeypatch, env):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'matrix.example.test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([
                x509.DNSName('matrix.example.test')]), critical=False).sign(key, hashes.SHA256()))
    cp, kp = tmp_path / 'ca.pem', tmp_path / 'key.pem'
    cp.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    kp.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    state = {'requests': [], 'events': {}, 'uploads': [], 'drop': False, 'redirect': False, 'wrong_user': False, 'encrypted': False}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def handle_request(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            state['requests'].append((self.command, self.path, raw, dict(self.headers)))
            assert self.headers['Authorization'] == 'Bearer protocol-fixture-token-only'
            status = 200
            if state['redirect']:
                status, value = 307, {'error': 'fixture redirect'}
            elif self.path.endswith('/whoami'):
                value = {'user_id': '@wrong:test' if state['wrong_user'] else USER}
            elif self.path.endswith('/state/m.room.encryption'):
                status, value = (200, {'algorithm': 'm.megolm.v1.aes-sha2'}) if state['encrypted'] else (404, {'errcode': 'M_NOT_FOUND'})
            elif self.command == 'POST' and self.path.startswith('/_matrix/media/v3/upload?filename='):
                state['uploads'].append(raw)
                value = {'content_uri': 'mxc://matrix.example.test/upload' + str(len(state['uploads']))}
            elif self.command == 'PUT' and '/send/m.room.message/isolated_' in self.path:
                old = state['events'].get(self.path)
                if old:
                    assert old[0] == raw, 'txn reused for different event bytes'
                else:
                    state['events'][self.path] = (raw, '$event' + str(len(state['events'])))
                value = {'event_id': state['events'][self.path][1]}
                if state['drop']:
                    state['drop'] = False
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
            else:
                status, value = 500, {'error': 'unexpected fixture request'}
            data = json.dumps(value).encode()
            self.send_response(status)
            if state['redirect']:
                self.send_header('Location', 'https://127.0.0.1/forbidden')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        do_GET = do_POST = do_PUT = handle_request

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cp, kp)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    trust = ssl.create_default_context(cafile=str(cp))

    class FixtureTLS(matrix.PinnedHTTPS):
        def connect(self):
            raw = socket.create_connection(('127.0.0.1', server.server_port), timeout=3)
            self.sock = trust.wrap_socket(raw, server_hostname=self.host)

    monkeypatch.setattr(matrix, 'PinnedHTTPS', FixtureTLS)
    monkeypatch.setattr(matrix.MatrixSender, 'resolve', staticmethod(lambda _: '127.0.0.1'))
    token = tmp_path / 'token'
    token.write_text('protocol-fixture-token-only')
    token.chmod(0o600)
    conf, _, previous, auth = env
    conf = conf.model_copy(update={'backend': 'matrix', 'matrix_accounts': {'test-owner': matrix.MatrixAccount(
        homeserver='https://matrix.example.test', user_id=USER, token_file=str(token), rooms=[ROOM])}})
    app = create_app(conf)
    client = TestClient(app, base_url=ORIGIN, headers=HEADERS)
    client.cookies.update(previous.cookies)
    try:
        yield state, conf, app, client, auth, token
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_real_protocol_text_media_and_exact_approval(protocol):
    state, _, app, c, auth, _ = protocol
    raw = b'\x00\xffexact fixture media'
    d, value = submit(c, recipient=ROOM, attachments=[{'name': 'a /?é.txt', 'media_type': 'text/plain',
        'data_base64': base64.b64encode(raw).decode()}])
    assert state['requests'] == []  # drafting cannot use provider capability
    assert c.post('/agent/full-send/' + d['id'], headers=AGENT_HEADERS).status_code == 403
    ch = begin(c, d)
    assert ch['binding']['exact']['destination']['room_id'] == ROOM
    response = finish(c, ch, auth)
    assert response.status_code == 200, response.text
    assert response.json()['backend'] == 'matrix'
    assert state['uploads'] == [raw]
    assert len(state['events']) == 2
    contents = [json.loads(v[0]) for v in state['events'].values()]
    assert contents[0] == {'msgtype': 'm.text', 'body': value['body']}
    assert contents[1]['url'] == 'mxc://matrix.example.test/upload1'
    assert contents[1]['filename'] == 'a /?é.txt'
    assert contents[1]['info'] == {'mimetype': 'text/plain', 'size': len(raw)}
    assert c.get('/agent/drafts/' + d['id'], headers=AGENT_HEADERS).json()['status'] == 'matrix-delivered'
    with app.state.authority.transaction() as db:
        assert db.execute('SELECT COUNT(*) FROM test_deliveries').fetchone()[0] == 0
        assert db.execute('SELECT COUNT(*) FROM matrix_parts WHERE event IS NOT NULL').fetchone()[0] == 2


def test_response_loss_restart_stable_txn_and_uri(protocol):
    state, conf, _, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM, body='', attachments=[{'name': 'x', 'media_type': 'application/octet-stream', 'data_base64': 'YQ=='}])
    ch = begin(c, d)
    credential = auth.assertion(ch)
    state['drop'] = True
    assert c.post('/owner/finish', json={'challenge_id': ch['challenge_id'], 'credential': credential}).status_code == 502
    assert len(state['events']) == 1
    assert c.post('/owner/finish', json={'challenge_id': ch['challenge_id'], 'credential': credential}).status_code == 403
    restarted = TestClient(create_app(conf), base_url=ORIGIN, headers=HEADERS)
    restarted.cookies.update(c.cookies)
    assert finish(restarted, begin(restarted, d), auth).status_code == 200
    puts = [r for r in state['requests'] if r[0] == 'PUT']
    assert len(puts) == 2 and puts[0][1:3] == puts[1][1:3]
    assert len(state['events']) == 1 and len(state['uploads']) == 1


def test_redirect_not_followed_and_wrong_identity_denied(protocol):
    state, _, _, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM)
    state['redirect'] = True
    assert finish(c, begin(c, d), auth).status_code == 502
    assert len(state['requests']) == 1
    assert not state['events']
    state['redirect'], state['wrong_user'] = False, True
    assert finish(c, begin(c, d), auth).status_code == 502
    assert not state['events']


@pytest.mark.parametrize('changes', [
    {'recipient': '!unknown:test'}, {'recipient': 'https://127.0.0.1/'}, {'account': 'unknown'},
    {'token': 'caller-token'}, {'homeserver': 'https://evil.test'},
    {'attachments': [{'name': 'x', 'media_type': 'text/plain\r\nX: evil', 'data_base64': 'YQ=='}]},
    {'attachments': [{'name': 'x', 'media_type': 'text/plain', 'url': 'http://169.254.169.254/'}]},
])
def test_no_proxy_or_unknown_destination(protocol, changes):
    state, _, _, c, _, _ = protocol
    value = {'request_id': 'fixture-request-00001', 'account': 'test-owner', 'recipient': ROOM, 'body': 'x', 'attachments': []}
    value.update(changes)
    assert c.post('/agent/drafts', headers=AGENT_HEADERS, json=value).status_code in (403, 422)
    assert not state['requests']


def test_attachments_tamper_never_reaches_matrix(protocol):
    state, _, app, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM, attachments=[{'name': 'a', 'media_type': 'text/plain', 'data_base64': 'YQ=='}])
    ch = begin(c, d)
    from isolated_sender.service import canonical, digest
    payload = json.loads(d['payload'])
    payload['attachments'][0]['data_base64'] = 'Yg=='
    changed = canonical(payload)
    with app.state.authority.transaction() as db:
        db.execute('UPDATE drafts SET payload=?,hash=? WHERE id=?', (changed, digest(changed), d['id']))
    assert finish(c, ch, auth).status_code == 409
    assert not state['requests']


def test_token_rotation_cannot_change_idempotency_scope(protocol):
    state, conf, _, c, auth, token = protocol
    d, _ = submit(c, recipient=ROOM)
    state['drop'] = True
    assert finish(c, begin(c, d), auth).status_code == 502
    token.write_text('rotated-protocol-fixture-token')
    restarted = TestClient(create_app(conf), base_url=ORIGIN, headers=HEADERS)
    restarted.cookies.update(c.cookies)
    # Route fingerprint is part of the exact signed envelope; no rebind to new token.
    assert finish(restarted, begin(restarted, d), auth).status_code == 409
    assert len(state['events']) == 1


def test_post_acceptance_local_crash_uses_same_event_after_restart(protocol, monkeypatch):
    state, conf, app, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM, body='', attachments=[{'name': 'x', 'media_type': 'text/plain', 'data_base64': 'YQ=='}])
    original = app.state.authority.matrix.send
    def crash(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError('fixture crash after Matrix accepts before local commit')
    monkeypatch.setattr(app.state.authority.matrix, 'send', crash)
    ch = begin(c, d)
    with pytest.raises(RuntimeError):
        finish(c, ch, auth)
    restarted = TestClient(create_app(conf), base_url=ORIGIN, headers=HEADERS)
    restarted.cookies.update(c.cookies)
    assert finish(restarted, begin(restarted, d), auth).status_code == 200
    assert len(state['events']) == 1 and len(state['uploads']) == 1
    puts = [r for r in state['requests'] if r[0] == 'PUT']
    assert len(puts) == 2 and puts[0][1:3] == puts[1][1:3]


def test_upload_crash_can_orphan_media_but_not_duplicate_message(protocol, monkeypatch):
    state, conf, app, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM, body='', attachments=[{'name': 'x', 'media_type': 'text/plain', 'data_base64': 'YQ=='}])
    original = app.state.authority.matrix.upload
    def crash(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError('fixture crash after media upload before URI commit')
    monkeypatch.setattr(app.state.authority.matrix, 'upload', crash)
    with pytest.raises(RuntimeError):
        finish(c, begin(c, d), auth)
    assert len(state['uploads']) == 1 and not state['events']
    restarted = TestClient(create_app(conf), base_url=ORIGIN, headers=HEADERS)
    restarted.cookies.update(c.cookies)
    assert finish(restarted, begin(restarted, d), auth).status_code == 200
    assert len(state['uploads']) == 2 and len(state['events']) == 1
    assert json.loads(next(iter(state['events'].values()))[0])['url'].endswith('/upload2')


def test_encrypted_room_rejected(protocol):
    state, _, _, c, auth, _ = protocol
    state['encrypted'] = True
    d, _ = submit(c, recipient=ROOM)
    assert finish(c, begin(c, d), auth).status_code == 502
    assert not state['events']


def test_concurrent_resume_and_epoch_fence(protocol):
    state, _, app, c, auth, _ = protocol
    d, _ = submit(c, recipient=ROOM)
    state['drop'] = True
    assert finish(c, begin(c, d), auth).status_code == 502
    # Owner mode change invalidates the durable queued authorization too.
    assert finish(c, begin(c, action='mode', mode='draft-only'), auth).status_code == 200
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        app.state.authority.dispatch(d['id'])
    assert len([r for r in state['requests'] if r[0] == 'PUT']) == 1
    # Fresh owner approval authorizes same transaction, never a new message.
    assert finish(c, begin(c, d), auth).status_code == 200
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: app.state.authority.dispatch(d['id']), range(4)))
    assert all(r['event_ids'] == ['$event0'] for r in results)
    assert len(state['events']) == 1


def test_public_dns_guard_and_pinned_connection(monkeypatch):
    original = matrix.MatrixSender.resolve
    for address in ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1']:
        monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, ip=address, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443))])
        with pytest.raises(ValueError): original('matrix.example.test')
    calls = []
    class Raw:
        def close(self): pass
    class TLS:
        def wrap_socket(self, raw, server_hostname):
            calls.append(server_hostname)
            return raw
    connection = matrix.PinnedHTTPS('matrix.example.test', '8.8.8.8')
    connection._context = TLS()
    monkeypatch.setattr(socket, 'create_connection', lambda destination, **k: (calls.append(destination) or Raw()))
    connection.connect()
    assert calls == [('8.8.8.8', 443), 'matrix.example.test']
