#!/usr/bin/env python3
"""Live control-only probe: no token, message store, provider login or logs."""
import argparse
import json
from pathlib import Path
import subprocess

PROBE = r'''
import json, time, urllib.request, urllib.error
from pathlib import Path
root = Path('/data')
conf = json.loads((root / 'unified/connectors.json').read_text())
registrations = json.loads((root / 'matrix/homeserver.yaml').read_text()).get('app_service_config_files', [])
out = {'config': {}, 'http': []}
for n in ('slack', 'instagram'):
    out['config'][n] = {'enabled': conf.get(n, {}).get('enabled') is True,
                        'configured_marker': (root/n/'configured').is_file(),
                        'config_exists': (root/n/'config.yaml').is_file(),
                        'matrix_registration_loaded': '/data/'+n+'-registration.yaml' in registrations}
for name, port, path in [('matrix',8008,'/health'), ('telegram',29317,'/_matrix/mau/live'),
                         ('signal',29328,'/_matrix/mau/live'), ('whatsapp',29318,'/_matrix/mau/live'),
                         ('slack',29335,'/_matrix/mau/live'), ('instagram',29330,'/_matrix/mau/live'),
                         ('slack',29335,'/_matrix/mau/ready'), ('instagram',29330,'/_matrix/mau/ready'),
                         ('slack',29335,'/_matrix/provision/v3/whoami'),
                         ('instagram',29330,'/_matrix/provision/v3/whoami'),
                         ('127.0.0.1',8765,'/healthz'),
                         ('127.0.0.1',8765,'/api/unified/connectors/slack/status'),
                         ('127.0.0.1',8765,'/api/unified/connectors/instagram/status')]:
    start=time.monotonic(); row={'service': name, 'path': path}
    try:
        with urllib.request.urlopen('http://%s:%s%s'%(name,port,path),timeout=3) as response:
            row['http']=response.status
    except urllib.error.HTTPError as e:
        row['http']=e.code; e.close()
    except Exception as e:
        row['error_class']=type(e).__name__; row['reason_class']=type(getattr(e,'reason',None)).__name__
    row['elapsed_ms']=round((time.monotonic()-start)*1000); out['http'].append(row)
print(json.dumps(out))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--container', default='messenger_wizardapps-messenger-1')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    record = json.loads(subprocess.check_output(['docker', 'inspect', args.container]))[0]
    out = {'container': args.container, 'container_id': record['Id'], 'image_id': record['Image'],
           'image_revision': record['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
           'mounts': [{'source': m['Source'], 'destination': m['Destination'], 'rw': m['RW']} for m in record['Mounts']],
           'changes': subprocess.check_output(['docker', 'diff', args.container], text=True).splitlines(),
           'account_authentication_attempted': False, 'message_store_accessed': False}
    out.update(json.loads(subprocess.check_output(['docker', 'exec', '-i', args.container, 'python3', '-'], input=PROBE, text=True)))
    names = ('messenger_wizardapps-slack-1', 'messenger_wizardapps-instagram-1', 'messenger_wizardapps-matrix-1', 'messenger_wizardapps-telegram-1', 'messenger_wizardapps-signal-1', 'messenger_wizardapps-whatsapp-1')
    out['workers'] = {}
    for name in names:
        result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
        if result.returncode:
            out['workers'][name] = {'exists': False}
            continue
        worker = json.loads(result.stdout)[0]
        out['workers'][name] = {'exists': True, 'container_id': worker['Id'], 'image_id': worker['Image'],
                                'state': worker['State']['Status'], 'started_at': worker['State']['StartedAt'],
                                'health': worker['State'].get('Health', {}).get('Status')}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out, indent=2) + '\n')
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
