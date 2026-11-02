// Inbox filters in two rows (Miguel, 2 Nov 2026: "I don't want to scroll sideways"): All · Unread · Medium · Low as
// one equal-width segmented control, then one icon per network and Filters (Type, Labels). Networks that do not fit
// fold into "+N"; nothing scrolls sideways at 360/390/1280 with 9 bridged networks + Wizard + labels.
// Medium priority stays in All but never pings: no badge, Unread count/view, push or inbox feed (server side in
// test_unified.py / test_inbox_feed.py). Synthetic APIs only.
// node tests/filter_layout_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'filter-layout-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, low_priority: false, medium_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, ...extra});
const group = (...a) => { const p = person(...a); return {...p, identities: ident(p.id, p.identities[0].network, 'group', p.display_name)}; };
const NETS = ['whatsapp', 'telegram', 'signal', 'instagram', 'line', 'slack', 'twitter', 'linkedin', 'facebook'];
const LABELS = {whatsapp: 'WhatsApp', telegram: 'Telegram', signal: 'Signal', instagram: 'Instagram DMs', line: 'LINE', slack: 'Slack', twitter: 'X', linkedin: 'LinkedIn', facebook: 'Facebook'};
const SKINS = {
  dark: {canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
};
const CASES = [
  {label: '360', viewport: {width: 360, height: 740}, scheme: 'dark', bar: false},
  {label: '390', viewport: {width: 390, height: 844}, scheme: 'light', bar: true},
  {label: '1280', viewport: {width: 1280, height: 860}, scheme: 'dark', bar: false, offset: true},
];
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const {label, viewport, scheme, bar, offset} of CASES) {
    const PEOPLE = [
      person('james', 'James Carter', 'whatsapp', 'On my way', 2, {unread: 1, labels: ['Work']}),
      person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow', 40),
      person('sig', 'Sam Signal', 'signal', 'ok', 50, {unread: 2}),
      person('ig', 'Ines Insta', 'instagram', 'lol', 60),
      person('sl', 'Sasha Slack', 'slack', 'PR ready', 70, {labels: ['Work']}),
      person('tw', 'Theo X', 'twitter', 'dm', 80),
      person('li', 'Lena LinkedIn', 'linkedin', 'Hello', 90),
      person('fb', 'Fay Facebook', 'facebook', 'Hey', 100),
    ];
    const GROUPS = [
      group('news', 'News Bot', 'telegram', 'Headline', 3, {unread: 5, medium_priority: true}),
      group('promo', 'Deals Channel', 'telegram', 'Flash sale!', 5, {unread: 7, low_priority: true}),
      group('fam', 'Family', 'whatsapp', 'Dinner Sunday?', 12, {unread: 2, labels: ['Family']}),
    ];
    const posted = [], badges = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: viewport.width < 600});
    await ctx.exposeBinding('__badge', (_, n) => badges.push(n));
    await ctx.addInitScript(([s, tokens, bar]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: n => window.__badge(n)},
        ...(bar ? {titlebar: {set: () => Promise.resolve(true)}} : {})};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v);
        r.style.background = tokens.glass;
        return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme], bar]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Private Alice'}, {member_id: ownKey}]};
    const PRIVATE = [{message_id: 'e'.repeat(64), group_id: dm.group_id, author: peerKey, direction: 'received', text: 'Hi there', created_at: (now - 30 * min) / 1000}];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: [dm]});
      if (p.startsWith('api/dms/') && p.endsWith('/messages')) return ok({messages: PRIVATE, next_cursor: null});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (req.method() === 'POST') { const body = JSON.parse(req.postData() || '{}'); posted.push([id, body]); Object.assign(pr, body); return ok(pr); }
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers: NETS.map(n => ({network: n, label: LABELS[n], supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}))});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const rows = async () => (await page.locator('.u-list > .u-person strong').allTextContents()).map(t => t.trim());
    const seg = v => page.locator(`#u-filters .u-seg-btn[data-seg=${v}]`);
    await page.goto('https://messenger.test/');
    if (offset) await page.addStyleTag({content: '#messenger { position: fixed !important; left: 120px !important; top: 60px !important; width: 1000px !important; height: 760px !important; }'});
    await page.locator('.u-person', {hasText: 'Private Alice'}).waitFor({timeout: 15000});
    await page.locator('#u-filters .u-nets .u-chip.net[data-filter="net:facebook"]').waitFor({state: 'attached'});
    await page.waitForTimeout(300);

    // ---- Nothing scrolls sideways; everything stays inside its row. ----
    const layout = () => page.evaluate(() => {
      const box = document.querySelector('#u-filters'), out = {};
      for (const sel of ['#u-filters', '#u-filters .u-seg', '#u-filters .u-netrow', '#u-filters .u-nets']) { const e = document.querySelector(sel); out[sel] = [e.scrollWidth, e.clientWidth, getComputedStyle(e).overflowX]; }
      const b = box.getBoundingClientRect(), outside = [];
      for (const el of box.querySelectorAll('button')) { if (el.hidden || !el.offsetWidth) continue; const r = el.getBoundingClientRect(); if (r.left < b.left - 0.5 || r.right > b.right + 0.5) outside.push(el.getAttribute('aria-label') || el.textContent); }
      const segs = [...box.querySelectorAll('.u-seg-btn')].map(e => e.getBoundingClientRect().width);
      const m = document.querySelector('#messenger').getBoundingClientRect();
      return {out, outside, segs, segRow: box.querySelector('.u-seg').getBoundingClientRect().width, boxW: b.width, docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visibleNets: [...box.querySelectorAll('.u-nets .u-chip.net')].filter(e => !e.hidden).map(e => e.dataset.filter), more: box.querySelector('.u-more-nets').hidden ? '' : box.querySelector('.u-more-nets').textContent,
        filters: box.getBoundingClientRect(), list: document.querySelector('.u-list').getBoundingClientRect(), host: {top: m.top, bottom: m.bottom, left: m.left, right: m.right}};
    });
    let L1 = await layout();
    for (const [sel, [sw, cw]] of Object.entries(L1.out)) assert.ok(sw <= cw + 1, `${sel} does not overflow sideways (${sw} > ${cw}) at ${label}`);
    assert.deepEqual(L1.outside, [], 'every filter control inside its row');
    assert.ok(L1.docOver <= 0, 'page never scrolls sideways');
    assert.equal(L1.segs.length, 4);
    assert.ok(Math.max(...L1.segs) - Math.min(...L1.segs) < 1, 'four equal segments: ' + L1.segs);
    assert.ok(L1.segRow >= L1.boxW - 40, 'segmented control spans the row');
    assert.deepEqual(await page.locator('#u-filters .u-seg-btn .u-seg-text').allTextContents(), ['All', 'Unread', 'Medium', 'Low']);
    assert.equal(await seg('all').getAttribute('aria-checked'), 'true', 'exactly one segment on: All');
    assert.equal(await page.locator('#u-filters .u-seg-btn[aria-checked=true]').count(), 1);
    if (viewport.width < 600) {
      assert.ok(L1.more, 'networks that do not fit fold into +N at ' + label);
      assert.equal(Number(L1.more.slice(1)) + L1.visibleNets.length, 10, '+N + visible = 9 networks + Wizard');
      // Both rows sit at the bottom, under the list (on top of the Wizard dock when the title bar holds the tools).
      assert.ok(L1.filters.top >= L1.list.bottom - 1, 'filters below the list on a phone');
      if (bar) { assert.ok(await page.evaluate(() => document.documentElement.hasAttribute('data-bar-tools'))); assert.ok(L1.host.bottom - L1.filters.bottom <= 8, 'flush on the dock: ' + (L1.host.bottom - L1.filters.bottom)); }
    } else {
      assert.equal(L1.more, '', 'every network fits at ' + label);
      assert.ok(L1.filters.bottom <= L1.list.top + 1, 'filters on top of the list on desktop');
    }
    // Network buttons: icon only, greyscale until chosen.
    const grey = await page.locator('#u-filters .u-nets .u-chip.net:not([hidden]) .u-chip-icon').first().evaluate(e => getComputedStyle(e).filter);
    assert.match(grey, /grayscale/, 'network icons greyscale until chosen');

    // ---- Medium priority: listed in All, never counted, never in Unread, the Medium segment shows only it. ----
    await page.waitForTimeout(300);
    assert.equal(badges.at(-1), 4, 'badge = james, sig, fam, private (Medium and Low never count)');
    assert.equal(await page.locator('[data-seg=unread] .u-seg-count').textContent(), '4', 'Unread count skips Medium');
    assert.equal(await page.locator('[data-seg=medium] .u-seg-count').textContent(), '1', 'Medium shows its own quiet count');
    assert.ok((await rows()).includes('News Bot'), 'Medium chat stays in All');
    assert.ok(!(await rows()).includes('Deals Channel'), 'Low chat is not in All');
    assert.equal(await page.locator('.u-person', {hasText: 'News Bot'}).locator('.u-badge.muted').count(), 1, 'Medium chat has a quiet badge');
    await seg('unread').click();
    assert.deepEqual((await rows()).sort(), ['Family', 'James Carter', 'Private Alice', 'Sam Signal'], 'Unread never lists Medium or Low');
    await seg('medium').click();
    assert.deepEqual(await rows(), ['News Bot'], 'Medium lists only Medium chats');
    assert.equal(await page.locator('#u-filters .u-seg-btn[aria-checked=true]').count(), 1);
    await seg('low').click();
    assert.deepEqual(await rows(), ['Deals Channel'], 'Low lists only Low chats');
    await seg('all').click();

    // Priority from the row menu: Medium and Low are exclusive.
    const setPriority = async (who, level) => {
      const row = page.locator('.u-person', {hasText: who});
      if (viewport.width < 600) { const b = await row.boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, {button: 'right'}); } else await row.click({button: 'right'});
      await page.getByRole('menuitem', {name: /^Priority: /}).click();
      const items = await page.getByRole('menuitemradio').evaluateAll(els => els.map(e => [e.textContent.trim(), e.getAttribute('aria-checked')]));
      assert.deepEqual(items.map(i => i[0]), ['Normal', 'Medium', 'Low']);
      assert.equal(items.filter(i => i[1] === 'true').length, 1, 'one priority checked');
      await page.getByRole('menuitemradio', {name: level, exact: true}).click();
    };
    await setPriority('James Carter', 'Medium');
    assert.deepEqual(posted.at(-1), ['james', {low_priority: false, medium_priority: true}]);
    await page.waitForTimeout(250);
    assert.equal(badges.at(-1), 3, 'Medium leaves the badge');
    assert.ok((await rows()).includes('James Carter'), 'still in All');
    await seg('medium').click();
    assert.deepEqual((await rows()).sort(), ['James Carter', 'News Bot']);
    await setPriority('James Carter', 'Low');
    assert.deepEqual(posted.at(-1), ['james', {low_priority: true, medium_priority: false}], 'Low clears Medium');
    assert.deepEqual(await rows(), ['News Bot'], 'no longer Medium');
    await seg('low').click();
    assert.deepEqual((await rows()).sort(), ['Deals Channel', 'James Carter']);
    await setPriority('James Carter', 'Normal');
    assert.deepEqual(posted.at(-1), ['james', {low_priority: false, medium_priority: false}]);
    await seg('all').click();
    // The Wizard chat (device record) takes Medium too.
    await setPriority('Private Alice', 'Medium');
    await page.waitForTimeout(250);
    assert.equal(badges.at(-1), 3, 'private Medium chat leaves the badge');
    await seg('medium').click();
    assert.deepEqual((await rows()).sort(), ['News Bot', 'Private Alice']);
    await setPriority('Private Alice', 'Normal');
    await seg('all').click();

    // ---- Filters: Type and Labels in a menu placed against Messenger's box, with a dot when something is on. ----
    const dot = () => page.locator('#u-filters .u-filter-dot').evaluate(e => getComputedStyle(e).display !== 'none');
    assert.equal(await dot(), false, 'no dot by default');
    const filters = page.locator('#u-filters .u-filter-btn');
    await filters.click();
    const menu = page.locator('.u-menu.u-filter-menu');
    await menu.waitFor();
    assert.equal(await filters.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await menu.locator('.u-menu-head').allTextContents(), viewport.width < 600 ? ['Type', 'Labels', 'Networks'] : ['Type', 'Labels']);
    for (const t of await menu.locator('.u-menu-head').evaluateAll(els => els.map(e => getComputedStyle(e).textTransform))) assert.equal(t, 'none', 'sentence case headings');
    assert.ok(await menu.getByRole('menuitemradio', {name: 'Merged'}).count() === 0, 'Merged only when a merged chat exists');
    const place = await page.evaluate(() => {
      const m = document.querySelector('#messenger').getBoundingClientRect(), p = document.querySelector('.u-filter-menu .u-actions').getBoundingClientRect(), b = document.querySelector('#u-filters .u-filter-btn').getBoundingClientRect();
      return {m: [m.left, m.top, m.right, m.bottom], p: [p.left, p.top, p.right, p.bottom], b: [b.left, b.top, b.right, b.bottom]};
    });
    assert.ok(place.p[0] >= place.m[0] - 1 && place.p[2] <= place.m[2] + 1 && place.p[1] >= place.m[1] - 1 && place.p[3] <= place.m[3] + 1, 'menu inside Messenger: ' + JSON.stringify(place));
    if (viewport.width < 600) assert.ok(place.p[3] <= place.b[1] + 2, 'phone: the menu opens above the Filters button, not over it: ' + JSON.stringify(place));
    else { assert.ok(Math.abs(place.p[2] - place.b[2]) < 24 || Math.abs(place.p[0] - place.b[0]) < 24, 'desktop: lined up with the button ' + JSON.stringify(place)); assert.ok(place.p[1] >= place.b[3] - 2 && place.p[1] - place.b[3] < 24, 'desktop: just under the button ' + JSON.stringify(place)); }
    await shot('filters-menu');
    await menu.getByRole('menuitemradio', {name: 'Groups', exact: true}).click();
    assert.equal(await dot(), true, 'dot once a Type is on');
    assert.deepEqual((await rows()).sort(), ['Family', 'News Bot']);
    await filters.click(); await page.locator('.u-filter-menu').getByRole('menuitemradio', {name: 'Family', exact: true}).click();
    assert.deepEqual(await rows(), ['Family'], 'Groups + label Family');
    await filters.click(); await page.locator('.u-filter-menu').getByRole('menuitemradio', {name: 'All chats', exact: true}).click();
    assert.equal(await dot(), true, 'label still on');
    await filters.click(); await page.locator('.u-filter-menu').getByRole('menuitemradio', {name: 'Any label', exact: true}).click();
    assert.equal(await dot(), false, 'dot gone with defaults');
    assert.equal(await filters.getAttribute('aria-expanded'), 'false');

    // ---- Networks: a folded network chosen from +N stays visible in the row and narrows the view. ----
    if (viewport.width < 600) {
      const folded = (await layout()), hidden = ['net:facebook', 'net:instagram', 'net:line', 'net:linkedin', 'net:signal', 'net:slack', 'net:telegram', 'net:whatsapp', 'net:twitter', 'net:private'].find(n => !folded.visibleNets.includes(n));
      const name = {net_private: 'Wizard'}[hidden.replace(':', '_')] || LABELS[hidden.slice(4)];
      await page.locator('#u-filters .u-more-nets').click();
      const m2 = page.locator('.u-menu.u-filter-menu');
      assert.equal(await m2.locator('.u-menu-head').first().textContent(), 'Networks', '+N opens the menu at the networks');
      await m2.getByRole('menuitemradio', {name, exact: true}).click();
      const after = await layout();
      assert.ok(after.visibleNets.includes(hidden), 'chosen network moves into view');
      assert.equal(await page.locator(`#u-filters [data-filter="${hidden}"]`).getAttribute('aria-pressed'), 'true');
      for (const [sel, [sw, cw]] of Object.entries(after.out)) assert.ok(sw <= cw + 1, `${sel} still fits after choosing`);
      await page.locator(`#u-filters [data-filter="${hidden}"]`).click();
    }
    const wa = page.locator('#u-filters [data-filter="net:whatsapp"]');
    if (await wa.isHidden()) { await page.locator('#u-filters .u-more-nets').click(); await page.locator('.u-filter-menu').getByRole('menuitemradio', {name: 'WhatsApp', exact: true}).click(); }
    else await wa.click();
    assert.equal(await wa.isVisible(), true, 'the chosen network is in the row');
    assert.deepEqual((await rows()).sort(), ['Family', 'James Carter'], 'WhatsApp narrows All');
    await seg('unread').click();
    assert.equal(await page.locator('[data-seg=unread] .u-seg-count').textContent(), '2');
    await page.locator('#u-filters [data-filter="net:whatsapp"]').click();
    await seg('all').click();
    await page.mouse.move(2, 2); await page.waitForTimeout(300);
    await shot('inbox');
    L1 = await layout();
    for (const [sel, [sw, cw]] of Object.entries(L1.out)) assert.ok(sw <= cw + 1, `${sel} fits at the end`);
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${label}/${scheme}${bar ? '/bar' : ''}${offset ? '/offset' : ''}`);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS filter_layout_browser: ' + summary.join(', ') + ' · two rows, no sideways scroll, equal segments, +N fold, Medium/Low exclusive, Filters dot + menu placement');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
