#!/usr/bin/env python3
"""App-owned private beta configuration; never reads another app's secrets."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import urllib.request
from urllib.parse import urlsplit

VERSION = '0.1.2-beta.1'
IMAGE = 'wizard-messenger:' + VERSION


def configure(root, base_url, port):
    u = urlsplit(base_url)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('An exact private HTTPS app URL is required')
    if not re.fullmatch(r'[A-Za-z0-9.-]+(?::[0-9]+)?', u.netloc):
        raise ValueError('Invalid HTTPS authority')
    path = u.path or '/apps/messenger/'
    if not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)+', path):
        raise ValueError('Use an app path ending with /')
    if not 1024 <= port <= 65535:
        raise ValueError('Use an unprivileged loopback port')
    origin = 'https://' + u.netloc
    root = Path(root).resolve()
    receipt = root / 'install.json'
    wanted = {'app': 'messenger', 'version': VERSION, 'origin': origin, 'path': path, 'port': port, 'image': IMAGE}
    if receipt.exists():
        prior = json.loads(receipt.read_text())
        if any(prior.get(k) != wanted[k] for k in ('app', 'origin', 'path', 'port')):
            raise ValueError('Existing installation target differs; refusing to change identity/configuration')
        # Re-runs preserve capability, data, and first-run entry.
        if not (root / '.env').is_file() or not (root / 'compose.json').is_file():
            raise ValueError('Incomplete owned installation; repair explicitly')
        return prior
    if root.exists() and any(root.iterdir()):
        raise ValueError('Refusing nonempty unowned installation directory')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    env = {'MESSENGER_API_TOKEN': secrets.token_urlsafe(48), 'MESSENGER_ALLOWED_ORIGINS': origin,
           'MESSENGER_PUBLIC_PATH': path, 'MESSENGER_COOKIE_SECURE': '1'}
    with (root / '.env').open('x') as f:
        os.chmod(f.name, 0o600)
        f.write(''.join(k + '=' + v + '\n' for k, v in env.items()))
    compose = {'services': {'messenger': {
        'image': IMAGE, 'pull_policy': 'never', 'restart': 'unless-stopped',
        'user': '0:0', 'read_only': True, 'cap_drop': ['ALL'], 'cap_add': ['CHOWN', 'SETUID', 'SETGID'],
        'security_opt': ['no-new-privileges:true'], 'pids_limit': 256, 'mem_limit': '1g',
        'env_file': ['.env'], 'ports': [f'127.0.0.1:{port}:8765'],
        'volumes': ['./data:/data'],
        'tmpfs': ['/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000',
                  '/run/messenger:rw,noexec,nosuid,size=64m,mode=0700,uid=1000,gid=1000']}}}
    (root / 'compose.json').write_text(json.dumps(compose, indent=2) + '\n')
    (root / 'route.caddy').write_text(f'handle_path {path}* {{\n    reverse_proxy 127.0.0.1:{port}\n}}\n')
    (root / 'route.json').write_text(json.dumps({'messenger': {'view': path}}, indent=2) + '\n')
    receipt.write_text(json.dumps(wanted, indent=2) + '\n')
    return wanted


def setup(root):
    root = Path(root)
    cfg = json.loads((root / 'install.json').read_text())
    env = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines())
    base = 'http://127.0.0.1:' + str(cfg['port'])
    auth = {'Authorization': 'Bearer ' + env['MESSENGER_API_TOKEN']}
    with urllib.request.urlopen(urllib.request.Request(base + '/api/status', headers=auth), timeout=30) as r:
        status = json.load(r)['result']
    url = cfg['origin'] + cfg['path']
    if not status.get('account_configured'):
        req = urllib.request.Request(base + '/api/view/ticket', data=b'{"bootstrap":true}',
            headers={**auth, 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=30) as r:
            ticket = json.load(r)['result']['ticket']
        url += '#ticket=' + ticket
    # The one-use URL is a secret; never print it into logs or release receipts.
    dest = root / 'owner-setup-url.txt'
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        os.chmod(dest, 0o600)
        f.write(url + '\n')
    return {'setup_file': str(dest), 'account_configured': status.get('account_configured', False)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['configure', 'setup'])
    p.add_argument('--root', required=True)
    p.add_argument('--base-url')
    p.add_argument('--port', type=int, default=9245)
    a = p.parse_args()
    if a.action == 'configure' and not a.base_url:
        p.error('--base-url is required for configure')
    os.umask(0o077)
    print(json.dumps(configure(a.root, a.base_url, a.port) if a.action == 'configure' else setup(a.root), indent=2))


if __name__ == '__main__':
    main()
