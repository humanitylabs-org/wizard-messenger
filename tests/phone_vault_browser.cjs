// Phone fingerprint vault proof (Wizard OS Android app path) on a FRESH disposable preview. WizardApp.vault is
// faked the way the shell answers it (has/seal/open/forget, codes); the native Keystore half is covered by the
// APK's own tests. Flow: create, lock, type password once -> sealed on the "phone"; restart the server (vault
// locked); reload -> Messenger asks for the fingerprint by itself and opens with no typing.
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  const container = process.env.PREVIEW_CONTAINER || 'messenger-mvp-preview-messenger-1';
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const pw = 'preview-only-passphrase-' + Date.now();
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
  await ctx.addInitScript(() => {
    const db = () => JSON.parse(localStorage.getItem('__fakeVault') || '{}'), put = v => localStorage.setItem('__fakeVault', JSON.stringify(v));
    const log = m => { const l = JSON.parse(localStorage.getItem('__fakeVaultLog') || '[]'); l.push(m); localStorage.setItem('__fakeVaultLog', JSON.stringify(l)); };
    const fake = {
      has: async () => ({available: true, saved: !!db().secret}),
      seal: async (secret, title) => { log('seal:' + title); if (db().cancelNext) { put({}); throw Object.assign(new Error('cancelled'), {code: 'cancelled'}); } put({secret}); return {saved: true}; },
      open: async title => { log('open:' + title); const s = db().secret; if (!s) throw Object.assign(new Error('not_saved'), {code: 'not_saved'}); return s; },
      forget: async () => { log('forget'); put({}); return {saved: false}; },
    };
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v, back: v.back, update: v.update, capture: v.capture, vault: fake, badge: {set: n => { window.__badges = (window.__badges || []).concat(n); return Promise.resolve(true); }}}); }});
  });
  const page = await ctx.newPage(); globalThis.__page = page; const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (/dbg|vault|seal/i.test(m.text())) console.log('console', m.text()); });
  const ticket = JSON.parse(execSync(`curl -s -X POST -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" -H 'Content-Type: application/json' -d '{"bootstrap":true}' http://127.0.0.1:19252/api/view/ticket`)).result.ticket;
  const messengerTab = async () => { if (await page.locator('#sheet-layer:not([hidden])').isVisible().catch(() => false)) await page.click('#close-sheet').catch(() => {}); if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]'); };
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(2000); await messengerTab();
  await page.locator('#confirm-passphrase').waitFor({state: 'visible', timeout: 30000});
  await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  // Creating never springs a question. Lock, type the password: Messenger ASKS first.
  const relock = async () => { if (!(await page.locator('#lock').isVisible())) { await messengerTab(); await page.click('#my-address'); } await page.locator('#lock').waitFor({state: 'visible', timeout: 90000}); await page.click('#lock'); await page.waitForTimeout(1500); await messengerTab();
    await page.locator('#passphrase').waitFor({state: 'visible', timeout: 30000}); await page.fill('#passphrase', pw); await page.click('#setup-submit'); };
  await relock();
  const sheet = page.locator('.u-sheet[aria-label="Unlock with your fingerprint?"]');
  await sheet.waitFor({state: 'visible', timeout: 30000});
  await page.screenshot({path: ev + '/vault-ask.png'});
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('__fakeVaultLog') || '[]')), [], 'no fingerprint prompt before the answer');
  await sheet.getByRole('button', {name: 'Not now'}).click();
  await page.locator('.u-toast', {hasText: 'turn it on anytime'}).waitFor({timeout: 5000});
  await page.screenshot({path: ev + '/vault-later.png'});
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('__fakeVaultLog') || '[]')), [], 'Not now never prompts');
  // Not asked again on the next unlock; turning it on from the address panel still works.
  await page.evaluate(() => localStorage.removeItem('messenger.fingerprint.declined'));
  await relock();
  await sheet.waitFor({state: 'visible', timeout: 30000});
  await sheet.getByRole('button', {name: 'Use fingerprint'}).click();
  await page.locator('.u-toast', {hasText: 'Fingerprint unlock is on'}).waitFor({timeout: 5000});
  await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('__fakeVault') || '{}').secret, null, {timeout: 20000}).catch(() => {});
  let vault = await page.evaluate(() => JSON.parse(localStorage.getItem('__fakeVault') || '{}'));
  if (!vault.secret) console.log('dbg', await page.evaluate(() => ({fake: !!window.WizardApp?.vault?.has, log: localStorage.getItem('__fakeVaultLog'), toggle: document.getElementById('fingerprint-toggle')?.textContent, hidden: document.getElementById('fingerprint-toggle')?.hidden, err: document.getElementById('setup-error')?.textContent})));
  assert.equal(vault.secret, pw, 'first typed password is saved behind the fingerprint');
  // Restart: server vault locked, nothing about the fingerprint is on the server.
  execSync(`docker restart ${container}`);
  for (let i = 0; i < 60; i++) { try { execSync('curl -sf http://127.0.0.1:19252/healthz', {stdio: 'ignore'}); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
  const status0 = JSON.parse(execSync(`curl -s -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" http://127.0.0.1:19252/api/status`)).result;
  assert.equal(status0.state, 'locked', 'restart locks the server vault');
  await page.evaluate(() => localStorage.setItem('__fakeVaultLog', '[]'));
  const t0 = Date.now();
  await page.reload(); await page.waitForTimeout(1500); await messengerTab().catch(() => {}); // the reopen may already be underway
  let status;
  for (let i = 0; i < 40; i++) { status = JSON.parse(execSync(`curl -s -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" http://127.0.0.1:19252/api/status`)).result; if (status.state === 'ready') break; await page.waitForTimeout(500); }
  assert.equal(status.state, 'ready', 'fingerprint alone reopened Messenger after the restart');
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem('__fakeVaultLog') || '[]'));
  assert.deepEqual(log, ['open:Unlock Messenger'], 'asked once, automatically');
  await page.waitForTimeout(800); await page.screenshot({path: ev + '/vault-reopened.png'});
  assert.equal(await page.locator('#passphrase').isVisible(), false, 'no password field');
  // Turn it off from the address panel.
  await page.waitForFunction(() => { document.getElementById('fingerprint-toggle').click(); return !JSON.parse(localStorage.getItem('__fakeVault') || '{}').secret; }, null, {timeout: 20000, polling: 1000}).catch(() => {});
  vault = await page.evaluate(() => JSON.parse(localStorage.getItem('__fakeVault') || '{}'));
  assert.ok(!vault.secret, 'turning it off forgets the phone copy');
  const pk = execSync(`docker exec ${container} sh -c 'cat /data/passkeys.json 2>/dev/null || true'`).toString();
  assert.ok(!pk.includes(pw), 'server never holds the password');
  // Another desk in front: the change feed keeps listening so the desk badge can move.
  const polls = []; page.on('request', r => { if (r.url().includes('api/unified/updates')) polls.push(Date.now()); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange')); });
  const hid = Date.now(); await page.waitForTimeout(32000);
  assert.ok(polls.some(x => x > hid + 1000), 'hidden Messenger still polls for changes: ' + JSON.stringify(polls.map(x => x - hid)));
  const badges = await page.evaluate(() => window.__badges || []);
  assert.ok(badges.length && badges.at(-1) === 0, 'Messenger reports its unread count to the desk badge');
  console.log(JSON.stringify({badges, reopen_ms: Date.now() - t0, errors}));
  assert.deepEqual(errors, []);
  console.log('pass'); await browser.close();
})().catch(async e => {
  console.error('FAIL', e.message, (e.stack.match(/phone_vault_browser.cjs:\d+/g) || []).join(' '));
  try { await globalThis.__page.screenshot({path: (process.env.EVIDENCE_DIR || '.') + '/fail.png'}); console.error(JSON.stringify(await globalThis.__page.evaluate(() => [document.getElementById('sheet-title')?.textContent, location.hash, JSON.stringify(history.state)]))); } catch { /* page gone */ }
  process.exit(1);
});
