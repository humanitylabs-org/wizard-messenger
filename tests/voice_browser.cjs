// Voice-note proof on the disposable preview: a recorded note uploads as Ogg Opus (what Telegram takes as a
// voice message), and playback runs through Web Audio without any <audio>/<video> element (those take the
// phone's audio focus and pause the owner's music).
const {chromium} = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const browser = await chromium.launch({headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', ignoreHTTPSErrors: true, permissions: ['microphone']});
  await ctx.addInitScript(() => {
    window.__voiceUploads = [];
    const f = window.fetch; window.fetch = async function (u, o) { if (String(u).includes('upload?kind=voice') && o?.body instanceof Blob) { const b = new Uint8Array(await o.body.arrayBuffer()); window.__voiceUploads.push({type: o.body.type, head: String.fromCharCode(...b.subarray(0, 4)), size: b.length, b64: btoa(String.fromCharCode(...b))}); } return f.call(this, u, o); };
    window.__mediaPlays = 0; window.__webAudioStarts = 0;
    const play = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { window.__mediaPlays++; return play.call(this); };
    const start = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function (...a) { window.__webAudioStarts++; return start.apply(this, a); };
  });
  const page = await ctx.newPage();
  const errors = [], uploads = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(base);
  const setup = page.locator('#setup-form');
  await Promise.race([page.locator('.u-person').first().waitFor({timeout: 30000}), setup.waitFor({state: 'visible', timeout: 30000})]);
  if (await setup.isVisible()) {
    const pw = 'preview-only-passphrase-' + Date.now();
    await page.fill('#passphrase', pw); if (await page.locator('#confirm-passphrase').isVisible()) await page.fill('#confirm-passphrase', pw);
    await page.click('#setup-submit'); await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  }
  await page.locator('.u-person').filter({hasText: 'Ben Carter'}).first().click();
  await page.locator('.u-row').first().waitFor();
  const before = await page.locator('.u-row.outgoing .u-voice').count();
  // Record ~2.5 s from the fake microphone and send.
  await page.locator('.u-composer .u-mic, button[aria-label="Record voice message"]').first().click();
  await page.locator('.u-recording').waitFor();
  const shared = await page.evaluate(() => window.WizAppCapture?.current?.('messenger') || window.WizardApp.capture.current());
  assert.ok(shared?.id, 'recording is held by the shared Wizard capture service: ' + JSON.stringify(shared));
  await page.waitForTimeout(2500);
  await page.locator('.u-recording .u-send').click();
  await page.locator('.u-row.outgoing .u-voice').nth(before).waitFor({timeout: 10000});
  await page.waitForFunction(n => document.querySelectorAll('.u-row.outgoing .u-message:not(.pending) .u-voice').length > n, before, {timeout: 20000});
  uploads.push(...await page.evaluate(() => window.__voiceUploads));
  assert.equal(uploads.length, 1, 'one voice upload');
  assert.equal(uploads[0].type, 'audio/ogg', 'uploaded as Ogg');
  assert.equal(uploads[0].head, 'OggS', 'Ogg bytes');
  fs.writeFileSync(ev + '/sent-voice.ogg', Buffer.from(uploads[0].b64, 'base64'));
  const failed = await page.locator('.u-row.outgoing .u-failed, .u-row.outgoing .failed').count();
  // Play the just-sent note from the server copy and an incoming seeded note.
  await page.reload(); await page.locator('.u-person').filter({hasText: 'Ben Carter'}).first().click(); await page.locator('.u-row').first().waitFor(); await page.waitForTimeout(2500);
  const sentId = await page.locator('.u-row.outgoing .u-voice').last().evaluate(b => b.closest('[data-id]').dataset.id);
  const olderId = await page.locator('.u-row .u-voice').first().evaluate(b => b.closest('[data-id]').dataset.id);
  // Pin each note by id: scrolling up loads older pages, so "first voice note" would move under the test.
  for (const [name, id] of [['sent', sentId], ['older', olderId]]) { const box = page.locator(`[data-id="${id}"] .u-voice`); await box.scrollIntoViewIfNeeded();
    await box.locator('.u-vplay').click();
    await box.locator('.u-wave i.on').first().waitFor({timeout: 8000}).catch(async e => { throw new Error(name + ' never played: ' + JSON.stringify(await box.evaluate(b => [b.className, b.closest('[data-id]')?.dataset.id])) + JSON.stringify(await page.evaluate(async id => { const r = await fetch('api/unified/media/' + encodeURIComponent(id) + '?kind=', {credentials: 'same-origin'}); const b = await r.arrayBuffer(); let d; try { d = (await new AudioContext().decodeAudioData(b)).duration; } catch (x) { d = 'decode ' + x.message; } return [r.status, r.headers.get('content-type'), b.byteLength, d, window.__webAudioStarts]; }, await box.evaluate(b => b.closest('[data-id]')?.dataset.id)))); });
    await box.locator('.u-vplay').click(); // pause
    assert.equal(await box.evaluate(b => b.classList.contains('playing')), false, 'pauses');
    const at = await box.locator('.u-wave i.on').count(); await page.waitForTimeout(600);
    assert.equal(await box.locator('.u-wave i.on').count(), at, 'stays paused');
    await box.locator('.u-vplay').click(); await page.waitForTimeout(150); // resume, then stop by switching notes
    assert.ok(await box.evaluate(b => b.classList.contains('playing')), 'resumes');
    await page.screenshot({path: ev + '/voice-playing-' + name + '.png'});
    await box.locator('.u-vplay').click().catch(() => {}); await page.waitForTimeout(2500);
  }
  // Android's native recorder hands back AAC: it must become Ogg Opus too.
  const aac = fs.readFileSync(process.env.AAC || __dirname + '/../../messenger-mvp-preview/seedfiles/voice.aac').toString('base64');
  const conv = await page.evaluate(async b64 => { const b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const o = await window.MessengerUnified_toOggOpus(new Blob([b], {type: 'audio/aac'})); const u = new Uint8Array(await o.arrayBuffer()); return {type: o.type, head: String.fromCharCode(...u.subarray(0, 4)), b64: btoa(String.fromCharCode(...u))}; }, aac);
  assert.equal(conv.head, 'OggS', 'AAC converted to Ogg'); fs.writeFileSync(ev + '/from-aac.ogg', Buffer.from(conv.b64, 'base64'));
  const plays = await page.evaluate(() => ({media: window.__mediaPlays, webAudio: window.__webAudioStarts}));
  console.log(JSON.stringify({plays, failedMarks: failed, uploadBytes: uploads[0].size, errors}));
  assert.equal(plays.media, 0, 'no media element played'); assert.ok(plays.webAudio >= 2, 'web audio played');
  assert.deepEqual(errors, []);
  console.log('pass');
  await browser.close();
})().catch(e => { console.error('FAIL', e.message, e.stack.split('\n').find(l => l.includes('voice_browser'))); process.exit(1); });
