// Issue 182: with "Tap beside a message for its menu" on, a finger tap on the empty space right of a received
// message opens that message's menu (photo, video, album: the media menu a hold opens; text: the text menu). A tap
// on the photo still opens the viewer, a drag from that space never opens a menu, own messages and selection mode
// are untouched. Off, the space does nothing, as before.
// Synthetic API only, no container and no shell: PLAYWRIGHT_MODULE=... node tests/row_tap_menu_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'row-tap-menu-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const base = (id, i, extra) => ({id, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (9 - i) * min, timeline_order: i + 1, reactions: [], ...extra});
const photo = (id, i) => base(id, i, {msgtype: 'm.image', media: {w: 800, h: 600, mime: 'image/jpeg', thumb: true}});
const MESSAGES = [
  photo('$photo', 0),
  base('$video', 1, {msgtype: 'm.video', media: {w: 800, h: 600, mime: 'video/mp4', thumb: true}}),
  {...photo('$a1', 2), album: 'alb', photos: [photo('$a1', 2), photo('$a2', 2)]},
  base('$text', 3, {msgtype: 'm.text', original: 'See you at six'}),
  base('$mine', 4, {msgtype: 'm.text', original: 'Sure', outgoing: true, sender: ''}),
];

async function run(browser, on) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'row-tap-menu', on}]})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: svg('#36a', 800, 600)});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  await page.locator('.u-row[data-id="$text"]').waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  const cdp = await ctx.newCDPSession(page);
  const menu = page.locator('.u-menu[role="menu"]');
  const items = async () => (await menu.locator('.u-act').allTextContents()).map(s => s.trim());
  const close = async () => { await page.keyboard.press('Escape'); await menu.waitFor({state: 'detached', timeout: 3000}); };
  // The middle of the empty space right of the bubble, inside the row.
  const besideOf = async id => {
    const row = page.locator(`.u-row[data-id="${id}"]`); await row.scrollIntoViewIfNeeded();
    const r = await row.boundingBox(), b = await row.locator('.u-message').boundingBox();
    assert.ok(r.x + r.width - (b.x + b.width) > 40, id + ' has empty space beside it');
    return {x: Math.round((b.x + b.width + r.x + r.width) / 2), y: Math.round(b.y + b.height / 2)};
  };
  const tapBeside = async id => { const {x, y} = await besideOf(id); await page.touchscreen.tap(x, y); await page.waitForTimeout(250); };
  const result = {on, menus: {}};
  for (const [id, want] of [['$photo', 'Select'], ['$video', 'Select'], ['$a1', 'Select'], ['$text', 'Select text']]) {
    await tapBeside(id);
    if (!on) { assert.equal(await menu.count(), 0, 'off: a tap beside ' + id + ' does nothing'); continue; }
    assert.equal(await menu.count(), 1, 'a tap beside ' + id + ' opens its menu');
    const got = await items(); result.menus[id] = got;
    assert.ok(got.includes('Reply') && got.includes(want), id + ' menu: ' + got);
    assert.equal(await page.locator('.u-quick').count(), 1, 'Telegram reactions on top');
    assert.equal(await page.locator(`.u-row.lifted[data-id="${id}"]`).count(), 1, 'it is the menu of ' + id);
    if (id === '$photo') await page.screenshot({path: path.join(out, 'on-photo-menu.png')});
    if (id === '$text') assert.ok(!got.includes('Select'), 'text gets the text menu: ' + got);
    await close();
  }
  if (on) {
    // Same as the hold menu on the photo.
    const box = await page.locator('.u-row[data-id="$photo"] .u-media').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await menu.waitFor({timeout: 3000});
    assert.deepEqual(await items(), result.menus.$photo, 'row tap and hold open the same photo menu');
    await close();
    // Own messages keep the space inert.
    const mine = page.locator('.u-row[data-id="$mine"]'), r = await mine.boundingBox(), mb = await mine.locator('.u-message').boundingBox();
    await page.touchscreen.tap(Math.round((r.x + mb.x) / 2), Math.round(mb.y + mb.height / 2)); await page.waitForTimeout(250);
    assert.equal(await menu.count(), 0, 'own message: nothing');
  }
  // A drag from the empty space scrolls and never opens a menu.
  const {x, y} = await besideOf('$video');
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
  for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y: y - i * 15}]}); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await page.waitForTimeout(300);
  assert.equal(await menu.count(), 0, 'a drag never opens the menu');
  // The photo itself still opens the viewer.
  await page.locator('.u-row[data-id="$photo"] .u-media').tap();
  const viewer = page.locator('.u-photo-view'); await viewer.waitFor({timeout: 5000});
  assert.equal(await menu.count(), 0, 'a photo tap opens the viewer, not the menu');
  await viewer.getByRole('button', {name: 'Close'}).click();
  if (on) {
    // Selection mode keeps its own tap: a tap beside a row toggles that row, no menu.
    await tapBeside('$photo');
    await menu.locator('.u-act', {hasText: /^Select$/}).tap();
    await page.locator('.u-selection:not([hidden])').waitFor({timeout: 3000});
    await tapBeside('$text');
    assert.equal(await menu.count(), 0, 'selecting: no menu');
    assert.equal(await page.locator('.u-row.u-selected[data-id="$text"]').count(), 1, 'selecting: the tap toggles the row as before');
    await page.screenshot({path: path.join(out, 'on-selecting.png')});
  }
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const on of [true, false]) summary.push(await run(browser, on));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
