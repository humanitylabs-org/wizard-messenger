// Issue 251: on a phone (no built-in translator), Translate falls back to the box, and the box uses the Wizard
// Tinfoil app. The owner's page asks Tinfoil (same origin, /wizard-tinfoil/api/app-tokens) for a Messenger-only token,
// hands it to the box (api/unified/tinfoil), and the translation shows. With Tinfoil not connected, the error says so
// and offers Open Tinfoil instead of the old dead end "Tinfoil not configured".
// Synthetic API only, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/tinfoil_app_translate_browser.cjs [outdir]
//   BEFORE=1 STATIC_DIR=<main>/static ... (the before shot: the old box answer and view)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'tinfoil-app-shots');
const BEFORE = process.env.BEFORE === '1';
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'line', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'สวัสดี', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [{id: '$thai', identity_id: 'ann-i', network: 'line', sender: 'Ann Lee', outgoing: false, original: 'สวัสดีครับ เจอกันพรุ่งนี้', msgtype: 'm.text', timestamp: now - min, timeline_order: 1, reactions: []}];
const NOT_CONNECTED = 'Tinfoil isn’t connected yet. Connect it in the Tinfoil app, then try again. You can send the original instead.';

async function run(browser, {connected, tag}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    // A phone browser: no built-in translator (headless Chromium on https has the API objects, so drop them).
    delete window.Translator; delete window.LanguageDetector;
  });
  const page = await ctx.newPage(), errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  let linked = null;
  await page.route('https://wizard.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const json = (body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    const ok = result => json({ok: true, result});
    // The Tinfoil app beside Messenger.
    if (p === '/wizard-tinfoil/api/connection') { calls.push('tinfoil:connection'); return json({contract: 'wizard.ai-connection/1', status: connected ? 'connected' : 'not_connected', credentialStored: connected}); }
    if (p === '/wizard-tinfoil/api/app-tokens') {
      calls.push('tinfoil:app-tokens');
      assert.equal(req.headers()['x-wizard-request'], '1');
      assert.deepEqual(JSON.parse(req.postData()), {app: 'messenger'});
      return connected ? json({app: 'messenger', token: 'T'.repeat(64), baseUrl: 'http://wizard-tinfoil:18804/v1', models: ['gemma4-31b'], recommended: ['gemma4-31b']}) : json({error: 'Connect Tinfoil first.'}, 409);
    }
    if (!p.startsWith('/messenger/')) return route.fulfill({status: 404, body: ''});
    const q = p.slice('/messenger/'.length);
    if (q === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (q === 'api/view/switches') return json({contract: 'wizard.app-switches/1', switches: []});
    if (q === 'api/status') return ok({state: 'ready', account_configured: true});
    if (q === 'api/identity') return ok({identity});
    if (q === 'api/contacts') return ok({contacts: []});
    if (q === 'api/invites') return ok({invites: []});
    if (q === 'api/dms') return ok({dms: []});
    if (q === 'api/unified/people') return ok({people: [person], seq: 5});
    if (q === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (q === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (q === 'api/unified/tinfoil') {
      if (req.method() === 'POST') { linked = JSON.parse(req.postData()); calls.push('box:link'); }
      else calls.push('box:state');
      return ok({linked: !!linked, removed: false});
    }
    if (q.endsWith('/translate')) {
      calls.push('box:translate');
      if (BEFORE) return ok({id: '$thai', translated: null, error: 'Tinfoil not configured. You can send the original instead.'});
      return ok(linked ? {id: '$thai', translated: 'Hello, see you tomorrow', error: null} : {id: '$thai', translated: null, error: NOT_CONNECTED, tinfoil: 'not_connected'});
    }
    if (q.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (q.startsWith('api/')) return ok({});
    const file = path.join(root, q || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://wizard.test/messenger/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const row = page.locator('.u-row[data-id="$thai"]'); await row.waitFor({timeout: 15000});
  await row.getByRole('button', {name: 'Translate'}).click();
  let text = null, notice = '', open = null;
  if (connected && !BEFORE) {
    await row.getByRole('button', {name: 'Show original'}).waitFor({timeout: 8000});
    text = (await row.locator('.u-text').textContent()).trim();
  } else {
    await page.waitForFunction(() => /Tinfoil/.test(document.querySelector('#u-error')?.textContent || ''), null, {timeout: 8000});
    notice = (await page.locator('#u-error').first().textContent()).trim();
    const a = page.locator('#u-error a.u-tinfoil-open');
    open = await a.count() ? await a.getAttribute('href') : null;
  }
  await page.screenshot({path: path.join(out, tag + '.png')});
  await ctx.close();
  assert.deepEqual(errors, []);
  return {text, notice, open, calls, linked};
}

(async () => {
  const browser = await chromium.launch();
  try {
    if (BEFORE) {
      const before = await run(browser, {connected: true, tag: 'before'});
      console.log(JSON.stringify(before));
      console.log('tinfoil app translate browser (before): ' + before.notice);
      return;
    }
    const on = await run(browser, {connected: true, tag: 'after-connected'});
    assert.equal(on.text, 'Hello, see you tomorrow', 'translated through the Tinfoil app');
    assert.equal(on.linked.token, 'T'.repeat(64), 'the box got the Messenger-only token');
    assert.ok(on.calls.includes('tinfoil:app-tokens') && on.calls.includes('box:link'));
    assert.ok(on.calls.indexOf('box:link') < on.calls.lastIndexOf('box:translate'), 'asked again after linking');
    const off = await run(browser, {connected: false, tag: 'after-not-connected'});
    assert.equal(off.text, null);
    assert.match(off.notice, /Tinfoil isn’t connected yet/);
    assert.doesNotMatch(off.notice, /not configured/);
    assert.equal(off.open, '/wizard-tinfoil/', 'offers Open Tinfoil');
    assert.ok(!off.calls.includes('tinfoil:app-tokens'), 'no token asked from a Tinfoil that is not connected');
    assert.equal(off.linked, null);
    console.log(JSON.stringify({on, off}));
    console.log('tinfoil app translate browser: ok');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
