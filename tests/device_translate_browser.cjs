// Issue 199: tapping Translate under a Thai message uses the browser's built-in translator (stubbed here as Chrome's
// Translator/LanguageDetector) and the box's translate route is never called; the bubble says "Translated on this
// device" and Show original goes back. Without a built-in translator it falls back to the box (Tinfoil) as before.
// The switch was approved and removed: this is always on, also when a box still lists an old stored value.
// Synthetic API only, no container and no shell: PLAYWRIGHT_MODULE=... node tests/device_translate_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'device-translate-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'line', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'สวัสดี', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [{id: '$thai', identity_id: 'ann-i', network: 'line', sender: 'Ann Lee', outgoing: false, original: 'สวัสดีครับ เจอกันพรุ่งนี้', msgtype: 'm.text', timestamp: now - min, timeline_order: 1, reactions: []}];

async function run(browser, {stale, builtIn}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(builtIn => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    window.deviceCalls = [];
    if (builtIn) {
      window.LanguageDetector = {create: async () => ({detect: async t => { deviceCalls.push(['detect', t]); return [{detectedLanguage: 'th', confidence: 0.97}]; }})};
      window.Translator = {availability: async () => 'available', create: async pair => { deviceCalls.push(['create', pair.sourceLanguage + '>' + pair.targetLanguage]); return {translate: async () => 'Hello, see you tomorrow'}; }};
    }
  }, builtIn);
  const page = await ctx.newPage(), errors = [], boxCalls = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: stale ? [{id: 'on-device-translate', on: false}] : []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.endsWith('/translate')) { boxCalls.push(p); return ok({id: '$thai', translated: 'Hello (Tinfoil)', error: null}); }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const row = page.locator('.u-row[data-id="$thai"]'); await row.waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  await row.getByRole('button', {name: 'Translate'}).click();
  await row.getByRole('button', {name: 'Show original'}).waitFor({timeout: 5000});
  const text = (await row.locator('.u-text').textContent()).trim(), note = await row.locator('.u-on-device').count();
  const tag = (stale ? 'stale-off' : 'on') + (builtIn ? '-builtin' : '-none');
  await page.screenshot({path: path.join(out, tag + '.png')});
  await row.getByRole('button', {name: 'Show original'}).click();
  await row.getByRole('button', {name: 'Translate'}).waitFor({timeout: 5000});
  const back = (await row.locator('.u-text').textContent()).trim();
  const deviceCalls = await page.evaluate(() => window.deviceCalls);
  await ctx.close();
  assert.deepEqual(errors, []);
  return {text, note, back, boxCalls, deviceCalls};
}

(async () => {
  const browser = await chromium.launch();
  try {
    const local = await run(browser, {builtIn: true});
    assert.equal(local.text, 'Hello, see you tomorrow', 'translated in the browser');
    assert.equal(local.note, 1, 'says it was translated on this device');
    assert.deepEqual(local.boxCalls, [], 'the box translate route (Tinfoil) is never called');
    assert.deepEqual(local.deviceCalls, [['detect', 'สวัสดีครับ เจอกันพรุ่งนี้'], ['create', 'th>en']]);
    assert.equal(local.back, 'สวัสดีครับ เจอกันพรุ่งนี้', 'Show original goes back');
    const fallback = await run(browser, {builtIn: false});
    assert.equal(fallback.text, 'Hello (Tinfoil)', 'no built-in translator: the box translates as before');
    assert.equal(fallback.note, 0);
    assert.equal(fallback.boxCalls.length, 1);
    const stale = await run(browser, {stale: true, builtIn: true});
    assert.equal(stale.text, 'Hello, see you tomorrow', 'an old stored off value no longer matters');
    assert.deepEqual(stale.boxCalls, []);
    assert.equal(stale.note, 1);
    console.log(JSON.stringify({local, fallback, stale}));
    console.log('device translate browser: ok');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
