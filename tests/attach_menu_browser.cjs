// Issue 285: + in a chat's composer (and in the Agent chat) used to open one bare file input, which an Android
// WebView turns straight into the photo gallery: no camera, no files. Now + opens a small attach menu like
// Telegram's paperclip (Camera on touch screens, Photo or video, File), and each item opens the matching picker.
// Synthetic API, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/attach_menu_browser.cjs [outdir]
// STATIC_DIR=<other checkout>/static BEFORE=1 runs the first steps against another build (for a before screenshot).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'attach-menu-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', avatar: null, identities: [{id: 'ann-i', network: 'whatsapp', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
  low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const switches = [{id: 'agent-chat', name: 'Agent chat', description: 'x', on: true, default: false, tried: false, vote: null, issues: ['humanitylabs-org/wizard-messenger#265']}];

async function open(browser, label, phone) {
  const viewport = phone ? {width: 390, height: 844} : {width: 1280, height: 800};
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: phone, isMobile: phone});
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
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) return ok({entries: [], unread: 0, urgent: false, reports_unread: 0, sweep_open: false, read_at: 0});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: [{id: '$hi', identity_id: 'ann-i', network: 'whatsapp', sender: 'Ann Lee', outgoing: false, original: 'Hi', msgtype: 'm.text', timestamp: now - min, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p === 'api/drafts') return ok({drafts: []});
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().waitFor({timeout: 20000});
  return {ctx, page, errors, shot: name => page.screenshot({path: path.join(out, `${label}-${name}.png`)})};
}

// Taps the menu item and returns what the picker was asked for.
async function choose(page, button, item) {
  await button.click();
  const menu = page.locator('.u-menu.u-attach-menu');
  await menu.waitFor({timeout: 5000});
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', {timeout: 5000}), menu.getByRole('menuitem', {name: item, exact: true}).click()]);
  const input = chooser.element();
  const got = {multiple: chooser.isMultiple(), accept: await input.getAttribute('accept'), capture: await input.getAttribute('capture')};
  assert.equal(await menu.count(), 0, item + ': the menu closes once a choice is made');
  return got;
}

(async () => {
  const browser = await chromium.launch(), result = {};
  if (process.env.BEFORE) {
    const {ctx, page, shot} = await open(browser, 'before', true);
    await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click();
    await page.locator('.u-row[data-id="$hi"]').waitFor({timeout: 15000});
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', {timeout: 5000}), page.locator('.u-composer .u-attach').click()]);
    result.before = {menu: await page.locator('.u-menu').count(), accept: await chooser.element().getAttribute('accept'), capture: await chooser.element().getAttribute('capture')};
    await shot('plus-tapped');
    await ctx.close(); await browser.close();
    console.log(JSON.stringify(result, null, 2)); return;
  }

  // Phone, a normal chat.
  {
    const {ctx, page, errors, shot} = await open(browser, 'phone', true);
    await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click();
    await page.locator('.u-row[data-id="$hi"]').waitFor({timeout: 15000});
    const plus = page.locator('.u-composer .u-attach');
    assert.equal(await plus.getAttribute('aria-haspopup'), 'menu');
    await plus.click();
    const menu = page.locator('.u-menu.u-attach-menu'); await menu.waitFor({timeout: 5000});
    result.phoneItems = await menu.getByRole('menuitem').allInnerTexts();
    assert.deepEqual(result.phoneItems.map(s => s.trim()), ['Camera', 'Photo or video', 'File']);
    const box = await menu.boundingBox(), plusBox = await plus.boundingBox();
    assert.ok(box.y + box.height <= plusBox.y + 1, 'the menu opens above the composer, not over it');
    await shot('menu');
    // An outside tap closes it and opens nothing.
    let opened = 0; page.on('filechooser', () => { opened++; });
    await page.mouse.click(200, 200); await page.waitForTimeout(600);
    assert.equal(await menu.count(), 0, 'an outside tap closes the menu'); assert.equal(opened, 0);
    result.phoneCamera = await choose(page, plus, 'Camera');
    assert.deepEqual(result.phoneCamera, {multiple: false, accept: 'image/*', capture: 'environment'});
    result.phonePhoto = await choose(page, plus, 'Photo or video');
    assert.deepEqual(result.phonePhoto, {multiple: true, accept: 'image/*,video/*', capture: null});
    result.phoneFile = await choose(page, plus, 'File');
    assert.deepEqual(result.phoneFile, {multiple: true, accept: '*/*', capture: null});
    // What a picked file does next (tray, photo or file) is unchanged; paste_photo and file_caption_send cover it.
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // Desktop: no Camera (no touch screen).
  {
    const {ctx, page, errors, shot} = await open(browser, 'desktop', false);
    await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click();
    await page.locator('.u-row[data-id="$hi"]').waitFor({timeout: 15000});
    const plus = page.locator('.u-composer .u-attach');
    await plus.click();
    const menu = page.locator('.u-menu.u-attach-menu'); await menu.waitFor({timeout: 5000});
    result.desktopItems = (await menu.getByRole('menuitem').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(result.desktopItems, ['Photo or video', 'File']);
    await shot('menu');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    assert.equal(await menu.count(), 0, 'Escape closes the menu');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // Phone, the Agent chat: photos and voice notes only.
  {
    const {ctx, page, errors, shot} = await open(browser, 'agent', true);
    await page.locator('.u-agent-row[data-mode="chat"]').click();
    await page.locator('.u-thread-head.u-agent-head').waitFor({timeout: 5000});
    const plus = page.locator('.u-ac-attach');
    await plus.click();
    const menu = page.locator('.u-menu.u-attach-menu'); await menu.waitFor({timeout: 5000});
    result.agentItems = (await menu.getByRole('menuitem').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(result.agentItems, ['Camera', 'Photo', 'Voice note file']);
    await shot('menu');
    await page.mouse.click(200, 200); await page.waitForTimeout(600);
    result.agentCamera = await choose(page, plus, 'Camera');
    assert.deepEqual(result.agentCamera, {multiple: false, accept: 'image/*', capture: 'environment'});
    result.agentPhoto = await choose(page, plus, 'Photo');
    assert.deepEqual(result.agentPhoto, {multiple: true, accept: 'image/*', capture: null});
    result.agentFile = await choose(page, plus, 'Voice note file');
    assert.deepEqual(result.agentFile, {multiple: true, accept: 'audio/*', capture: null});
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(result, null, 2));
  console.log('attach menu: ok');
})().catch(e => { console.error(e); process.exit(1); });
