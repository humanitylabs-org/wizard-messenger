// Disposable preview only. Pasting or dropping an image into the composer attaches it, like Chats (James, 25 Oct 2026).
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
  await ctx.route(/\/upload\?kind=(image|file)/, async route => { const q = new URL(route.request().url()).searchParams; uploads.push({kind: q.get('kind'), name: q.get('name'), bytes: route.request().postDataBuffer()?.length || 0}); route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {upload_id: 'u' + uploads.length}})}); });
  await ctx.route(/\/send$/, async route => { const b = JSON.parse(route.request().postData()); sends.push(b); route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {state: 'sent'}})}); });
  // The thread composer is rebuilt once the person (and their Telegram identity) loads; paste into that one.
  await page.locator('.u-attach:not([hidden])').waitFor({timeout: 30000});
  const ta = page.locator('.u-composer textarea');
  // Paste a screenshot (Cmd/Ctrl+V of an image): it lands in the photo tray like the picker, as in Chats.
  const pasted = await ta.evaluate(async el => {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; const x = cv.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 64, 48);
    const b = await new Promise(r => cv.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([b], 'image.png', {type: 'image/png'}));
    const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); el.focus(); el.dispatchEvent(ev); return ev.defaultPrevented;
  });
  assert.equal(pasted, true, 'image paste is claimed');
  await page.locator('.u-attach-strip .ch-att').first().waitFor({timeout: 10000});
  assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 1, 'pasted image attaches');
  assert.equal(await ta.inputValue(), '', 'no junk text from the image paste');
  assert.equal(await page.evaluate(() => typeof window.WizComposerInput?.bind), 'function', 'shared composer input loaded');
  // A text paste lands from the paste event's own snapshot, so a dictation app that restores its clipboard at
  // once (Wispr Flow) still gets its words in, exactly as in Chats.
  const textClaimed = await ta.evaluate(el => { const dt = new DataTransfer(); dt.setData('text/plain', 'dictated take'); const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); el.focus(); el.dispatchEvent(ev); return ev.defaultPrevented; });
  assert.equal(textClaimed, true, 'text paste inserted from the event snapshot');
  assert.equal(await ta.inputValue(), 'dictated take', 'dictated words landed');
  // Drafts survive closing Messenger: kept in localStorage, not the tab.
  const kept = await page.evaluate(() => JSON.stringify(localStorage.getItem('messenger-drafts-v2') || ''));
  assert.ok(kept.includes('dictated take'), 'draft saved to localStorage: ' + kept);
  // Dropping an image file on the composer attaches it too.
  await page.locator('.u-composer').evaluate(async form => {
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40; cv.getContext('2d').fillRect(0, 0, 40, 40);
    const b = await new Promise(r => cv.toBlob(r, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([b], 'drop.png', {type: 'image/png'}));
    form.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
    form.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
  });
  await page.locator('.u-attach-strip .ch-att').nth(1).waitFor({timeout: 10000});
  // Any other file attaches too, as a file chip (name + size), the same chip Chats shows (James, 26 Oct 2026).
  await ta.evaluate(el => { const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4 hello'], 'notes.pdf', {type: 'application/pdf'})); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); });
  await page.locator('.u-attach-strip .ch-att').nth(2).waitFor({timeout: 10000});
  const fileChip = page.locator('.u-attach-strip .ch-att:not(.ch-attimg)');
  assert.equal(await fileChip.count(), 1, 'one file chip');
  assert.match(await fileChip.innerText(), /notes\.pdf\s*14 B/, 'file chip shows name and size');
  assert.equal(await page.locator('.u-attach-strip .ch-attimg').count(), 2, 'photos stay thumbnails');
  assert.equal(await page.evaluate(() => typeof window.WizAttachChip?.node), 'function', 'shared attachment chip loaded');
  await ta.fill('');
  await ta.fill('pasted shot');
  await page.screenshot({path: ev + '/paste-photo.png'});
  await page.locator('.u-send').click();
  for (let i = 0; i < 50 && sends.length < 2; i++) await page.waitForTimeout(200);
  assert.deepEqual(uploads.map(u => u.kind), ['image', 'image', 'file'], 'two photo uploads then the file');
  assert.equal(uploads[2].name, 'notes.pdf', 'file upload carries its name');
  assert.equal(sends.length, 2, 'album then file'); assert.equal(sends[0].text, 'pasted shot');
  assert.deepEqual(sends[0].upload_ids, ['u1', 'u2']);
  assert.equal(sends[1].upload_id, 'u3'); assert.equal(sends[1].text, '', 'the text rides with the album only');
  assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 0, 'tray cleared');
  // The + picker takes any file; a lone file carries the typed text, and Remove takes a chip back out.
  await page.locator('.u-composer input[type=file]').setInputFiles([{name: 'Quarterly report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 ' + 'x'.repeat(3000))}, {name: 'oops.zip', mimeType: 'application/zip', buffer: Buffer.from('PK')}]);
  await page.locator('.u-attach-strip .ch-att').nth(1).waitFor({timeout: 10000});
  await page.locator('.u-attach-strip .ch-att', {hasText: 'oops.zip'}).getByRole('button', {name: 'Remove'}).click();
  assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 1, 'Remove drops only that file');
  await page.screenshot({path: ev + '/file-chip.png'});
  await ta.fill('here is the report'); await page.locator('.u-send').click();
  for (let i = 0; i < 50 && sends.length < 3; i++) await page.waitForTimeout(200);
  assert.equal(uploads[3].kind, 'file'); assert.equal(uploads[3].name, 'Quarterly report.pdf'); assert.equal(uploads.length, 4);
  assert.equal(sends[2].upload_id, 'u4'); assert.equal(sends[2].text, 'here is the report');
  await page.locator('.u-file', {hasText: 'Quarterly report.pdf'}).first().waitFor({timeout: 5000});
  await page.screenshot({path: ev + '/file-sent.png'});
  // Ctrl/Cmd+Enter sends, Shift+Enter is a new line (the shared Enter policy).
  await ta.fill('line one'); await ta.press('Shift+Enter'); await ta.type('line two');
  assert.equal(await ta.inputValue(), 'line one\nline two', 'Shift+Enter is a new line');
  await ta.press('Control+Enter');
  for (let i = 0; i < 50 && sends.length < 4; i++) await page.waitForTimeout(200);
  assert.equal(sends.length, 4, 'Ctrl+Enter sends'); assert.equal(sends[3].text, 'line one\nline two');
  assert.equal(await ta.inputValue(), '', 'composer cleared after send');
  assert.deepEqual(errors, []);
  fs.writeFileSync(ev + '/receipt.json', JSON.stringify({uploads, sends}, null, 1));
  console.log('pass paste_photo_browser'); await browser.close();
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  if (diagnosticPage) {
    console.error('visible state:', await diagnosticPage.locator('body').innerText().catch(() => 'unavailable'));
    await diagnosticPage.screenshot({path: (process.env.EVIDENCE_DIR || './evidence') + '/failure.png'}).catch(() => {});
  }
  process.exit(1);
});
