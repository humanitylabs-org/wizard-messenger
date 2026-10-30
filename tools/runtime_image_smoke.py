"""Run via stdin inside the packaged image: no source/data bind mounts or provider I/O."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading

import engine
import server
import web
import passkey
import messenger_addresses
import unified
import unified_setup
import translation
import history_cursor
import permissions
import drafts
import remote_authority
import connector_setup
import connectors
import connector_inbox
import connector_web
import readiness.search
# Push dependencies are an explicit opt-in Docker build/runtime feature. Verify
# dormant startup without importing that optional dependency tree.
import builtins
_real_import = builtins.__import__
def dormant_import(name, *args, **kwargs):
    if name.startswith('push_notifications'):
        raise AssertionError('Disabled push must not import optional dependencies')
    return _real_import(name, *args, **kwargs)
builtins.__import__ = dormant_import


class FixtureEngine:
    relays = []

    def __init__(self, data):
        self.data = data
        self.ready = False

    def status(self):
        return {'state': 'ready' if self.ready else 'setup_required', 'account_configured': self.ready}

    def setup(self, payload):
        return self.setup_with_proof(payload)[0]

    def setup_with_proof(self, payload):
        self.ready = True
        return self.status(), True


with tempfile.TemporaryDirectory(dir='/run/messenger') as directory:
    os.environ['UNIFIED_ENABLED'] = '0'
    os.environ['MESSENGER_COOKIE_SECURE'] = '0'
    instance = web.ViewServer(('127.0.0.1', 0), FixtureEngine(Path(directory)), 'fixture-' + 'a'*48, [])
    origin = 'http://127.0.0.1:' + str(instance.server_port)
    instance.origins = frozenset({origin})
    artifact = web.provision_owner_enrollment(instance)
    ticket = json.loads(artifact.read_text())['fragment'].removeprefix('#ticket=')
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()

    def request(path, payload, cookie=None, csrf=None, bearer=False):
        connection = http.client.HTTPConnection('127.0.0.1', instance.server_port)
        headers = {'Content-Type': 'application/json', 'Origin': origin}
        if cookie:
            headers['Cookie'] = cookie
        if csrf:
            headers['X-Messenger-CSRF'] = csrf
        if bearer:
            headers['Authorization'] = 'Bearer ' + instance.token
        connection.request('POST', path, json.dumps(payload), headers)
        response = connection.getresponse()
        data = json.loads(response.read())
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    try:
        status, headers, data = request('/api/view/session', {'ticket': ticket})
        assert status == 200, data
        cookie = headers['Set-Cookie'].split(';')[0]
        csrf = data['result']['csrf_token']
        status, _, data = request('/api/setup', {'action': 'create', 'vault_password': 'packaged-runtime-fixture-password'}, cookie, csrf)
        assert status == 200, data
        status, _, data = request('/api/view/unlock', {'vault_password': 'packaged-runtime-fixture-password'})
        assert status == 200, data
        status, headers, _ = request('/api/view/session', {'ticket': ticket}, bearer=True)
        assert status == 403 and 'Set-Cookie' not in headers
        print(json.dumps({'imports': 'PASS', 'packaged_owner_first_run': 'PASS', 'configured_bearer_owner_session_denied': True,
                          'source_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in Path('/app').glob('*.py')},
                          'scope': 'packaged code, fake provider, no source mounts, network-none container; not deployed confinement'}))
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join()
