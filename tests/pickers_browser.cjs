// Composer Emoji / GIFs / Stickers panel (Miguel, 5 Nov 2026: "I don't know how to send emojis. Please add an emoji
// picker and GIF picker and sticker picker"). Staged by tests/pickers_stage.py (real ViewServer + UnifiedInbox send
// path; the Telegram bridge's picker routes and Matrix are mocked, every Matrix send lands in sends.jsonl).
// Checks on Dark / Light / Landscapes light at 390 (touch) and 1280 (mouse):
//  - one smiley button sits inside the message box; it opens a panel with Emoji / GIFs / Stickers tabs in a Telegram
//    chat and Emoji only in a WhatsApp chat; Escape (desktop) closes it;
//  - an emoji goes in at the caret (not the end) and stays a draft (nothing is sent); Recent then leads with it;
//  - emoji search uses Wizard's shared emoji set (WosTopicEmoji) when the shell serves it;
//  - a GIF tap sends ONE m.room.message m.video with fi.mau.gif and the prepared mxc, through people/<id>/send {pick};
//  - a sticker (Recent and from a pack) sends ONE m.sticker carrying fi.mau.bridged_sticker; both render in the thread;
//  - nothing overflows sideways, no page errors.
// AGENT_STAGE_DIR=<dir> python3 tests/pickers_stage.py <port> &  then  node tests/pickers_browser.cjs [outdir]
// SHOTS=<dir> also writes panel screenshots per skin and width.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/pickers-stage';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const out = path.resolve(process.argv[2] || process.env.EVIDENCE_DIR || dir); fs.mkdirSync(out, {recursive: true});
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR;
const P = {
  dark: {scheme: 'dark', bg: '#000000', ink: '#f7f7f7', ink2: '#c4c4c4', ink3: '#8a8a8a', line2: 'rgba(255,255,255,.26)', accent: '#ffffff', on: '#000000', glass: '#141414'},
  light: {scheme: 'light', bg: '#ffffff', ink: '#000000', ink2: '#2e2e2e', ink3: '#6b6b6b', line2: 'rgba(0,0,0,.32)', accent: '#000000', on: '#ffffff', glass: '#f0f0f0'},
  'landscapes-light': {scheme: 'light', bg: '#EEF1F4', ink: '#111216', ink2: 'rgba(17,18,22,.76)', ink3: 'rgba(17,18,22,.54)', line2: 'rgba(0,0,0,.26)', accent: '#5B3FE6', on: '#ffffff', glass: 'linear-gradient(160deg,#cfd8e3,#eef1f4 55%,#e6dccf)'},
};
const tokens = p => ({canvas: 'transparent', base: p.bg, surface: `color-mix(in srgb, ${p.ink} 6%, transparent)`, 'surface-raised': `color-mix(in srgb, ${p.ink} 10%, transparent)`,
  text: p.ink, 'text-secondary': p.ink2, 'text-muted': p.ink3, border: p.line2, accent: p.accent, 'accent-soft': `color-mix(in srgb, ${p.accent} 16%, transparent)`, 'on-accent': p.on});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'};
const sends = () => fs.readFileSync(st.sends, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.method === 'PUT' && /\/send\//.test(x.path));

async function setup(browser, p, viewport) {
  const phone = viewport.width < 640;
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: p.scheme, ...(phone ? {isMobile: true, hasTouch: true} : {})});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const u = new URL(r.request().url());
    if (!WEB) return r.continue({url: 'http://127.0.0.1:8796' + u.pathname});
    const f = path.join(WEB, u.pathname.replace(/^\/wizard-os-home\//, ''));
    if (!fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
    return r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
  });
  await ctx.addInitScript(([scheme, t, glass]) => {
    const mark = () => {
      const r = document.documentElement; if (!r) return false;
      r.dataset.wzHosted = ''; r.dataset.colorScheme = scheme; r.style.colorScheme = scheme;
      for (const [k, v] of Object.entries(t)) r.style.setProperty('--wz-' + k, v);
      r.style.background = glass; return true;
    };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    // The Mac app has no JS panels: any confirm/alert/prompt would silently fail there.
    window.__panels = 0; window.confirm = () => { window.__panels++; return false; }; window.alert = () => { window.__panels++; }; window.prompt = () => { window.__panels++; return null; };
  }, [p.scheme, tokens(p), p.glass]);
  const page = await ctx.newPage(), errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/send$/.test(new URL(r.url()).pathname)) posts.push(r.postDataJSON()); });
  await page.goto(st.origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  return {ctx, page, errors, posts, phone};
}
const tap = (t, loc, o) => t.phone ? loc.tap(o) : loc.click(o);
async function open(t, name) {
  const {page} = t;
  if (await page.locator('.u-thread-body').count() && t.phone) { await tap(t, page.locator('.u-back').first()); await page.locator('.u-person').first().waitFor(); }
  await tap(t, page.locator('.u-person', {hasText: name}).first());
  await page.locator('.u-thread-body .u-row').first().waitFor();
  await page.locator('.u-composer .u-pick-btn').waitFor({timeout: 5000});
  await page.waitForTimeout(600);
}
const tabs = page => page.locator('.u-picker .u-pick-tab').allInnerTexts();
async function openPanel(t) {
  const {page} = t;
  if (!(await page.locator('.u-picker:not([hidden])').count())) await tap(t, page.locator('.u-composer .u-pick-btn'));
  await page.locator('.u-picker:not([hidden])').waitFor({timeout: 3000});
}
async function waitSends(n0, n, tag) {
  for (let i = 0; i < 60 && sends().length < n0 + n; i++) await new Promise(r => setTimeout(r, 100));
  const got = sends().slice(n0);
  assert.equal(got.length, n, `${tag}: ${n} Matrix send(s)`);
  return got;
}
const shot = async (page, name) => { if (!SHOTS) return; await page.mouse.move(2, 2).catch(() => {}); await page.waitForTimeout(350); await page.screenshot({path: path.join(SHOTS, name)}); };

(async () => {
  const browser = await chromium.launch();
  for (const [skin, p] of Object.entries(P)) for (const viewport of [{width: 390, height: 844}, {width: 1280, height: 860}]) {
    const tag = skin + '-' + viewport.width;
    const t = await setup(browser, p, viewport), {ctx, page, errors, posts} = t;
    // WhatsApp chat: Emoji only.
    await open(t, 'Bram');
    const btn = page.locator('.u-composer .u-pick-btn');
    assert.equal(await btn.count(), 1, tag + ' one picker button in the box');
    const inField = await page.evaluate(() => { const b = document.querySelector('.u-pick-btn').getBoundingClientRect(), f = document.querySelector('.u-field textarea').getBoundingClientRect(); return b.left >= f.left - 1 && b.right <= f.right + 1 && b.top >= f.top - 1 && b.bottom <= f.bottom + 1; });
    assert.ok(inField, tag + ' button sits inside the message box');
    await openPanel(t);
    assert.deepEqual(await tabs(page), ['Emoji'], tag + ' WhatsApp: Emoji only');
    await tap(t, btn); await page.waitForTimeout(150);
    assert.equal(await page.locator('.u-picker:not([hidden])').count(), 0, tag + ' button toggles the panel closed');

    // Telegram chat: three tabs; emoji goes in at the caret.
    await open(t, 'Zoe');
    const box = page.locator('.u-composer textarea');
    await tap(t, box); await box.fill('Hello world'); await box.evaluate(e => e.setSelectionRange(5, 5));
    await openPanel(t);
    assert.deepEqual(await tabs(page), ['Emoji', 'GIFs', 'Stickers'], tag + ' Telegram tabs');
    await page.locator('.u-picker .u-emo-grid .u-emo').nth(10).waitFor();
    const emoCount = await page.locator('.u-picker .u-emo').count();
    if (WEB) assert.ok(emoCount > 500, `${tag} full shared emoji set (${emoCount})`);
    await shot(page, `picker-emoji-${tag}.png`);
    const smile = page.locator('.u-picker .u-emo', {hasText: '😂'}).first();
    await tap(t, smile);
    assert.equal(await box.inputValue(), 'Hello😂 world', tag + ' emoji inserted at the caret');
    await page.locator('.u-picker .u-pick-tab', {hasText: 'Emoji'}).first().evaluate(e => e.click());
    await page.waitForTimeout(150);
    assert.equal((await page.locator('.u-picker .u-pick-head').first().innerText()).trim(), 'Recent', tag + ' Recent first');
    assert.equal((await page.locator('.u-picker .u-emo-grid').first().locator('.u-emo').first().innerText()).trim(), '😂', tag + ' recent emoji leads');
    if (WEB) {
      await page.locator('.u-picker .u-pick-search').fill('pizza'); await page.waitForTimeout(200);
      assert.ok((await page.locator('.u-picker .u-emo').allInnerTexts()).includes('🍕'), tag + ' emoji search finds 🍕');
      await page.locator('.u-picker .u-pick-search').fill('');
    }
    assert.equal(posts.length, 0, tag + ' an emoji never sends');

    // GIFs: saved list, tap sends m.video fi.mau.gif.
    await tap(t, page.locator('.u-picker .u-pick-tab', {hasText: 'GIFs'}));
    await page.locator('.u-picker .u-pick-tile.gif img').first().waitFor({timeout: 5000});
    assert.equal(await page.locator('.u-picker .u-pick-tile.gif').count(), 8, tag + ' saved GIFs listed');
    await page.waitForTimeout(400);
    await shot(page, `picker-gifs-${tag}.png`);
    await page.locator('.u-picker .u-pick-search').fill('cat');
    await page.waitForFunction(() => document.querySelectorAll('.u-picker .u-pick-tile.gif').length === 5, null, {timeout: 4000});
    assert.equal(await page.locator('.u-picker .u-pick-more').count(), 1, tag + ' More GIFs pages the search');
    let n0 = sends().length;
    await tap(t, page.locator('.u-picker .u-pick-tile.gif').first());
    assert.equal(await page.locator('.u-picker:not([hidden])').count(), 0, tag + ' panel closes on send');
    let got = await waitSends(n0, 1, tag + ' GIF');
    assert.match(got[0].path, /\/send\/m\.room\.message\//, tag + ' GIF is a room message');
    assert.equal(got[0].body.msgtype, 'm.video'); assert.equal(got[0].body.url, 'mxc://messenger.internal/gfull');
    assert.equal(got[0].body.info['fi.mau.gif'], true, tag + ' fi.mau.gif set so Telegram shows a GIF');
    assert.ok(posts.at(-1).pick && !posts.at(-1).text, tag + ' send carried the pick id');
    await page.locator('.u-row.outgoing .u-media.gif').last().waitFor({timeout: 5000});
    assert.equal(await box.inputValue(), 'Hello😂 world', tag + ' the typed text stays in the box');

    // Stickers: recent + favourites + packs; a sticker sends m.sticker with fi.mau.bridged_sticker.
    await openPanel(t);
    await tap(t, page.locator('.u-picker .u-pick-tab', {hasText: 'Stickers'}));
    await page.locator('.u-picker .u-pick-tile.sticker img').first().waitFor({timeout: 5000});
    assert.deepEqual(await page.locator('.u-picker .u-pick-head').allInnerTexts(), ['Recent', 'Favorites'], tag + ' recent + favourites');
    assert.deepEqual(await page.locator('.u-picker .u-pack').allInnerTexts(), ['Recent', 'Cats', 'Dogs'], tag + ' pack chips');
    await page.waitForTimeout(300);
    await shot(page, `picker-stickers-${tag}.png`);
    n0 = sends().length;
    await tap(t, page.locator('.u-picker .u-pick-tile.sticker').first());
    got = await waitSends(n0, 1, tag + ' sticker');
    assert.match(got[0].path, /\/send\/m\.sticker\//, tag + ' sticker is an m.sticker event');
    assert.equal(got[0].body.info['fi.mau.bridged_sticker'].pack_url, 'https://t.me/addstickers/Cats', tag + ' original Telegram sticker reference');
    assert.equal(got[0].body.body, '😀');
    await page.locator('.u-row.outgoing .u-media.sticker').last().waitFor({timeout: 5000});
    // A pack.
    await openPanel(t);
    await page.locator('.u-picker .u-pack', {hasText: 'Cats'}).waitFor();
    await tap(t, page.locator('.u-picker .u-pack', {hasText: 'Cats'}));
    await page.waitForFunction(() => document.querySelectorAll('.u-picker .u-sticker-grid .u-pick-tile').length === 8, null, {timeout: 4000});
    n0 = sends().length;
    await tap(t, page.locator('.u-picker .u-sticker-grid .u-pick-tile').nth(6));
    got = await waitSends(n0, 1, tag + ' pack sticker');
    assert.equal(got[0].body.info['fi.mau.bridged_sticker'].id, '1006', tag + ' the picked pack sticker');
    // Issue 159: the panel closes by itself on a tap outside it, a tap in the text box, and on send (tap or Enter).
    const isOpen = () => page.locator('.u-picker:not([hidden])').count();
    await openPanel(t); await tap(t, page.locator('.u-picker .u-pick-tab', {hasText: 'Emoji'}));
    assert.equal(await isOpen(), 1, tag + ' a tap inside the panel keeps it open');
    await tap(t, page.locator('.u-thread-body'), {position: {x: 8, y: 8}});
    await page.waitForTimeout(150);
    assert.equal(await isOpen(), 0, tag + ' a tap in the chat closes the panel');
    await openPanel(t); await tap(t, box, {position: {x: 14, y: 10}}); await page.waitForTimeout(150);
    assert.equal(await isOpen(), 0, tag + ' a tap in the text box closes the panel');
    const typed = v => box.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', {bubbles: true})); }, v);
    await openPanel(t); await typed('Sent by tapping Send'); n0 = sends().length;
    await tap(t, page.locator('.u-composer .u-send'));
    await waitSends(n0, 1, tag + ' text by Send'); await page.waitForTimeout(150);
    assert.equal(await isOpen(), 0, tag + ' tapping Send closes the panel');
    await openPanel(t); await typed('Sent by Enter'); n0 = sends().length;
    await page.locator('.u-composer').evaluate(f => f.requestSubmit()); // the Enter / Ctrl+Enter path (no tap at all)
    await waitSends(n0, 1, tag + ' text by Enter'); await page.waitForTimeout(150);
    assert.equal(await isOpen(), 0, tag + ' sending without a tap closes the panel');
    if (!t.phone) {
      await openPanel(t); await typed('Sent by the Enter key'); await box.focus(); n0 = sends().length;
      assert.equal(await isOpen(), 1, tag + ' focus from the keyboard alone leaves the panel open');
      await page.keyboard.press('Enter');
      await waitSends(n0, 1, tag + ' text by the Enter key'); await page.waitForTimeout(150);
      assert.equal(await isOpen(), 0, tag + ' the Enter key sends and closes the panel');
    }
    if (!t.phone) {
      await openPanel(t); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
      assert.equal(await page.locator('.u-picker:not([hidden])').count(), 0, tag + ' Escape closes the panel');
    }
    await page.waitForTimeout(500);
    await shot(page, `picker-sent-${tag}.png`);
    assert.ok(await page.evaluate(() => { const b = document.querySelector('.u-thread-body'), c = document.querySelector('.u-composer'); return b.scrollWidth <= b.clientWidth + 1 && c.scrollWidth <= c.clientWidth + 1; }), tag + ' no sideways overflow');
    assert.equal(await page.evaluate(() => window.__panels), 0, tag + ' no confirm/alert/prompt');
    assert.deepEqual(errors, [], tag + ' page errors');
    await ctx.close();
    console.log('ok', tag);
  }
  await browser.close();
  console.log('PASS pickers_browser: one smiley in the box opens Emoji/GIFs/Stickers (Emoji only off Telegram), emoji at the caret + Recent, GIF = one m.video fi.mau.gif, sticker = one m.sticker with fi.mau.bridged_sticker, 3 skins x phone/desktop');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
