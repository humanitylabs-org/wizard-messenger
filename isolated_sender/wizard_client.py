"""Fail-closed Wizard-side draft client. Contains no provider credentials/send operation.

This guard is deployment hygiene, NOT a security boundary against Wizard root.
The separately administered owner authority is the boundary.
"""
import argparse
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

import httpx


def validate(value):
    if set(value) != {'independent_endpoint', 'wizard_origin', 'owner_verified_independent_host', 'draft_key_file'}:
        raise ValueError('unexpected or missing client configuration fields')
    endpoint = value['independent_endpoint']
    if not endpoint or value['owner_verified_independent_host'] is not True:
        raise ValueError('disabled: owner independent endpoint/trust gate not configured')
    remote, wizard = urlsplit(endpoint), urlsplit(value['wizard_origin'])
    if (remote.scheme != 'https' or not remote.hostname or remote.port not in (None, 443)
            or remote.path or remote.query or remote.fragment or remote.username or remote.password
            or remote.hostname == wizard.hostname or remote.hostname in ('localhost', '127.0.0.1', '::1')):
        raise ValueError('independent dedicated HTTPS origin required; no Wizard-origin or local fallback')
    if not value['draft_key_file'] or not Path(value['draft_key_file']).is_absolute():
        raise ValueError('absolute narrow draft-key file required')
    return endpoint


def run(value, draft=None):
    endpoint = validate(value)
    # Default public CA validation is mandatory. No verify=False, redirects, custom
    # proxy or ticket exchange, owner credentials, settings, or generic proxy paths.
    with httpx.Client(timeout=15, follow_redirects=False, trust_env=False) as client:
        health = client.get(endpoint + '/health')
        health.raise_for_status()
        status = health.json()
        backend = status.get('backend')
        if status.get('service') != 'independent-owner-authority' or backend not in ('test-ledger', 'matrix') or status.get('production_send') is not (backend == 'matrix'):
            raise ValueError('unexpected authority/backend')
        if draft is None:
            return {'ready': True, 'production_send': backend == 'matrix', 'trust_gate': 'owner-attested, not independently machine-proven'}
        key = Path(value['draft_key_file']).read_text().strip()
        if len(key) < 32:
            raise ValueError('draft key must contain at least 32 random characters')
        response = client.post(endpoint + '/agent/drafts', json=draft, headers={'Authorization': 'Bearer ' + key})
        response.raise_for_status()
        return response.json()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preflight', 'submit-draft'])
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        value = json.loads(Path(args.config).read_text())
        draft = json.loads(sys.stdin.buffer.read(1600001)) if args.command == 'submit-draft' else None
        result = run(value, draft)
        print(json.dumps(result))
    except Exception as error:
        # Do not print headers, keys or payloads from client/network exceptions.
        print('Isolated sender unavailable; no local fallback: ' + type(error).__name__, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
