// Issue 471 (switch full-reactions): any emoji as a reaction, like Telegram.
// On a fresh pickers stage (real ViewServer + UnifiedInbox, one Telegram chat Zoe, one WhatsApp chat Bram):
//   - switch off: the message menu's ＋ still shows the old 72-emoji grid and Messenger never asks for reaction rules;
//   - switch on (set through the box's own switches route): ＋ opens the full emoji panel (Search emoji, every
//     category); "zap" and "lightning" find ⚡; picking it sends an m.reaction with ⚡ and the bubble shows it;
//   - the next menu leads with ⚡ (most used) and the panel's Recent holds it;
//   - an outside tap and Back close the panel without leaving the chat (Escape too on a computer);
//   - a Telegram chat whose bridge lists only some reactions shows only those (quick row and panel; "zap" finds
//     nothing), and a reaction outside them is refused by the box with "Telegram only allows some reactions in this
//     chat": nothing is sent and no chip stays on the bubble.
// Run (fresh stage per viewport, each run reacts once):
//   AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python tests/pickers_stage.py <port> &
//   AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web VIEWPORT=phone|desktop node tests/full_reactions_browser.cjs
// SHOTS=<dir> writes off/on screenshots; OFF_ONLY=1 stops after the switch-off case.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), engine = pw[process.env.BROWSER || 'chromium'];
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR;
if (!dir) { console.error('AGENT_STAGE_DIR is required'); process.exit(2); }
const WEB = process.env.WIZARD_WEB_DIR;
if (!WEB) { console.error('WIZARD_WEB_DIR is required (the shared emoji set)'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const PHONE = (process.env.VIEWPORT || 'desktop') === 'phone';
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'};
// Zoe's Telegram chat lets only these through (a group with limited reactions).
const LIMITED = ['❤️', '👍', '👎', '😂', '😮', '😢', '🔥', '🎉', '💯'];
fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({'!zoe': [{type: 'com.beeper.room_features', state_key: 'fi.mau.telegram://telegram/9',
  content: {id: 'x', reaction: 2, reaction_count: 1, allowed_reactions: LIMITED}}]}));
const sends = () => fs.readFileSync(st.sends, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const reactionSends = () => sends().filter(x => /\/send\/m\.reaction\//.test(x.path));

(async () => {
  const browser = await engine.launch();
  const ctx = await browser.newContext(PHONE ? {viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true, deviceScaleFactor: 2} : {viewport: {width: 1280, height: 860}});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const f = path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
    return fs.existsSync(f) ? r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: fs.readFileSync(f)}) : r.fulfill({status: 404, body: ''});
  });
  const page = await ctx.newPage(), errors = [], rulesAsked = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/\/messages\/[^/]+\/reactions$/.test(new URL(r.url()).pathname)) rulesAsked.push(r.url()); });
  const tap = loc => PHONE ? loc.tap() : loc.click();
  const shot = async name => { if (SHOTS) await page.screenshot({path: path.join(SHOTS, name + '.png')}); };
  async function openChat(name) {
    if (PHONE && await page.locator('.u-thread-body').count()) { await page.evaluate(() => window.MessengerUnified.back()); await page.waitForTimeout(400); }
    await tap(page.locator('.u-person', {hasText: name}).first());
    await page.locator('.u-thread-body .u-message').first().waitFor();
    await page.waitForTimeout(500);
  }
  async function openMenu() {
    const bubble = page.locator('.u-thread-body .u-message').first();
    if (PHONE) await bubble.tap(); else await bubble.click({button: 'right'});
    await page.locator('.u-menu .u-quick').waitFor({timeout: 5000});
    await page.waitForTimeout(400); // the chat's reaction rules arrive
  }
  const quick = () => page.$$eval('.u-menu .u-quick .u-qr-btn:not(.more)', bs => bs.map(b => b.textContent));
  async function openFull() {
    await tap(page.locator('.u-menu .u-quick .more'));
    await page.locator('.u-menu .u-react-picker').waitFor({timeout: 5000});
    await page.waitForTimeout(400);
  }
  async function search(q) {
    const box = page.locator('.u-react-picker .u-pick-search');
    await box.fill(q); await page.waitForTimeout(400);
    return page.$$eval('.u-react-picker .u-emo', bs => bs.map(b => b.textContent));
  }
  const menuOpen = () => page.locator('#u-overlay').count();
  const inChat = async name => (await page.locator('.u-thread-body .u-message').count()) > 0 && (await page.locator('.u-thread-head, .u-head', {hasText: name}).count()) > 0;
  const setSwitch = on => page.evaluate(async on => {
    const r = await fetch('api/view/switches', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-Wizard-Switch': '1'}, body: JSON.stringify({id: 'full-reactions', on})});
    return r.status;
  }, on);

  await page.goto(st.origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});

  // Switch off: nothing changes.
  await openChat('Zoe'); await openMenu();
  assert.deepEqual(await quick(), ['❤️', '👍', '👎', '😂', '😮', '😢']);
  await tap(page.locator('.u-menu .u-quick .more')); await page.waitForTimeout(300);
  assert.equal(await page.locator('.u-menu .u-grid .u-qr-btn').count(), 72, 'off: the old grid');
  assert.equal(await page.locator('.u-menu .u-react-picker, .u-menu .u-pick-search').count(), 0, 'off: no full panel');
  assert.equal(await page.locator('.u-menu .u-grid').getByText('⚡', {exact: true}).count(), 0);
  await shot('off');
  assert.equal(rulesAsked.length, 0, 'off: never asks the box for reaction rules');
  await page.keyboard.press('Escape'); await page.evaluate(() => window.MessengerUnified.back()); await page.waitForTimeout(300);
  if (await menuOpen()) await page.mouse.click(5, 5);
  console.log('ok switch off: old 72 grid, no rules asked');
  if (process.env.OFF_ONLY) { await browser.close(); return; }

  assert.equal(await setSwitch(true), 200);
  await page.reload(); await page.locator('.u-person').first().waitFor({timeout: 20000});

  // Any emoji on a chat whose network takes any (WhatsApp here).
  await openChat('Bram'); await openMenu();
  assert.deepEqual(await quick(), ['❤️', '👍', '👎', '😂', '😮', '😢'], 'no history: the usual six');
  await openFull();
  assert.ok(await page.locator('.u-react-picker .u-pick-search[placeholder="Search emoji"]').count(), 'Search emoji');
  const cats = await page.$$eval('.u-react-picker .u-emo-cat', bs => bs.map(b => b.getAttribute('aria-label')));
  for (const c of ['Smileys & People', 'Animals & Nature', 'Food & Drink', 'Activity', 'Travel & Places', 'Objects', 'Symbols', 'Flags']) assert.ok(cats.includes(c), 'category ' + c);
  assert.ok((await page.locator('.u-react-picker .u-emo').count()) > 200, 'the full set, not 72');
  assert.ok((await search('lightning')).includes('⚡'), 'lightning finds ⚡');
  assert.ok((await search('zap')).includes('⚡'), 'zap finds ⚡');
  const panelBox = await page.locator('.u-menu .u-react-picker').boundingBox(), vw = PHONE ? 412 : 1280, vh = 860;
  assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= vw && panelBox.y >= 0 && panelBox.y + panelBox.height <= vh, 'panel fits the screen ' + JSON.stringify(panelBox));
  await shot('on-search');
  await tap(page.locator('.u-react-picker .u-emo', {hasText: '⚡'}).first());
  await page.waitForTimeout(600);
  assert.equal(await menuOpen(), 0, 'the pick closes the menu');
  const sent = reactionSends();
  assert.equal(sent.length, 1); assert.equal(sent[0].body['m.relates_to'].key, '⚡'); assert.ok(sent[0].path.includes('%21bram'));
  assert.ok(await page.locator('.u-thread-body .u-reactions', {hasText: '⚡'}).count(), 'the bubble shows ⚡');
  await shot('on-reacted');
  console.log('ok ⚡ found by search, sent and shown');

  // Most used first; Recent holds it.
  await openMenu();
  assert.equal((await quick())[0], '⚡', 'the quick row leads with the most-used reaction');
  assert.equal((await quick()).length, 6);
  await openFull();
  const recent = await page.$$eval('.u-react-picker .u-pick-head', hs => { const h = hs.find(x => x.textContent === 'Recent'); return h ? [...h.nextElementSibling.children].map(b => b.textContent) : null; });
  assert.ok(recent && recent.includes('⚡'), 'Recent holds ⚡ ' + JSON.stringify(recent));
  const composerUsage = await page.evaluate(() => JSON.parse(localStorage.getItem('messenger-emoji-usage-v1') || '{}'));
  assert.ok(composerUsage['⚡'], 'the composer ranking has it too');
  await shot('on-panel');
  console.log('ok most-used first, Recent');

  // Outside tap closes it, the chat stays.
  const tb = await page.locator('.u-menu .u-react-picker').boundingBox();
  const outside = tb.y > 120 ? {x: 20, y: 60} : {x: 20, y: vh - 40};
  if (PHONE) await page.touchscreen.tap(outside.x, outside.y); else await page.mouse.click(outside.x, outside.y);
  await page.waitForTimeout(500);
  assert.equal(await menuOpen(), 0, 'outside tap closes'); assert.ok(await page.locator('.u-thread-body .u-message').count(), 'still in the chat');
  await page.waitForTimeout(500);
  // Back closes it, the chat stays.
  await openMenu(); await openFull();
  const handled = await page.evaluate(() => { const u = window.MessengerUnified; const can = u.canGoBack(); u.back(); return can; });
  await page.waitForTimeout(400);
  assert.ok(handled); assert.equal(await menuOpen(), 0, 'Back closes'); assert.ok(await page.locator('.u-thread-body .u-message').count(), 'Back stays in the chat');
  if (!PHONE) {
    await openMenu(); await openFull();
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.equal(await menuOpen(), 0, 'Escape closes'); assert.ok(await page.locator('.u-thread-body .u-message').count());
  }
  console.log('ok outside tap / Back close without leaving the chat');

  // A Telegram chat that allows only some reactions.
  await openChat('Zoe'); await openMenu();
  const zq = await quick();
  assert.ok(!zq.includes('⚡') && zq.every(k => LIMITED.includes(k)) && zq.length === 6, 'quick row only allowed ones ' + zq);
  await openFull();
  const shown = await page.$$eval('.u-react-picker .u-emo', bs => [...new Set(bs.map(b => b.textContent))]);
  assert.ok(shown.length > 0 && shown.every(k => LIMITED.map(x => x.replace(/\uFE0F/g, '')).includes(k.replace(/\uFE0F/g, ''))), 'only the allowed set ' + shown);
  assert.deepEqual(await search('zap'), [], 'zap finds nothing here');
  assert.ok(await page.locator('.u-react-picker .u-pick-empty').count());
  await shot('on-limited');
  await page.evaluate(() => window.MessengerUnified.back()); await page.waitForTimeout(300);
  console.log('ok limited chat shows only its reactions');

  // A view that doesn't know the rules yet (older answer) still can't send one the network refuses.
  await page.route('**/messages/*/reactions', r => r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({reactions: true, allowed: null, custom: false, network: 'Telegram'})}));
  await page.evaluate(() => window.MessengerUnified.back()); await page.waitForTimeout(200);
  await page.reload(); await page.locator('.u-person').first().waitFor({timeout: 20000});
  await openChat('Zoe'); await openMenu(); await openFull();
  await search('zap');
  const before = reactionSends().length;
  await tap(page.locator('.u-react-picker .u-emo', {hasText: '⚡'}).first());
  await page.getByText('Telegram only allows some reactions in this chat').first().waitFor({timeout: 5000});
  await page.waitForTimeout(500);
  assert.equal(reactionSends().length, before, 'nothing sent');
  assert.equal(await page.locator('.u-thread-body .u-reactions', {hasText: '⚡'}).count(), 0, 'no ⚡ chip stays');
  await shot('on-refused');
  console.log('ok refused reaction: plain message, not shown as sent');

  assert.deepEqual(errors.filter(e => !/ResizeObserver loop/.test(e)), []);
  await setSwitch(false);
  await browser.close();
  console.log('PASS', PHONE ? 'phone' : 'desktop');
})().catch(e => { console.error(e); process.exit(1); });
