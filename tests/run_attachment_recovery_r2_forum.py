"""Admitted Forum-only test repair. Preserve r1; inherit only source-identical passing phases."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'evidence'
OUT.mkdir(exist_ok=True)
R1 = Path('/srv/work/messenger-draft-attachment-20261105')
PRODUCT = '0ecb22b2364121cfd6679fc9ca1485088bc209bb'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(R1 / 'evidence/qa-receipt.json') == 'e302677a22537c031e79dfff0324e24d2c8cba009bfaa094bea62aa1c57a5ff2'
assert subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip() == ''
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
changes = subprocess.check_output(['git', 'diff', '--name-only', PRODUCT, revision], cwd=ROOT, text=True).splitlines()
assert changes and all(p.startswith('tests/') for p in changes), changes
for rel in subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', PRODUCT], cwd=ROOT, text=True).splitlines():
    if rel.startswith('static/') or (rel.endswith('.py') and not rel.startswith('tests/')):
        assert sha(ROOT / rel) == sha(R1 / 'source' / rel), rel
r1 = json.loads((R1 / 'evidence/qa-receipt.json').read_text())
inherited = []
for name in ['focused-python', 'candidate-browser', 'existing-single-send']:
    old = next(x for x in r1['runs'] if x['name'] == name)
    assert old['returncode'] == 0
    inherited.append({'name': name, 'returncode': 0, 'from': PRODUCT, 'log_sha256': sha(R1 / 'evidence' / (name + '.log'))})
# Preserve the original failed controls and every original synthetic artifact, not only the green portions.
dest = OUT / 'inherited-r1'
dest.mkdir(exist_ok=False)
manifest = {}
for p in sorted((R1 / 'evidence').iterdir()):
    if p.is_file():
        manifest[p.name] = {'sha256': sha(p), 'bytes': p.stat().st_size}
        shutil.copyfile(p, dest / p.name)
        assert sha(dest / p.name) == manifest[p.name]['sha256']
(OUT / 'r1-preserved-manifest.json').write_text(json.dumps(manifest, indent=2))
ENV = dict(os.environ, PYTHONPATH=str(ROOT) + ':' + str(ROOT / 'tests'),
           PLAYWRIGHT_MODULE='/srv/work/morning-diff-deps-r4/node_modules/playwright',
           SHELL_DIR=str(ROOT.parent / 'shell-web'), AGENT_STAGE_DIR=str(OUT / 'synthetic-state'),
           EVIDENCE_DIR=str(OUT), STATIC_DIR=str(ROOT / 'static'))
Path(ENV['AGENT_STAGE_DIR']).mkdir(exist_ok=True)
records = []
def run(name, argv, extra=None, timeout=180):
    p = subprocess.run(argv, cwd=ROOT, env=dict(ENV, **(extra or {})), stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=timeout)
    log = OUT / (name + '.log')
    log.write_text(p.stdout)
    rec = {'name': name, 'argv': argv, 'returncode': p.returncode, 'log': str(log), 'log_sha256': sha(log)}
    records.append(rec)
    print(json.dumps(rec), flush=True)
    return p

baseline = R1 / 'baseline-unified.js'
assert sha(baseline) == 'd3d43465fd49cae6a9535a4ffbc2ce0378505f14a99a7e629622badf3fe06b68'
negative = run('old-specific-negative', ['node', '--test', '--test-name-pattern=^two overlapping selections use successive revisions, not a sticky false error$', 'tests/test_draft_attachment_recovery.cjs'], {'STATIC_JS': str(baseline)})
valid_negative = (negative.returncode == 1 and 'not ok 1 - two overlapping selections use successive revisions' in negative.stdout
                  and "code: 'ERR_ASSERTION'" in negative.stdout and 'REGRESSION_OVERLAPPING_ATTACHMENT_BATCH_LOST' in negative.stdout
                  and re.search(r'\n\s+expected: 2\n\s+actual: 1\n', negative.stdout) is not None
                  and '# fail 1\n' in negative.stdout and 'TypeError' not in negative.stdout and 'ReferenceError' not in negative.stdout)
fixed = run('candidate-recovery', ['node', '--test', 'tests/test_draft_attachment_recovery.cjs'])
node = run('existing-node', ['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('test_*.cjs')) if p.name != 'test_draft_attachment_recovery.cjs']])
# Browser repeats only because its skin oracle changed. Python and single-send are inherited unchanged.
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
with (OUT / 'synthetic-server.log').open('w') as log:
    server = subprocess.Popen([sys.executable, 'tests/agent_drafts_stage.py', str(port)], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while not (Path(ENV['AGENT_STAGE_DIR']) / 'state.json').exists():
            if server.poll() is not None: raise RuntimeError('Synthetic server exited')
            if time.monotonic() >= deadline: raise TimeoutError('Synthetic server setup')
            time.sleep(.1)
        browser = run('candidate-browser-skin-corrected', ['node', 'tests/draft_attachment_recovery_browser.cjs'])
    finally:
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)
success = valid_negative and all(x['returncode'] == 0 for x in records if x['name'] != 'old-specific-negative')
receipt = {'pass': success, 'synthetic_only': True, 'live_provider_sends': 0, 'product_revision': PRODUCT,
           'test_revision': revision, 'candidate_source_sha256': sha(ROOT / 'static/unified.js'),
           'old_specific_regression_verified': valid_negative, 'inherited': inherited,
           'inherited_browser_scope': 'Recovery passed; r1 skin label switch is not distinct-palette evidence; use fresh corrected skin phase.',
           'runs': records}
(OUT / 'qa-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt), flush=True)
sys.exit(0 if success else 1)
