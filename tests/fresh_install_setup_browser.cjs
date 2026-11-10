// Issue 148: a fresh Messenger install on a trusted Wizard opens straight into setup (Create address, no passphrase,
// no "setup link" dead end), and creating the address opens the inbox.
// node tests/fresh_install_setup_browser.cjs   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static');
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
  await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
  const page = await ctx.newPage(), errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32);
  let configured = false;
  await page.route('https://messenger.test/**', async route => {
    const url = new URL(route.request().url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p.startsWith('api/')) calls.push(route.request().method() + ' ' + p);
    if (p === 'api/view/trusted-owner') return ok({enabled: true, remembered: false});
    // The fixed server answers a fresh install with a setup-only session (before: 401 setup_link_required).
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok(configured ? {state: 'ready', account_configured: true} : {state: 'setup_required', account_configured: false});
    if (p === 'api/setup') { const body = route.request().postDataJSON(); assert.equal(body.action, 'create'); configured = true; return ok({state: 'ready'}); }
    if (p === 'api/view/unlock') { assert.equal(route.request().postDataJSON().remember_wizard, true); return ok({authenticated: true, csrf_token: 'fixture2'}); }
    if (p === 'api/identity') return ok({identity: configured ? {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'} : null});
    if (['api/contacts', 'api/invites', 'api/dms'].includes(p)) return ok({contacts: [], invites: [], dms: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 1}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('#setup-submit', {hasText: 'Create address'}).waitFor({state: 'visible', timeout: 15000});
  assert.equal(await page.locator('#passphrase').isVisible(), false, 'no passphrase on a trusted Wizard');
  assert.equal(await page.locator('#setup-submit').isDisabled(), false, 'Create address can be tapped right away');
  assert.match(await page.locator('#gate-description').textContent(), /Create your Wizard Messenger address/);
  await page.screenshot({path: path.join(process.argv[2] || process.env.TMPDIR || '/tmp', 'fresh-install-setup.png')});
  await page.fill('#display-name', 'Owner');
  await page.click('#setup-submit');
  await page.waitForFunction(() => document.getElementById('gate').hidden === true, null, {timeout: 15000});
  assert.ok(calls.includes('POST api/setup') && calls.includes('POST api/view/unlock'), calls.join(', '));
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS fresh_install_setup_browser: a fresh trusted install opens into Create address and lands in Messenger');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
