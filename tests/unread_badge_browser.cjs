// Browser proof: Messenger puts its total unread count on the Wizard app badge and clears it on read.
// Runs against a disposable preview (PREVIEW_URL); LIVE_SEND is a command that delivers one incoming message.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {execSync} = require('node:child_process');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://127.0.0.1:19253/';
  const evidence = process.env.EVIDENCE_DIR || './evidence-badge'; fs.mkdirSync(evidence, {recursive: true});
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}, colorScheme: 'dark', ignoreHTTPSErrors: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (process.env.UNIFIED_JS) await page.route('**/unified.js', r => r.fulfill({contentType: 'application/javascript', body: fs.readFileSync(process.env.UNIFIED_JS)}));
  // Observe what the app asks the shell to badge (standalone the shared client has no shell to forward to).
  await page.addInitScript(() => {
    window.__badges = []; let real;
    Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => real, set: v => { real = Object.freeze({...Object.getOwnPropertyDescriptors ? Object.fromEntries(Object.keys(v).map(k => [k, v[k]])) : v, hosted: v.hosted, badge: {set: n => { window.__badges.push(n); return v.badge.set(n); }}}); }});
  });
  const last = () => page.evaluate(() => window.__badges.at(-1));
  const listUnread = () => page.evaluate(() => [...document.querySelectorAll('.u-person .u-badge')].reduce((a, b) => a + (parseInt(b.textContent) || 0), 0));
  await page.goto(base); await page.locator('.u-person').first().waitFor({state: 'visible'});
  await page.waitForFunction(() => window.__badges.length > 0);
  const before = await last();
  execSync(process.env.LIVE_SEND + ' "badge proof ' + Date.now() + '"');
  await page.waitForFunction(b => window.__badges.at(-1) > b, before, {timeout: 30000});
  const after = await last();
  await page.screenshot({path: evidence + '/list-unread.png'});
  assert.ok(after >= await listUnread(), 'badge covers every unread chat row (plus groups)');
  await page.locator('.u-person.unread').first().click();
  await page.locator('.u-message').first().waitFor({state: 'visible'});
  await page.waitForFunction(a => window.__badges.at(-1) < a, after, {timeout: 15000});
  const read = await last();
  assert.deepEqual(errors, []);
  const out = {pass: true, before, afterIncoming: after, afterOpening: read, calls: await page.evaluate(() => window.__badges), errors};
  fs.writeFileSync(evidence + '/badge-proof.json', JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
