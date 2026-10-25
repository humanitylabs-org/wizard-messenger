// Disposable preview only. Attach several photos at once; one album request, caption once.
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

  const uploads = [], sends = [];
  await ctx.route(/\/upload\?kind=image/, async route => { uploads.push(route.request().postDataBuffer()?.length || 0); route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {upload_id: 'u' + uploads.length}})}); });
  await ctx.route(/\/send$/, async route => { const b = JSON.parse(route.request().postData()); sends.push(b); route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {state: 'sent'}})}); });
  const shots = await page.evaluate(async () => Promise.all(['#c33', '#3c3', '#33c'].map(async c => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 64, 48); const b = await new Promise(r => cv.toBlob(r, 'image/png')); return Array.from(new Uint8Array(await b.arrayBuffer())); })));
  const input = page.locator('.u-compose-row input[type=file]');
  assert.equal(await input.getAttribute('multiple'), '', 'picker allows several photos');
  await input.setInputFiles(shots.map((bytes, i) => ({name: 'p' + i + '.png', mimeType: 'image/png', buffer: Buffer.from(bytes)})));
  await page.locator('.u-attach-chip').nth(2).waitFor({timeout: 10000});
  assert.equal(await page.locator('.u-attach-chip').count(), 3);
  await page.locator('.u-attach-chip').nth(1).getByRole('button', {name: 'Remove photo'}).click();
  assert.equal(await page.locator('.u-attach-chip').count(), 2, 'remove one photo keeps the others');
  await input.setInputFiles([{name: 'p3.png', mimeType: 'image/png', buffer: Buffer.from(shots[1])}]);
  await page.locator('.u-attach-chip').nth(2).waitFor({timeout: 10000});
  await page.locator('.u-composer textarea').fill('three photos');
  await page.screenshot({path: ev + '/multi-photo.png'});
  await page.locator('.u-send').click();
  for (let i = 0; i < 50 && sends.length < 1; i++) await page.waitForTimeout(200);
  assert.equal(uploads.length, 3, 'three uploads'); assert.equal(sends.length, 1, 'one album send');
  assert.equal(sends[0].text, 'three photos', 'one caption');
  assert.deepEqual(sends[0].upload_ids, ['u1', 'u2', 'u3']);
  assert.equal(sends[0].upload_id, undefined);
  assert.equal(await page.locator('.u-attach-chip').count(), 0, 'tray cleared');
  assert.deepEqual(errors, []);
  fs.writeFileSync(ev + '/receipt.json', JSON.stringify({uploads, sends}, null, 1));
  console.log('pass multi_photo_browser'); await browser.close();
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  if (diagnosticPage) {
    console.error('visible state:', await diagnosticPage.locator('body').innerText().catch(() => 'unavailable'));
    await diagnosticPage.screenshot({path: (process.env.EVIDENCE_DIR || './evidence') + '/failure.png'}).catch(() => {});
  }
  process.exit(1);
});
