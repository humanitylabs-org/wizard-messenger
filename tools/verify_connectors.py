#!/usr/bin/env python3
"""Verify downloaded official release binaries offline (never start bridges).

Download release assets and sha256sums.txt from the official release pages into
a scratch directory first. This command only runs --version-json and -g there.
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
from connectors import Connectors


def verify(binary_dir):
    proof = json.loads((Path(__file__).resolve().parents[1] / 'plumbing/connectors-provenance.json').read_text())
    outcomes = {}
    with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as td:
        root = Path(td)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}): setup(root)
        setup_connectors(root, proof)
        for name, expected in proof.items():
            binary = Path(binary_dir) / ('mautrix-' + name + '-amd64')
            if hashlib.sha256(binary.read_bytes()).hexdigest() != expected['binary_sha256']:
                raise ValueError(name + ' release binary checksum mismatch')
            version = json.loads(subprocess.check_output([str(binary), '--version-json'], text=True, timeout=10))
            if version['Tag'] != expected['tag'] or not version['IsRelease']:
                raise ValueError(name + ' unexpected release version')
            # -g exits after parsing config and generating a registration: no
            # bridge server, device linking, message sending or account network.
            result = subprocess.run([str(binary), '-g', '-c', str(root / name / 'config.yaml'), '-r', str(root / name / 'proof-registration.yaml')], capture_output=True, timeout=15)
            if result.returncode:
                raise ValueError(name + ' upstream config validation failed')
            outcomes[name] = {'release': version['Tag'], 'source_commit': version['Commit'], 'binary_hash_verified': True, 'config_parse_and_registration_exit': result.returncode, 'account_authentication_attempted': False}
        setup_connectors(root)
        outcomes['dormant'] = Connectors(root / 'unified').health()
    return outcomes


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary-dir', required=True)
    print(json.dumps(verify(parser.parse_args().binary_dir), indent=2))
