#!/usr/bin/env python3
"""Disposable real Synapse/bridge HTTP proof, no provider login/send/egress.

Only already-present images and scratch data; no host ports or Docker socket in
carrier. Removes its own containers/network and retains private scratch logs.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified_setup import setup
from connector_setup import setup_connectors
from connectors import Connectors

ROOT = Path(__file__).resolve().parents[1]
SYNAPSE = 'ghcr.io/element-hq/synapse@sha256:e98ab72138d90fa8b8876c6421fe78a9fdb181c0d7cc690ad740e5173e0c65e6'
CARRIER = 'python@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.STDOUT).strip()


def run():
    import yaml
    proof = json.loads((ROOT / 'plumbing/connectors-provenance.json').read_text())
    base = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())
    specs = {n: (p.get('local_image_id', p['image']), p.get('image_executable', '/usr/bin/mautrix-' + n)) for n, p in proof.items()}
    specs['telegram'] = (base['services']['telegram']['image'], '/usr/bin/mautrix-telegram')
    for image in [SYNAPSE, CARRIER, *(v[0] for v in specs.values())]:
        docker('image', 'inspect', image)
    root = Path(tempfile.mkdtemp(prefix='five-bridge-http-', dir=os.environ.get('TMPDIR')))
    # Non-account syntax fixture only: no external network and no Telegram start.
    with patch.dict(os.environ, {'TELEGRAM_API_ID': '1', 'TELEGRAM_API_HASH': '0' * 32}):
        setup(root)
    setup_connectors(root, proof)
    project = 'messenger-five-proof-' + str(os.getpid())
    containers = []
    outcomes = {'isolation': 'internal Docker network; no provider egress or published ports', 'carrier_image': CARRIER, 'owner_account_login_attempted': False, 'messages_sent': 0, 'telegram_api_configuration': 'non-account syntax fixture, not usable account credentials', 'services': {}}
    try:
        docker('network', 'create', '--internal', project)
        carrier = project + '-carrier'
        docker('run', '-d', '--pull=never', '--name', carrier, '--network', project, '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', str(root) + ':/data', '-v', str(ROOT) + ':/app:ro', CARRIER, 'sleep', '600')
        containers.append(carrier)
        def launch(name, image, executable, args):
            cname = project + '-' + name
            docker('run', '-d', '--pull=never', '--name', cname, '--network', project, '--network-alias', name, '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '0:0', '-v', str(root / name) + ':/data', '--entrypoint', executable, image, *args)
            containers.append(cname)
        def wait(url):
            code = "import urllib.request,time\nfor i in range(90):\n try:\n  r=urllib.request.urlopen(%r,timeout=2);assert r.status==200;break\n except Exception:time.sleep(1)\nelse:raise RuntimeError('Service not live')" % url
            docker('exec', carrier, 'python', '-c', code)
        launch('matrix', SYNAPSE, 'python', ['-m', 'synapse.app.homeserver', '--config-path', '/data/homeserver.yaml'])
        wait('http://matrix:8008/_matrix/client/versions')
        outcomes['synapse'] = {'image': SYNAPSE, 'versions_http': 200}
        for name, (image, executable) in specs.items():
            conf = json.loads((root / name / 'config.yaml').read_text())
            launch(name, image, executable, ['-c', '/data/config.yaml'])
            wait('http://%s:%s/_matrix/mau/live' % (name, conf['appservice']['port']))
            outcomes['services'][name] = {'image': image, 'liveness_http': 200}
        result = json.loads(docker('exec', carrier, 'python', '/app/tools/prove_connector_http.py'))
        for name, evidence in result.pop('services').items():
            outcomes['services'][name].update(evidence)
        outcomes.update(result)
        # Disable optional connectors; inspect all statuses without touching I/O.
        setup_connectors(root)
        outcomes['dormant_readback'] = Connectors(root / 'unified', reader=lambda *a: (_ for _ in ()).throw(AssertionError('Dormant I/O'))).health()
        return outcomes
    except Exception:
        for c in containers:
            (root / (c + '.log')).write_text(docker('logs', c))
        print('Private diagnostics: ' + str(root), file=sys.stderr)
        raise
    finally:
        for c in reversed(containers): docker('rm', '-f', c)
        docker('network', 'rm', project)


if __name__ == '__main__':
    result = run()
    (ROOT / 'evidence/five-network-real-http.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
