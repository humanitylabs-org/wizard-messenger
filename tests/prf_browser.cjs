// Fingerprint-after-restart proof on a FRESH disposable preview: create Messenger, turn on fingerprint unlock,
// type the passphrase once (the phone seals it with its fingerprint key via WebAuthn PRF), restart the
// server so the encrypted vault is locked, then reopen with the fingerprint alone. Uses Chrome's virtual
// authenticator with PRF. Asserts the server never stores the passphrase in the clear.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const {execSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  const data = process.env.PREVIEW_DATA; const container = process.env.PREVIEW_CONTAINER || 'messenger-mvp-preview-messenger-1';
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const pw = 'preview-only-passphrase-' + Date.now();
  const find = (dir, name) => { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, e.name); if (e.isFile() && e.name === name) return p; if (e.isDirectory()) { try { const r = find(p, name); if (r) return r; } catch {} } } return null; };
  const browser = await chromium.launch({headless: true});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, ignoreHTTPSErrors: true});
  const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (['warning', 'error'].includes(m.type())) console.log('console', m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true}});
  const ticket = JSON.parse(execSync(`curl -s -X POST -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" -H 'Content-Type: application/json' -d '{"bootstrap":true}' http://127.0.0.1:19252/api/view/ticket`)).result.ticket;
  await page.goto(base + '#ticket=' + ticket);
  const messengerTab = async () => { const f = page.locator('#setup-form'); if (!(await f.isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]'); };
  await page.waitForTimeout(2000); await messengerTab();
  await page.locator('#confirm-passphrase').waitFor({state: 'visible', timeout: 30000});
  await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#fingerprint-toggle').waitFor({state: 'visible', timeout: 90000});
  await page.click('#fingerprint-toggle');
  await page.locator('#copy-error', {hasText: 'Fingerprint unlock is on'}).waitFor({timeout: 20000});
  // Lock, then type the passphrase once: that is when the phone seals it.
  await page.click('#lock'); await page.waitForTimeout(1500); await messengerTab();
  await page.locator('#passphrase').waitFor({state: 'visible', timeout: 30000});
  await page.fill('#passphrase', pw); await page.click('#setup-submit');
  let store = null;
  for (let i = 0; i < 40 && !store; i++) { await page.waitForTimeout(500); const f = find(data, 'passkeys.json'); if (f) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.keys?.some(k => k.wrap)) store = {f, raw: fs.readFileSync(f, 'utf8')}; } }
  if (!store) console.log(fs.readFileSync(find(data, 'passkeys.json'), 'utf8').slice(0, 300), await page.evaluate(() => document.getElementById('setup-error')?.textContent));
  assert.ok(store, 'passphrase sealed on the fingerprint key');
  assert.ok(!store.raw.includes(pw), 'server never stores the passphrase in the clear');
  // Restart: the encrypted vault is locked again.
  execSync(`docker restart ${container}`);
  for (let i = 0; i < 60; i++) { try { execSync('curl -sf http://127.0.0.1:19252/healthz', {stdio: 'ignore'}); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
  const t0 = Date.now();
  await page.reload(); await page.waitForTimeout(2000); await messengerTab();
  await page.locator('#fingerprint-unlock').waitFor({state: 'visible', timeout: 30000});
  await page.screenshot({path: ev + '/prf-locked.png'});
  await page.click('#fingerprint-unlock');
  await page.locator('#fingerprint-unlock').waitFor({state: 'hidden', timeout: 60000});
  await page.waitForTimeout(1000); await page.screenshot({path: ev + '/prf-reopened.png'});
  const status = JSON.parse(execSync(`curl -s -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" http://127.0.0.1:19252/api/status`)).result;
  assert.equal(status.state, 'ready', 'vault unlocked by fingerprint after restart');
  console.log(JSON.stringify({reopen_ms: Date.now() - t0, state: status.state, errors}));
  console.log('pass'); await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
