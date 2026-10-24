// Signal MVP browser proof on the disposable preview (390x844, dark). Saves screenshots + timings.
const {chromium} = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const browser = await chromium.launch({headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: false, permissions: ['microphone']});
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) bad.push(r.status() + ' ' + r.url()); });
  const t = {}; const tag = ' #' + Date.now().toString(36); const mark = (k, s) => t[k] = Date.now() - s;
  const shot = n => page.screenshot({path: ev + '/' + n + '.png'});
  let s = Date.now();
  await page.goto(base);
  // A fresh preview first asks for a passphrase; create one (disposable).
  const setup = page.locator('#setup-form');
  await Promise.race([page.locator('.u-person').first().waitFor({timeout: 30000}), setup.waitFor({state: 'visible', timeout: 30000})]);
  if (await setup.isVisible()) {
    const pw = 'preview-only-passphrase-' + Date.now();
    await page.fill('#passphrase', pw); if (await page.locator('#confirm-passphrase').isVisible()) await page.fill('#confirm-passphrase', pw);
    await page.click('#setup-submit');
    await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
    await page.keyboard.press('Escape').catch(() => {});
    if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet').catch(() => {});
  }
  s = Date.now();
  await page.locator('.u-person').first().waitFor({timeout: 30000}); mark('chat_list', s);
  await shot('01-chats');
  const rows = await page.locator('.u-person .u-chat-top strong').allTextContents();
  assert.ok(rows.includes('Ben Carter'), 'Ben in chat list: ' + rows);
  // Open thread
  s = Date.now();
  await page.locator('.u-person').filter({hasText: 'Ben Carter'}).first().click();
  await page.locator('.u-row').first().waitFor(); mark('open_thread', s);
  await page.locator('.u-media img.in').first().waitFor({timeout: 15000}).catch(() => {}); mark('photo_visible', s);
  await shot('02-thread');
  // Send text: optimistic bubble appears immediately, then confirms
  await page.fill('.u-field textarea', 'Signal-speed test message' + tag);
  s = Date.now();
  await page.locator('.u-send').click();
  await page.locator('.u-message.outgoing').filter({hasText: 'Signal-speed test message' + tag}).first().waitFor(); mark('send_bubble', s);
  await page.locator('.u-message.outgoing:not(.pending)').filter({hasText: 'Signal-speed test message' + tag}).first().waitFor({timeout: 15000}); mark('send_confirmed', s);
  // Long-press menu → react
  const target = page.locator('.u-row .u-message:not(.pending)').filter({hasText: 'Signal-speed test message' + tag}).first();
  const targetRow = page.locator('.u-row').filter({hasText: 'Signal-speed test message' + tag}).first();
  await target.click({button: 'right'});
  await page.locator('.u-menu').waitFor(); await shot('03-menu');
  s = Date.now();
  await page.locator('.u-quick .u-qr-btn').filter({hasText: '👍'}).click();
  await targetRow.locator('.u-react.mine').waitFor(); mark('react', s);
  // Reply via menu
  await target.click({button: 'right'}); await page.locator('.u-act').filter({hasText: 'Reply'}).click();
  await page.locator('.u-bar .u-quote').waitFor();
  await page.fill('.u-field textarea', 'Replying to that' + tag);
  await page.keyboard.press('Enter');
  await page.locator('.u-row.outgoing').filter({hasText: 'Replying to that' + tag}).locator('.u-quote').first().waitFor();
  await page.locator('.u-message.outgoing:not(.pending)').filter({hasText: 'Replying to that' + tag}).first().waitFor({timeout: 15000});
  // Edit own message
  const mine = page.locator('.u-message.outgoing').filter({hasText: 'Signal-speed test message' + tag}).first();
  await mine.click({button: 'right'}); await page.locator('.u-act').filter({hasText: 'Edit'}).click();
  await page.fill('.u-field textarea', 'Signal-speed test message (edited)' + tag); await page.keyboard.press('Enter');
  await page.locator('.u-message.outgoing').filter({hasText: '(edited)' + tag}).locator('.u-edited').waitFor({timeout: 10000});
  // Photo send
  s = Date.now();
  await page.locator('.u-composer input[type=file]').setInputFiles(process.env.PHOTO);
  await page.locator('.u-attach-chip img').waitFor();
  await page.fill('.u-field textarea', 'Sunset');
  await page.locator('.u-send').click();
  await page.locator('.u-row.outgoing .u-media').last().waitFor();
  await page.locator('.u-row.outgoing .u-message:not(.pending) .u-media').last().waitFor({timeout: 20000}); mark('photo_send_confirmed', s);
  // Voice note record (fake mic) → send
  s = Date.now();
  await page.locator('.u-mic').click();
  await page.locator('.u-recording').waitFor(); await page.waitForTimeout(1800); await shot('04-recording');
  await page.locator('.u-recording .u-send').click();
  await page.locator('.u-row.outgoing .u-message:not(.pending) .u-voice').last().waitFor({timeout: 20000}); mark('voice_send_confirmed', s);
  await page.locator('.u-row.outgoing .u-voice .u-vplay').last().click();
  await page.locator('.u-voice.playing .u-wave i.on').first().waitFor({timeout: 5000}); // playback progresses
  await page.locator('.u-row.outgoing .u-voice').last().screenshot({path: ev + '/10-voice-playing.png'});
  // Photo viewer + Back closes viewer, then thread
  await page.locator('.u-row .u-message:not(.pending) .u-media').last().click();
  await page.locator('.u-viewer img').waitFor(); await shot('05-viewer');
  await page.goBack(); await page.locator('.u-viewer').waitFor({state: 'detached'});
  assert.equal(await page.locator('.u-timeline').count(), 1, 'Back closes viewer only');
  await page.locator('.u-timeline').evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(300);
  await shot('06-thread-after');
  // Incoming live: another device writes; the change feed delivers without reload
  await page.goBack(); await page.locator('.u-person').first().waitFor();
  assert.equal(await page.locator('.u-timeline').count(), 0, 'second Back leaves thread');
  await shot('07-chats-after');
  // Load-older: open Ben again (cached) and scroll to top
  s = Date.now();
  await page.locator('.u-person').filter({hasText: 'Ben Carter'}).first().click();
  await page.locator('.u-row').first().waitFor(); mark('reopen_cached', s);
  for (let i = 0; i < 12 && !(await page.locator('.u-message').filter({hasText: 'Older message 1 from'}).count()); i++) { await page.locator('.u-timeline').evaluate(el => el.scrollTop = 0); await page.waitForTimeout(400); }
  await page.locator('.u-message').filter({hasText: 'Older message 1 from'}).first().waitFor({timeout: 5000});
  if (process.env.LIVE_CMD) {
    // Another device writes to this chat; the change feed must paint it without any reload.
    await page.locator('.u-timeline').evaluate(el => el.scrollTop = el.scrollHeight);
    const live = 'Live from another device' + tag;
    s = Date.now();
    require('node:child_process').execSync(process.env.LIVE_CMD.replace('%TEXT%', live));
    const sent = Date.now();
    await page.locator('.u-message').filter({hasText: live}).first().waitFor({timeout: 15000}); t.live_incoming_after_send = Date.now() - sent;
  }
  await page.goBack();
  await page.getByRole('button', {name: 'Groups', exact: true}).click();
  await page.locator('.u-person').first().waitFor(); await shot('08-groups');
  await page.locator('.u-person').first().click(); await page.locator('.u-row').first().waitFor(); await shot('09-group-thread');
  assert.ok(await page.locator('.u-sender').count() >= 1, 'group sender names');
  await page.goBack(); await page.getByRole('button', {name: 'Messenger', exact: true}).click();
  await page.locator('#workspace:visible, #gate:visible').first().waitFor(); await page.waitForTimeout(500); await shot('11-messenger-tab');
  assert.equal(await page.locator('#unified-inbox:visible').count(), 0, 'Messenger tab shows the private Marmot view');
  await page.getByRole('button', {name: 'Chats', exact: true}).click(); await page.locator('.u-person').first().waitFor();
  // Cold reload: time from navigation to a painted chat list.
  s = Date.now(); await page.reload(); await page.locator('.u-person').first().waitFor(); mark('cold_reload_to_list', s);
  // After reload the saved thread paints, the server copy replaces it, and sending still works.
  s = Date.now(); await page.locator('.u-person').filter({hasText: 'Ben Carter'}).first().click();
  await page.locator('.u-row').first().waitFor(); mark('reopen_after_reload', s);
  await page.fill('.u-field textarea', 'After reload' + tag); await page.locator('.u-send').click();
  await page.locator('.u-message.outgoing:not(.pending)').filter({hasText: 'After reload' + tag}).first().waitFor({timeout: 15000});
  if (process.env.LIVE_CMD) await page.locator('.u-message').filter({hasText: 'Live from another device' + tag}).first().waitFor({timeout: 10000});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
  const out = {pass: true, timings_ms: t, errors, bad_responses: bad};
  fs.writeFileSync(ev + '/proof.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
  await browser.close();
})().catch(async e => { console.error('FAIL', e.message, e.stack.split('\n').find(l => l.includes('signal_mvp_browser'))); process.exit(1); });
