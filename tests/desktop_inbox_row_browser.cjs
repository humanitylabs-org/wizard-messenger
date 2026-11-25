// Issue 409: on the desktop shell, Messenger's Inbox row (QR, Agent/Reports, Search, Settings) stays on top at every
// window width and never moves into the window title bar (that row holds the desktop width buttons). The filter rows
// (All / Unread / ... and the network icons) sit at the bottom of the chat list at every width, desktop and phone,
// so resizing across 600 px moves nothing between top and bottom. The phone shell keeps its title-bar tools.
// Messenger runs framed in a stand-in Wizard page that carries the shell's own html data-shell, like Wizard's
// desktop.html / index.html. Synthetic API, no container:
//   PLAYWRIGHT_MODULE=... node tests/desktop_inbox_row_browser.cjs [outdir]
//   BEFORE=1 STATIC_DIR=<main>/static ...   (shots of the old layout, no asserts)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'desktop-inbox-row-shots');
const BEFORE = process.env.BEFORE === '1';
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name, i) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: i % 2 ? 'signal' : 'line', kind: 'person', label: name}], labels: [], unread: i % 3 ? 0 : 1, muted: false, low_priority: false, last: {text: 'Hi there ' + i, timestamp: now - i * min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = ['Anna Lee', 'Ben Ito', 'Cara Diaz', 'Dan Moss', 'Eve Hart', 'Finn Roe'].map((n, i) => base(n.split(' ')[0].toLowerCase(), n, i));
// A photo skin the way the shell hosts an app: transparent canvas over a picture-like glass (agents_panel_browser).
const SKINS = {
  dark: null,
  landscapes: {scheme: 'dark', tokens: {canvas: 'transparent', base: '#0B0A10', text: '#ffffff', 'text-secondary': 'rgba(255,255,255,.80)', 'text-muted': 'rgba(255,255,255,.58)', border: 'rgba(255,255,255,.28)', accent: '#7A5CFF', 'on-accent': '#ffffff'},
    glass: 'linear-gradient(160deg,#2b2340,#141a2e 55%,#3a2a2a)'},
};

async function open(browser, {width, height = 800, shell = 'desktop', mobile = false, skin = 'dark'}) {
  const ctx = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: mobile, isMobile: mobile});
  await ctx.addInitScript(look => {
    if (location.pathname === '/wizard.html') return;
    const noop = () => {};
    window.__bar = {tools: null, calls: 0};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      // Wizard's title-bar service accepts tools on both shells (app-services setTools); the app decides whether to ask.
      titlebar: {set: (tools, fn) => { window.__bar = {tools, fn, calls: window.__bar.calls + 1}; return true; }}};
    const mark = () => {
      const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = '';
      if (look) { r.dataset.colorScheme = look.scheme; for (const [k, v] of Object.entries(look.tokens)) r.style.setProperty('--wz-' + k, v); r.style.background = look.glass; }
      return true;
    };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, SKINS[skin]);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'wizard.html') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html data-shell="${shell}"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#222"><iframe id="app" src="/" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`});
    if (p === 'notifications/api/items') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({items: []})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity: {account_id: '11'.repeat(32), npub: L.encodePublic('11'.repeat(32)), display_name: 'Owner'}});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) return ok({entries: [], unread: 0, urgent: false, sweep_open: false, read_at: 0, agent: {woken: false, checked: true}, reports_unread: 0, reports_read_at: 0});
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/people/')) { const who = PEOPLE.find(x => p === 'api/unified/people/' + x.id); if (who) return ok({person: who, messages: [], has_more: false, seq: 5}); }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/wizard.html');
  const app = page.frameLocator('#app');
  await app.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
  await page.waitForTimeout(700);
  const frame = () => page.frames().find(f => f.url() === 'https://messenger.test/');
  return {ctx, page, errors, app, frame};
}
// Where the Inbox row, the chats, the filter rows, the compose button and a toast are in the list pane.
const layout = f => f.evaluate(() => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return b.height > 0 ? {top: Math.round(b.top), bottom: Math.round(b.bottom)} : null; };
  const pane = document.querySelector('.u-pane-list') || document.getElementById('unified-inbox');
  const toast = document.createElement('p'); toast.className = 'u-toast'; toast.textContent = 'Saved'; document.getElementById('messenger').append(toast);
  const t = r(toast); toast.remove();
  return {bar: document.documentElement.hasAttribute('data-bar-tools'), header: r(pane.querySelector(':scope > .u-header')),
    tools: [...pane.querySelectorAll('.u-head-actions > button')].filter(b => b.getBoundingClientRect().height > 0).map(b => b.getAttribute('aria-label')),
    list: r(pane.querySelector(':scope > .u-list')), filters: r(pane.querySelector(':scope > #u-filters')), fab: r(pane.querySelector(':scope > .u-fab')), toast: t,
    titlebar: (window.__bar.tools || []).map(x => x.id), height: innerHeight};
});
function filtersAtBottom(g, where) {
  assert.ok(g.filters, where + ': filter rows shown');
  assert.ok(Math.abs(g.filters.bottom - g.height) <= 1, where + ': filter rows end at the bottom ' + JSON.stringify(g));
  assert.ok(g.list.bottom <= g.filters.top + 1, where + ': chats above the filter rows');
  assert.ok(g.fab.bottom <= g.filters.top, where + ': compose button clear of the filter rows');
  assert.ok(g.toast.bottom <= g.filters.top, where + ': toasts clear of the filter rows');
}
function desktopRow(g, where) {
  assert.equal(g.bar, false, where + ': no title-bar mode');
  assert.deepEqual(g.titlebar, [], where + ': nothing published to the window title bar');
  assert.ok(g.header && g.header.top <= 1, where + ': Inbox row on top');
  for (const name of ['My QR codes', 'Search', 'Settings']) assert.ok(g.tools.includes(name), where + ': ' + name + ' in the Inbox row');
  assert.ok(g.list.top >= g.header.bottom - 1, where + ': chats under the Inbox row');
}

(async () => {
  const browser = await chromium.launch();
  try {
    // 1. Desktop shell at the three widths the issue names, on the dark fallback and a photo skin. Each tool opens.
    for (const skin of Object.keys(SKINS)) for (const width of [1200, 700, 420]) {
      const t = await open(browser, {width, skin}), f = t.frame(), where = `desktop ${skin} ${width}`;
      const g = await layout(f);
      await t.page.screenshot({path: path.join(out, `desktop-${skin}-${width}.png`)});
      if (!BEFORE) {
        desktopRow(g, where); filtersAtBottom(g, where);
        const head = t.app.locator('.u-header .u-head-actions');
        await head.getByRole('button', {name: 'My QR codes'}).click();
        await t.app.locator('.u-sheet[aria-label="My QR codes"]').waitFor({timeout: 5000});
        await t.app.locator('.u-sheet').getByRole('button', {name: 'Close'}).click();
        await head.getByRole('button', {name: 'Settings'}).click();
        await t.app.locator('.u-sheet[aria-label="Settings"]').waitFor({timeout: 5000});
        await t.page.screenshot({path: path.join(out, `desktop-${skin}-${width}-settings.png`)});
        const panel = await t.app.locator('.u-sheet[aria-label="Settings"]').evaluate(e => getComputedStyle(e).backgroundColor);
        assert.doesNotMatch(panel, /rgba\(0, 0, 0, 0\)|transparent/, where + ': Settings panel is opaque');
        await t.app.locator('.u-sheet').getByRole('button', {name: 'Close'}).click();
        await head.getByRole('button', {name: 'Search'}).click();
        await t.app.locator('input.u-search').waitFor({timeout: 5000});
        const s = await f.evaluate(() => document.querySelector('input.u-search').getBoundingClientRect().top);
        assert.ok(s < 60, where + ': the search field opens on top');
        // The filter menu opens from the bottom rows and stays on screen.
        await t.app.getByRole('button', {name: 'Close search'}).click();
        await t.app.locator('.u-filter-btn').click();
        const m = await t.app.locator('.u-menu.u-filter-menu').evaluate(e => { const b = e.getBoundingClientRect(); return {top: b.top, bottom: b.bottom}; });
        assert.ok(m.top >= 0 && m.bottom <= g.height, where + ': filter menu on screen ' + JSON.stringify(m));
        assert.deepEqual(t.errors, [], where + ': no page errors');
      }
      await t.ctx.close();
      console.log('ok', where);
    }
    // 2. Resizing the desktop window across 600 px moves nothing between top and bottom.
    {
      const t = await open(browser, {width: 1200}), f = t.frame(), seen = [];
      for (const width of [1200, 760, 620, 590, 420, 590, 700, 1200]) {
        await t.page.setViewportSize({width, height: 800}); await t.page.waitForTimeout(400);
        const g = await layout(f); seen.push([width, g.header?.top, g.filters?.top]);
        if (!BEFORE) { desktopRow(g, 'resize ' + width); filtersAtBottom(g, 'resize ' + width); }
      }
      if (!BEFORE) assert.equal((await f.evaluate(() => window.__bar.calls)) <= 1, true, 'desktop never hands tools to the title bar');
      console.log('ok resize', JSON.stringify(seen));
      await t.ctx.close();
    }
    // 3. An open chat in the desktop split: the list pane keeps its rows at the bottom, the chat is as before.
    {
      const t = await open(browser, {width: 1200}), f = t.frame();
      await t.app.locator('.u-person', {hasText: 'Anna Lee'}).first().click();
      await t.app.locator('.u-thread-head').waitFor({timeout: 5000}); await t.page.waitForTimeout(500);
      const g = await layout(f);
      const thread = await f.evaluate(() => { const h = document.querySelector('.u-thread-head').getBoundingClientRect(), c = document.querySelector('.u-composer').getBoundingClientRect(); return {head: Math.round(h.top), composer: Math.round(c.bottom)}; });
      await t.page.screenshot({path: path.join(out, 'desktop-split-chat.png')});
      if (!BEFORE) { desktopRow(g, 'split'); filtersAtBottom({...g, fab: g.fab || {bottom: 0}}, 'split'); assert.ok(thread.head <= 1 && Math.abs(thread.composer - 800) <= 1, 'split: chat header on top, composer at the bottom'); }
      console.log('ok split', JSON.stringify(thread));
      await t.ctx.close();
    }
    // 4. Phone shell: phone width keeps its title-bar tools (as today); a wide phone window also has the rows at the bottom.
    {
      const t = await open(browser, {width: 412, height: 860, shell: 'phone', mobile: true}), g = await layout(t.frame());
      await t.page.screenshot({path: path.join(out, 'phone-412.png')});
      if (!BEFORE) {
        assert.equal(g.bar, true, 'phone: title-bar mode'); assert.equal(g.header, null, 'phone: own row hidden as today');
        assert.deepEqual(g.titlebar, ['qr', 'agent-rows', 'search', 'settings'], 'phone: tools in the title bar as today');
        filtersAtBottom(g, 'phone 412');
      }
      await t.ctx.close(); console.log('ok phone 412');
      const w = await open(browser, {width: 760, height: 412, shell: 'phone', mobile: true}), h = await layout(w.frame());
      await w.page.screenshot({path: path.join(out, 'phone-760.png')});
      if (!BEFORE) { assert.ok(h.header && h.header.top <= 1, 'wide phone: Inbox row on top'); filtersAtBottom(h, 'phone 760'); }
      await w.ctx.close(); console.log('ok phone 760');
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
