// Catch me up in the real app UI (stage: tests/catchup_stage.py, synthetic chats, fake summarizer).
// Checks: title-bar button, three-choice permission sheet, summary bullets that jump to their message, divider button,
// Back closes one layer, outside tap closes, targets >= 44px, opaque sheet, chat-info turn-off, the summary model under the summary,
// 1000-message chat says "in K parts". SHOTS=<dir> writes sheet screenshots on four skins, phone + desktop.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR; const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const P = {
  dark: {scheme: 'dark', bg: '#000000', ink: '#f7f7f7', ink2: '#c4c4c4', ink3: '#8a8a8a', line2: 'rgba(255,255,255,.26)', accent: '#ffffff', on: '#000000', glass: '#000000'},
  landscapes: {scheme: 'dark', bg: '#0B0A10', ink: '#ffffff', ink2: 'rgba(255,255,255,.80)', ink3: 'rgba(255,255,255,.58)', line2: 'rgba(255,255,255,.28)', accent: '#7A5CFF', on: '#ffffff', glass: 'linear-gradient(160deg,#1d2a44,#4a3150 50%,#0b0a10)'},
  'landscapes-light': {scheme: 'light', bg: '#EEF1F4', ink: '#111216', ink2: 'rgba(17,18,22,.76)', ink3: 'rgba(17,18,22,.54)', line2: 'rgba(0,0,0,.26)', accent: '#5B3FE6', on: '#ffffff', glass: 'linear-gradient(160deg,#cfd8e3,#eef1f4 55%,#e6dccf)'},
};
const tokens = p => ({canvas: 'transparent', base: p.bg, surface: `color-mix(in srgb, ${p.ink} 6%, transparent)`, 'surface-raised': `color-mix(in srgb, ${p.ink} 10%, transparent)`,
  text: p.ink, 'text-secondary': p.ink2, 'text-muted': p.ink3, border: p.line2, accent: p.accent, 'accent-soft': `color-mix(in srgb, ${p.accent} 16%, transparent)`, 'on-accent': p.on});
const ok = body => ({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: body})});
async function setup(browser, p, viewport) {
  const phone = viewport.width < 640;
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: p.scheme, ...(phone ? {isMobile: true, hasTouch: true} : {})});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  const WEB = process.env.WIZARD_WEB_DIR, TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json'};
  await ctx.route('**/wizard-os-home/**', r => {
    const f = WEB && path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
    return f && fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)}) : r.fulfill({status: 404, body: ''});
  });
  await ctx.route(/\/api\/unified\/people\/[^/]+\/(read|unread)$/, r => r.request().method() === 'POST' ? r.fulfill(ok({ok: true})) : r.continue());
  await ctx.route(/\/api\/unified\/updates/, async r => { await new Promise(res => setTimeout(res, 800)); return r.fulfill(ok({seq: 0})); });
  await ctx.addInitScript(([scheme, tk, glass]) => {
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = scheme; r.style.colorScheme = scheme;
      for (const [k, v] of Object.entries(tk)) r.style.setProperty('--wz-' + k, v); r.style.background = glass; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, [p.scheme, tokens(p), p.glass]);
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(st.origin + '/'); await page.locator('.u-person').first().waitFor({timeout: 20000});
  return {ctx, page, errors, phone};
}
const open = async (t, name) => { const row = t.page.locator('.u-person', {hasText: name}).first(); if (t.phone) await row.tap(); else await row.click(); await t.page.locator('.u-thread-body .u-row').first().waitFor(); await t.page.waitForTimeout(1300); };
const tap = (t, loc) => t.phone ? loc.tap() : loc.click();
// The stage keeps grants between the phone and the desktop run, so the question only appears the first time.
const answer = async (page, label) => { const b = page.locator('.u-cu-body button', {hasText: label}); await Promise.race([b.waitFor({timeout: 4000}).then(() => b.click()), page.locator('.u-cu-running, .u-cu-bullet').first().waitFor({timeout: 4000})]).catch(() => {}); };
const box = async loc => loc.evaluate(e => { const r = e.getBoundingClientRect(); return {w: r.width, h: r.height}; });
async function scenario(browser, viewport, skin = 'dark') {
  const tag = viewport.width < 640 ? 'phone' : 'desktop', t = await setup(browser, P[skin], viewport), page = t.page, sheet = page.locator('#u-overlay .u-sheet');
  await open(t, 'Lena');
  const btn = page.locator('.u-catchup-btn'); assert.equal(await btn.count(), 1, tag + ': Catch me up button in the title bar');
  const b = await box(btn); assert.ok(b.w >= 44 && b.h >= 44, tag + ' title button >= 44px ' + JSON.stringify(b));
  assert.equal(await page.locator('.u-thread-head [aria-label="Chat options"]').count(), 1, tag + ': menu still there');
  // First tap: permission sheet with three choices, default first. Nothing is summarized before an answer.
  await tap(t, btn); await sheet.waitFor();
  await page.locator('.u-cu-body button').first().waitFor();
  const names = await page.locator('.u-cu-body button').allTextContents();
  assert.deepEqual(names, ['Just this once', 'This chat for 24 hours', 'This chat always'], tag);
  for (const h of await page.locator('.u-cu-body button').all()) { const bb = await box(h); assert.ok(bb.h >= 44, tag + ' choice >= 44px'); }
  assert.equal(await page.locator('.u-cu-bullet').count(), 0, tag + ': nothing summarized before the answer');
  if (SHOTS) await page.screenshot({path: path.join(SHOTS, `catchup-permission-${skin}-${tag}.png`)});
  // Back closes the sheet, one layer.
  assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true, tag + ': Back handled by the sheet');
  await page.locator('#u-overlay').waitFor({state: 'detached'});
  assert.equal(await page.locator('.u-thread-body').count(), 1, tag + ': Back closed only the sheet, the chat stays');
  // Outside tap closes too.
  await tap(t, btn); await sheet.waitFor();
  await page.mouse.click(5, 5); await page.locator('#u-overlay').waitFor({state: 'detached'});
  // Choose "This chat for 24 hours": runs, then shows bullets and the footer.
  await tap(t, btn); await page.locator('.u-cu-body button', {hasText: 'This chat for 24 hours'}).click();
  await page.locator('.u-cu-bullet').first().waitFor({timeout: 15000}).catch(async e => { throw new Error(e.message + ' | body: ' + await page.locator('.u-cu-body').innerText().catch(() => '?') + ' | err: ' + await page.locator('#u-error').innerText().catch(() => '?')); });
  const bullets = await page.locator('.u-cu-bullet').allTextContents();
  assert.ok(bullets.length >= 3, tag + ' bullets ' + bullets.length);
  assert.ok(/For you/.test(bullets[0]) && /charger/.test(bullets[0]), tag + ' first bullet is the ask for you: ' + bullets[0]);
  const foot = await page.locator('.u-cu-foot').textContent(); assert.match(foot, /Summarized 25 messages/, tag + ' footer count');
  assert.match(await page.locator('.u-cu-basis').textContent(), /Since the new-messages marker · 25 messages/);
  assert.equal(await page.locator('.u-cu-parts').count(), 0, tag + ': no parts note for a short chat');
  for (const h of await page.locator('.u-cu-bullet').all()) { const bb = await box(h); assert.ok(bb.h >= 44, tag + ' bullet >= 44px'); }
  const opaque = await sheet.evaluate(e => { const c = getComputedStyle(e); return {bg: c.backgroundColor, image: c.backgroundImage}; });
  assert.ok(!/rgba\(.*,\s*0(\.\d+)?\)$/.test(opaque.bg) || opaque.image !== 'none', tag + ' sheet background opaque ' + JSON.stringify(opaque));
  if (SHOTS) await page.screenshot({path: path.join(SHOTS, `catchup-summary-${skin}-${tag}.png`)});
  // Tapping a bullet closes the sheet and scrolls to its source message, which flashes.
  await page.locator('.u-cu-bullet').first().click(); await page.locator('#u-overlay').waitFor({state: 'detached'});
  await page.locator('.u-message.flash, .flash').first().waitFor({timeout: 3000});
  // Reopen: the cached summary is shown at once (no permission, no spinner), Refresh re-runs.
  await tap(t, btn); await page.locator('.u-cu-bullet').first().waitFor({timeout: 3000});
  assert.equal(await page.locator('.u-cu-running').count(), 0, tag + ': cached shows without a run');
  await tap(t, page.locator('.u-cu-refresh')); await page.locator('.u-cu-running').waitFor({timeout: 3000}); await page.locator('.u-cu-bullet').first().waitFor({timeout: 15000}).catch(async e => { throw new Error(e.message + ' | body: ' + await page.locator('.u-cu-body').innerText().catch(() => '?') + ' | err: ' + await page.locator('#u-error').innerText().catch(() => '?')); });
  await tap(t, page.locator('#u-overlay [aria-label="Close"]'));
  // Chat info sheet: shows the standing grant and turns it off.
  await tap(t, page.locator('.u-thread-head .u-who')); await page.locator('.u-cu-info .wide').first().waitFor();
  assert.match(await page.locator('.u-cu-info .helper').textContent(), /until/);
  await page.locator('.u-cu-info button', {hasText: 'Turn off and clear saved summary'}).click();
  await page.locator('.u-cu-info .helper', {hasText: 'Asks before'}).waitFor();
  await tap(t, page.locator('#u-overlay [aria-label="Close"]')); await page.locator('#u-overlay').waitFor({state: 'detached'});
  await tap(t, btn); await page.locator('.u-cu-body button', {hasText: 'Just this once'}).waitFor();  // asks again, cache gone
  await tap(t, page.locator('#u-overlay [aria-label="Close"]'));
  assert.deepEqual(t.errors, [], tag + ' page errors');
  await t.ctx.close();
}
async function dividerAndBig(browser, viewport) {
  const tag = viewport.width < 640 ? 'phone' : 'desktop', t = await setup(browser, P.dark, viewport), page = t.page;
  await open(t, 'Bram');  // 2 unread: the divider carries Summarize these
  const sum = page.locator('.u-unread-catchup-btn'); assert.equal(await sum.count(), 1, tag + ': Summarize these under the divider');
  const bb = await box(sum); assert.ok(bb.h >= 44, tag + ' divider button >= 44px');
  await tap(t, sum); await answer(page, 'This chat always');
  await page.locator('.u-cu-bullet').first().waitFor({timeout: 15000}).catch(async e => { throw new Error(e.message + ' | body: ' + await page.locator('.u-cu-body').innerText().catch(() => '?') + ' | err: ' + await page.locator('#u-error').innerText().catch(() => '?')); });
  assert.match(await page.locator('.u-cu-foot').textContent(), /Summarized 2 messages\./, tag + ' divider run covers the 2 unread');
  await tap(t, page.locator('#u-overlay [aria-label="Close"]'));
  if (t.phone) await page.locator('.u-back').first().click(); else await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await open(t, 'Big');  // 1000 unread: all of them, in parts
  await tap(t, page.locator('.u-catchup-btn')); await answer(page, 'This chat always');
  await page.locator('.u-cu-bullet').first().waitFor({timeout: 60000});
  const foot = await page.locator('.u-cu-foot').textContent();
  assert.match(foot, /Summarized 1000 messages in \d+ parts\./, tag + ' ' + foot);
  if (SHOTS) await page.screenshot({path: path.join(SHOTS, `catchup-1000-dark-${tag}.png`)});
  // Issue 202: the summary model is picked under the summary (Settings has no Catch me up part).
  await page.locator('.u-cu-model:not([hidden]) select').waitFor({timeout: 8000});
  assert.equal(await page.locator('.u-cu-model select option').count(), 2);
  assert.equal(await page.locator('.u-cu-model select').inputValue(), 'glm-5-3');
  await tap(t, page.locator('#u-overlay [aria-label="Close"]'));
  assert.deepEqual(t.errors, [], tag + ' page errors');
  await t.ctx.close();
}
(async () => {
  const browser = await chromium.launch();
  try {
    for (const v of [{width: 390, height: 844}, {width: 1280, height: 800}]) { await scenario(browser, v); await dividerAndBig(browser, v); }
    if (SHOTS) for (const skin of ['landscapes', 'landscapes-light']) for (const v of [{width: 390, height: 844}, {width: 1280, height: 800}]) {
      const t = await setup(browser, P[skin], v), tag = v.width < 640 ? 'phone' : 'desktop'; await open(t, 'Lena');
      await tap(t, t.page.locator('.u-catchup-btn')); await answer(t.page, 'Just this once');
      await t.page.locator('.u-cu-bullet').first().waitFor({timeout: 15000}); await t.page.mouse.move(1, 1);
      await t.page.screenshot({path: path.join(SHOTS, `catchup-summary-${skin}-${tag}.png`)}); await t.ctx.close();
    }
    console.log('catch me up: ok');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
