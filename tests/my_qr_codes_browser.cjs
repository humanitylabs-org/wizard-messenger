// My QR codes: real index.html, CSS, qr.js and unified.js; app.js swapped for a stub that mounts the unified view
// on a faked API. Proves connected accounts appear as codes with no setup, hide/extra round trip, swipe, Back,
// and that the owner's codes are shared with Contacts (My card).
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', 'static');
const evidence = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'evidence', 'my-qr'); fs.mkdirSync(evidence, {recursive: true});
const stub = `
  window.WizardApp = {update: {hold: () => ({release() {}})}, back: {register() {}}, share: {text: async p => { window.shared = p; return 'shared'; }}};
  window.posts = [];
  const connected = [{network: 'telegram', value: 'JamesDeFleur', label: '', auto: true}, {network: 'whatsapp', value: '+15550100199', label: '', auto: true}];
  const keyOf = c => c.network + ':' + c.value.replace(/\\s+/g, '').toLowerCase().replace(/^[@+]+/, '');
  window.state = {extras: [], hidden: []};
  const view = () => ({codes: connected.filter(c => !state.hidden.includes(keyOf(c))).concat(state.extras), connected, extras: state.extras, hidden: state.hidden, name: 'James', saved: !!state.extras.length});
  const people = [{id: 'p1', display_name: 'Alice', identities: [{id: 'i1', network: 'telegram', label: 'Alice'}], last: {original: 'hi', timestamp: Date.now()}, unread: 0}];
  async function api(p, opts = {}) {
    if (p === 'api/unified/people') return {people, seq: 1};
    if (p === 'api/unified/groups') return {groups: [], seq: 1};
    if (p.startsWith('api/unified/updates')) return new Promise(() => {});
    if (p === 'api/unified/qr-codes' && opts.method === 'POST') { window.posts.push(opts.body); state.extras = opts.body.codes.filter(c => !c.auto); state.hidden = opts.body.hidden || []; return view(); }
    if (p === 'api/unified/qr-codes') return view();
    return {};
  }
  window.MessengerUnified.mount({api, csrf: () => 'x'});
  window.MessengerUnified.authenticated();`;
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 360, height: 597}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const toContacts = [];
  await page.route('http://msg.test/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/contacts/api/contacts') return route.fulfill({contentType: 'application/json', body: '{"contacts":[]}'});
    if (u.pathname === '/contacts/api/me/connected') { toContacts.push(JSON.parse(route.request().postData())); return route.fulfill({contentType: 'application/json', body: '{}'}); }
    let f = u.pathname.replace(/^\/messenger\//, '') || 'index.html';
    if (f === 'app.js') return route.fulfill({contentType: 'text/javascript', body: stub});
    if (f.startsWith('/wizard-os-home')) return route.fulfill({contentType: 'text/javascript', body: ''});
    const file = path.join(root, f); if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    route.fulfill({contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('http://msg.test/messenger/');
  await page.locator('.u-person').first().waitFor({state: 'visible'});
  // Contacts receives the owner's connected codes at start, without opening anything.
  for (let i = 0; i < 30 && !toContacts.length; i++) await page.waitForTimeout(100);
  assert.deepEqual(toContacts.at(-1), {name: 'James', accounts: [{network: 'telegram', value: 'JamesDeFleur'}, {network: 'whatsapp', value: '+15550100199'}]});
  await page.getByRole('button', {name: 'My QR codes'}).click();
  await page.locator('.u-myqr-card canvas').waitFor({state: 'visible'});
  assert.deepEqual(await page.locator('.u-myqr-chips .u-chip').allTextContents(), ['Telegram', 'WhatsApp'], 'connected accounts show with no setup');
  assert.match(await page.locator('.u-myqr-card canvas').getAttribute('aria-label'), /https:\/\/t\.me\/JamesDeFleur$/);
  await page.screenshot({path: evidence + '/1-connected.png'});
  const box = await page.locator('.u-myqr-card').boundingBox();
  await page.locator('.u-myqr-card').dispatchEvent('touchstart', {touches: [{identifier: 1, clientX: box.x + 300, clientY: box.y + 100}], changedTouches: [], targetTouches: []});
  await page.locator('.u-myqr-card').dispatchEvent('touchend', {touches: [], changedTouches: [{identifier: 1, clientX: box.x + 60, clientY: box.y + 100}], targetTouches: []});
  assert.equal(await page.locator('.u-myqr-chips [aria-pressed=true]').textContent(), 'WhatsApp');
  assert.match(await page.locator('.u-myqr-card canvas').getAttribute('aria-label'), /https:\/\/wa\.me\/15550100199$/);
  await page.getByRole('button', {name: 'Share'}).click();
  assert.equal((await page.evaluate(() => window.shared)).text, 'https://wa.me/15550100199');
  const fit = await page.evaluate(() => { const b = document.querySelector('.u-myqr-body'), sh = document.querySelector('.u-sheet'), a = document.querySelector('.u-myqr-actions').getBoundingClientRect(); return {body: b.scrollHeight - b.clientHeight, sheet: sh.scrollHeight - sh.clientHeight, bottom: a.bottom, vh: innerHeight}; });
  assert.ok(fit.body <= 1 && fit.sheet <= 1 && fit.bottom <= fit.vh, 'fits one screen: ' + JSON.stringify(fit));
  await page.getByRole('button', {name: 'Edit codes'}).click();
  assert.equal(await page.locator('.u-myqr-autorow').count(), 2);
  await page.screenshot({path: evidence + '/2-edit.png'});
  assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true, 'Back from edit');
  await page.locator('.u-myqr-card').waitFor({state: 'visible'});
  await page.getByRole('button', {name: 'Edit codes'}).click();
  await page.locator('.u-myqr-autorow', {hasText: 'WhatsApp'}).locator('input').uncheck();
  await page.getByRole('button', {name: 'Add another'}).click();
  const rows = page.locator('.u-myqr-row');
  await rows.nth(0).locator('select').selectOption('signal'); await rows.nth(0).locator('input').first().fill('+1 555 010 0199'); await rows.nth(0).locator('input').nth(1).fill('Signal (private)');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.locator('.u-myqr-chips .u-chip').nth(1).waitFor({state: 'visible'});
  const posted = await page.evaluate(() => window.posts.at(-1));
  assert.deepEqual(posted.codes.map(c => c.network), ['signal']);
  assert.deepEqual(posted.hidden, ['whatsapp:15550100199']);
  assert.deepEqual(await page.locator('.u-myqr-chips .u-chip').allTextContents(), ['Telegram', 'Signal (private)']);
  await page.screenshot({path: evidence + '/3-saved.png'});
  const size = await page.locator('.u-myqr-card canvas').evaluate(c => c.getBoundingClientRect().width);
  assert.ok(size >= 160, 'QR is large enough to scan: ' + size);
  assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true);
  await page.locator('.u-overlay').waitFor({state: 'detached'});
  await page.locator('.u-person').first().waitFor({state: 'visible'});
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('my-qr-codes browser: ok ->', evidence);
})().catch(e => { console.error(e); process.exit(1); });
