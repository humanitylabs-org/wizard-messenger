#!/usr/bin/env python3
"""Build pinned MIT LINE bridge; no account data, credentials, push or deploy.

Run on a build worker with ~2 GiB free memory and sufficient disk. A large
upstream generated Go crypto file makes a first build slow. No Rust toolchain.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', type=Path, help='Reuse an already downloaded pinned source context')
    args = parser.parse_args()
    pin = json.loads((ROOT / 'plumbing/connectors-provenance.json').read_text())['line']
    context = args.context
    if context is None:
        context = Path(tempfile.mkdtemp(prefix='line-build-', dir=os.environ.get('TMPDIR')))
        with urlopen('https://api.github.com/repos/beeper/line/tarball/' + pin['source_commit'], timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != pin['source_archive_sha256']:
            raise ValueError('Upstream archive checksum changed; review before building')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for member in archive.getmembers():
                member.name = '/'.join(member.name.split('/')[1:])
                if member.name:
                    archive.extract(member, context, filter='data')
    subprocess.run(['docker', 'build', '-f', str(ROOT / 'plumbing/line.Dockerfile'), '-t', pin['image'], str(context)], check=True)
    subprocess.run(['docker', 'image', 'inspect', pin['image'], '--format', '{{.Id}}'], check=True)


if __name__ == '__main__': main()
