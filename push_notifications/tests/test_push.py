import base64
import json
import os
import socket
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from push_notifications import Store, OwnerAPI, Worker, EndpointPolicy, InvalidSubscription, PyWebPushTransport


def subscription(endpoint='https://push.example.test/token'):
    key = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
    return {'endpoint': endpoint, 'keys': {'p256dh': b64(key), 'auth': b64(os.urandom(16))}}


@pytest.fixture
def setup(tmp_path):
    clock = [1000000.0]
    store = Store(tmp_path / 'private', EndpointPolicy({'push.example.test'}), lambda: clock[0])
    return store, clock


def rows(store, table='outbox'):
    with store.db() as db:
        return [dict(r) for r in db.execute('SELECT * FROM ' + table)]


class Fake:
    def __init__(self, statuses=(201,)):
        self.statuses = iter(statuses)
        self.calls = []
    def send(self, subscription: dict, payload: str, ttl: int) -> int:
        self.calls.append((subscription, json.loads(payload), ttl))
        return next(self.statuses)


def test_owner_api_fails_closed(setup):
    store, _ = setup
    api = OwnerAPI(store, lambda req: req.get('owner') if req.get('cookie') and req.get('csrf') else None)
    for req in ({}, {'cookie': True}, {'csrf': True}):
        with pytest.raises(PermissionError): api.handle(req, 'subscribe', subscription())
    req = {'cookie': True, 'csrf': True, 'owner': 'a'}
    sub = subscription()
    sub.update({'owner': 'b', 'headers': {'Authorization': 'SECRET'}})
    result = api.handle(req, 'subscribe', sub)
    assert rows(store, 'subscription')[0]['owner'] == 'a'
    assert 'SECRET' not in rows(store, 'subscription')[0]['json']
    with pytest.raises(PermissionError): store.subscribe('b', sub)
    store.revoke('b', result['id'])
    assert not rows(store, 'subscription')[0]['revoked']
    api.handle(req, 'unsubscribe', result)
    assert rows(store, 'subscription')[0]['revoked']


@pytest.mark.parametrize('endpoint', ['http://push.example.test/x', 'https://localhost/x',
    'https://push.example.test.evil/x', 'https://push.example.test:8443/x',
    'https://user:pass@push.example.test/x', 'https://push.example.test/x#frag',
    'https://127.0.0.1/x', 'https://push.example.test/\nx', 'https://push.example.test\\evil/x'])
def test_endpoint_rejected(setup, endpoint):
    with pytest.raises(InvalidSubscription): setup[0].subscribe('a', subscription(endpoint))


def test_keys_are_real_curve_points(setup):
    sub = subscription()
    sub['keys']['p256dh'] = base64.urlsafe_b64encode(b'\x04' + b'\x00'*64).decode().rstrip('=')
    with pytest.raises(InvalidSubscription): setup[0].subscribe('a', sub)
    sub = subscription(); sub['keys']['auth'] = 'invalid'
    with pytest.raises(InvalidSubscription): setup[0].subscribe('a', sub)


@pytest.mark.parametrize('address', ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1'])
def test_dns_rejects_nonpublic(setup, address):
    with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', (address, 443))]):
        with pytest.raises(InvalidSubscription): setup[0].policy.addresses('push.example.test')


def test_received_dedup_audience_and_restart(setup):
    store, clock = setup
    for owner, path in [('a', '1'), ('a', '2'), ('b', '3')]:
        store.subscribe(owner, subscription('https://push.example.test/' + path))
    assert store.received('a', 'message', outgoing=True, live=True) == 0
    assert store.received('a', 'message', outgoing=False, live=False) == 0
    assert store.received('a', 'message', outgoing=False, live=True) == 2
    assert store.received('a', 'message', outgoing=False, live=True) == 0
    reopened = Store(store.directory, store.policy, lambda: clock[0])
    assert reopened.received('a', 'message', outgoing=False, live=True) == 0
    transport = Fake([201, 201]); worker = Worker(reopened, transport)
    assert worker.run_once() and worker.run_once() and not worker.run_once()
    assert {r['state'] for r in rows(store)} == {'sent'}
    assert all(set(payload) == {'v', 'tag'} for _, payload, _ in transport.calls)
    assert transport.calls[0][1]['tag'] == transport.calls[1][1]['tag']
    assert store.directory.stat().st_mode & 0o777 == 0o700
    assert store.path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize('status,state,error', [(201,'sent',None),(404,'revoked','subscription_gone'),(410,'revoked','subscription_gone'),(400,'failed','permanent'),(401,'failed','permanent'),(302,'failed','permanent'),(429,'pending','transient'),(503,'pending','transient')])
def test_status_classification(setup, status, state, error):
    store, _ = setup; store.subscribe('a', subscription())
    store.received('a', 'm', outgoing=False, live=True)
    Worker(store, Fake([status])).run_once()
    assert (rows(store)[0]['state'], rows(store)[0]['error']) == (state, error)


def test_retries_bounded_and_no_early_retry(setup):
    store, clock = setup; store.subscribe('a', subscription())
    store.received('a', 'm', outgoing=False, live=True)
    transport = Fake([503]*5); worker = Worker(store, transport)
    for i in range(5):
        assert worker.run_once()
        assert not worker.run_once()
        clock[0] += 30*2**i
    assert rows(store)[0]['attempts'] == 5
    assert rows(store)[0]['state'] == 'failed'
    assert len(transport.calls) == 5


def test_expiry_revoke_and_lease_recovery(setup):
    store, clock = setup; result = store.subscribe('a', subscription())
    store.received('a', 'expired', outgoing=False, live=True, ttl=1)
    clock[0] += 2
    transport = Fake(); worker = Worker(store, transport)
    assert not worker.run_once()
    assert rows(store)[0]['state'] == 'expired'
    store.received('a', 'recover', outgoing=False, live=True)
    with store.db() as db:
        db.execute("UPDATE outbox SET state='sending',attempts=1,lease='old',lease_until=? WHERE message='recover'", (clock[0]+60,))
    assert not worker.run_once()
    clock[0] += 61
    assert worker.run_once()
    store.received('a', 'cancel', outgoing=False, live=True)
    store.revoke('a', result['id'])
    assert not worker.run_once()
    assert rows(store)[-1]['state'] == 'cancelled'


def test_parallel_claim_one_send(setup):
    store, _ = setup; store.subscribe('a', subscription())
    store.received('a', 'm', outgoing=False, live=True)
    transport = Fake()
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: Worker(store, transport).run_once(), range(2)))
    assert sorted(results) == [False, True]
    assert len(transport.calls) == 1


def test_subscription_expiry_cancels_pending_and_browser_expiry(setup):
    store, clock = setup
    sub = subscription(); sub['expirationTime'] = (clock[0] + 1) * 1000
    result = store.subscribe('a', sub)
    assert result['expires'] == clock[0] + 1
    store.received('a', 'm', outgoing=False, live=True)
    clock[0] += 2
    assert not Worker(store, Fake()).run_once()
    assert rows(store)[0]['state'] == 'expired'
    assert store.received('a', 'new', outgoing=False, live=True) == 0
    sub['expirationTime'] = float('nan')
    with pytest.raises(InvalidSubscription): store.subscribe('a', sub)


def test_transport_exception_is_sanitized(setup, capsys):
    store, _ = setup; store.subscribe('a', subscription())
    store.received('a', 'm', outgoing=False, live=True)
    class Broken:
        def send(self, subscription, payload, ttl):
            raise RuntimeError('SECRET message body token')
    Worker(store, Broken()).run_once()
    assert rows(store)[0]['error'] == 'transient'
    assert 'SECRET' not in json.dumps(rows(store))
    assert not capsys.readouterr().err


def test_storage_rejects_symlinks(tmp_path):
    target = tmp_path / 'target'; target.mkdir()
    link = tmp_path / 'link'; link.symlink_to(target)
    with pytest.raises(ValueError): Store(link, EndpointPolicy({'push.example.test'}))
    (target / 'push.sqlite3').symlink_to(tmp_path / 'outside')
    with pytest.raises(OSError): Store(target, EndpointPolicy({'push.example.test'}))


def test_real_pywebpush_encrypts_without_network(setup):
    store, _ = setup
    transport = PyWebPushTransport(store.policy, ec.generate_private_key(ec.SECP256R1()), 'mailto:operator@example.test')
    # pywebpush accepts a Vapid object, not a cryptography key.
    from py_vapid import Vapid
    vapid = Vapid(); vapid.generate_keys(); transport.private_key = vapid
    captured = {}
    import requests
    def request(session, method, url, **kwargs):
        captured.update(kwargs)
        assert not session.trust_env
        assert method == 'POST' and url == 'https://push.example.test/token'
        response = requests.Response(); response.status_code = 201; response._content = b''
        return response
    with patch('requests.Session.request', request):
        assert transport.send(subscription(), '{"v":1}', 60) == 201
    assert captured['allow_redirects'] is False
    assert captured['data'] != b'{"v":1}'
    assert captured['headers']['authorization'].startswith('vapid ')
    assert 'Cookie' not in captured['headers']


def test_connection_pins_checked_ip_and_keeps_tls_host(setup):
    import requests
    store, _ = setup
    from py_vapid import Vapid
    vapid = Vapid(); vapid.generate_keys()
    transport = PyWebPushTransport(store.policy, vapid, 'mailto:operator@example.test')
    def request(session, method, url, **kwargs):
        adapter = session.get_adapter(url)
        pool = adapter.poolmanager.connection_from_url(url)
        conn = pool._new_conn()
        assert conn.host == 'push.example.test'
        with patch.object(store.policy, 'addresses', return_value=['8.8.8.8']), patch('socket.create_connection') as connect:
            conn._new_conn()
            assert connect.call_args.args[0] == ('8.8.8.8', 443)
        response = requests.Response(); response.status_code = 201; response._content = b''
        return response
    with patch('requests.Session.request', request):
        assert transport.send(subscription(), '{}', 60) == 201
