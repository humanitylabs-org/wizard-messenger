// Issue 294: the emoji panel stays open while the owner picks several emoji in a row (James, 18 Nov 2026).
// Three emoji picked one after another land in the text box in order, with the panel open the whole time; the
// existing ways to close it still work (the smiley again, a tap outside, a tap in the text box, sending).
// Staged like tests/pickers_browser.cjs:
//   AGENT_STAGE_DIR=<dir> python3 tests/pickers_stage.py <port> &  then  node tests/emoji_stays_open_browser.cjs
// On a phone the box never takes focus after a pick (the keyboard would cover the panel), also on a phone that
// reports a fine pointer, and focus that reaches the box without a tap leaves the panel open.
// BROWSER=webkit runs it in WebKit. WIZARD_WEB_DIR=<wizard-ux>/web serves the shared emoji set; SHOTS=<dir> writes a screenshot per skin and width.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), chromium = pw[process.env.BROWSER || 'chromium'];
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR;
if (!dir) { console.error('AGENT_STAGE_DIR is required'); process.exit(2); }
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR;
const SKINS = {
  dark: {scheme: 'dark', bg: '#000000', ink: '#f7f7f7', accent: '#ffffff'},
  'landscapes-light': {scheme: 'light', bg: '#EEF1F4', ink: '#111216', accent: '#5B3FE6'},
};
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'};

async function setup(browser, p, {fine, ...viewport}) {
  const phone = viewport.width < 640;
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: p.scheme, ...(phone ? {isMobile: true, hasTouch: true} : {})});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const u = new URL(r.request().url());
    if (!WEB) return r.fulfill({status: 404, body: ''});
    const f = path.join(WEB, u.pathname.replace(/^\/wizard-os-home\//, ''));
    if (!fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
    return r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
  });
  await ctx.addInitScript(([scheme, p]) => {
    const mark = () => {
      const r = document.documentElement; if (!r) return false;
      r.dataset.wzHosted = ''; r.dataset.colorScheme = scheme; r.style.colorScheme = scheme;
      r.style.setProperty('--wz-base', p.bg); r.style.setProperty('--wz-text', p.ink); r.style.setProperty('--wz-accent', p.accent);
      r.style.background = p.bg; return true;
    };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, [p.scheme, p]);
  // Some phones report a fine pointer to the page (stylus phones): the touch screen must still be treated as touch.
  if (fine) await ctx.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = q => /pointer:\s*coarse/.test(q) ? Object.assign(mm('(min-width: 99999px)'), {media: q}) : mm(q); });
  const page = await ctx.newPage(), errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'POST' && /\/send$/.test(new URL(r.url()).pathname)) posts.push(r.postDataJSON()); });
  await page.goto(st.origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  return {ctx, page, errors, posts, phone};
}
const tap = (t, loc, o) => t.phone ? loc.tap(o) : loc.click(o);
const isOpen = page => page.locator('.u-picker:not([hidden])').count();
async function openChat(t, name) {
  const {page} = t;
  if (await page.locator('.u-thread-body').count() && t.phone) { await tap(t, page.locator('.u-back').first()); await page.locator('.u-person').first().waitFor(); }
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
// Three emoji from the grid, picked one after another; the panel must still be open after each.
async function pickThree(t, tag) {
  const {page} = t, box = page.locator('.u-composer textarea');
  const picks = ['😂', '❤️', '👍'], typed = [];
  for (const k of picks) {
    const emo = page.locator('.u-picker .u-emo', {hasText: k}).first();
    const text = (await emo.innerText()).trim();
    await tap(t, emo); await page.waitForTimeout(+(process.env.PICK_WAIT || 250));
    typed.push(text);
    assert.equal(await isOpen(page), 1, `${tag} panel still open after picking ${text}`);
    assert.equal(await box.inputValue(), (process.env.START ?? '') + typed.join(''), `${tag} emoji land in order`);
    // On a phone the keyboard stays down (the box does not take focus), so the panel stays in view.
    if (t.phone) assert.equal(await box.evaluate(e => document.activeElement === e), false, `${tag} the box does not take focus after ${text}`);
  }
  // A phone can hand focus back to the box on its own (no tap): the panel stays open.
  if (t.phone) {
    await box.evaluate(e => e.focus()); await page.waitForTimeout(200);
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, `emoji-focus-${tag}.png`)});
    assert.equal(await isOpen(page), 1, `${tag} focus alone does not close the panel`);
    await box.evaluate(e => e.blur());
  }
}

(async () => {
  const browser = await chromium.launch();
  for (const [skin, p] of Object.entries(SKINS)) for (const viewport of [{width: 390, height: 844}, {width: 390, height: 844, fine: true}, {width: 1280, height: 860}]) {
    const tag = skin + '-' + viewport.width + (viewport.fine ? '-fine-pointer' : '');
    const t = await setup(browser, p, viewport), {ctx, page, errors, posts} = t;
    const box = page.locator('.u-composer textarea'), btn = page.locator('.u-composer .u-pick-btn');
    await openChat(t, 'Zoe');
    await tap(t, box); await box.fill(process.env.START ?? '');
    await openPanel(t);
    await pickThree(t, tag);
    if (SHOTS) { await page.mouse.move(2, 2).catch(() => {}); await page.waitForTimeout(300); await page.screenshot({path: path.join(SHOTS, `emoji-three-${tag}.png`)}); }
    assert.equal(posts.length, 0, tag + ' picking emoji never sends');

    // The ways it closed before still close it.
    await tap(t, btn); await page.waitForTimeout(150);
    assert.equal(await isOpen(page), 0, tag + ' the smiley closes it');
    await openPanel(t);
    await tap(t, page.locator('.u-thread-body'), {position: {x: 8, y: 8}}); await page.waitForTimeout(150);
    assert.equal(await isOpen(page), 0, tag + ' a tap outside closes it');
    await openPanel(t);
    await tap(t, box); await page.waitForTimeout(150);
    assert.equal(await isOpen(page), 0, tag + ' a tap in the text box closes it');
    await openPanel(t);
    await tap(t, page.locator('.u-picker .u-emo', {hasText: '👍'}).first()); await page.waitForTimeout(150);
    assert.equal(await isOpen(page), 1, tag + ' still open before sending');
    await tap(t, page.locator('.u-composer .u-send')); await page.waitForTimeout(300);
    assert.equal(await isOpen(page), 0, tag + ' sending closes it');
    assert.deepEqual(errors, [], tag + ' page errors');
    await ctx.close();
    console.log('ok', tag);
  }
  await browser.close();
  console.log('PASS emoji_stays_open_browser: three emoji in a row with the panel open, smiley/outside/text box/send still close it, phone focus/keyboard, 2 skins x phone (also one reporting a fine pointer)/desktop');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
