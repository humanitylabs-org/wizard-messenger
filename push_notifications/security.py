"""Push capability validation and DNS-pinned, certificate-verified HTTPS transport."""
import base64
import ipaddress
import re
import socket
from urllib.parse import urlsplit
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePublicKey, SECP256R1


class InvalidSubscription(ValueError):
    pass


class EndpointPolicy:
    # Exact service hosts, never suffix matching or a client-supplied allowlist.
    def __init__(self, hosts):
        self.hosts = frozenset(hosts)
        if not self.hosts:
            raise ValueError('Explicit push service hosts required')

    def endpoint(self, value):
        if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise InvalidSubscription('Invalid push endpoint')
        try:
            p = urlsplit(value)
            valid = (p.scheme == 'https' and p.hostname in self.hosts and p.port in (None, 443)
                     and not p.username and not p.password and not p.fragment and p.path.startswith('/')
                     and '\\' not in value)
        except ValueError:
            raise InvalidSubscription('Untrusted push endpoint') from None
        if not valid:
            raise InvalidSubscription('Untrusted push endpoint')
        return p

    def subscription(self, value):
        try:
            self.endpoint(value['endpoint'])
            keys = value['keys']
            def decode(k, size):
                s = keys[k]
                if not isinstance(s, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', s):
                    raise ValueError()
                b = base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
                if len(b) != size:
                    raise ValueError()
                return b
            point = decode('p256dh', 65)
            EllipticCurvePublicKey.from_encoded_point(SECP256R1(), point)
            decode('auth', 16)
            # Only Web Push encryption keys survive. No arbitrary headers/credentials.
            return {'endpoint': value['endpoint'], 'keys': {k: keys[k] for k in ('auth', 'p256dh')}}
        except (KeyError, TypeError, ValueError):
            raise InvalidSubscription('Invalid push subscription') from None

    def addresses(self, host):
        addresses = {r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise InvalidSubscription('Push service DNS is not public')
        return sorted(addresses)


class PyWebPushTransport:
    """No cookies, environment proxy/netrc, redirects, or caller-supplied HTTP headers.

    Resolve at connection time and connect to the checked numeric IP. TLS still
    validates/SNIs the original service hostname, closing DNS-rebinding TOCTOU.
    """
    def __init__(self, policy, private_key, subject):
        if not subject.startswith('mailto:'):
            raise ValueError('Operator mailto VAPID subject required')
        self.policy, self.private_key, self.subject = policy, private_key, subject

    def send(self, subscription, payload, ttl):
        import requests
        from urllib3.connection import HTTPSConnection
        from urllib3.connectionpool import HTTPSConnectionPool
        from requests.adapters import HTTPAdapter
        from pywebpush import webpush, WebPushException
        policy = self.policy
        subscription = policy.subscription(subscription)
        endpoint = subscription['endpoint']
        host = policy.endpoint(endpoint).hostname

        class PinnedConnection(HTTPSConnection):
            def _new_conn(self):
                policy.endpoint('https://' + self.host + '/')
                addresses = policy.addresses(self.host)
                return socket.create_connection((addresses[0], 443), timeout=self.timeout,
                                                source_address=self.source_address)

        class PinnedPool(HTTPSConnectionPool):
            ConnectionCls = PinnedConnection

        class Adapter(HTTPAdapter):
            def init_poolmanager(self, *args, **kwargs):
                super().init_poolmanager(*args, **kwargs)
                self.poolmanager.pool_classes_by_scheme = {'https': PinnedPool}

        class RestrictedSession(requests.Session):
            def post(self, url, **kwargs):
                if url != endpoint:
                    raise InvalidSubscription('Endpoint changed')
                kwargs['allow_redirects'] = False
                return super().post(url, **kwargs)

        with RestrictedSession() as session:
            session.trust_env = False
            session.mount('https://', Adapter(max_retries=0))
            try:
                response = webpush(subscription, data=payload, vapid_private_key=self.private_key,
                                   vapid_claims={'sub': self.subject, 'aud': 'https://' + host},
                                   requests_session=session, timeout=10, ttl=ttl, verbose=False)
                return response.status_code
            except WebPushException as exc:
                return exc.response.status_code if exc.response is not None else 503
            except InvalidSubscription:
                return 400
            except requests.RequestException:
                return 503
