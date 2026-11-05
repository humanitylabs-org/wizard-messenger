"""Forum-only synthetic QA. Run exclusively through wizard_heavy_submit; no owner service URLs or data mounts."""
from pathlib import Path
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / 'evidence'
OUT.mkdir(exist_ok=True)
ENV = dict(os.environ, PYTHONPATH=str(ROOT) + ':' + str(ROOT / 'tests'),
           PLAYWRIGHT_MODULE='/srv/work/morning-diff-deps-r4/node_modules/playwright',
           SHELL_DIR=str(ROOT.parent / 'shell-web'), AGENT_STAGE_DIR=str(OUT / 'synthetic-state'),
           EVIDENCE_DIR=str(OUT), STATIC_DIR=str(ROOT / 'static'))
Path(ENV['AGENT_STAGE_DIR']).mkdir(exist_ok=True)
records = []
def run(name, argv, extra=None, timeout=240):
    p = subprocess.run(argv, cwd=ROOT, env=dict(ENV, **(extra or {})), stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, text=True, timeout=timeout)
    (OUT / (name + '.log')).write_text(p.stdout)
    item = {'name': name, 'argv': argv, 'returncode': p.returncode, 'log': str(OUT / (name + '.log'))}
    records.append(item)
    print(json.dumps(item), flush=True)
    return p

baseline = ROOT.parent / 'baseline-unified.js'
assert baseline.is_file()
assert hashlib.sha256(baseline.read_bytes()).hexdigest() == 'd3d43465fd49cae6a9535a4ffbc2ce0378505f14a99a7e629622badf3fe06b68'
negative = run('old-negative', ['node', '--test', 'tests/test_draft_attachment_recovery.cjs'], {'STATIC_JS': str(baseline)})
assert negative.returncode != 0 and '# fail 0' not in negative.stdout, 'baseline must exhibit a real regression failure'
fixed = run('candidate-recovery', ['node', '--test', 'tests/test_draft_attachment_recovery.cjs'])
node = run('existing-node', ['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'tests').glob('test_*.cjs')) if p.name != 'test_draft_attachment_recovery.cjs']])
python = run('focused-python', [sys.executable, '-m', 'unittest', 'test_server_drafts', 'test_agent_send', 'test_photo_albums', 'test_web', '-v'], timeout=360)
# Only temporary synthetic state, a fake engine and mocked Matrix upload/send. No live account or providers.
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
with (OUT / 'synthetic-server.log').open('w') as log:
    server = subprocess.Popen([sys.executable, 'tests/agent_drafts_stage.py', str(port)], cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        while not (Path(ENV['AGENT_STAGE_DIR']) / 'state.json').exists():
            if server.poll() is not None: raise RuntimeError('Synthetic fixture server exited; inspect synthetic-server.log')
            if time.monotonic() >= deadline: raise TimeoutError('Synthetic fixture setup')
            time.sleep(.1)
        browser = run('candidate-browser', ['node', 'tests/draft_attachment_recovery_browser.cjs'], timeout=180)
        # Existing send-latch test, entirely intercepted synthetic message/draft endpoints.
        single = run('existing-single-send', ['node', 'tests/single_send_browser.cjs'],
                     {'PREVIEW_URL': 'http://127.0.0.1:%d/' % port, 'PREVIEW_API_URL': 'http://127.0.0.1:%d' % port,
                      'MESSENGER_API_TOKEN': 'synthetic-unused-by-cookie-path'}, timeout=100)
    finally:
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)

success = all(r['returncode'] == 0 for r in records if r['name'] != 'old-negative')
receipt = {'pass': success, 'synthetic_only': True, 'live_provider_sends': 0, 'baseline_expected_negative': negative.returncode != 0,
           'candidate_source_sha256': hashlib.sha256((ROOT / 'static/unified.js').read_bytes()).hexdigest(), 'runs': records}
(OUT / 'qa-receipt.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt), flush=True)
sys.exit(0 if success else 1)
