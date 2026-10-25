// Fresh disposable preview: (1) voice-note speed pill 1x -> 1.5x -> 2x, remembered; (2) a new Messenger release
// a typed draft no longer holds Wizard's update reload; a reload returns to the same chat with the draft.
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const pw = 'preview-only-passphrase-' + Date.now();
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: true, isMobile: true});
  await ctx.addInitScript(() => {
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v, back: v.back, update: {...v.update, hold(reason) { const h = {reason, released: false, at: new Error().stack.split('\n').slice(2, 5).join(' | ')}; (window.__holds ||= []).push(h); return {release() { h.released = true; }}; }}, capture: v.capture, vault: {has: async () => ({available: false, saved: false})}, badge: {set: n => { window.__badges = (window.__badges || []).concat(n); return Promise.resolve(true); }}}); }});
  });
  const now = Date.now() / 1000;
  const person = (id, name, unread, group) => ({id, display_name: name, unread, identities: [{kind: group ? 'group' : 'telegram', id}], last: {text: 'hello', timestamp: now}, labels: []});
  const fake = {people: [person('p1', 'Ana', 3), person('p2', 'Ben', 2), person('p3', 'Cy', 0)], groups: [person('g1', 'Climbing', 4, true), person('g2', 'Family', 0, true)]};
  await ctx.route(/api\/unified\/(people|groups)(\?.*)?$/, async route => {
    const r = await route.fetch(); const body = await r.json(); const key = /groups/.test(route.request().url()) ? 'groups' : 'people';
    const target = body.result || body; target[key] = fake[key];
    route.fulfill({response: r, body: JSON.stringify(body)});
  });

  // Ana's thread holds one incoming 4 s voice note, served as a real WAV.
  const sr = 16000, n = sr * 4, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / sr)), 44 + i * 2);
  const note = {id: '$v1', sender: 'Ana', outgoing: false, original: '', msgtype: 'm.audio', media: {voice: true, duration: 4000, mimetype: 'audio/wav'}, timestamp: now, reactions: {}};
  await ctx.route(/api\/unified\/people\/p1\?limit=60$/, route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {person: fake.people[0], messages: [note], has_more: false, seq: 1}})}));
  await ctx.route(/api\/unified\/people\/p1\/read$/, route => route.fulfill({status: 200, contentType: 'application/json', body: '{"ok":true,"result":{}}'}));
  await ctx.route(/api\/unified\/media\/%24v1/, route => route.fulfill({status: 200, contentType: 'audio/wav', body: wav}));
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const ticket = JSON.parse(execSync(`curl -s -X POST -H "Authorization: Bearer ${process.env.MESSENGER_API_TOKEN}" -H 'Content-Type: application/json' -d '{"bootstrap":true}' http://127.0.0.1:19252/api/view/ticket`)).result.ticket;
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(2000);
  await page.locator('#setup-form:visible, #inbox-tabs:visible').first().waitFor({timeout: 60000});
  if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.locator('#confirm-passphrase').waitFor({state: 'visible', timeout: 30000});
  await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet').catch(() => {});
  await page.click('#inbox-tabs [data-tab="people"]');
  await page.locator('.u-person', {hasText: 'Ana'}).click();
  const voice = page.locator('.u-voice').first(); await voice.waitFor({timeout: 15000});

  // (1) Speed pill appears while playing; taps cycle 1x -> 1.5x -> 2x and stick.
  assert.equal(await page.locator('.u-speed').isVisible(), false, 'pill hidden until playing');
  await voice.locator('.u-vplay').click();
  await page.waitForFunction(() => document.querySelector('.u-voice.playing'), null, {timeout: 10000});
  const pill = voice.locator('.u-speed'); await pill.waitFor({state: 'visible'});
  assert.equal(await pill.textContent(), '1×');
  await pill.click(); assert.equal(await pill.textContent(), '1.5×');
  await page.waitForTimeout(300); await page.screenshot({path: ev + '/speed.png'});
  assert.ok(await page.locator('.u-voice.playing').count(), 'still playing after speed change');
  await pill.click(); assert.equal(await pill.textContent(), '2×');
  assert.equal(await page.evaluate(() => localStorage.getItem('messenger.voice.rate')), '2');
  // 4 s at 2x ends in ~2 s.
  await page.waitForFunction(() => !document.querySelector('.u-voice.playing'), null, {timeout: 4500});

  // (2) A draft left in a chat no longer holds a Wizard update; reloading comes back on the same chat with the draft.
  await page.locator('.u-composer textarea').fill('half a thought');
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => (window.__holds || []).filter(h => !h.released).map(h => h.reason)); 
  assert.ok(!open.some(r => /unified|sending|saving|recording/i.test(r)), 'a chat draft holds no update: ' + open); // (a half-typed account setup on the locked Messenger tab still may)
  await page.evaluate(() => { window.__before = 1; }); await page.reload();
  await page.waitForFunction(() => !window.__before, null, {timeout: 15000});
  await page.locator('.u-voice').first().waitFor({timeout: 20000});
  assert.equal(await page.locator('#inbox-tabs [data-tab="people"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.u-speed').first().textContent(), '2×', 'speed choice survives the reload');
  assert.equal(await page.locator('.u-composer textarea').inputValue(), 'half a thought', 'draft survives the reload');
  await page.screenshot({path: ev + '/after-reload.png'});
  console.log(JSON.stringify({errors})); assert.deepEqual(errors, []);
  await browser.close(); console.log('pass');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
