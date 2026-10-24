"""Executable local acceptance checks with evidence; never sends provider traffic.

python3 -m readiness.check --output /owned/scratch/report-directory
Optional --endpoints config.json permits only explicit disposable loopback HTTP.
Exit 0: local checks passed; exit 1: check/probe failed; exit 2: invalid config.
--require-migration-ready exits 3 until all network gates are actually proven.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
CHECKS = {
    'acceptance_probe_safety': ['readiness.tests.test_checker', 'readiness.tests.test_runner'],
    'search_module': ['readiness.tests.test_search'],
    'sync_recovery_and_history_limit': ['readiness.tests.test_transport'],
    'existing_media_relations_changefeed': [
        'test_unified.SignalMvpTests.test_reply_reaction_edit_redaction_ingest',
        'test_unified.SignalMvpTests.test_media_rows_hide_mxc_and_upgrade_label_rows',
        'test_unified.SignalMvpTests.test_voice_note_ingest',
        'test_unified.SignalMvpTests.test_media_proxy_caches_and_serves_safe_types_only',
        'test_unified.SignalMvpTests.test_updates_feed_returns_new_rows_and_wakes_waiters'],
}


def validate_endpoints(config):
    if not isinstance(config, list) or len(config) > 20:
        raise ValueError('endpoints must be a list of at most 20 disposable loopback targets')
    seen = set()
    for item in config:
        if not isinstance(item, dict) or set(item) != {'id', 'base_url', 'kind', 'disposable'}:
            raise ValueError('each endpoint requires exactly id, base_url, kind, disposable')
        name = item['id']
        if not isinstance(name, str) or not name.isascii() or not name.replace('-', '').replace('_', '').isalnum() or len(name) > 64 or name in seen:
            raise ValueError('invalid or duplicate endpoint id')
        seen.add(name)
        if item['disposable'] is not True or item['kind'] not in ('matrix_versions', 'health'):
            raise ValueError('unsupported probe or missing disposable declaration')
        if not isinstance(item['base_url'], str):
            raise ValueError('base_url must be text')
        url = urlsplit(item['base_url'])
        if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', '::1') or not url.port
                or url.username is not None or url.password is not None or url.path not in ('', '/')
                or url.query or url.fragment):
            raise ValueError('only literal loopback HTTP with explicit port, no credentials/path/query is allowed')
    return config


def probe(item):
    validate_endpoints([item])
    url = urlsplit(item['base_url'])
    path = '/_matrix/client/versions' if item['kind'] == 'matrix_versions' else '/healthz'
    record = {'id': item['id'], 'base_url': item['base_url'], 'path': path,
              'method': 'GET', 'scope': 'disposable-local-liveness-only', 'passed': False}
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=3)
    try:
        connection.request('GET', path, headers={'Accept': 'application/json'})
        response = connection.getresponse()
        data = response.read(65537)
        record.update(http_status=response.status, body_sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
        if response.status != 200 or len(data) > 65536:
            return record
        body = json.loads(data)
        if not isinstance(body, dict):
            return record
        record['passed'] = (isinstance(body.get('versions'), list) and bool(body['versions'])
                            and all(isinstance(v, str) and v.startswith(('r0.', 'v1.')) for v in body['versions'])) if item['kind'] == 'matrix_versions' else body.get('ok') is True
    except (OSError, ValueError, http.client.HTTPException):
        record['error'] = 'local_probe_failed'  # no exception bodies, credentials or message content
    finally:
        connection.close()
    return record


def run_checks(output, endpoints=()):
    import os
    manifest = json.loads((ROOT / 'readiness/manifest.json').read_text())
    report = deepcopy(manifest)
    report.update(generated_at=datetime.now(timezone.utc).isoformat(), checks=[], probes=[])
    report['source'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    paths = ['unified.py', 'engine.py', 'unified_setup.py', 'translation.py', 'tests/test_unified.py', 'readiness/manifest.json'] + [str(p.relative_to(ROOT)) for p in sorted((ROOT/'readiness').rglob('*.py'))]
    report['source_files'] = {p: hashlib.sha256((ROOT / p).read_bytes()).hexdigest() for p in paths}
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    for name, targets in CHECKS.items():
        command = [sys.executable, '-m', 'readiness.runner', '--result', str(output.resolve() / (name + '.json')), *targets]
        env = dict(os.environ, PYTHONPATH=str(ROOT) + os.pathsep + str(ROOT/'tests'), PYTHONDONTWRITEBYTECODE='1')
        started = time.monotonic()
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=60)
            raw, code = result.stdout + result.stderr, result.returncode
        except subprocess.TimeoutExpired as error:
            raw, code = (error.stdout or b'') + (error.stderr or b''), 124
        log = name + '.log'
        (output / log).write_bytes(raw)
        report['checks'].append({'id': name, 'command': command, 'exit_code': code,
            'passed': code == 0, 'seconds': round(time.monotonic()-started, 3),
            'evidence': log, 'evidence_sha256': hashlib.sha256(raw).hexdigest(),
            'test_results': name + '.json' if (output / (name + '.json')).exists() else None})
        if name == 'search_module' and code == 0:
            report['components']['search_module']['status'] = 'proven'
            report['components']['search_module']['evidence'] = log
        if name == 'sync_recovery_and_history_limit' and code == 0:
            report['components']['sync_cursor_recovery']['status'] = 'proven'
            report['components']['sync_cursor_recovery']['evidence'] = log
    report['probes'] = [probe(item) for item in endpoints]
    report['local_checks_passed'] = all(x['passed'] for x in report['checks'] + report['probes'])
    # Local fixtures cannot establish provider support, login, background phone alerts, or daily use.
    report['migration_ready'] = False
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--endpoints', type=Path)
    parser.add_argument('--require-migration-ready', action='store_true')
    args = parser.parse_args()
    try:
        endpoints = validate_endpoints(json.loads(args.endpoints.read_text())) if args.endpoints else []
        report = run_checks(args.output, endpoints)
    except (OSError, ValueError) as error:
        parser.exit(2, 'Invalid configuration or output directory: ' + type(error).__name__ + '\n')
    print(json.dumps({'report': str(args.output/'report.json'), 'local_checks_passed': report['local_checks_passed'], 'migration_ready': False}))
    return 1 if not report['local_checks_passed'] else (3 if args.require_migration_ready else 0)


if __name__ == '__main__': raise SystemExit(main())
