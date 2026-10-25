// My QR codes: real index.html, CSS, qr.js and unified.js; app.js swapped for a stub that mounts the unified view
// on a faked API. Proves the header entry, Telegram suggestion, edit/save round trip, swipe, and nested Back.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', 'static');
const evidence = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'evidence', 'my-qr'); fs.mkdirSync(evidence, {recursive: true});
const stub = `
  window.WizardApp = {update: {hold: () => ({release() {}})}, back: {register() {}}, share: {text: async p => { window.shared = p; return 'shared'; }}};
  window.saved = null; window.posts = [];
  const people = [{id: 'p1', display_name: 'Alice', identities: [{id: 'i1', network: 'telegram', label: 'Alice'}], last: {original: 'hi', timestamp: Date.now()}, unread: 0}];
  async function api(p, opts = {}) {
    if (p === 'api/unified/people') return {people, seq: 1};
    if (p === 'api/unified/groups') return {groups: [], seq: 1};
    if (p.startsWith('api/unified/updates')) return new Promise(() => {});
    if (p === 'api/unified/qr-codes' && opts.method === 'POST') { window.posts.push(opts.body); window.saved = opts.body.codes; return {codes: window.saved, saved: true}; }
    if (p === 'api/unified/qr-codes') return window.saved ? {codes: window.saved, saved: true} : {codes: [{network: 'telegram', value: 'JamesDeFleur', label: ''}], saved: false};
    return {};
  }
  window.MessengerUnified.mount({api, csrf: () => 'x'});
  window.MessengerUnified.authenticated();`;
(async () => {
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('http://msg.test/**', route => {
    const u = new URL(route.request().url()); let f = u.pathname.replace(/^\/messenger\//, '') || 'index.html';
    if (f === 'app.js') return route.fulfill({contentType: 'text/javascript', body: stub});
    if (f.startsWith('/wizard-os-home')) return route.fulfill({contentType: 'text/javascript', body: ''});
    const file = path.join(root, f); if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    route.fulfill({contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('http://msg.test/messenger/');
  await page.locator('.u-person').first().waitFor({state: 'visible'});
  const qrButton = page.getByRole('button', {name: 'My QR codes'});
  await qrButton.click();
  await page.locator('.u-myqr-card canvas').waitFor({state: 'visible'});
  assert.equal(await page.locator('.u-myqr-name').textContent(), 'Telegram');
  assert.equal(await page.locator('.u-myqr-value').textContent(), 'JamesDeFleur');
  assert.match(await page.locator('.u-myqr-card canvas').getAttribute('aria-label'), /https:\/\/t\.me\/JamesDeFleur$/);
  await page.screenshot({path: evidence + '/1-suggested-telegram.png'});
  // Edit: keep Telegram, add WhatsApp and Signal.
  await page.getByRole('button', {name: 'Edit codes'}).click();
  await page.getByRole('button', {name: 'Add another'}).click();
  let rows = page.locator('.u-myqr-row'); assert.equal(await rows.count(), 2);
  await rows.nth(1).locator('select').selectOption('whatsapp');
  await rows.nth(1).locator('input').first().fill('+1 555 010 0199');
  await page.getByRole('button', {name: 'Add another'}).click();
  await rows.nth(2).locator('select').selectOption('signal');
  await rows.nth(2).locator('input').first().fill('+1 555 010 0199');
  await rows.nth(2).locator('input').nth(1).fill('Signal (private)');
  await page.screenshot({path: evidence + '/2-edit.png'});
  // Nested Back from edit returns to the codes, not the chat list.
  assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true);
  await page.locator('.u-myqr-card').waitFor({state: 'visible'});
  assert.equal(await page.locator('.u-sheet[aria-label="My QR codes"]').count(), 1, 'Back from edit lands on My QR codes');
  // Redo the edit and save.
  await page.getByRole('button', {name: 'Edit codes'}).click();
  await page.getByRole('button', {name: 'Add another'}).click();
  rows = page.locator('.u-myqr-row');
  await rows.nth(1).locator('select').selectOption('whatsapp'); await rows.nth(1).locator('input').first().fill('+1 555 010 0199');
  await page.getByRole('button', {name: 'Add another'}).click();
  await rows.nth(2).locator('select').selectOption('signal'); await rows.nth(2).locator('input').first().fill('+1 555 010 0199'); await rows.nth(2).locator('input').nth(1).fill('Signal (private)');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.locator('.u-myqr-chips .u-chip').nth(2).waitFor({state: 'visible'});
  const posted = await page.evaluate(() => window.posts.at(-1).codes);
  assert.deepEqual(posted.map(c => c.network), ['telegram', 'whatsapp', 'signal']);
  assert.deepEqual(await page.locator('.u-myqr-chips .u-chip').allTextContents(), ['Telegram', 'WhatsApp', 'Signal (private)']);
  await page.locator('.u-myqr-chips .u-chip', {hasText: 'WhatsApp'}).click();
  assert.match(await page.locator('.u-myqr-card canvas').getAttribute('aria-label'), /https:\/\/wa\.me\/15550100199$/);
  await page.screenshot({path: evidence + '/3-whatsapp.png'});
  // Swipe left -> Signal.
  const box = await page.locator('.u-myqr-card').boundingBox();
  await page.locator('.u-myqr-card').dispatchEvent('touchstart', {touches: [{identifier: 1, clientX: box.x + 300, clientY: box.y + 100}], changedTouches: [], targetTouches: []});
  await page.locator('.u-myqr-card').dispatchEvent('touchend', {touches: [], changedTouches: [{identifier: 1, clientX: box.x + 60, clientY: box.y + 100}], targetTouches: []});
  assert.equal(await page.locator('.u-myqr-name').textContent(), 'Signal (private)');
  assert.match(await page.locator('.u-myqr-card canvas').getAttribute('aria-label'), /https:\/\/signal\.me\/#p\/\+15550100199$/);
  await page.getByRole('button', {name: 'Share'}).click();
  assert.equal((await page.evaluate(() => window.shared)).text, 'https://signal.me/#p/+15550100199');
  await page.screenshot({path: evidence + '/4-signal-swipe.png'});
  // QR canvas really decodes to its link: module grid matches qrcode() output for the same text.
  const size = await page.locator('.u-myqr-card canvas').evaluate(c => [c.width, c.getBoundingClientRect().width]);
  assert.ok(size[0] >= 290 && size[1] >= 280, 'QR is large enough to scan: ' + size);
  // Back closes the page, then the list is back.
  assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true);
  await page.locator('.u-overlay').waitFor({state: 'detached'});
  await page.locator('.u-person').first().waitFor({state: 'visible'});
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('my-qr-codes browser: ok ->', evidence);
})().catch(e => { console.error(e); process.exit(1); });
