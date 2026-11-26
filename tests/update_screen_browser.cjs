// Issue 439: Messenger opened while an automatic App Store update has its containers down. The App Manager's
// GET /wizard-os-home/store-install/_app-updates lists it in `running`. The page shows one steady
// "Messenger is updating · back in a moment" screen with the spinner (no flip back to "Opening your messages…", no
// Try again card, also for a gateway 404), and opens by itself once Messenger answers again.
// Static view only, every API answered by route fixtures:
//   PLAYWRIGHT_MODULE=... node tests/update_screen_browser.cjs [outdir]   (STATIC_DIR=<main>/static BEFORE=1 for the before shot)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static'));
const out = process.argv[2] || '';
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};

async function scenario(browser, {down, updating, openFirst = false, seconds = 14, shot = ''}) {
  const page = await browser.newPage({viewport: {width: 412, height: 860}});
  await page.addInitScript(() => {
    const noop = () => {};
    try { localStorage.setItem('messenger-trusted-wizard', '1'); } catch { /* storage blocked */ }
    window.WizardApp = {ready: noop, update: {hold: () => noop}, back: {register: noop}, on: noop, nav: {}, toast: noop};
  });
  let isDown = !openFirst; let asked = 0;
  await page.route('http://box.test/**', route => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/wizard-os-home/store-install/_app-updates') {
      asked++;
      const running = isDown && updating ? [{app: 'messenger', from: 173, to: 174, to_version: '0.2.0-unified.16.125', step: 'updating', started: 1, by: 'app-updates'}] : [];
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({app_mode: 'auto', due: [], skipped: [], running, queued: []})});
    }
    if (!p.startsWith('/messenger/')) return route.fulfill({status: 404, body: ''});
    const q = p.slice('/messenger/'.length);
    if (q.startsWith('api/')) {
      if (isDown) return down === '404' ? route.fulfill({status: 404, contentType: 'application/json', body: '{"error":"not found"}'}) : route.fulfill({status: 502, body: ''});
      const result = q === 'api/view/trusted-owner' ? {enabled: true, remembered: true} : q === 'api/view/session' ? {authenticated: true, csrf_token: 'csrf-fixture'}
        : q === 'api/status' ? {state: 'ready', account_configured: true} : q === 'api/identity' ? {identity: {npub: 'npub1fixture', display_name: 'Fixture'}} : [];
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    }
    const file = path.join(root, q || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('http://box.test/messenger/');
  if (openFirst) { await page.waitForFunction(() => document.getElementById('gate').hidden, null, {timeout: 15000}); isDown = true; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }
  const look = () => page.evaluate(() => ({gate: !document.getElementById('gate').hidden, spinner: !document.getElementById('gate-progress').hidden,
    retry: !document.getElementById('reconnect').hidden, text: document.getElementById('gate-description').textContent}));
  const seen = []; const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) { seen.push(await look()); await page.waitForTimeout(100); }
  if (shot) await page.screenshot({path: shot});
  isDown = false; const up = Date.now(); let opened = null;
  while (Date.now() - up < 15000) { if (!(await look()).gate) { opened = (Date.now() - up) / 1000; break; } await page.waitForTimeout(100); }
  await page.close();
  return {seen, opened, asked};
}

(async () => {
  const browser = await chromium.launch();
  if (out) fs.mkdirSync(out, {recursive: true});
  const shot = name => out ? path.join(out, name) : '';
  for (const down of ['502', '404']) {
    const r = await scenario(browser, {down, updating: true, shot: shot(`updating-${down}.png`)});
    const late = r.seen.slice(Math.floor(r.seen.length / 4));   // after the first boot attempt
    console.log(down, JSON.stringify({texts: [...new Set(r.seen.map(s => s.text))], opened: r.opened, asked: r.asked}));
    if (process.env.BEFORE) continue;
    assert.ok(late.every(s => s.gate && s.text === 'Messenger is updating · back in a moment'), `${down}: one steady updating line`);
    assert.ok(late.every(s => s.spinner), `${down}: the spinner stays on while it waits`);
    assert.ok(!r.seen.some(s => s.retry), `${down}: never the Try again card`);
    assert.ok(r.opened !== null && r.opened < 7, `${down}: opens by itself within seconds of Messenger answering`);
    assert.ok(r.asked <= 3, `${down}: the App Manager is asked at most every 10 s`);
  }
  const open = await scenario(browser, {down: '502', updating: true, openFirst: true, shot: shot('updating-while-open.png')});
  console.log('open-first', JSON.stringify({texts: [...new Set(open.seen.map(s => s.text))], opened: open.opened}));
  if (!process.env.BEFORE) {
    assert.ok(open.seen.slice(-50).every(s => s.text === 'Messenger is updating · back in a moment'), 'an open Messenger says it is updating too');
    assert.ok(open.opened !== null, 'and comes back by itself');
  }
  // A plain restart (no update running) keeps one steady restarting line, never the updating words.
  const restart = await scenario(browser, {down: '502', updating: false, seconds: 10});
  const late = restart.seen.slice(Math.floor(restart.seen.length / 4));
  console.log('restart', JSON.stringify({texts: [...new Set(restart.seen.map(s => s.text))], opened: restart.opened}));
  if (!process.env.BEFORE) {
    assert.ok(late.every(s => s.text === 'Messenger is restarting. Reconnecting…' && s.spinner), 'a restart keeps one steady line with the spinner');
    assert.ok(!restart.seen.some(s => /updating/.test(s.text)), 'a restart never says updating');
  }
  await browser.close();
  console.log(process.env.BEFORE ? 'BEFORE shots taken' : 'PASS update_screen_browser');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
