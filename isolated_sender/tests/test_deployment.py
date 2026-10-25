"""Real executable/TLS socket and fail-closed deployment guards. Local fixtures ONLY."""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
import httpx
import pytest

from isolated_sender.service import digest
from isolated_sender.wizard_client import validate

ROOT = Path(__file__).resolve().parents[2]


def test_shipped_wizard_deployment_is_disabled():
    path = ROOT / 'isolated_sender/deploy/wizard-client.disabled.json'
    result = subprocess.run([sys.executable, '-m', 'isolated_sender.wizard_client', 'preflight', '--config', str(path)], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 1
    assert 'no local fallback' in result.stderr


@pytest.mark.parametrize('endpoint', [None, 'http://owner.test', 'https://wizard.test', 'https://localhost', 'https://owner.test/proxy', 'https://a:b@owner.test', 'https://owner.test:8443'])
def test_wizard_guard_rejects_unsafe_endpoints(endpoint):
    with pytest.raises(ValueError):
        validate({'independent_endpoint': endpoint, 'wizard_origin': 'https://wizard.test',
                  'owner_verified_independent_host': True, 'draft_key_file': '/secrets/draft.key'})


def test_owner_config_ships_disabled():
    path = ROOT / 'isolated_sender/deploy/owner-config.example.json'
    result = subprocess.run([sys.executable, '-m', 'isolated_sender.service', 'check', '--config', str(path)], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode != 0


def test_live_https_executable_and_draft_boundary(tmp_path):
    # The only network in this test is a loopback fixture subprocess. Generated CA
    # trust applies only to this client and is never installed on this host.
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'owner.example.test')])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(minutes=10))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('owner.example.test'),
                           x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .sign(key, hashes.SHA256()))
    certfile, keyfile = tmp_path / 'fixture.pem', tmp_path / 'fixture.key'
    certfile.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    config = tmp_path / 'config.json'
    agent_key = 'fixture-key-not-for-real-use-000000000000'
    config.write_text(json.dumps({'origin': 'https://owner.example.test', 'rp_id': 'owner.example.test',
                                 'database': str(tmp_path / 'test.db'), 'agent_key_sha256': digest(agent_key),
                                 'accounts': ['test-owner'], 'independently_administered': True}))
    # No enrollment, real owner credential or provider capability is created.
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    args = [sys.executable, '-m', 'isolated_sender.service', 'serve', '--config', str(config),
            '--host', '127.0.0.1', '--port', str(port), '--tls-cert', str(certfile), '--tls-key', str(keyfile)]
    with (tmp_path / 'server.log').open('w+') as log:
        process = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=log, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        try:
            trust = ssl.create_default_context(cafile=str(certfile))
            with httpx.Client(base_url=f'https://127.0.0.1:{port}', verify=trust, trust_env=False,
                              headers={'host': 'owner.example.test'}, timeout=2) as client:
                for _ in range(80):
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail('fixture server exited: ' + log.read())
                    try:
                        ready = client.get('/health')
                        if ready.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(0.05)
                else:
                    pytest.fail('fixture TLS server never ready')
                assert ready.json()['production_send'] is False
                assert client.get('/').status_code == 200
                value = {'request_id': 'socket-fixture-request-0001', 'account': 'test-owner',
                         'recipient': 'test-recipient', 'body': 'no real message'}
                draft = client.post('/agent/drafts', headers={'authorization': 'Bearer ' + agent_key}, json=value)
                assert draft.status_code == 200, draft.text
                did = draft.json()['id']
                status = client.get('/agent/drafts/' + did, headers={'authorization': 'Bearer ' + agent_key})
                assert status.json()['status'] == 'pending'
                assert client.post('/agent/full-send/' + did, headers={'authorization': 'Bearer ' + agent_key}).status_code == 403
                assert client.post('/owner/begin', headers={'origin': 'https://wizard.example.test'}, json={'action': 'login'}).status_code == 403
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            with socket.socket() as check:
                check.settimeout(0.2)
                assert check.connect_ex(('127.0.0.1', port)) != 0, 'fixture TLS listener survived cleanup'
