"""Prepare an explicitly isolated local preview. Never touch the installed app."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket

p = argparse.ArgumentParser()
p.add_argument('--directory', type=Path, required=True)
p.add_argument('--port', type=int, default=19246)
p.add_argument('--source-mount', action='store_true', help='Temporary pre-build verification only')
a = p.parse_args()
root = a.directory.resolve()
if root.exists() and not (root / '.unified-preview-owned').exists():
    raise SystemExit('Refusing unowned directory')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
(root / '.unified-preview-owned').touch(mode=0o600)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', a.port))
key = os.environ.get('TINFOIL_API_KEY', '')
if not key:
    envfile = Path.home() / '.hermes/.env'
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            if line.startswith('TINFOIL_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"').strip("'")
envpath = root / 'preview.env'
if not envpath.exists():
    values = {'APP_DATA_DIR': str(root), 'MESSENGER_API_TOKEN': secrets.token_urlsafe(48), 'MESSENGER_ALLOWED_ORIGINS': 'https://localhost:' + str(a.port), 'MESSENGER_PUBLIC_PATH': '/', 'TINFOIL_API_KEY': key, 'TRANSLATION_MODEL': 'gemma4-31b'}
    with envpath.open('w') as out:
        os.chmod(envpath, 0o600)
        out.write('\n'.join(k + '=' + v for k, v in values.items()) + '\n')
source = Path(__file__).resolve().parents[1]
services = {'messenger': {'ports': ['127.0.0.1:' + str(a.port) + ':8765']}}
if a.source_mount:
    for name in ('messenger', 'unified-init', 'translation'):
        services.setdefault(name, {}).update(image='wizard-messenger:0.1.1-candidate', volumes=[str(source) + ':/app:ro'])
    services['messenger']['entrypoint'] = ['/bin/sh', '/app/engine/entrypoint.sh']
(root / 'override.json').write_text(json.dumps({'services': services}, indent=2))
print('Preview configuration created; Tinfoil key ' + ('available' if key else 'NOT found') + '. No secrets printed.')
print('Source mounted before build: ' + str(a.source_mount))
