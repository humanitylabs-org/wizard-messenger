"""Runs INSIDE the adversarial worker (arbitrary Python is intentional)."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
from client import call


def check(name, success, detail=''):
    if not success:
        raise AssertionError(name + ': ' + str(detail))
    print('PASS ' + name, flush=True)


if __name__ == '__main__':
    for op in ('send', 'approve', 'freeze', 'policy', 'inspect', 'exec', 'upload', 'proxy'):
        request = {'op': op, 'mode': 'draft-only', 'url': 'http://host.docker.internal'}
        result = call(request)
        check('worker denied ' + op, result['ok'] is False, result)
    check('worker cannot schema-smuggle owner flag', not call({'op': 'read', 'owner': True})['ok'])
    paths = ['/state/fixture-provider-key', '/state/fixture.json', '/owner/control.sock',
             '/var/run/docker.sock', '/run/docker.sock', '/run/user/1000/docker.sock', '/home/oscar/.hermes/.env',
             '/home/oscar/runtipi', '/root/.ssh/id_rsa', '/host', '/proc/1/root/state/fixture-provider-key']
    for path in paths:
        try:
            Path(path).read_bytes()
        except (OSError, PermissionError):
            check('worker cannot read ' + path, True)
        else:
            check('worker cannot read ' + path, False)
    for path in ['/owner/control.sock', '/agent/../owner/control.sock', '/var/run/docker.sock', '/run/user/1000/docker.sock']:
        try:
            call({'op': 'policy', 'mode': 'draft-only'}, path)
        except OSError:
            check('worker cannot connect ' + path, True)
        else:
            check('worker cannot connect ' + path, False)
    check('worker no provider/owner credential env', not any(k for k in os.environ if any(t in k.upper() for t in ('TOKEN', 'SECRET', 'API_KEY', 'PASSWORD'))))
    status = Path('/proc/self/status').read_text().splitlines()
    check('worker zero effective caps', 'CapEff:\t0000000000000000' in status)
    check('worker no-new-privileges', 'NoNewPrivs:\t1' in status)
    check('worker seccomp filter active', 'Seccomp:\t2' in status)
    check('worker unprivileged UID', os.getuid() == 10002)
    check('worker has no sudo executable', shutil.which('sudo') is None)
    check('worker has no Docker executable', shutil.which('docker') is None)
    for target in ('/code/broker.py', '/agent/injected'):
        try:
            with open(target, 'a') as f:
                f.write('attack')
        except OSError:
            check('worker immutable mount ' + target, True)
        else:
            check('worker immutable mount ' + target, False)
    check('worker only loopback interface', sorted(os.listdir('/sys/class/net')) == ['lo'])
    for host, port in [('172.17.0.1', 2375), ('172.17.0.1', 80), ('169.254.169.254', 80), ('1.1.1.1', 443), ('127.0.0.1', 2375)]:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                pass
        except OSError:
            check('worker blocked network %s:%s' % (host, port), True)
        else:
            check('worker blocked network %s:%s' % (host, port), False)
    try:
        socket.gethostbyname('host.docker.internal')
    except OSError:
        check('worker no host gateway alias', True)
    else:
        check('worker no host gateway alias', False)
    try:
        subprocess.run(['mount', '-t', 'tmpfs', 'tmpfs', '/tmp'], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        check('worker cannot mount', True)
    else:
        check('worker cannot mount', False)
    print('ADVERSARIAL WORKER COMPLETE', flush=True)
