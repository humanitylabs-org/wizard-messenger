// Issue 214: a fresh Messenger install on a Wizard WITHOUT the platform owner proof opens straight into
// "Create address" against the real view server (web.py ViewServer + a synthetic engine), never the
// "setup link" dead end. Creating the address then opens Messenger with the new passphrase.
// PLAYWRIGHT_MODULE=<playwright> PYTHON=<venv python> node tests/fresh_install_no_owner_proof_browser.cjs [outdir]
// BEFORE=1 only takes the screenshot (use it with a main checkout's web.py to show the old dead end).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn} = require('node:child_process');
const path = require('node:path'), assert = require('node:assert/strict');
const repo = path.resolve(process.env.REPO_DIR || path.join(__dirname, '..'));
const out = process.argv[2] || process.env.TMPDIR || '/tmp';
const STAGE = `
import sys, threading, os
sys.path[:0] = [${JSON.stringify(repo)}, ${JSON.stringify(path.join(__dirname))}]
os.environ.pop('MESSENGER_PROVISION_OWNER_ENROLLMENT', None)
os.environ['MESSENGER_COOKIE_SECURE'] = '0'
from pathlib import Path
from web import ViewServer
from test_web import FakeEngine, TOKEN
class Engine(FakeEngine):
    def dispatch(self, *a, **k): return {}
server = ViewServer(('127.0.0.1', 0), Engine(), TOKEN, [])
server.static_root = Path(${JSON.stringify(path.join(__dirname, '..', 'static'))})
print(server.server_port, flush=True)
server.serve_forever()
`;
(async () => {
  const stage = spawn(process.env.PYTHON || 'python3', ['-c', STAGE], {cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: {...process.env, PYTHONPATH: `${repo}:${__dirname}`}});
  const port = await new Promise((resolve, reject) => { stage.stdout.once('data', d => resolve(String(d).trim())); stage.once('exit', c => reject(new Error('stage exited ' + c))); });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
    await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    if (process.env.BEFORE) {
      await page.waitForFunction(() => /setup link|reach Messenger/.test(document.getElementById('gate-description')?.textContent || ''), null, {timeout: 15000});
      await page.screenshot({path: path.join(out, 'fresh-install-no-owner-proof-before.png')});
      console.log('BEFORE gate:', await page.locator('#gate-description').textContent());
      return;
    }
    await page.locator('#setup-submit', {hasText: 'Create address'}).waitFor({state: 'visible', timeout: 15000});
    const text = await page.locator('#gate-description').textContent();
    assert.doesNotMatch(text, /setup link/i);
    assert.match(text, /Create a messaging address/);
    assert.equal(await page.locator('#passphrase').isVisible(), true, 'a Wizard without owner proof keeps the passphrase');
    await page.screenshot({path: path.join(out, 'fresh-install-no-owner-proof-after.png')});
    const password = 'fresh-install-browser-passphrase';
    await page.fill('#display-name', 'Owner');
    await page.fill('#passphrase', password);
    await page.fill('#confirm-passphrase', password);
    const unlock = page.waitForResponse(r => r.url().endsWith('/api/view/unlock'));
    await page.click('#setup-submit');
    assert.equal((await unlock).status(), 200, 'the new passphrase opens Messenger');
    await page.waitForFunction(() => document.getElementById('gate').hidden === true, null, {timeout: 15000});
    assert.deepEqual(errors, []);
    console.log('PASS fresh_install_no_owner_proof_browser: no setup link, Create address, then Messenger opens');
  } finally { await browser.close(); stage.kill(); }
})().catch(e => { console.error('FAIL', e); process.exit(1); });
