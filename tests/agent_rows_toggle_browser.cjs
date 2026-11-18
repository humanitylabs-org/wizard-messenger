// Issue 291 (switch agent-rows-toggle): a button right beside My QR codes hides the pinned Agent and Reports chats
// from the list, and a second tap shows them again. It shows its state (aria-pressed, label saying what a tap does),
// the choice survives a reload (kept on this device, like the Inbox view), and an open Agent chat stays open. At phone
// width inside Wizard it rides the shell title bar right after QR. No button when Agent chat and Notifications in
// Reports are both off, and with the switch off the rows show as before even if the device once hid them.
// Synthetic API, no container:
//   PLAYWRIGHT_MODULE=... node tests/agent_rows_toggle_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-rows-toggle-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee'), base('ben', 'Ben Ito')];

async function open(browser, on, viewport, {hidden = false} = {}) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(hide => {
    const noop = () => {};
    window.__bar = {tools: null, fn: null};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      titlebar: {set: (tools, fn) => { window.__bar = {tools, fn}; return true; }}};
    if (hide && !sessionStorage.getItem('seeded')) { localStorage.setItem('messenger.agentRowsHidden', '1'); sessionStorage.setItem('seeded', '1'); }
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, hidden);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const entries = [{id: 'p1', kind: 'report', by: 'agent', agent: 'Oscar', text: 'Weekly social stats', link: null, items: [], at: now - 30 * min},
    {id: 'n1', kind: 'note', by: 'owner', text: 'Call the plumber', at: now - 20 * min}];
  const state = () => ({entries, unread: 0, urgent: false, sweep_open: false, read_at: 0, agent: {woken: false, checked: true}, reports_unread: 0, reports_read_at: 0});
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const sw = (id, v) => ({id, name: id, description: 'x', on: !!v, default: false, tried: false, vote: null, issues: []});
  const switches = [sw('agent-chat', on.agentChat), sw('reports-notifications', on.notices), sw('agent-rows-toggle', on.toggle)];
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'notifications/api/items') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({items: []})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) return ok(state());
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  const load = async () => {
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
    await page.waitForTimeout(1200);
  };
  await load();
  const pinned = () => page.locator('.u-list > .u-agent-row').evaluateAll(els => els.map(e => e.dataset.mode));
  const btn = page.locator('.u-head-actions .u-agent-toggle');
  const bar = () => page.evaluate(() => (window.__bar.tools || []).map(t => ({id: t.id, text: t.text, label: t.label})));
  return {ctx, page, errors, load, pinned, btn, bar};
}

(async () => {
  const browser = await chromium.launch();
  try {
    // Desktop: the header button right after My QR codes.
    {
      const t = await open(browser, {agentChat: true, toggle: true}, {width: 1280, height: 800});
      assert.deepEqual(await t.pinned(), ['chat', 'reports'], 'desktop: both rows to start with');
      const order = await t.page.locator('.u-head-actions > button:not([hidden])').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
      assert.equal(order[0], 'My QR codes'); assert.equal(order[1], 'Hide Agent and Reports', 'desktop: toggle right after QR');
      assert.equal(await t.btn.getAttribute('aria-pressed'), 'false');
      await t.page.screenshot({path: path.join(out, 'desktop-shown.png')});
      await t.btn.click();
      assert.deepEqual(await t.pinned(), [], 'desktop: a tap hides both rows');
      assert.equal(await t.btn.getAttribute('aria-pressed'), 'true');
      assert.equal(await t.btn.getAttribute('aria-label'), 'Show Agent and Reports');
      assert.equal(await t.page.locator('.u-person', {hasText: 'Anna Lee'}).count() > 0, true, 'desktop: other chats stay');
      await t.page.screenshot({path: path.join(out, 'desktop-hidden.png')});
      await t.load();
      assert.deepEqual(await t.pinned(), [], 'desktop: still hidden after reload');
      assert.equal(await t.btn.getAttribute('aria-pressed'), 'true', 'desktop: pressed after reload');
      await t.btn.click();
      assert.deepEqual(await t.pinned(), ['chat', 'reports'], 'desktop: a second tap shows them again');
      assert.equal(await t.btn.getAttribute('aria-label'), 'Hide Agent and Reports');
      // An open Agent chat stays open when the rows are hidden.
      await t.page.locator('.u-agent-row[data-mode="chat"]').click();
      await t.page.locator('.u-agent-head').waitFor({timeout: 5000});
      await t.btn.click();
      assert.deepEqual(await t.pinned(), [], 'desktop: hidden with the chat open');
      assert.equal(await t.page.locator('.u-agent-head').count(), 1, 'desktop: the open Agent chat stays open');
      assert.deepEqual(t.errors, [], 'desktop: no page errors');
      await t.ctx.close();
    }
    // Phone width inside Wizard: the shell title bar carries the toggle right after QR.
    {
      const t = await open(browser, {notices: true, toggle: true}, {width: 390, height: 800});
      assert.deepEqual(await t.pinned(), ['reports'], 'phone: Reports row with only Notifications in Reports on');
      let tools = await t.bar();
      assert.deepEqual(tools.map(x => x.id), ['qr', 'agent-rows', 'search', 'settings'], 'phone: bar tool after QR');
      assert.equal(tools[1].label, 'Hide Agent and Reports');
      await t.page.screenshot({path: path.join(out, 'phone-shown.png')});
      await t.page.evaluate(() => window.__bar.fn({id: 'agent-rows'}));
      await t.page.waitForTimeout(200);
      assert.deepEqual(await t.pinned(), [], 'phone: a tap hides the row');
      tools = await t.bar();
      assert.equal(tools[1].label, 'Show Agent and Reports'); assert.equal(tools[1].text, 'Show Agent');
      await t.load();
      assert.deepEqual(await t.pinned(), [], 'phone: still hidden after reload');
      tools = await t.bar();
      assert.equal(tools.find(x => x.id === 'agent-rows')?.label, 'Show Agent and Reports', 'phone: state after reload');
      await t.page.evaluate(() => window.__bar.fn({id: 'agent-rows'}));
      await t.page.waitForTimeout(200);
      assert.deepEqual(await t.pinned(), ['reports'], 'phone: a second tap shows it again');
      assert.deepEqual(t.errors, [], 'phone: no page errors');
      await t.ctx.close();
    }
    // Nothing to hide: no button, no bar tool.
    for (const viewport of [{width: 1280, height: 800}, {width: 390, height: 800}]) {
      const t = await open(browser, {toggle: true}, viewport);
      assert.equal(await t.btn.isVisible(), false, 'nothing to hide: no header button');
      assert.equal((await t.bar()).some(x => x.id === 'agent-rows'), false, 'nothing to hide: no bar tool');
      await t.ctx.close();
    }
    // Switch off: rows show as before even with a stored hide, and no toggle anywhere.
    for (const viewport of [{width: 1280, height: 800}, {width: 390, height: 800}]) {
      const t = await open(browser, {agentChat: true}, viewport, {hidden: true});
      assert.deepEqual(await t.pinned(), ['chat', 'reports'], 'switch off: rows as before');
      assert.equal(await t.btn.isVisible(), false, 'switch off: no header button');
      assert.equal((await t.bar()).some(x => x.id === 'agent-rows'), false, 'switch off: no bar tool');
      await t.ctx.close();
    }
    console.log('agent_rows_toggle_browser: ok, shots in', out);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
