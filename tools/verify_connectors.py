#!/usr/bin/env python3
"""Offline pinned-image binary/config proof. Never starts a bridge.

-g regenerates tokens: disposable configs only. Optional --binary-dir also
checks original downloaded release assets. All image calls use network=none.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified_setup import setup
from connector_setup import setup_connectors

ROOT = Path(__file__).resolve().parents[1]


def verify(binary_dir=None):
    pins = json.loads((ROOT / 'plumbing/connectors-provenance.json').read_text())
    outcomes = {}
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as td:
        root = Path(td)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(root)
        setup_connectors(root, pins)
        for name, pin in pins.items():
            image = pin.get('local_image_id', pin['image'])
            executable = pin.get('image_executable', '/usr/bin/mautrix-' + name)
            prefix = ['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0', '--entrypoint']
            digest = subprocess.check_output(prefix + ['sha256sum', image, executable], text=True, timeout=20).split()[0]
            assert digest == pin.get('image_binary_sha256', pin.get('binary_sha256')), name + ' binary checksum mismatch'
            version = json.loads(subprocess.check_output(prefix + [executable, image, '--version-json'], text=True, timeout=20))
            if name != 'line':
                assert version['Tag'] == pin['tag'] and version['IsRelease'], name + ' release version mismatch'
            if binary_dir and 'binary_sha256' in pin:
                binary = Path(binary_dir) / ('mautrix-' + name + '-amd64')
                assert hashlib.sha256(binary.read_bytes()).hexdigest() == pin['binary_sha256']
            result = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0', '-v', str(root / name) + ':/proof', '--entrypoint', executable, image, '-g', '-c', '/proof/config.yaml', '-r', '/proof/proof-registration.yaml'], capture_output=True, timeout=25)
            assert result.returncode == 0, name + ' upstream config parser failed'
            outcomes[name] = {'binary_hash_verified': True, 'config_parse_and_registration_exit': result.returncode, 'release': version.get('Tag'), 'source_commit': pin.get('source_commit', version.get('Commit')), 'account_authentication_attempted': False}
    return outcomes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary-dir')
    result = verify(parser.parse_args().binary_dir)
    (ROOT / 'evidence/five-network-offline-images.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
