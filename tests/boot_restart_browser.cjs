// Opening Messenger while its release restarts (gateway 502s) keeps "Opening…" and reconnects by itself;
// it never lands on the Try again card. Static view only, every API answered by route fixtures.
// node tests/boot_restart_browser.cjs [static dir]   (needs `playwright` resolvable, or PLAYWRIGHT_MODULE)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../static'));
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => noop}, back: {register: noop}, on: noop, nav: {}, toast: noop};
  });
  let sessionCalls = 0; const modes = [];
  await page.route('http://messenger.test/**', async route => {
    const u = new URL(route.request().url()), p = u.pathname.replace(/^\//, '');
    if (p === 'api/view/session') {
      sessionCalls++;
      if (sessionCalls <= 3) return route.fulfill({status: 502, body: ''}); // Caddy: upstream down, empty body
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {authenticated: true, csrf_token: 'csrf-fixture'}})});
    }
    if (p.startsWith('api/')) {
      const result = p === 'api/status' ? {state: 'ready', account_configured: true} : p === 'api/identity' ? {npub: 'npub1fixture', display_name: 'Fixture'} : [];
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    }
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('http://messenger.test/');
  for (let i = 0; i < 40; i++) {
    modes.push(await page.evaluate(() => ({gate: !document.getElementById('gate').hidden, retry: !document.getElementById('reconnect').hidden, text: document.getElementById('gate-description').textContent})));
    if (sessionCalls >= 4) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
  const end = await page.evaluate(() => ({retry: !document.getElementById('reconnect').hidden, text: document.getElementById('gate-description').textContent}));
  const sawRetryCard = modes.some(m => m.retry) || end.retry;
  console.log(JSON.stringify({sessionCalls, sawRetryCard, restartingText: modes.some(m => /restarting/i.test(m.text)), end}));
  assert.ok(sessionCalls >= 4, 'boot retried by itself through three 502s');
  assert.equal(sawRetryCard, false, 'never showed the Try again card during a restart');
  assert.ok(modes.some(m => /restarting/i.test(m.text)), 'said Messenger is restarting while waiting');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), /Open Messenger from Wizard to reconnect/);
  await browser.close();
  console.log('PASS boot_restart_browser');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
