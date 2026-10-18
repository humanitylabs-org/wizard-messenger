#!/usr/bin/env python3
"""Run through the durable build worker on the designated external volume only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--revision', required=True)
p.add_argument('--context', default='colima')
p.add_argument('--carrier', default='wizard-messenger:0.1.2-beta.1-amd64')
p.add_argument('--tag', default='wizard-messenger:0.2.0-unified.1')
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
if not str(root).startswith('/Volumes/ThalesMedia/'):
    raise SystemExit('Image builds belong on the designated external build volume')
if len(a.revision) != 40 or any(c not in '0123456789abcdef' for c in a.revision):
    raise SystemExit('Use the exact pushed source revision')
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ.get('PATH', '')
docker = ['docker', '--context', a.context]
provenance = json.loads((root / 'engine/provenance.json').read_text())['amd64']
expected = {name: provenance[name + '_sha256'] for name in ('wn', 'wnd')}
def verify(image):
    output = subprocess.check_output(docker + ['run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'sha256sum', image, '/usr/local/bin/wn', '/usr/local/bin/wnd'], text=True)
    hashes = {Path(line.split()[1]).name: line.split()[0] for line in output.splitlines()}
    if hashes != expected:
        raise SystemExit('Audited MDK binary checksum mismatch')
    return hashes
verify(a.carrier)
subprocess.run(docker + ['build', '--platform', 'linux/amd64', '--build-arg', 'MDK_BUILD_IMAGE=' + a.carrier, '--build-arg', 'MESSENGER_RUNTIME_BASE=' + a.carrier, '--label', 'org.opencontainers.image.revision=' + a.revision, '-t', a.tag, '.'], cwd=root, check=True)
hashes = verify(a.tag)
image = json.loads(subprocess.check_output(docker + ['image', 'inspect', a.tag], text=True))[0]
assert image['Architecture'] == 'amd64'
assert image['Config']['Labels']['org.opencontainers.image.revision'] == a.revision
out = root.parent / 'artifacts'
out.mkdir(exist_ok=True)
archive = out / 'wizard-messenger-unified-amd64.tar.gz'
with archive.open('wb') as f:
    save = subprocess.Popen(docker + ['save', a.tag], stdout=subprocess.PIPE)
    compress = subprocess.Popen(['gzip', '-1'], stdin=save.stdout, stdout=f)
    assert save.stdout is not None
    save.stdout.close()
    if compress.wait() != 0 or save.wait() != 0:
        raise SystemExit('Image export failed')
with archive.open('rb') as f:
    checksum = hashlib.file_digest(f, 'sha256').hexdigest()
receipt = {'revision': a.revision, 'tag': a.tag, 'id': image['Id'], 'architecture': image['Architecture'], 'mdk_sha256': hashes, 'archive': str(archive), 'archive_sha256': checksum, 'carrier': a.carrier, 'method': 'audited carrier reuse, not a fresh Rust build'}
(out / 'image-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt, indent=2))
