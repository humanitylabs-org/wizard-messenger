// Inbox view (James, 6 Nov 2026; in the list header ⋯ since issue 202): Inbox view, Chats (default: last message, group sender, time, unread badge) or Compact.
// Also dumps the row structure so the Chats rows can be diffed against the 15.15.1 build: STATIC_ROOT=<15.15.1 static dir> node tests/inbox_view_browser.cjs <outdir>.
// Synthetic API only; phone + desktop x two skins. node tests/inbox_view_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
// STATIC_ROOT points at another build's static dir (the 15.15.1 export) to dump the same rows for the layout comparison.
const root = path.resolve(process.env.STATIC_ROOT || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'inbox-view-shots');
const L = require(path.join(root, 'app.js')), BASELINE = !!process.env.STATIC_ROOT;
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, ...extra});
// Skin tokens as the Wizard shell posts them: the canvas is transparent when hosted (APPEARANCE.md).
const SKINS = {
  dark: {canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
};
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const scheme of ['dark', 'light']) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [
      person('james', 'James Carter', 'whatsapp', 'On my way, 10 minutes', 2, {last: {text: 'On my way, 10 minutes', timestamp: now - 2 * min, outgoing: true, sender: 'Owner'}, peer_read_ts: now}),
      person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow at the station, bring the documents', 40, {unread: 1}),
      person('marco', 'Marco Bianchi', 'telegram', 'Invoice sent', 300, {unread: 3, muted: true, identities: [{id: 'marco-t', network: 'telegram', kind: 'person', label: 'Marco'}, {id: 'marco-s', network: 'signal', kind: 'person', label: 'Marco'}]}),
    ];
    const GROUPS = [
      {...person('fam', 'Family', 'whatsapp', 'Dinner Sunday?', 12, {unread: 2}), identities: ident('fam', 'whatsapp', 'group', 'Family'), last: {text: 'Dinner Sunday?', timestamp: now - 12 * min, sender: 'Ana Souza', outgoing: false}},
      {...person('dev', 'Wizard devs', 'telegram', 'Shipped', 20), identities: ident('dev', 'telegram', 'group', 'Wizard devs'), last: {text: 'Shipped', timestamp: now - 20 * min, sender: 'Luca Rossi', outgoing: false}},
    ];
    const catalog = ['WizardOS'];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addInitScript(([s, tokens]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v);
        r.style.background = tokens.glass;
        return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const bad = (status, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'invalid_input', message}})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (req.method() === 'POST') { Object.assign(pr, body()); return ok(pr); }
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers: [
        {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'telegram', label: 'Telegram', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'signal', label: 'Signal', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'line', label: 'LINE', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}]});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const rowSig = () => page.$$eval('#unified-inbox .u-person', els => els.map(e => ({name: e.querySelector('strong')?.textContent, h: Math.round(e.getBoundingClientRect().height), kids: [...e.querySelectorAll('*')].map(x => x.tagName.toLowerCase() + '.' + (x.className.baseVal ?? x.className)).join(' '), text: e.innerText.replace(/\s+/g, ' ')})));
    const tall = async (loc, what) => { for (const b of await loc.all()) { const r = await b.boundingBox(); assert.ok(r && r.height >= 44 - 0.5 && r.width >= 44 - 0.5, what + ' tap target >= 44px: ' + JSON.stringify(r)); } };
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.waitForTimeout(400);
    // Default: Chats. Last message under each name, a group names its sender, time and unread badge.
    const sig = await rowSig();
    fs.writeFileSync(path.join(out, `rows-${label}-${scheme}.json`), JSON.stringify(sig, null, 1));
    await shot('chats');
    if (BASELINE) { summary.push(`baseline ${scheme}-${label}: ${sig.length} rows`); await ctx.close(); continue; }
    assert.equal(await page.locator('#messenger.u-compact').count(), 0, 'Chats is the default view');
    assert.equal(await page.locator('.u-person .u-snippet').count(), 5, 'every row has its last-message line');
    assert.match(await page.locator('.u-person', {hasText: 'James Carter'}).locator('.u-snippet').innerText(), /^You: On my way/);
    assert.match(await page.locator('.u-person', {hasText: 'Family'}).locator('.u-snippet').innerText(), /^Ana: Dinner Sunday\?/, 'a group row names the sender');
    assert.equal(await page.locator('.u-person', {hasText: 'Kenji'}).locator('.u-badge').innerText(), '1', 'unread badge');
    assert.ok(await page.locator('.u-person time.u-when').count() >= 5, 'time on every row');
    for (const r of sig) assert.ok(r.h >= 56, 'Chats rows are full rows (' + r.name + ' ' + r.h + 'px)');
    // List header ⋯ > Inbox view: two choices, saves at once, 44px targets.
    const more = page.locator('.u-inbox-more').first();
    await more.click(); const menu = page.locator('.u-menu.u-inbox-menu'); await menu.waitFor();
    assert.equal(await menu.locator('.u-act.checked').innerText(), 'Chats');
    await tall(menu.locator('.u-act'), 'Inbox view');
    await page.waitForTimeout(250); await shot('menu-chats');
    await menu.locator('.u-act', {hasText: 'Compact'}).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('messenger.inboxView')), 'compact', 'saved at once');
    await page.waitForTimeout(450);
    assert.equal(await page.locator('#messenger.u-compact').count(), 1);
    assert.equal(await page.locator('.u-person .u-snippet').count(), 0, 'Compact has no last-message line');
    const compact = await rowSig(); for (const r of compact) assert.ok(r.h >= 44 && r.h < sig.find(x => x.name === r.name).h, 'Compact rows are denser but still tappable (' + r.name + ' ' + r.h + ')');
    assert.ok(await page.locator('.u-person time.u-when').count() >= 5 && await page.locator('.u-person .u-badge').count() >= 3, 'Compact keeps time and badge');
    await shot('compact');
    await page.reload(); await page.locator('.u-person', {hasText: 'James Carter'}).waitFor();
    assert.equal(await page.locator('.u-person .u-snippet').count(), 0, 'Compact is remembered');
    await page.locator('.u-inbox-more').first().click();
    await page.locator('.u-menu.u-inbox-menu .u-act', {hasText: 'Chats'}).click(); await page.waitForTimeout(550);
    assert.equal(await page.locator('.u-person .u-snippet').count(), 5, 'back to Chats');
    assert.deepEqual((await rowSig()).map(r => r.kids), sig.map(r => r.kids), 'Chats rows are the same rows after a round trip');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${scheme}-${label}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
