// Tab badges proof on a FRESH disposable preview: Chats, Groups and Messenger tabs each show their own unread
// count, and the desk badge is their sum. Chats/Groups rows are injected into the real API responses (the fresh
// preview has no bridged chats); the Messenger tab count is reported through its real hook.
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
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v, back: v.back, update: v.update, capture: v.capture, vault: {has: async () => ({available: false, saved: false})}, badge: {set: n => { window.__badges = (window.__badges || []).concat(n); return Promise.resolve(true); }}}); }});
  });
  const now = Date.now() / 1000;
  const person = (id, name, unread, group) => ({id, display_name: name, unread, identities: [{kind: group ? 'group' : 'telegram', id}], last: {text: 'hello', timestamp: now}, labels: []});
  const fake = {people: [person('p1', 'Ana', 3), person('p2', 'Ben', 2), person('p3', 'Cy', 0)], groups: [person('g1', 'Climbing', 4, true), person('g2', 'Family', 0, true)]};
  await ctx.route(/api\/unified\/(people|groups)(\?.*)?$/, async route => {
    const r = await route.fetch(); const body = await r.json(); const key = /groups/.test(route.request().url()) ? 'groups' : 'people';
    const target = body.result || body; target[key] = fake[key];
    route.fulfill({response: r, body: JSON.stringify(body)});
  });
  const posted = [];
  await ctx.route(/api\/unified\/people\/p1$/, async route => { if (route.request().method() !== 'POST') return route.continue(); posted.push(route.request().postDataJSON()); route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {id: 'p1'}})}); });
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
  const tab = t => page.locator(`#inbox-tabs [data-tab="${t}"] .tab-badge`);
  await tab('people').waitFor({timeout: 20000});
  await page.waitForFunction(() => document.querySelector('#inbox-tabs [data-tab="groups"] .tab-badge'), null, {timeout: 20000});
  assert.equal(await tab('people').textContent(), '5');
  assert.equal(await tab('groups').textContent(), '4');
  assert.equal(await tab('messenger').count(), 0, 'nothing unread in Messenger: no badge');
  await page.evaluate(() => window.MessengerUnified.setNativeUnread(2));
  assert.equal(await tab('messenger').textContent(), '2');
  assert.equal(await page.evaluate(() => window.__badges.at(-1)), 11, 'desk badge = all three tabs');
  assert.match(await page.locator('#inbox-tabs [data-tab="groups"]').getAttribute('aria-label'), /4 unread/);
  await page.screenshot({path: ev + '/tab-badges.png'});
  // Long-press Ana -> Mute: her 3 leave the Chats tab and desk counts, her own badge turns gray.
  const ana = page.locator('.u-person', {hasText: 'Ana'});
  const box = await ana.boundingBox();
  // A real finger: CDP touch events, held still for 800 ms, like a phone long-press.
  const cdp = await ctx.newCDPSession(page); const pt = [{x: box.x + 120, y: box.y + 30}];
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: pt}); await page.waitForTimeout(800);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  assert.equal(await page.evaluate(() => String(getSelection())), '', 'long-press selects no text');
  await page.locator('.u-menu[aria-label="Ana"]').waitFor({timeout: 5000});
  assert.equal(await page.locator('.u-timeline').count(), 0, 'long-press does not open the chat');
  await page.screenshot({path: ev + '/mute-menu.png'});
  await page.getByRole('menuitem', {name: 'Mute'}).click();
  await page.locator('.u-toast', {hasText: 'Muted'}).waitFor({timeout: 5000});
  assert.deepEqual(posted, [{muted: true}]);
  assert.equal(await tab('people').textContent(), '2', 'muted chat leaves the Chats tab count');
  assert.equal(await page.evaluate(() => window.__badges.at(-1)), 8, 'and the desk badge');
  assert.equal(await ana.locator('.u-badge.muted').textContent(), '3', 'muted chat keeps a gray badge');
  assert.equal(await ana.locator('.u-muted-mark').count(), 1);
  const gray = await ana.locator('.u-badge').evaluate(e => getComputedStyle(e).backgroundColor);
  const blue = await page.locator('.u-person', {hasText: 'Ben'}).locator('.u-badge').evaluate(e => getComputedStyle(e).backgroundColor);
  assert.notEqual(gray, blue);
  await page.waitForTimeout(1700); await page.screenshot({path: ev + '/muted.png'});
  // Right-click (desktop) -> Unmute brings it back.
  await ana.click({button: 'right'}); await page.getByRole('menuitem', {name: 'Unmute'}).click();
  assert.equal(await tab('people').textContent(), '5');
  assert.deepEqual(posted, [{muted: true}, {muted: false}]);
  await page.evaluate(() => window.MessengerUnified.setNativeUnread(0));
  assert.equal(await tab('messenger').count(), 0, 'badge leaves at zero');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({badges: await page.evaluate(() => window.__badges)})); console.log('pass'); await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
