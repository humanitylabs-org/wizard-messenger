"""Local Docker fixture deployment. Never starts installed Messenger or Hermes."""
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
DEFAULT_IMAGE = 'python:3.12-slim'


def docker(*args):
    p = subprocess.run(['docker', *map(str, args)], text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError('docker %s: %s' % (args[0], p.stderr))
    return p.stdout.strip()


class Deployment:
    def __init__(self):
        # Resolve once to a local content-addressed image; never pulls/builds.
        self.image = docker('image', 'inspect', os.environ.get('SAME_HOST_IMAGE', DEFAULT_IMAGE), '--format', '{{.Id}}')
        self.prefix = 'messenger-same-host-' + uuid.uuid4().hex[:12]
        self.volumes = []
        self.containers = []
        self.names = {role: self.prefix + '-' + role for role in ('broker', 'worker', 'owner')}
        self.vol = {role: self.prefix + '-' + role for role in ('agent', 'owner', 'state')}

    def common(self, name, uid):
        return ['run', '--detach', '--pull=never', '--name', name,
                '--label', 'wizard.test=messenger-same-host', '--network', 'none',
                '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
                '--user', str(uid) + ':' + str(uid), '--pids-limit', '64', '--memory', '128m',
                '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m',
                '--mount', 'type=bind,src=%s,dst=/code,readonly' % HERE,
                '--workdir', '/code', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--entrypoint', 'python3']

    def start(self):
        for v in self.vol.values():
            docker('volume', 'create', '--label', 'wizard.test=messenger-same-host', v)
            self.volumes.append(v)
        # Root only inside the namespace for empty-volume ownership initialization.
        # Not a worker, no host socket/files/secrets; fixture key generated here only.
        init = """import os,secrets
from pathlib import Path
p=Path('/state/fixture-provider-key'); p.write_text('TEST-ONLY-'+secrets.token_hex(32)); os.chmod(p,0o600); os.chown(p,10001,10001)
for p in ['/agent','/owner','/state']:
 os.chmod(p,0o755 if p=='/agent' else 0o700); os.chown(p,10001,10001)
"""
        name = self.prefix + '-init'
        self.containers.append(name)
        docker('run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--read-only',
               '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=FOWNER', '--security-opt', 'no-new-privileges:true',
               *sum((['--mount', 'type=volume,src=%s,dst=/%s' % (v, k)] for k, v in self.vol.items()), []),
               '--entrypoint', 'python3', self.image, '-c', init)
        for role, uid in [('broker', 10001), ('worker', 10002), ('owner', 10001)]:
            args = self.common(self.names[role], uid)
            mounts = ('agent', 'owner', 'state') if role == 'broker' else (('agent',) if role == 'worker' else ('owner',))
            for k in mounts:
                args += ['--mount', 'type=volume,src=%s,dst=/%s%s' % (self.vol[k], k, '' if role == 'broker' else ',readonly')]
            args += [self.image, '/code/broker.py'] if role == 'broker' else [self.image, '-c', 'import time; time.sleep(86400)']
            self.containers.append(self.names[role])
            docker(*args)
        for _ in range(60):
            try:
                if self.rpc('owner', {'op': 'inspect'})['ok']:
                    return
            except RuntimeError:
                pass
            time.sleep(0.1)
        raise RuntimeError('fixture broker not ready: ' + docker('logs', self.names['broker']))

    def rpc(self, role, q):
        assert role in ('worker', 'owner')
        socket = '/agent/broker.sock' if role == 'worker' else '/owner/control.sock'
        return json.loads(docker('exec', self.names[role], 'python3', '/code/client.py', socket, json.dumps(q)))

    def cleanup(self):
        errors = []
        for name in reversed(self.containers):
            p = subprocess.run(['docker', 'rm', '-f', name], text=True, capture_output=True)
            if p.returncode and 'No such container' not in p.stderr:
                errors.append(p.stderr)
        for v in reversed(self.volumes):
            try:
                docker('volume', 'rm', v)
            except RuntimeError as e:
                errors.append(str(e))
        # Read back exact resource names, never prune shared resources.
        remaining = docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        assert not set(self.containers) & set(remaining)
        remaining_vol = docker('volume', 'ls', '--format', '{{.Name}}').splitlines()
        assert not set(self.volumes) & set(remaining_vol)
        if errors:
            raise RuntimeError('; '.join(errors))
        print('PASS test resources removed and read-back verified', flush=True)
