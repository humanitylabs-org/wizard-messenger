#!/usr/bin/env python3
"""Forum-only disposable pinned-worker proof. No owner data, login, or egress.

Downloads pinned images, exercises production worker commands with synthetic
config, and removes all containers/networks/fixture data. Printed output is
control metadata only; no arbitrary bridge logs or upstream bodies are emitted.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import yaml

ROOT = Path(__file__).resolve().parents[1]
SYNAPSE = 'ghcr.io/element-hq/synapse@sha256:e98ab72138d90fa8b8876c6421fe78a9fdb181c0d7cc690ad740e5173e0c65e6'


def run(*argv, input=None):
    result = subprocess.run(argv, input=input, text=True, capture_output=True, timeout=240)
    if result.returncode:
        # Never echo arbitrary docker/provisioning output into the task log.
        raise RuntimeError('Command failed: ' + argv[0] + ' ' + argv[1] + '; exit=' + str(result.returncode))
    return result.stdout.strip()


PROBE = r'''
import json, time, urllib.request, urllib.error
from pathlib import Path
from connectors import Connectors
controller = Connectors('/data/unified')
out = {}
for name, port, flow in [('slack', 29335, 'email'), ('instagram', 29330, 'android')]:
    started = time.monotonic()
    with urllib.request.urlopen('http://%s:%s/_matrix/mau/live' % (name, port), timeout=3) as response:
        assert response.status == 200
    try:
        urllib.request.urlopen('http://%s:%s/_matrix/provision/v3/whoami?user_id=%%40owner%%3Amessenger.internal' % (name, port), timeout=3)
        raise AssertionError('Missing-token request accepted')
    except urllib.error.HTTPError as error:
        assert error.code in (401, 403)
        denied = error.code
        error.close()
    status = controller.dispatch('GET', [name, 'status'], {})
    assert status['state'] == 'disconnected', (name, status['state'])
    assert status['capabilities']['bridge_live']
    assert not status['capabilities']['account_connected']
    assert any(f['id'] == flow for f in status['flows'])
    assert not status['logins']
    elapsed = round((time.monotonic() - started) * 1000)
    assert elapsed < 3000, (name, elapsed)
    out[name] = {'liveness_http': 200, 'missing_token_http': denied,
                 'owner_status': 'disconnected', 'owner_input_needed': True,
                 'bridge_live': True, 'account_connected': False,
                 'advertised_expected_flow': flow, 'elapsed_ms': elapsed}
print(json.dumps(out))
'''


def main():
    if not str(ROOT).startswith('/srv/work/'):
        raise RuntimeError('Run only through wizard_heavy_submit on forum /srv/work')
    evidence = ROOT / 'evidence/slack-instagram-workers'
    evidence.mkdir(parents=True, exist_ok=True)
    main_spec = yaml.safe_load((ROOT / 'runtipi/docker-compose.yml').read_text())
    services = main_spec['services']
    images = [SYNAPSE] + [services[n]['image'] for n in ('slack', 'instagram')]
    for image in images:
        try:
            run('docker', 'image', 'inspect', image)
        except RuntimeError:
            run('docker', 'pull', image)
    fixture = Path(tempfile.mkdtemp(prefix='worker-proof-', dir=str(evidence)))
    project = 'messenger-worker-proof-' + str(os.getpid())
    specfile = fixture / 'compose.json'
    spec = {'services': {}, 'networks': {'private': {'internal': True}}}
    # Production commands, pinned binaries, users, resources and healthchecks;
    # substitute only scratch mounts, dependencies and an isolated private lane.
    for name in ('matrix', 'slack', 'instagram'):
        item = copy.deepcopy(services[name])
        item['image'] = SYNAPSE if name == 'matrix' else services[name]['image']
        item['volumes'] = [str(fixture / 'data' / name) + ':/data']
        item['networks'] = ['private']
        item['restart'] = 'no'
        item.pop('depends_on', None)
        spec['services'][name] = item
    spec['services']['carrier'] = {
        'image': SYNAPSE, 'entrypoint': ['python', '-c'],
        'command': ['import time; time.sleep(600)'], 'user': '1000:1000',
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
        'networks': ['private'], 'working_dir': '/app',
        'volumes': [str(ROOT) + ':/app:ro', str(fixture / 'data') + ':/data'],
    }
    specfile.write_text(json.dumps(spec))
    compose = ['docker', 'compose', '-p', project, '-f', str(specfile)]
    outcomes = {'source_revision': run('git', '-C', str(ROOT), 'rev-parse', 'HEAD'),
                'provider_login_started': False, 'owner_data_mounted': False,
                'provider_egress': False, 'messages_accessed': False, 'messages_sent': 0}
    try:
        init = "import os; from unified_setup import setup; from connector_setup import setup_connectors; setup('/data'); setup_connectors('/data'); os.chown('/data', 1000, 1000)"
        run('docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
            '-v', str(ROOT) + ':/app:ro', '-v', str(fixture / 'data') + ':/data',
            '-w', '/app', '--entrypoint', 'python', SYNAPSE, '-c', init)
        run(*compose, 'up', '-d')
        carrier = run(*compose, 'ps', '-q', 'carrier')
        run('docker', 'exec', carrier, 'python', '-c', "import urllib.request,time\nfor i in range(60):\n try:\n  assert urllib.request.urlopen('http://matrix:8008/health',timeout=2).status==200; break\n except Exception: time.sleep(1)\nelse: raise RuntimeError('Matrix startup timeout')")
        # Dormant worker health is not readiness. No marker means no listener.
        dormant = "from connectors import Connectors; import socket; c=Connectors('/data/unified');\nfor n,p in [('slack',29335),('instagram',29330)]:\n assert c.status(n)['state']=='not_configured'\n s=socket.socket(); s.settimeout(1); assert s.connect_ex((n,p)) != 0; s.close()\nprint('dormant_no_listener')"
        assert run('docker', 'exec', carrier, 'python', '-c', dormant) == 'dormant_no_listener'
        before = {n: run(*compose, 'ps', '-q', n) for n in ('matrix', 'slack', 'instagram')}
        enable = "from connectors import Connectors; c=Connectors('/data/unified'); c.enable('slack'); c.enable('instagram')"
        run('docker', 'exec', carrier, 'python', '-c', enable)
        wait = "import time,urllib.request\nfor n,p in [('slack',29335),('instagram',29330)]:\n for i in range(60):\n  try:\n   assert urllib.request.urlopen('http://%s:%s/_matrix/mau/live'%(n,p),timeout=2).status==200; break\n  except Exception: time.sleep(1)\n else: raise RuntimeError('Worker startup timeout')"
        run('docker', 'exec', carrier, 'python', '-c', wait)
        outcomes['services'] = json.loads(run('docker', 'exec', '-i', carrier, 'python', '-', input=PROBE))
        after = {n: run(*compose, 'ps', '-q', n) for n in before}
        assert before == after
        outcomes['dormant_marker_wake_without_recreate'] = True
        outcomes['matrix_not_restarted'] = True
        # Readiness does not turn a genuine outage or transport timeout into ready.
        for name in ('slack', 'instagram'):
            run(*compose, 'stop', name)
            unavailable = "from connectors import Connectors; import time,json; c=Connectors('/data/unified'); t=time.monotonic(); s=c.status(%r); assert s['state']=='unavailable'; assert not s['capabilities']['bridge_live']; elapsed=round((time.monotonic()-t)*1000); assert elapsed<3000; print(json.dumps({'state':s['state'],'elapsed_ms':elapsed}))" % name
            outcomes['services'][name]['stopped_worker'] = json.loads(run('docker', 'exec', carrier, 'python', '-c', unavailable))
        outcomes['images'] = {image: json.loads(run('docker', 'image', 'inspect', image))[0]['Id'] for image in images}
    finally:
        run(*compose, 'down', '--volumes', '--remove-orphans')
        shutil.rmtree(fixture)
    outcomes['cleanup_complete'] = True
    (evidence / 'real-pinned-worker-proof.json').write_text(json.dumps(outcomes, indent=2) + '\n')
    print(json.dumps(outcomes, indent=2))


if __name__ == '__main__':
    main()
