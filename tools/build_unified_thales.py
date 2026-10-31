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
p.add_argument('--arch', choices=['amd64', 'arm64'], default='amd64')
p.add_argument('--carrier', default='')
p.add_argument('--tag', default='wizard-messenger:0.2.0-unified.1')
a = p.parse_args()
a.carrier = a.carrier or 'wizard-messenger:0.1.2-beta.1-' + a.arch
root = Path(__file__).resolve().parents[1]
build_root = os.environ.get('MESSENGER_BUILD_ROOT', '')
if build_root and not str(root).startswith(build_root.rstrip('/') + '/'):
    raise SystemExit('Image builds belong under MESSENGER_BUILD_ROOT')
if len(a.revision) != 40 or any(c not in '0123456789abcdef' for c in a.revision):
    raise SystemExit('Use the exact pushed source revision')
os.environ['PATH'] = '/opt/homebrew/bin:' + os.environ.get('PATH', '')
docker = ['docker', '--context', a.context]
# Check the same patch/provenance binding as Docker before touching a carrier.
subprocess.run(['sh', str(root / 'engine/admit-prebuilt.sh'), 'check',
                str(root / 'engine/prebuilt-manifest.txt'), str(root / 'engine/provenance.json'),
                str(root / 'engine/patches')], check=True)
provenance = json.loads((root / 'engine/provenance.json').read_text())['patched_binaries'].get(a.arch, {})
expected = {name: provenance.get(name + '_sha256', '') for name in ('wn', 'wnd')}
if not all(expected.values()):
    raise SystemExit('No patched hashes for ' + a.arch + '; use a source build with the default MDK_BUILD_IMAGE instead')
def verify(image):
    output = subprocess.check_output(docker + ['run', '--rm', '--platform', 'linux/' + a.arch, '--network', 'none', '--entrypoint', 'sha256sum', image, '/usr/local/bin/wn', '/usr/local/bin/wnd'], text=True)
    hashes = {Path(line.split()[1]).name: line.split()[0] for line in output.splitlines()}
    if hashes != expected:
        raise SystemExit('Patched MDK binary checksum mismatch; supply a matching patched carrier or use a source build with the default MDK_BUILD_IMAGE')
    return hashes
verify(a.carrier)
subprocess.run(docker + ['build', '--platform', 'linux/' + a.arch, '--build-arg', 'MDK_BUILD_IMAGE=' + a.carrier, '--build-arg', 'MESSENGER_RUNTIME_BASE=' + a.carrier, '--label', 'org.opencontainers.image.revision=' + a.revision, '-t', a.tag, '.'], cwd=root, check=True)
hashes = verify(a.tag)
image = json.loads(subprocess.check_output(docker + ['image', 'inspect', a.tag], text=True))[0]
assert image['Architecture'] == a.arch
assert image['Config']['Labels']['org.opencontainers.image.revision'] == a.revision
out = root.parent / 'artifacts'
out.mkdir(exist_ok=True)
# Per revision and arch: parallel builds of other branches never overwrite this release's archive.
archive = out / ('wizard-messenger-%s-%s.tar.gz' % (a.revision[:12], a.arch))
with archive.open('wb') as f:
    save = subprocess.Popen(docker + ['save', a.tag], stdout=subprocess.PIPE)
    compress = subprocess.Popen(['gzip', '-1'], stdin=save.stdout, stdout=f)
    assert save.stdout is not None
    save.stdout.close()
    if compress.wait() != 0 or save.wait() != 0:
        raise SystemExit('Image export failed')
with archive.open('rb') as f:
    digest = hashlib.sha256()
    for block in iter(lambda: f.read(1 << 20), b''):
        digest.update(block)
    checksum = digest.hexdigest()  # older system pythons lack hashlib.file_digest
receipt = {'revision': a.revision, 'tag': a.tag, 'id': image['Id'], 'architecture': image['Architecture'], 'mdk_sha256': hashes, 'archive': str(archive), 'archive_sha256': checksum, 'carrier': a.carrier, 'method': 'audited carrier reuse, not a fresh Rust build'}
(out / ('image-receipt-%s-%s.json' % (a.revision[:12], a.arch))).write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt, indent=2))
