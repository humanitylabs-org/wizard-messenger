// Disposable preview only. A phone that slept leaves the change feed hanging on a dead connection; coming back must
// restart it so chats started elsewhere appear (James, 26 Oct 2026: PC chats never showed on the phone).
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
let diagnosticPage;
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  assert.match(new URL(base).hostname, /^(localhost|127\.0\.0\.1)$/, 'preview only');
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const transcript = 'Miguel says: Let us think through the next step together. ' + 'This longer transcript wraps safely inside the voice-note bubble. '.repeat(3).trim();
  let transcribes = 0; const shares = [], inputs = []; let receipt = 'shared';
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: true, isMobile: true, timezoneId: 'UTC'});
  await ctx.exposeBinding('__transcribe', (_, data) => { transcribes++; inputs.push(data); return {text: transcript}; });
  await ctx.exposeBinding('__share', (_, data) => { shares.push(data); return receipt; });
  await ctx.addInitScript(() => {
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v,
      back: {...v.back, register(h) {window.__backHandler = h; return v.back.register(h);}},
      voice: window.__oldShell ? undefined : {transcribe: async file => window.__transcribe({type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))})},
      share: {file: async (file, options) => window.__share({kind: 'file', name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), options}), text: data => window.__share({kind: 'text', ...data})},
      vault: {has: async () => ({available: false, saved: false})},
      update: {...v.update, hold(reason) {const h = {reason, released: false}; (window.__holds ||= []).push(h); return {release() {h.released = true;}};}},
    }); }});
  });
  const sr = 16000, n = sr * 2, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / sr)), 44 + i * 2);
  execFileSync('docker', ['exec', 'messenger-mvp-preview-messenger-1', 'python3', '-c', `
from unified import PeopleStore
s=PeopleStore('/data/unified/people.sqlite3')
a=s.identity('telegram','!preview-miguel','Miguel')
s.add_message('$v1',a,'Miguel',False,'',1792869840000,msgtype='m.audio',media={'voice':True,'duration':2000,'mime':'audio/wav'})
s.add_message('$t1',a,'Miguel',False,'What do you think of this idea?',1792869900000)
s.add_message('$v2',a,'You',True,'',1792869960000,msgtype='m.audio',media={'voice':True,'duration':2000,'mime':'audio/wav'})
`]);
  let mediaFetches = 0;
  await ctx.route(/api\/unified\/media\/%24v[12]/, route => {mediaFetches++; return route.fulfill({status: 200, contentType: 'audio/wav', body: wav});});
  // Serve this checkout's view files so the shared preview container is not touched.
  if (process.env.STATIC_DIR) await ctx.route(/\/(unified\.js|unified\.css)(\?|$)/, route => { const f = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({status: 200, contentType: f.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(process.env.STATIC_DIR + '/' + f)}); });
  // The composer behaviour is Wizard's shared WizComposerInput; serve a shell checkout's copy when given.
  if (process.env.SHELL_DIR) await ctx.route(/\/wizard-os-home\/core\/(app-client|composer-input|attach-chip)\.(js|css)(\?|$)/, route => { const f = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({status: 200, contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(process.env.SHELL_DIR + '/web/core/' + f)}); });
  let held = 0, served = 0; const fresh = {};
  await ctx.route(/api\/unified\/updates/, async route => {
    if (!fresh.row) { held++; return; } // the dead connection: never answers
    served++; const seq = Number(new URL(route.request().url()).searchParams.get('since')) + 1;
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {seq, people: served === 1 ? [fresh.row] : [], messages: {}, typing: {}, removed: []}})});
  });
  // The list's own fetch on wake sees the same new chat the PC started.
  await ctx.route(/api\/unified\/people(\?|$)/, async route => {
    if (!fresh.row || route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch(); const j = await res.json(); fresh.listed = (fresh.listed || 0) + 1;
    j.result.people = [fresh.row, ...j.result.people]; return route.fulfill({response: res, body: JSON.stringify(j)});
  });
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  diagnosticPage = page;
  page.on('console', m => { if (m.type() === 'error') console.error('browser:', m.text()); });
  const ticket = JSON.parse(execFileSync('curl', ['-sf','-X','POST','-H','Authorization: Bearer ' + process.env.MESSENGER_API_TOKEN,'-H','Content-Type: application/json','-d','{"bootstrap":true}','http://127.0.0.1:19252/api/view/ticket'])).result.ticket;
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(2000);
  await page.locator('#setup-form:visible, #inbox-tabs:visible').first().waitFor({timeout: 60000});
  if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.locator('#confirm-passphrase').waitFor({state: 'visible', timeout: 30000});
  const pw = 'preview-only-passphrase-' + Date.now(); await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  // Address sheet opens after the asynchronous post-create snapshot, not at first ready paint.
  await page.locator('#sheet-layer:not([hidden])').waitFor({state: 'visible', timeout: 30000});
  await page.click('#close-sheet');
  await page.click('#inbox-tabs [data-tab="people"]');
  await page.locator('.u-person', {hasText: 'Miguel'}).waitFor({timeout: 30000});
  for (let i = 0; i < 50 && !held; i++) await page.waitForTimeout(200);
  assert.ok(held >= 1, 'the feed is waiting on a poll that never answers');
  // A new chat arrives elsewhere (from the PC) while this poll is dead.
  const row = await page.evaluate(async () => (await (await fetch('api/unified/people')).json()).result.people.find(p => p.display_name === 'Miguel'));
  fresh.row = {...row, id: row.id + '-pc', display_name: 'Ana from the PC', last: {...(row.last || {}), text: 'sent from my PC', timestamp: Date.now()}, last_at: Date.now(), unread: 1};
  // Phone wakes: the page becomes visible again.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('.u-person', {hasText: 'Ana from the PC'}).waitFor({timeout: 8000});
  await page.waitForTimeout(1500);
  assert.ok(fresh.listed >= 1, 'waking re-fetches the list directly');
  assert.equal(await page.locator('.u-person', {hasText: 'Ana from the PC'}).count(), 1, 'the new chat shows once');
  await page.screenshot({path: ev + '/after-wake.png'});
  assert.deepEqual(errors, []);
  console.log('pass feed_wake_browser'); await browser.close();
})().catch(async e => { console.error(e); try { await diagnosticPage?.screenshot({path: (process.env.EVIDENCE_DIR || '.') + '/failure.png'}); } catch {} process.exit(1); });
