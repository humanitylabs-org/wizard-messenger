"""Parent-admitted Forum r3: new product bytes, fresh affected tests; never activates an app."""
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
STAGE = ROOT.parent
OUT = STAGE / 'evidence'
assert str(STAGE) == '/srv/work/messenger-draft-attachment-r3-20261105'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest_path = STAGE / 'source-manifest.json'
assert len(sys.argv) == 2 and sha(manifest_path) == sys.argv[1], 'submitted manifest drift'
manifest = json.loads(manifest_path.read_text())
assert subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip() == ''
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
assert revision == manifest['revision']
for rel, digest in manifest['files'].items():
    assert sha(STAGE / rel) == digest, rel
assert not OUT.exists(), 'fresh evidence required; do not overwrite a previous attempt'
OUT.mkdir()
# Historical r1 is retained verbatim (failures included); not credited as current JS acceptance.
R1 = Path('/srv/work/messenger-draft-attachment-20261105/evidence')
assert sha(R1 / 'qa-receipt.json') == 'e302677a22537c031e79dfff0324e24d2c8cba009bfaa094bea62aa1c57a5ff2'
old = json.loads((R1 / 'qa-receipt.json').read_text())
assert all(next(x for x in old['runs'] if x['name'] == name)['returncode'] == 0
           for name in ['focused-python', 'candidate-browser', 'existing-single-send'])
history = OUT / 'historical-r1'
history.mkdir()
historical_files = {}
for p in sorted(R1.iterdir()):
    if p.is_file():
        shutil.copyfile(p, history / p.name)
        assert sha(history / p.name) == sha(p)
        historical_files[p.name] = sha(p)
(OUT / 'historical-r1-manifest.json').write_text(json.dumps(historical_files, indent=2))
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(ROOT) + ':' + str(ROOT / 'tests'),
           PLAYWRIGHT_MODULE='/srv/work/morning-diff-deps-r4/node_modules/playwright',
           SHELL_DIR=str(STAGE / 'shell-web'), AGENT_STAGE_DIR=str(OUT / 'synthetic-state'),
           EVIDENCE_DIR=str(OUT), STATIC_DIR=str(ROOT / 'static'))
Path(ENV['AGENT_STAGE_DIR']).mkdir()
records = []
def run(name, argv, extra=None, timeout=180):
    p = subprocess.run(argv, cwd=ROOT, env=dict(ENV, **(extra or {})), stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=timeout)
    log = OUT / (name + '.log')
    log.write_text(p.stdout)
    rec = {'name': name, 'argv': argv, 'returncode': p.returncode, 'log': str(log), 'log_sha256': sha(log)}
    if '--test' in argv:
        rec['counts'] = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$', p.stdout, re.M)}
    records.append(rec)
    (OUT / 'progress.json').write_text(json.dumps(records, indent=2))
    print(json.dumps(rec), flush=True)
    return p

def specific_negative(p, name, marker):
    return (p.returncode == 1 and re.search(r'^not ok \d+ - ' + re.escape(name) + r'\s*$', p.stdout, re.M)
            and "code: 'ERR_ASSERTION'" in p.stdout and marker in p.stdout
            and '# fail 1\n' in p.stdout and '# cancelled 0\n' in p.stdout
            and 'TypeError' not in p.stdout and 'ReferenceError' not in p.stdout)

baseline = STAGE / 'baseline-unified.js'
assert sha(baseline) == 'd3d43465fd49cae6a9535a4ffbc2ce0378505f14a99a7e629622badf3fe06b68'
pre_race = STAGE / 'pre-race-unified.js'
assert sha(pre_race) == 'd6f38a612a7e7e9aeb309fe357e93e6fe0711f158fb017b3e98560f4c201f6d8'
overlap_name = 'two overlapping selections use successive revisions, not a sticky false error'
negative = run('old-overlap-specific-negative', ['node', '--test', '--test-name-pattern=^' + overlap_name + '$', 'tests/test_draft_attachment_recovery.cjs'], {'STATIC_JS': str(baseline)})
overlap_valid = bool(specific_negative(negative, overlap_name, 'REGRESSION_OVERLAPPING_ATTACHMENT_BATCH_LOST')
                     and re.search(r'\n\s+expected: 2\n\s+actual: 1\n', negative.stdout))
race_name = 'caption-cleared autosave survives navigation during held upload to empty composer'
race = run('pre-race-specific-negative', ['node', '--test', '--test-name-pattern=^' + race_name + '$', 'tests/test_draft_attachment_recovery.cjs'], {'STATIC_JS': str(pre_race)})
race_valid = bool(specific_negative(race, race_name, 'REGRESSION_AUTOSAVE_NAVIGATION_DELETED_ATTACHMENT_DRAFT')
                  and re.search(r'\n\s+expected: true\n\s+actual: false\n', race.stdout))
fixed = run('candidate-recovery', ['node', '--test', 'tests/test_draft_attachment_recovery.cjs'])
node = run('existing-node', ['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('test_*.cjs')) if p.name != 'test_draft_attachment_recovery.cjs']])
# Product JS changed: do not inherit r1's browser or send-latch pass at this head.
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
        single = run('existing-single-send', ['node', 'tests/single_send_browser.cjs'],
                     {'PREVIEW_URL': 'http://127.0.0.1:%d/' % port, 'PREVIEW_API_URL': 'http://127.0.0.1:%d' % port,
                      'MESSENGER_API_TOKEN': 'synthetic-unused-by-cookie-path'}, timeout=100)
    finally:
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)
# Cheap unchanged Python suites are freshly rerun too, preserving the historical attribution above.
python = run('focused-python', [sys.executable, '-m', 'unittest', 'test_server_drafts', 'test_agent_send', 'test_photo_albums', 'test_web', '-v'], timeout=240)
negatives = {'old-overlap-specific-negative', 'pre-race-specific-negative'}
counts = next(r['counts'] for r in records if r['name'] == 'candidate-recovery')
success = (overlap_valid and race_valid and counts.get('tests') == 17 and counts.get('pass') == 17
           and counts.get('fail') == 0 and counts.get('cancelled') == 0 and counts.get('skipped') == 0
           and all(x['returncode'] == 0 for x in records if x['name'] not in negatives))
receipt = {'pass': success, 'synthetic_only': True, 'live_provider_sends': 0, 'revision': revision,
           'candidate_source_sha256': sha(ROOT / 'static/unified.js'), 'manifest_sha256': sha(manifest_path),
           'runner_sha256': sha(Path(__file__)), 'old_specific_regression_verified': overlap_valid,
           'autosave_navigation_negative_verified': race_valid, 'historical_r1': historical_files,
           'inherited_current_acceptance': [], 'runs': records}
(OUT / 'qa-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt), flush=True)
sys.exit(0 if success else 1)
