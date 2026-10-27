"""Oscar's owner-only bridge adapter, extending the live shared inbox algorithms."""
from unified import *
from connectors import Connectors, MATRIX_NETWORKS, own_ghost

class ConnectorInbox(UnifiedInbox):
    def __init__(self, data, engine, sender=None):
        super().__init__(data, engine)
        self.sender = sender
        self.connectors = Connectors(self.root, self.owner, writer=sender,
                                     ensure_owner=self.matrix_token)

    def mx(self, path, method='GET', body=None, timeout=15):
        if method == 'GET':
            # No implicit registration from a read. Bootstrap is owner-only.
            token = self.store.get('matrix_token')
            if not token:
                fail('owner_bootstrap_required', 'Owner must initialize the private Matrix account', 409)
            return http(self.matrix, '/_matrix/client/v3' + path, method, body, token, timeout)
        if self.sender is None:
            fail('sender_required', 'An authorized owner sender is required for network writes', 403)
        return self.sender(network='matrix', base=self.matrix,
                           path='/_matrix/client/v3' + path, method=method,
                           body=body, token=self.store.get('matrix_token'), timeout=timeout)

    def matrix_token(self):
        # Register/login is also a write; do not bypass the isolated sender.
        token = self.store.get('matrix_token')
        if not token:
            if self.sender is not None and hasattr(self.sender, 'bootstrap'):
                return self.sender.bootstrap(self)
            fail('owner_bootstrap_required', 'Initialize Matrix on the owner-controlled sender and provision its read capability separately', 409)
        return token

    def trusted_inviter(self, sender):
        if not sender.endswith(':messenger.internal'):
            return False
        for network in MATRIX_NETWORKS:
            try:
                self.connectors.config(network)
            except EngineError:
                continue
            if sender.startswith('@' + network + '_') or sender == '@' + network + 'bot:messenger.internal':
                return True
        return False

    def dispatch(self, method, path, payload, query=None, raw=None):
        parts = [unquote(p) for p in path.split('?')[0].strip('/').split('/')]
        if parts[:3] == ['api', 'unified', 'connectors']:
            return self.connectors.dispatch(method, parts[3:], payload)
        if parts[:3] == ['api', 'unified', 'telegram']:
            result = self.connectors.dispatch(method, ['telegram'] + parts[3:], payload)
            if method == 'GET' and parts[3:] == ['status']:
                pending = self.connectors.telegram_resume
                result['pending_login'] = pending[1] if pending and pending[0] > time.monotonic() else None
            return result
        return super().dispatch(method, path, payload, query, raw)

    def telegram_status(self):
        # General status is available to a machine key: never include pending QR
        # provisioning data, even when the owner is currently linking a device.
        status = self.connectors.status('telegram')
        # Keep Telegram profile fields used by live My QR codes suggestions.
        if status['state'] not in ('not_configured', 'unavailable'):
            try:
                status['logins'] = self.connectors.request('telegram', '/whoami').get('logins') or []
            except EngineError:
                pass
        return status

    def provision(self, path, method='GET', body=None):
        # Preserve the legacy Telegram routes, but all writes use the sender.
        return self.connectors.request('telegram', path, method, body)

    def room_meta(self, room, data):
        # One shared live room parser; only provider classification is extended.
        return super().room_meta(room, data)

    def learn_me(self):
        if time.time() - self.mine_checked < 300:
            return
        self.mine_checked = time.time()
        found = set()
        for network in MATRIX_NETWORKS:
            try:
                logins = self.connectors.request(network, '/whoami').get('logins') or []
            except EngineError:
                continue
            for login in logins:
                ghost = own_ghost(network, login.get('id'))
                if ghost:
                    found.add(ghost)
        if found - self.mine:
            self.mine |= found
            self.store.put('own_ghosts', json.dumps(sorted(self.mine)))
        for ghost in self.mine:
            if not self.store.get('own_fixed:' + ghost):
                self.store.claim_own(ghost)
                self.store.put('own_fixed:' + ghost, '1')

    def matrix_upload(self, data, filename, mime):
        if self.sender is None:
            fail('sender_required', 'An authorized owner sender is required for uploads', 403)
        return self.sender(network='matrix', base=self.matrix,
                           path='/_matrix/media/v3/upload?' + urlencode({'filename': filename}),
                           method='POST', body=data, token=self.matrix_token(),
                           content_type=mime, timeout=60)
