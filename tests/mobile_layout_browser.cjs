// Phone layout (Miguel, 30 Oct 2026: "Messenger does not work well at all on mobile"). Disposable ViewServer +
// synthetic chats (tests/agent_drafts_stage.py). 390x844 touch, standalone and inside a Wizard-like iframe window,
// dark and light skin tokens. Inbox controls sit at the bottom in thumb reach on phone widths; desktop keeps them on top.
// Inside a real Wizard window host (the shell's own app-services.js + shell CSS, borderless phone frame) the QR,
// Search and Settings controls move into the window's title bar and the filter chips become the bottom row (Miguel,
// 30 Oct 2026). WIZARD_WEB_DIR=<wizard-ux>/web serves a shell checkout instead of the live shell on 127.0.0.1:8796.
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
const WEB = process.env.WIZARD_WEB_DIR || '';
const TYPES = {'.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png'};
async function shellRoute(ctx) {
  await ctx.route('**/wizard-os-home/**', r => {
    const u = new URL(r.request().url());
    if (!WEB) return r.continue({url: 'http://127.0.0.1:8796' + u.pathname});
    const f = path.join(WEB, u.pathname.replace(/^\/wizard-os-home\//, ''));
    if (!f.startsWith(WEB) || !fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
    r.fulfill({contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
  });
}
// A Wizard phone window: the shell's real window markup and CSS, and its real app-services.js attached to the frame.
const SHELL_SKINS = {'obsidian': 'dark', 'obsidian-light': 'light', 'landscapes-light': 'light'};
const shellPage = (skin) => '<!doctype html><html data-shell="phone" data-skin="' + skin + '" data-skin-frame="borderless"><head><meta charset=utf-8>' +
  // The live shell paints its palette from JS; this host sets the few shell tokens the bar uses.
  '<style>html,body,.win{background:' + SKINS[SHELL_SKINS[skin]].glass + '!important}html{--bg:' + SKINS[SHELL_SKINS[skin]].base + ';--ink:' + SKINS[SHELL_SKINS[skin]].text + ';--ink-2:' + SKINS[SHELL_SKINS[skin]]['text-secondary'] + '}</style><meta name=viewport content="width=device-width,initial-scale=1">' +
  ['core/base.css', 'styles.css', 'core/skin-frame.css', 'skins/obsidian/skin.css', 'skins/landscapes/skin.css'].map(h => '<link rel=stylesheet href="/wizard-os-home/' + h + '">').join('') +
  '</head><body style="margin:0"><div class="device"><div class="tiles"><article class="win solo" style="position:fixed;left:0;top:0;width:390px;height:' + (FRAME_H + 44) + 'px;display:flex;flex-direction:column">' +
  '<header class="wbar"><span class="wt">Messenger</span><button type="button" data-wact="close" aria-label="Close">\u2715</button></header>' +
  '<div class="wbody" style="flex:1 1 auto;min-height:0;position:relative"><iframe id=w style="display:block;width:100%;height:100%;border:0"></iframe></div></article>' +
  '<nav id=dock style="position:fixed;left:0;right:0;top:' + (FRAME_H + 44) + 'px;bottom:0"></nav></div></div>' +
  '<script>window.WizCore={apps:()=>({APPS:[{id:"messenger",kind:"wizard",url:"/"}]}),workspaceNav:{setCount(){}}};</script>' +
  '<script src="/wizard-os-home/core/app-services.js"></script>' +
  '<script>const f=document.getElementById("w");window.__detach=WizAppServices.attach(f,{appId:"messenger",path:"/",isVisible:()=>true});f.src="/";</script></body></html>';

const box = (loc) => loc.boundingBox();
(async () => {
  const browser = await chromium.launch();
  const runs = [['standalone', 'dark'], ['standalone', 'light'], ['framed', 'dark'], ['framed', 'light']];
  for (const [mode, scheme] of runs) {
    const framed = mode === 'framed', tag = mode + '-' + scheme, H = framed ? FRAME_H : 844;
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await shellRoute(ctx);
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
    assert.equal(await app.locator('#unified-inbox > .u-header h1').isVisible(), false, tag + ': no "Inbox" word on a phone');
    assert.equal(await frame().evaluate(() => document.documentElement.hasAttribute('data-bar-tools')), false, tag + ': no title-bar host, own toolbar kept');
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
  // ---- Inside a Wizard window: QR / Search / Settings in the shell's title bar, chips straight on the dock ----
  for (const [skin, scheme] of Object.entries(SHELL_SKINS)) {
    const tag = 'wizard-' + skin;
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await shellRoute(ctx);
    await ctx.route(st.origin + '/__wizard_shell.html', r => r.fulfill({contentType: 'text/html', body: shellPage(skin)}));
    await ctx.addInitScript(([s, tokens]) => {
      if (location.pathname.endsWith('__wizard_shell.html')) return;
      const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v); return true; };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/__wizard_shell.html');
    const app = page.frameLocator('#w'), frame = () => page.frames().find(f => f !== page.mainFrame());
    await app.locator('.u-person', {hasText: 'Alice Example'}).first().waitFor();
    const tools = page.locator('.wbar > .wtools > .wtool');
    await page.waitForFunction(() => document.querySelectorAll('.wbar > .wtools > .wtool').length === 3, null, {timeout: 10000});
    await page.waitForTimeout(700);
    const win = await box(page.locator('#w'));
    assert.deepEqual(await tools.evaluateAll(b => b.map(x => x.getAttribute('aria-label'))), ['My QR codes', 'Search', 'Settings'], tag + ': three tools in the window bar');
    if (WEB) assert.deepEqual(await tools.evaluateAll(b => b.map(x => !!x.querySelector('svg') && x.textContent === '')), [true, true, true], tag + ': shell-drawn icons');
    const bar = await box(page.locator('.wbar'));
    for (const t of await tools.all()) {
      const b = await box(t); assert.ok(b.y >= bar.y - 0.5 && b.y + b.height <= bar.y + bar.height + 0.5, tag + ': tool inside the title bar');
      if (WEB) {
        assert.ok(b.width >= 44, tag + ': 44px wide tap target (' + b.width + ')');
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        for (const dy of [-21, 21]) assert.equal(await page.evaluate(([x, y, l]) => { const e = document.elementFromPoint(x, y); return !!e?.closest('[aria-label="' + l + '"]'); }, [cx, Math.max(1, cy + dy), await t.getAttribute('aria-label')]), true, tag + ': 44px tall hit area');
      }
    }
    // The toolbar row and the word "Inbox" are gone; the filter chips are the bottom row, on the dock.
    assert.equal(await frame().evaluate(() => document.documentElement.hasAttribute('data-bar-tools')), true, tag + ': title-bar mode');
    assert.equal(await app.locator('#unified-inbox > .u-header').isVisible(), false, tag + ': own toolbar hidden');
    assert.equal(await frame().evaluate(() => [...document.querySelectorAll('#messenger *')].some(e => e.offsetParent !== null && e.childElementCount === 0 && e.textContent.trim() === 'Inbox')), false, tag + ': no "Inbox" word');
    const chips = await box(app.locator('#u-filters')), list = await box(app.locator('.u-list')), fab = await box(app.locator('.u-fab'));
    assert.ok(Math.abs(chips.y + chips.height - (win.y + win.height)) <= 1, tag + ': chips end at the window bottom (' + (chips.y + chips.height) + ' vs ' + (win.y + win.height) + ')');
    const below = await frame().evaluate(y => [...document.querySelectorAll('#unified-inbox > *')].filter(e => e.id !== 'u-filters' && !e.classList.contains('u-fab') && e.getClientRects().length && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().top >= y - 1).map(e => e.className || e.id), chips.y - win.y);
    assert.deepEqual(below, [], tag + ': nothing below the chips');
    assert.ok(list.y - win.y < 10 && list.y + list.height <= chips.y + 1, tag + ': chats fill the space above the chips');
    assert.ok(fab.y + fab.height <= chips.y - 4 && fab.y + fab.height > chips.y - 40, tag + ': compose button just above the chips');
    await page.screenshot({path: path.join(out, tag + '-list.png')});
    const gone = async (why) => { await page.waitForFunction(() => !document.querySelector('.wbar > .wtools'), null, {timeout: 5000}).catch(() => { throw new Error(tag + ': tools clear for ' + why); }); };
    const back3 = async (why) => { await page.waitForFunction(() => document.querySelectorAll('.wbar > .wtools > .wtool').length === 3, null, {timeout: 5000}).catch(() => { throw new Error(tag + ': tools return after ' + why); }); };
    // QR -> My QR codes sheet; tools clear while it is open and come back after.
    await page.getByRole('button', {name: 'My QR codes'}).tap(); await app.locator('.u-sheet').waitFor(); await gone('qr');
    await app.locator('.u-sheet header .icon-button[aria-label=Close]').tap(); await back3('QR sheet');
    // Search -> search field reachable at the bottom; Close search restores.
    await page.getByRole('button', {name: 'Search', exact: true}).tap(); const field = app.locator('input.u-search'); await field.waitFor(); await gone('search');
    const fb = await box(field); assert.ok(fb.y > win.y + FRAME_H - 90 && fb.y + fb.height <= win.y + win.height + 0.5, tag + ': search field in reach');
    await page.screenshot({path: path.join(out, tag + '-search.png')});
    await app.getByRole('button', {name: 'Close search'}).tap(); await back3('search');
    // Settings -> Settings sheet.
    await page.locator('.wbar [data-tool=settings]').tap(); await app.locator('.u-sheet').waitFor(); await gone('settings'); await page.waitForTimeout(350);
    await page.screenshot({path: path.join(out, tag + '-settings.png')});
    await app.locator('.u-sheet header .icon-button[aria-label=Close]').tap(); await back3('settings');
    // A chat: tools clear (the thread header owns the top); Back brings them back.
    await app.locator('.u-person', {hasText: 'Alice Example'}).first().tap(); await app.locator('textarea[aria-label="Message"]').waitFor(); await gone('thread');
    await app.getByRole('button', {name: 'Back', exact: true}).tap(); await back3('thread');
    // A reconnect warning shows as the dot on the Settings tool.
    await frame().evaluate(() => { const b = document.querySelector('.u-settings-btn'); b.classList.add('warn'); b.setAttribute('aria-label', 'Settings, WhatsApp needs reconnecting'); document.getElementById('unified-inbox').dataset.view = 'list'; });
    await page.waitForFunction(() => document.querySelector('.wbar [data-tool=settings]')?.getAttribute('aria-label') === 'Settings, WhatsApp needs reconnecting', null, {timeout: 5000});
    if (WEB) assert.equal(await page.locator('.wbar [data-tool=settings]').evaluate(b => b.classList.contains('wtool-dot') && getComputedStyle(b, '::after').content !== 'none'), true, tag + ': attention dot');
    await page.screenshot({path: path.join(out, tag + '-bar-dot.png'), clip: {x: 0, y: 0, width: 390, height: 120}});
    // Wider than a phone: tools go, the desktop header is back on top.
    await page.evaluate(() => { document.querySelector('.win').style.width = '900px'; });
    await gone('desktop width'); await page.waitForTimeout(300);
    assert.equal(await frame().evaluate(() => document.documentElement.hasAttribute('data-bar-tools')), false, tag + ': desktop width leaves title-bar mode');
    const dh = await box(app.locator('#unified-inbox > .u-header h1')); assert.ok(dh && dh.y - win.y < 40, tag + ': desktop header on top');
    await page.evaluate(() => { document.querySelector('.win').style.width = '390px'; }); await back3('phone width again');
    assert.deepEqual(errors, [], tag + ': no page errors');
    console.log('ok', tag);
    await ctx.close();
  }
  // ---- Desktop keeps the controls on top ----
  {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 860}});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await shellRoute(ctx);
    const page = await ctx.newPage(); await page.goto(st.origin + '/');
    await page.locator('.u-person', {hasText: 'Alice Example'}).first().waitFor(); await page.waitForTimeout(500);
    const s = await box(page.locator('.u-settings-btn')), c = await box(page.locator('#u-filters')), l = await box(page.locator('.u-list'));
    assert.ok(s.y < 30 && c.y < l.y, 'desktop: header and filters on top, unchanged');
    await page.screenshot({path: path.join(out, 'desktop-list.png')});
    await ctx.close();
  }
  await browser.close();
  console.log('PASS mobile_layout_browser: phone list/search/settings/thread/keyboard/back in standalone + Wizard window, dark + light; title-bar tools in a real shell window host (3 skins); desktop unchanged; shots in ' + out);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
