#!/usr/bin/env python3
"""Durable forum light-lane entry point; all data is synthetic."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys
import yaml

parser = argparse.ArgumentParser()
parser.add_argument('--deployment-app-data', required=True)
parser.add_argument('--deployment-project', default='messenger_wizardapps')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
if not str(root).startswith('/srv/work/'):
    raise SystemExit('Forum /srv/work only')
evidence = root / 'evidence/slack-instagram-workers'
evidence.mkdir(parents=True, exist_ok=True)
with (evidence / 'unit-tests.log').open('w') as log:
    result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_connector*.py', '-v'], cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=240)
(evidence / 'unit-test-result.json').write_text(json.dumps({'exit_code': result.returncode, 'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()}) + '\n')
print('connector unit tests exit=' + str(result.returncode), flush=True)
if result.returncode:
    raise SystemExit(result.returncode)
subprocess.run([sys.executable, 'tools/prove_slack_instagram_workers.py'], cwd=root, check=True, timeout=600)
# A separate, two-service deployment document cannot recreate the healthy app,
# Matrix, Telegram, Signal or WhatsApp containers. No init job runs on live data.
source = yaml.safe_load((root / 'runtipi/docker-compose.yml').read_text())
deploy = {'services': {}, 'networks': {n: {'external': True, 'name': args.deployment_project + '_' + n} for n in ('matrix-lane', 'connector-egress')}}
for name in ('slack', 'instagram'):
    service = copy.deepcopy(source['services'][name])
    service.pop('depends_on', None)
    service['volumes'] = [str(Path(args.deployment_app_data) / 'data' / name) + ':/data']
    deploy['services'][name] = service
(evidence / 'workers-only.deploy.json').write_text(json.dumps(deploy, indent=2) + '\n')
# Export only public pinned images, never fixture or owner volumes, for a narrow
# deploy without building/downloading large images on the control plane.
with (evidence / 'worker-images.tar').open('wb') as output:
    subprocess.run(['docker', 'save', *[source['services'][n]['image'] for n in ('slack', 'instagram')]], stdout=output, check=True, timeout=120)
print('Pinned-worker proof complete; see evidence/slack-instagram-workers/', flush=True)
