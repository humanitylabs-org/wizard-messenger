// Disposable preview only. On desktop (a mouse, no long-press) right-click a message → Select starts picking several
// messages; clicks add more; Esc leaves. A phone's tap menu keeps no Select: holding does that (James, 26 Oct 2026).
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
  const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, colorScheme: 'dark', ignoreHTTPSErrors: true, timezoneId: 'UTC'});
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
  await page.locator('.u-person', {hasText: 'Miguel'}).click();

  const msgs = page.locator('.u-message');
  await msgs.nth(2).waitFor({timeout: 30000});
  await msgs.nth(1).click({button: 'right'});
  const sel = page.getByRole('menuitem', {name: 'Select', exact: true});
  await sel.waitFor({timeout: 5000});
  await page.screenshot({path: ev + '/right-click-menu.png'});
  await sel.click();
  const bar = page.locator('.u-selection:not([hidden])');
  await bar.waitFor({timeout: 5000});
  assert.match(await bar.innerText(), /1 selected/, 'Select picks that message');
  await msgs.nth(2).click();
  assert.match(await bar.innerText(), /2 selected/, 'a click adds another message');
  await page.screenshot({path: ev + '/two-selected.png'});
  await msgs.nth(2).click();
  assert.match(await bar.innerText(), /1 selected/, 'clicking again removes it');
  await page.keyboard.press('Escape');
  await bar.waitFor({state: 'hidden', timeout: 5000});
  // A left click still opens the menu (with Select) when not selecting.
  await msgs.nth(1).click();
  await sel.waitFor({timeout: 5000});
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('pass select_desktop_browser'); await browser.close();
})().catch(async e => { console.error(e); try { await diagnosticPage?.screenshot({path: (process.env.EVIDENCE_DIR || '.') + '/failure.png'}); } catch {} process.exit(1); });
