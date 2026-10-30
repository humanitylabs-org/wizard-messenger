// Phone layout (Miguel, 30 Oct 2026: "Messenger does not work well at all on mobile"). Disposable ViewServer +
// synthetic chats (tests/agent_drafts_stage.py). 390x844 touch, standalone and inside a Wizard-like iframe window,
// dark and light skin tokens. Inbox controls sit at the bottom in thumb reach on phone widths; desktop keeps them on top.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const out = process.env.EVIDENCE_DIR || path.join(dir, 'mobile-shots'); fs.mkdirSync(out, {recursive: true});
const SKINS = {
  dark: {canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
};
const FRAME_H = 760;
const box = (loc) => loc.boundingBox();
(async () => {
  const browser = await chromium.launch();
  const runs = [['standalone', 'dark'], ['standalone', 'light'], ['framed', 'dark'], ['framed', 'light']];
  for (const [mode, scheme] of runs) {
    const framed = mode === 'framed', tag = mode + '-' + scheme, H = framed ? FRAME_H : 844;
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route('**/wizard-os-home/**', r => { const u = new URL(r.request().url()); r.continue({url: 'http://127.0.0.1:8796' + u.pathname}); });
    await ctx.route(st.origin + '/__wizard_window.html', r => r.fulfill({contentType: 'text/html', body:
      '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;background:' + SKINS[scheme].glass + '">' +
      '<iframe id=w src="/" style="position:fixed;left:0;top:44px;width:390px;height:' + FRAME_H + 'px;border:0"></iframe></body>'}));
    await ctx.addInitScript(([s, tokens]) => {
      if (location.pathname.endsWith('__wizard_window.html')) return;
      const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v); r.style.background = tokens.glass; return true; };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + (framed ? '/__wizard_window.html' : '/'));
    const app = framed ? page.frameLocator('#w') : page;
    const frame = () => framed ? page.frames().find(f => f !== page.mainFrame()) : page.mainFrame();
    const top = framed ? 44 : 0; // the window's offset on the page
    await app.locator('.u-person', {hasText: 'Alice Example'}).first().waitFor(); await page.waitForTimeout(700);
    // ---- Inbox: list on top, filters then the toolbar (QR, search, settings) at the bottom ----
    const settings = await box(app.locator('.u-settings-btn')), search = await box(app.getByRole('button', {name: 'Search', exact: true}));
    const chips = await box(app.locator('#u-filters')), list = await box(app.locator('.u-list')), fab = await box(app.locator('.u-fab'));
    for (const b of [settings, search]) { assert.ok(b.y + b.height <= top + H + 0.5, tag + ': toolbar inside the window'); assert.ok(b.y > top + H - 90, tag + ': toolbar in thumb reach at the bottom (' + b.y + ')'); assert.ok(b.width >= 44 && b.height >= 44, tag + ': 44px targets'); }
    assert.ok(chips.y > list.y && chips.y + chips.height <= settings.y + 1, tag + ': filter chips sit above the toolbar, below the list');
    assert.ok(fab.y + fab.height <= chips.y, tag + ': compose button clears the filters');
    assert.ok(list.y - top < 10, tag + ': chats start at the top');
    assert.equal(await frame().evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, tag + ': no sideways scroll');
    await page.screenshot({path: path.join(out, tag + '-list.png')});
    // Search opens at the bottom too, and Back closes it.
    await app.getByRole('button', {name: 'Search', exact: true}).tap();
    const field = await box(app.locator('input.u-search')); assert.ok(field.y > top + H - 90, tag + ': search field in reach');
    await app.getByRole('button', {name: 'Close search'}).tap(); await app.locator('.u-settings-btn').waitFor();
    // ---- Settings sheet fits the window ----
    await app.locator('.u-settings-btn').tap(); const sheet = app.locator('.u-sheet'); await sheet.waitFor(); await page.waitForTimeout(350);
    const sb = await box(sheet), close = await box(app.locator('.u-sheet header .icon-button[aria-label=Close]'));
    assert.ok(sb.y >= top - 0.5 && sb.y + sb.height <= top + H + 0.5 && sb.x >= -0.5 && sb.x + sb.width <= 390.5, tag + ': settings sheet inside the window');
    assert.ok(close.y >= top, tag + ': sheet close reachable');
    await page.screenshot({path: path.join(out, tag + '-settings.png')});
    await app.locator('.u-sheet header .icon-button[aria-label=Close]').tap(); await page.waitForTimeout(250);
    // ---- Thread ----
    await app.locator('.u-person', {hasText: 'Alice Example'}).first().tap();
    const ta = app.locator('textarea[aria-label="Message"]'); await ta.waitFor(); await page.waitForTimeout(800);
    const back = await box(app.getByRole('button', {name: 'Back', exact: true}));
    assert.ok(back.width >= 44 && back.height >= 44 && back.y >= top, tag + ': Back is a full-size target');
    assert.ok(parseFloat(await ta.evaluate(el => getComputedStyle(el).fontSize)) >= 16, tag + ': 16px field, so iOS never zooms in');
    const t1 = await box(ta); assert.ok(t1.y + t1.height <= top + H, tag + ': composer visible');
    await page.screenshot({path: path.join(out, tag + '-thread.png')});
    // Keyboard: the window/viewport gets shorter; the composer must ride above it with the newest message in view.
    await ta.tap(); await ta.fill('Typing on a phone');
    if (framed) await page.evaluate(h => { document.getElementById('w').style.height = h + 'px'; }, 430);
    else await page.setViewportSize({width: 390, height: 470});
    await page.waitForTimeout(500);
    const kb = framed ? top + 430 : 470, t2 = await box(ta), head = await box(app.getByRole('button', {name: 'Back', exact: true}));
    assert.ok(t2.y + t2.height <= kb + 0.5, tag + ': composer above the keyboard (' + (t2.y + t2.height) + ' <= ' + kb + ')');
    assert.ok(head.y >= top - 0.5, tag + ': header still on screen with the keyboard up');
    const last = await box(app.locator('.u-row .u-message').last()); assert.ok(last.y + last.height <= t2.y + 1 && last.y >= head.y, tag + ': newest message visible above the composer');
    await page.screenshot({path: path.join(out, tag + '-composer-focused.png')});
    if (framed) await page.evaluate(h => { document.getElementById('w').style.height = h + 'px'; }, FRAME_H); else await page.setViewportSize({width: 390, height: 844});
    await ta.fill('');
    // Back returns to the Inbox with the toolbar at the bottom again.
    await app.getByRole('button', {name: 'Back', exact: true}).tap();
    await app.locator('.u-settings-btn').waitFor();
    assert.deepEqual(errors, [], tag + ': no page errors');
    console.log('ok', tag);
    await ctx.close();
  }
  // ---- Desktop keeps the controls on top ----
  {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 860}});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route('**/wizard-os-home/**', r => { const u = new URL(r.request().url()); r.continue({url: 'http://127.0.0.1:8796' + u.pathname}); });
    const page = await ctx.newPage(); await page.goto(st.origin + '/');
    await page.locator('.u-person', {hasText: 'Alice Example'}).first().waitFor(); await page.waitForTimeout(500);
    const s = await box(page.locator('.u-settings-btn')), c = await box(page.locator('#u-filters')), l = await box(page.locator('.u-list'));
    assert.ok(s.y < 30 && c.y < l.y, 'desktop: header and filters on top, unchanged');
    await page.screenshot({path: path.join(out, 'desktop-list.png')});
    await ctx.close();
  }
  await browser.close();
  console.log('PASS mobile_layout_browser: phone list/search/settings/thread/keyboard/back in standalone + Wizard window, dark + light; desktop unchanged; shots in ' + out);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
