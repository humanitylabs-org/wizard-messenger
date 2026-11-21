// Issue 349 (switch telegram-emoji): Messenger's emoji panel works like Telegram's (James, 20 Nov 2026).
// With the switch on, on a phone and a computer, in two skins:
//   - a category bar sits over the emoji; tapping 🏁 lands on Flags and the bar's highlight follows scrolling;
//   - a delete key in the bottom strip removes one emoji per tap and keeps deleting while held, keyboard down;
//   - the smiley turns into a keyboard button: the keyboard comes back with the panel hidden and the caret where it
//     was, and a second tap brings the panel back;
//   - a long press (right-click on a computer) on 👍 shows 6 tones; 👍🏽 sticks for the next plain tap and in Recent;
//   - on a phone the panel takes the keyboard's height; a computer keeps the fixed one;
//   - search still works, GIFs/Stickers are still there, and the panel still closes on outside tap and send.
// OFF=1 checks the switch off leaves today's panel as it was.
// Staged like tests/emoji_stays_open_browser.cjs:
//   AGENT_STAGE_DIR=<dir> python3 tests/pickers_stage.py <port> &  then  node tests/telegram_emoji_browser.cjs
// WIZARD_WEB_DIR=<wizard-ux>/web serves the shared emoji set (needed); SHOTS=<dir> writes screenshots.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), engine = pw[process.env.BROWSER || 'chromium'];
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR;
if (!dir) { console.error('AGENT_STAGE_DIR is required'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR, OFF = process.env.OFF === '1';
if (!WEB) { console.error('WIZARD_WEB_DIR is required (the shared emoji set)'); process.exit(2); }
const SKINS = {
  dark: {scheme: 'dark', bg: '#000000', ink: '#f7f7f7', accent: '#ffffff'},
  'landscapes-light': {scheme: 'light', bg: '#EEF1F4', ink: '#111216', accent: '#5B3FE6'},
};
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'};
const KEYBOARD = 300;

async function setup(browser, p, viewport) {
  const phone = viewport.width < 640;
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: p.scheme, ...(phone ? {isMobile: true, hasTouch: true} : {})});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const u = new URL(r.request().url());
    const f = path.join(WEB, u.pathname.replace(/^\/wizard-os-home\//, ''));
    if (!fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
    return r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
  });
  // The box's switch listing, with this one switch on (or off).
  await ctx.route('**/api/view/switches', r => r.request().method() === 'GET'
    ? r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'telegram-emoji', name: 'Emoji panel like Telegram', on: !OFF, default: false, issues: ['humanitylabs-org/wizard-messenger#349']}]})})
    : r.continue());
  await ctx.addInitScript(([scheme, p, kb, width]) => {
    const mark = () => {
      const r = document.documentElement; if (!r) return false;
      r.dataset.wzHosted = ''; r.dataset.colorScheme = scheme; r.style.colorScheme = scheme;
      r.style.setProperty('--wz-base', p.bg); r.style.setProperty('--wz-text', p.ink); r.style.setProperty('--wz-accent', p.accent);
      r.style.background = p.bg; return true;
    };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    // This phone's keyboard was 300 px tall last time the box had it up.
    try { localStorage.setItem('messenger.keyboardHeight', JSON.stringify({[width]: kb})); } catch {}
  }, [p.scheme, p, KEYBOARD, viewport.width]);
  const page = await ctx.newPage(), errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/send$/.test(new URL(r.url()).pathname)) posts.push(r.postDataJSON()); });
  await page.goto(st.origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  const cdp = phone ? await ctx.newCDPSession(page) : null;
  return {ctx, page, errors, posts, phone, cdp};
}
const tap = (t, loc, o) => t.phone ? loc.tap(o) : loc.click(o);
const isOpen = page => page.locator('.u-picker:not([hidden])').count();
const focused = box => box.evaluate(e => document.activeElement === e);
async function hold(t, loc, ms) {
  const b = await loc.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  if (t.phone) {
    await t.cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await t.page.waitForTimeout(ms);
    await t.cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  } else { await t.page.mouse.move(x, y); await t.page.mouse.down(); await t.page.waitForTimeout(ms); await t.page.mouse.up(); }
}
async function openChat(t, name) {
  const {page} = t;
  await tap(t, page.locator('.u-person', {hasText: name}).first());
  await page.locator('.u-thread-body .u-row').first().waitFor();
  await page.locator('.u-composer .u-pick-btn').waitFor({timeout: 5000});
  await page.waitForTimeout(600);
}
async function openPanel(t) {
  if (!(await isOpen(t.page))) await tap(t, t.page.locator('.u-composer .u-pick-btn'));
  await t.page.locator('.u-picker:not([hidden])').waitFor({timeout: 3000});
  await t.page.locator('.u-picker .u-emo-grid .u-emo').nth(10).waitFor();
}
// The section whose header is at the top of the panel's scroll area, and the lit category.
const lit = page => page.locator('.u-emo-cats .u-emo-cat.on').getAttribute('aria-label');
const headTop = (page, label) => page.evaluate(l => {
  const body = document.querySelector('.u-picker .u-pick-body'), h = [...body.querySelectorAll('.u-pick-head')].find(x => x.textContent === l);
  return h ? Math.round(h.getBoundingClientRect().top - body.getBoundingClientRect().top) : null;
}, label);
const scrollTo = (page, label) => page.evaluate(l => {
  const body = document.querySelector('.u-picker .u-pick-body'), h = [...body.querySelectorAll('.u-pick-head')].find(x => x.textContent === l);
  body.scrollTop += h.getBoundingClientRect().top - body.getBoundingClientRect().top + 30;
}, label);

async function offCase(browser) {
  for (const viewport of [{width: 390, height: 844}, {width: 1280, height: 860}]) {
    const t = await setup(browser, SKINS.dark, viewport), {page} = t;
    await openChat(t, 'Zoe'); await openPanel(t);
    assert.equal(await page.locator('.u-picker.tg').count(), 0, 'off: no Telegram layout');
    assert.equal(await page.locator('.u-emo-cats').count(), 0, 'off: no category bar');
    assert.equal(await page.locator('.u-pick-del').count(), 0, 'off: no delete key');
    assert.equal(await page.locator('.u-composer .u-pick-btn').getAttribute('aria-label'), 'Emoji, GIFs and stickers', 'off: the smiley stays a smiley');
    assert.deepEqual(await page.locator('.u-picker .u-pick-tab').allInnerTexts(), ['Emoji', 'GIFs', 'Stickers']);
    const h = await page.locator('.u-picker').evaluate(e => e.getBoundingClientRect().height);
    assert.notEqual(Math.round(h), KEYBOARD, 'off: the fixed height');
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `off-${viewport.width}.png`)});
    assert.deepEqual(t.errors, []);
    await t.ctx.close();
    console.log('ok off', viewport.width);
  }
}

(async () => {
  const browser = await engine.launch();
  if (OFF) { await offCase(browser); await browser.close(); console.log('PASS telegram_emoji_browser OFF: switch off keeps today\'s panel'); return; }
  for (const [skin, p] of Object.entries(SKINS)) for (const viewport of [{width: 390, height: 844}, {width: 1280, height: 860}]) {
    const tag = skin + '-' + viewport.width;
    const t = await setup(browser, p, viewport), {ctx, page, errors, posts, phone} = t;
    const box = page.locator('.u-composer textarea'), btn = page.locator('.u-composer .u-pick-btn');
    await openChat(t, 'Zoe');
    await tap(t, box); await box.fill('');
    await openPanel(t);

    // Layout: category bar on top, tabs and delete key in the bottom strip, keyboard button in the box.
    const cats = await page.locator('.u-emo-cats .u-emo-cat').allInnerTexts();
    assert.deepEqual(cats.filter(c => c !== '🕘'), ['😀', '🐻', '🍔', '⚽', '🚗', '💡', '🔣', '🏁'], tag + ' category bar');
    assert.equal(await page.locator('.u-pick-foot .u-pick-tab').count(), 3, tag + ' tabs in the bottom strip');
    assert.equal(await page.locator('.u-pick-foot .u-pick-del').count(), 1, tag + ' delete key in the bottom strip');
    assert.equal(await btn.getAttribute('aria-label'), 'Show keyboard', tag + ' the smiley is a keyboard button');
    const bg = await page.locator('.u-picker').evaluate(e => getComputedStyle(e).backgroundColor);
    assert.ok(!/rgba\(.*, 0\)$/.test(bg) && bg !== 'transparent', tag + ' opaque panel ' + bg);

    // Height: the keyboard's on a phone, the fixed one on a computer.
    const h = Math.round(await page.locator('.u-picker').evaluate(e => e.getBoundingClientRect().height));
    if (phone) assert.equal(h, KEYBOARD, tag + ' panel as tall as the keyboard'); else assert.ok(h >= 220 && h <= 362, tag + ' desktop fixed height ' + h);

    // Category bar: 🏁 lands on Flags and lights 🏁; scrolling moves the light.
    await tap(t, page.locator('.u-emo-cat[aria-label="Flags"]'));
    await page.waitForTimeout(250);
    const flagsTop = await headTop(page, 'Flags');
    assert.ok(flagsTop !== null && flagsTop <= 8, tag + ' Flags at the top after 🏁, at ' + flagsTop);
    assert.equal(await lit(page), 'Flags', tag + ' 🏁 lit');
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `flags-${tag}.png`)});
    await scrollTo(page, 'Animals & Nature'); await page.waitForTimeout(250);
    assert.equal(await lit(page), 'Animals & Nature', tag + ' the light follows scrolling to 🐻');
    await scrollTo(page, 'Food & Drink'); await page.waitForTimeout(250);
    assert.equal(await lit(page), 'Food & Drink', tag + ' and on to 🍔');
    await tap(t, page.locator('.u-emo-cat[aria-label="Smileys & People"]')); await page.waitForTimeout(250);
    assert.equal(await lit(page), 'Smileys & People', tag + ' back to 😀');

    // Delete key: 😀😀, ⌫ once leaves one 😀; holding keeps deleting; the keyboard stays down on a phone.
    const grin = page.locator('.u-picker .u-emo[data-emoji="😀"]').first();
    await tap(t, grin); await tap(t, grin); await page.waitForTimeout(150);
    assert.equal(await box.inputValue(), '😀😀', tag + ' two picks');
    await tap(t, page.locator('.u-pick-del')); await page.waitForTimeout(150);
    assert.equal(await box.inputValue(), '😀', tag + ' ⌫ removes one emoji');
    if (phone) assert.equal(await focused(box), false, tag + ' keyboard stays down after ⌫');
    for (let i = 0; i < 6; i++) await tap(t, grin);
    assert.equal(await box.inputValue(), '😀'.repeat(7), tag + ' seven');
    await hold(t, page.locator('.u-pick-del'), 1400); await page.waitForTimeout(200);
    assert.equal(await box.inputValue(), '', tag + ' holding ⌫ keeps deleting');
    assert.equal(await isOpen(page), 1, tag + ' panel still open after holding ⌫');
    if (phone) assert.equal(await focused(box), false, tag + ' keyboard stays down while holding ⌫');

    // Skin tones: a long press (right-click on a computer) on 👍 shows 6 tones.
    await page.locator('.u-picker .u-pick-search').fill('thumbs up'); await page.waitForTimeout(400);
    assert.equal(await page.locator('.u-emo-cats').isHidden(), true, tag + ' no category bar while searching');
    const thumb = page.locator('.u-picker .u-emo[data-emoji="👍"]').first();
    if (phone) await hold(t, thumb, 650); else await thumb.click({button: 'right'});
    await page.locator('.u-emo-tones').waitFor({timeout: 2000});
    assert.deepEqual(await page.locator('.u-emo-tones .u-emo-tone').allInnerTexts(), ['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'], tag + ' six tones');
    assert.equal(await box.inputValue(), '', tag + ' a long press inserts nothing by itself');
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `tones-${tag}.png`)});
    await tap(t, page.locator('.u-emo-tones .u-emo-tone', {hasText: '👍🏽'}));
    await page.waitForTimeout(150);
    assert.equal(await box.inputValue(), '👍🏽', tag + ' 👍🏽 inserted');
    assert.equal(await page.locator('.u-emo-tones').count(), 0, tag + ' tone choices closed');
    await page.waitForTimeout(500); // past any held-press guard
    await tap(t, thumb); await page.waitForTimeout(150);
    assert.equal(await box.inputValue(), '👍🏽👍🏽', tag + ' the next plain tap on 👍 inserts 👍🏽');

    // Search still works.
    await page.locator('.u-picker .u-pick-search').fill('heart'); await page.waitForTimeout(400);
    assert.ok(await page.locator('.u-picker .u-emo', {hasText: '❤️'}).count() >= 1, tag + ' search "heart" finds ❤️');
    await page.locator('.u-picker .u-pick-search').fill(''); await page.waitForTimeout(400);
    assert.equal(await page.locator('.u-emo-cats').isVisible(), true, tag + ' category bar back after search');

    // Keyboard button: keyboard back, panel hidden, caret where it was; tapping again brings the panel back.
    await tap(t, btn); await page.waitForTimeout(200);
    assert.equal(await isOpen(page), 0, tag + ' keyboard button hides the panel');
    assert.equal(await focused(box), true, tag + ' the box has the keyboard');
    assert.equal(await btn.getAttribute('aria-label'), 'Emoji, GIFs and stickers', tag + ' and turns back into the smiley');
    await box.evaluate(e => { e.value = 'hello world'; e.dispatchEvent(new Event('input', {bubbles: true})); e.setSelectionRange(5, 5); });
    await tap(t, btn); await page.waitForTimeout(200);
    assert.equal(await isOpen(page), 1, tag + ' tapping again shows the panel');
    await tap(t, btn); await page.waitForTimeout(200);
    assert.equal(await box.evaluate(e => [e.selectionStart, e.selectionEnd].join()), '5,5', tag + ' caret where it was');
    await tap(t, btn); await page.waitForTimeout(200); await openPanel(t);
    // Recent holds the toned thumbs up.
    const recent = await page.evaluate(() => { const h = [...document.querySelectorAll('.u-picker .u-pick-head')].find(x => x.textContent === 'Recent'); return h ? [...h.nextElementSibling.children].map(b => b.textContent) : []; });
    // Ranked by use: 😀 went in nine times, 👍🏽 three.
    assert.deepEqual(recent.slice(0, 2), ['😀', '👍🏽'], tag + ' Recent shows 👍🏽, ranked by use: ' + recent.slice(0, 4).join(' '));
    assert.ok(!recent.includes('👍'), tag + ' and not the plain one');
    await tap(t, page.locator('.u-picker .u-emo[data-emoji="😀"]').first()); await page.waitForTimeout(150);
    assert.equal(await box.inputValue(), 'hello😀 world', tag + ' the pick goes in at the kept caret');
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `panel-${tag}.png`)});

    // GIFs / Stickers still there; the bar is emoji-only and ⌫ stays.
    await tap(t, page.locator('.u-pick-foot .u-pick-tab', {hasText: 'Stickers'}));
    await page.locator('.u-picker .u-pack').first().waitFor({timeout: 5000});
    assert.equal(await page.locator('.u-emo-cats').isHidden(), true, tag + ' no category bar on Stickers');
    await tap(t, page.locator('.u-pick-foot .u-pick-tab', {hasText: 'GIFs'}));
    await page.locator('.u-picker .u-pick-tile.gif').first().waitFor({timeout: 5000});
    await tap(t, page.locator('.u-pick-foot .u-pick-tab', {hasText: 'Emoji'}));
    await page.locator('.u-emo-cats .u-emo-cat').first().waitFor();

    // The close actions from issue 159 still work.
    await tap(t, page.locator('.u-thread-body'), {position: {x: 8, y: 8}}); await page.waitForTimeout(150);
    assert.equal(await isOpen(page), 0, tag + ' a tap outside closes it');
    await openPanel(t);
    await tap(t, page.locator('.u-composer .u-send')); await page.waitForTimeout(300);
    assert.equal(await isOpen(page), 0, tag + ' sending closes it');
    assert.equal(posts.length, 1, tag + ' one send');
    assert.deepEqual(errors, [], tag + ' page errors');
    await ctx.close();
    console.log('ok', tag);
  }
  await browser.close();
  console.log('PASS telegram_emoji_browser: category bar + scroll light, ⌫ tap/hold keyboard down, keyboard button + caret, 6 skin tones sticking and in Recent, keyboard-height panel, search, GIFs/Stickers, close actions; 2 skins x phone/desktop');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
