// One-phone linking (James, 28 Oct 2026: "I can't scan a QR code of my own screen with my phone").
// Real index.html, CSS, qr.js, connectors.js and unified.js on a faked bridge API, as a touch phone and as a computer.
// Proves: phone leads with same-phone routes; Signal is one tap (sgnl://linkdevice, top-level link) with the QR
// tucked away for another phone; WhatsApp needs no + sign, prefills the My QR codes number, shows a big copyable
// code with WhatsApp's real steps; a computer still leads with QR codes.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', 'static');
const evidence = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'evidence', 'one-phone-linking'); fs.mkdirSync(evidence, {recursive: true});
const SIGNAL = 'sgnl://linkdevice?uuid=AbCdEf123_-x&pub_key=BQ%2Babc%2Fdef%3D';
const stub = `
  window.WizardApp = {update: {hold: () => ({release() {}})}, back: {register() {}}, share: {text: async () => 'shared'}};
  window.calls = []; let polls = 0;
  const providers = () => [
    {network: 'telegram', label: 'Telegram', state: 'connected', flows: [{id: 'qr'}, {id: 'phone'}], logins: [{name: 'James'}]},
    {network: 'whatsapp', label: 'WhatsApp', state: 'disconnected', flows: [{id: 'qr', name: 'QR'}, {id: 'phone', name: 'Phone'}], logins: []},
    {network: 'signal', label: 'Signal', state: 'disconnected', flows: [{id: 'qr', name: 'QR'}], logins: []}];
  async function api(p, opts = {}) {
    window.calls.push([p, opts.method || 'GET', opts.body]);
    if (p === 'api/unified/people') return {people: [], seq: 1};
    if (p === 'api/unified/groups') return {groups: [], seq: 1};
    if (p.startsWith('api/unified/updates')) return new Promise(() => {});
    if (p === 'api/unified/qr-codes') return {codes: [{network: 'whatsapp', value: '+66 81 234 5678', label: ''}], saved: true};
    if (p === 'api/unified/connectors') return {providers: providers()};
    if (p === 'api/view/agent-access') return {enabled: false, log: []};
    const m = p.match(/^api\\/unified\\/connectors\\/(\\w+)\\/(\\w+)$/); if (!m) return {};
    const [, net, act] = m;
    if (act === 'cancel') return {};
    if (act === 'start' && net === 'signal') return {login_id: 's1', step_id: 'qr', type: 'display_and_wait', display_and_wait: {type: 'qr', data: '${SIGNAL}'}};
    if (act === 'start' && net === 'whatsapp' && opts.body.flow === 'phone') return {login_id: 'w1', step_id: 'phone', type: 'user_input', user_input: {fields: [{id: 'phone_number', type: 'phone_number', name: 'Phone number'}]}};
    if (act === 'start' && net === 'whatsapp') return {login_id: 'w2', step_id: 'qr', type: 'display_and_wait', display_and_wait: {type: 'qr', data: '2@abc,def,ghi'}};
    if (act === 'step' && opts.body.fields && opts.body.fields.phone_number) { window.sentPhone = opts.body.fields.phone_number; return {login_id: 'w1', step_id: 'code', type: 'display_and_wait', display_and_wait: {type: 'code', data: 'ABCD-EFGH'}}; }
    if (act === 'step') return new Promise(() => {}); // the bridge waits for the phone
    return {};
  }
  window.MessengerUnified.mount({api, csrf: () => 'x'});
  window.MessengerUnified.authenticated();`;
async function open(browser, ctx) {
  const context = await browser.newContext(ctx); await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: 'https://msg.test'});
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.errors = errors;
  await page.route('https://msg.test/**', route => {
    const u = new URL(route.request().url()); const f = u.pathname.replace(/^\/messenger\//, '') || 'index.html';
    if (f === 'app.js') return route.fulfill({contentType: 'text/javascript', body: stub});
    const file = path.join(root, f); if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    route.fulfill({contentType: f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://msg.test/messenger/');
  await page.getByRole('button', {name: 'Settings'}).first().waitFor({state: 'visible'});
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.locator('[data-network="signal"]').waitFor({state: 'visible'});
  return page;
}
(async () => {
  const browser = await chromium.launch({headless: true});
  // ---- Phone ----
  const page = await open(browser, {viewport: {width: 360, height: 640}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  assert.equal(await page.locator('.u-connectors-title').textContent(), 'Connect your chats');
  const wa = page.locator('[data-network="whatsapp"] button');
  assert.deepEqual(await wa.allTextContents(), ['Link on this phone', 'Show QR code for another device'], 'phone route first on a phone');
  assert.match(await wa.first().getAttribute('class'), /primary/);
  assert.deepEqual(await page.locator('[data-network="signal"] button').allTextContents(), ['Link on this phone']);
  await page.screenshot({path: evidence + '/1-phone-connect-your-chats.png'});
  // Signal: one tap into Signal's own "Link this device?" screen.
  await page.getByRole('button', {name: 'Link on this phone for Signal'}).click();
  const link = page.locator('a.u-connector-open'); await link.waitFor({state: 'visible'});
  assert.equal(await link.textContent(), 'Open Signal to link');
  assert.equal(await link.getAttribute('href'), SIGNAL);
  assert.equal(await link.getAttribute('target'), '_top', 'top-level so the Wizard phone app hands it to Signal');
  assert.equal(await page.locator('.u-connector-other canvas').isVisible(), false, 'QR stays tucked away on a phone');
  const box = await link.boundingBox(); assert.ok(box.height >= 44 && box.width >= 280, 'big tap target ' + JSON.stringify(box));
  await page.screenshot({path: evidence + '/2-phone-signal-one-tap.png'});
  await page.locator('.u-connector-other summary').click();
  await page.locator('.u-connector-other canvas').waitFor({state: 'visible'});
  assert.match(await page.locator('.u-connector-other canvas').getAttribute('aria-label'), /Scan it/);
  await page.getByRole('button', {name: 'Cancel'}).click(); // closes Settings and cancels the Signal login
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'api/unified/connectors/signal/cancel'));
  await page.getByRole('button', {name: 'Settings'}).first().click();
  // WhatsApp: no + sign; the My QR codes number is already there.
  await page.locator('[data-network="whatsapp"]').waitFor({state: 'visible'});
  await page.getByRole('button', {name: 'Link on this phone for WhatsApp'}).click();
  const number = page.getByRole('textbox', {name: 'Phone number'}); await number.waitFor({state: 'visible'});
  assert.equal(await number.inputValue(), '812345678'); assert.match(await page.locator('.u-prefix').textContent(), /^\+66$/);
  await page.screenshot({path: evidence + '/3-phone-whatsapp-number.png'});
  await number.fill('081 234 5678'); // typed the local way, trunk 0 and spaces
  await page.getByRole('button', {name: 'Continue'}).click();
  const code = page.locator('.u-connector-code'); await code.waitFor({state: 'visible'});
  assert.equal(await page.evaluate(() => window.sentPhone), '+66812345678');
  assert.equal(await code.textContent(), 'ABCD-EFGH');
  const fs_ = await code.evaluate(n => parseFloat(getComputedStyle(n).fontSize)); assert.ok(fs_ >= 28, 'big code ' + fs_);
  await page.waitForFunction(() => document.querySelector('.u-connector-copied')?.textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ABCD-EFGH', 'code copied for the owner');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('button', {name: 'Copy code'}).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ABCD-EFGH');
  const steps = await page.locator('.u-connectors ol li').allTextContents();
  assert.match(steps.join(' '), /Enter code to link new device/); assert.match(steps.join(' '), /Link with phone number instead/);
  assert.equal(await page.getByRole('button', {name: 'Get a new code'}).count(), 1);
  assert.equal(await page.getByRole('button', {name: 'I scanned it'}).count(), 0, 'no manual confirm: it settles on its own');
  await page.screenshot({path: evidence + '/4-phone-whatsapp-code.png', fullPage: true});
  assert.deepEqual(page.errors, []);
  // ---- Computer: QR codes lead ----
  const desk = await open(browser, {viewport: {width: 1280, height: 860}, colorScheme: 'light'});
  assert.deepEqual(await desk.locator('[data-network="whatsapp"] button').allTextContents(), ['Show QR code', 'Connect with phone']);
  assert.deepEqual(await desk.locator('[data-network="signal"] button').allTextContents(), ['Show QR code']);
  await desk.getByRole('button', {name: 'Show QR code for Signal'}).click();
  await desk.locator('.u-connector-qr canvas').waitFor({state: 'visible'});
  assert.equal(await desk.locator('a.u-connector-open').count(), 0);
  await desk.screenshot({path: evidence + '/5-computer-signal-qr.png'});
  assert.deepEqual(desk.errors, []);
  await browser.close();
  console.log('one-phone linking browser: ok -> ' + evidence);
})().catch(e => { console.error(e); process.exit(1); });
