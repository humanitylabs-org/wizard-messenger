// Sent vs received clarity, platform icons and platform filters, on the shipping static view with synthetic APIs.
// node tests/ui_clarity_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE). No real accounts, no network.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'ui-clarity-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const OWNER = 'Miguel Nieves'; // the owner's own display name: must never label an own message
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, ...extra});
const PEOPLE = [
  // The owner sent the last message to James from another device: the bridge sender is the owner's own name.
  person('james', 'James Carter', 'whatsapp', 'On my way, 10 minutes', 2, {last: {text: 'On my way, 10 minutes', timestamp: now - 2 * min, outgoing: true, sender: OWNER}, peer_read_ts: now}),
  person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow', 40, {unread: 1}),
  person('priya', 'Priya Raman', 'slack', 'Deck is in the shared folder', 95),
  person('marco', 'Marco Bianchi', 'telegram', 'Invoice sent', 300, {unread: 3}),
  person('lucia', 'Lucía Gómez', 'instagram', 'Loved the photos', 1500),
  person('sam', 'Sam Lee', 'signal', 'ok, thanks', 2900),
];
const GROUPS = [{...person('fam', 'Family', 'whatsapp', 'Dinner Sunday?', 12, {unread: 2, labels: ['Family']}), identities: ident('fam', 'whatsapp', 'group', 'Family'), last: {text: 'Dinner Sunday?', timestamp: now - 12 * min, sender: 'Ana Souza', outgoing: false}}];
const msg = (id, ago, outgoing, text, sender, extra = {}) => ({id, timestamp: now - ago * min, outgoing, original: text, sender, msgtype: 'm.text', network: 'whatsapp', reactions: [], ...extra});
const THREADS = {
  james: [
    msg('j1', 1500, false, 'Are we still on for Saturday?', 'James Carter'),
    msg('j2', 1499, true, 'Yes! 7pm at the usual place', OWNER),
    msg('j3', 1498.5, true, 'I booked a table', OWNER),
    msg('j4', 8, false, 'Running a bit late', 'James Carter'),
    msg('j5', 7.5, false, 'Order me a drink?', 'James Carter'),
    msg('j6', 3, true, 'Sure, the usual', OWNER, {reply: {id: 'j5', outgoing: false, sender: 'James Carter', text: 'Order me a drink?'}}),
    msg('j7', 2, true, 'On my way, 10 minutes', OWNER),
  ],
  fam: [
    msg('f1', 60, false, 'Who is cooking on Sunday?', 'Ana Souza'),
    msg('f2', 59.5, false, 'I can bring dessert', 'Ana Souza'),
    msg('f3', 40, false, 'I will do the roast', 'Pedro Souza'),
    msg('f4', 30, true, 'I will bring wine', OWNER),
    msg('f5', 12, false, 'Dinner Sunday?', 'Ana Souza'),
  ],
};
const providers = [
  {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: '+66 ••• 4821'}]},
  {network: 'telegram', label: 'Telegram', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: 'Fixture'}]},
  {network: 'line', label: 'LINE', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: 'Fixture'}]},
  {network: 'slack', label: 'Slack', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: 'Fixture'}]},
  {network: 'instagram', label: 'Instagram DMs', supported: true, state: 'degraded', flows: [{id: 'android', name: 'Native Android'}], logins: []},
  {network: 'signal', label: 'Signal', supported: true, state: 'disconnected', flows: [{id: 'qr', name: 'QR'}], logins: []},
];
(async () => {
  const browser = await chromium.launch();
  const summary = [];
  for (const scheme of ['dark', 'light']) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addInitScript(s => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      // What the Wizard shell does for a light skin (app-client applyTheme): mark the root's colour scheme.
      if (s === 'light') {
        const mark = () => { if (!document.documentElement) return false; document.documentElement.dataset.colorScheme = 'light'; return true; };
        if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
      }
    }, scheme);
    const page = await ctx.newPage(), errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')));
    page.on('request', r => { if (!r.url().startsWith('https://messenger.test/')) external.push(r.url()); });
    const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: OWNER};
    const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Private Alice'}, {member_id: ownKey}]};
    const pm = (id, ago, dir, text) => ({message_id: id.repeat(64), group_id: dm.group_id, author: dir === 'sent' ? ownKey : peerKey, direction: dir, text, created_at: (now - ago * min) / 1000});
    const PRIVATE = [pm('a', 50, 'received', 'Hi! Is this your Wizard address?'), pm('b', 49.6, 'received', 'Just checking it works'), pm('c', 48, 'sent', 'Yes, it is me'), pm('d', 47.8, 'sent', 'Private and end-to-end'), pm('e', 30, 'received', 'Great, talk soon')];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: [dm]});
      if (p.startsWith('api/dms/') && p.endsWith('/messages')) return ok({messages: url.searchParams.get('limit') === '1' ? PRIVATE.slice(-1) : PRIVATE, next_cursor: null});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) { const id = decodeURIComponent(thread[1]); const pr = [...PEOPLE, ...GROUPS].find(x => x.id === id); return ok({person: pr, messages: THREADS[id] || [], has_more: false, next_cursor: null, seq: 5, typing: []}); }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p === 'api/view/push') return ok({enabled: false});
      if (p === 'api/view/agent-access') return ok({mode: 'no_access', enabled: false, log: []});
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const settle = () => page.waitForTimeout(350);
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Private Alice'}).waitFor({timeout: 15000});
    await page.locator('.u-acct-dot').first().waitFor();
    assert.equal(await page.locator('.u-person').count(), PEOPLE.length + GROUPS.length + 1, 'one unified Inbox: bridged, group and private');

    // Platform icons are inline SVG paths (no runtime image/CDN), on every row avatar, chip, strip and card.
    for (const row of await page.locator('.u-person').all()) {
      const net = await row.getAttribute('data-network');
      assert.ok(net, 'row has a network');
      assert.equal(await row.locator(`.u-av-wrap .u-net[data-network="${net}"] svg.brand-icon path`).count(), 1, 'row avatar wears the ' + net + ' glyph');
    }
    assert.equal(await page.locator('img[src^="http"], [style*="url("]').count(), 0, 'no remote images');

    // Inbox preview: own last message reads "You:", never the owner's name.
    const james = page.locator('.u-person', {hasText: 'James Carter'});
    assert.equal((await james.locator('.u-snippet').textContent()).trim(), 'You: On my way, 10 minutes');
    assert.equal(await page.locator('.u-list', {hasText: OWNER}).count(), 0, 'owner name never shown in the Inbox');
    assert.match(await page.locator('.u-person', {hasText: 'Family'}).locator('.u-snippet').textContent(), /^Ana: /, 'group preview names the other sender');

    // Chips: All, Unread, one per platform (with icon), Private, then Direct/Groups/labels as quieter toggles.
    const chips = await page.locator('#u-filters .u-chip').evaluateAll(els => els.map(e => [e.dataset.filter, e.getAttribute('aria-label'), e.classList.contains('sub'), !!e.querySelector('svg.brand-icon path'), e.querySelector('.u-chip-count')?.textContent || '']));
    const order = chips.map(c => c[1]);
    assert.deepEqual(order.slice(0, 2), ['All', 'Unread']);
    for (const n of ['WhatsApp', 'Telegram', 'LINE', 'Slack', 'Instagram', 'Signal', 'Private']) {
      const c = chips.find(x => x[1] === n); assert.ok(c, 'chip ' + n + ' in ' + order); assert.equal(c[3], true, n + ' chip shows its icon'); assert.equal(c[2], false);
    }
    for (const n of ['Direct', 'Groups', 'Family']) assert.equal(chips.find(x => x[1] === n)?.[2], true, n + ' is a secondary chip');
    assert.ok(order.indexOf('Private') < order.indexOf('Direct'), 'platform chips before Direct/Groups');
    assert.equal(chips.find(c => c[1] === 'Unread')[4], '4', 'Unread chip counts unread chats');
    assert.equal(chips.find(c => c[1] === 'Telegram')[4], '1');
    assert.equal(chips.find(c => c[1] === 'WhatsApp')[4], '1');
    const boxes = await page.locator('#u-filters .u-chip').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.height, e.scrollWidth <= e.clientWidth + 1]; }));
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], 'chips do not overlap');
    assert.ok(boxes.every(b => b[3] && b[2] >= 32), 'chips are not clipped and stay tappable');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no page overflow');
    // Accounts strip: real glyphs, connected first, degraded flagged.
    const strip = await page.locator('.u-acct-dot').evaluateAll(els => els.map(e => [e.dataset.network, e.className, !!e.querySelector('svg path')]));
    assert.ok(strip.every(s => s[2]), 'strip uses glyphs'); assert.ok(strip[0][1].includes(' on'), 'connected first');
    assert.ok(strip.find(s => s[0] === 'instagram')[1].includes('warn'));
    await shot('inbox');

    // Platform chips filter rows to that platform only.
    for (const [chip, net, count] of [['Telegram', 'telegram', 1], ['WhatsApp', 'whatsapp', 2], ['Private', 'private', 1], ['Slack', 'slack', 1]]) {
      await page.getByRole('button', {name: chip, exact: true}).click();
      const nets = await page.locator('.u-person').evaluateAll(els => els.map(e => e.dataset.network));
      assert.equal(nets.length, count, chip + ' rows'); assert.ok(nets.every(n => n === net), chip + ' shows only ' + net);
      assert.equal(await page.locator(`[data-filter="net:${net}"]`).getAttribute('aria-pressed'), 'true');
    }
    await page.getByRole('button', {name: 'WhatsApp', exact: true}).click(); await shot('filter-whatsapp');
    await page.getByRole('button', {name: 'Groups', exact: true}).click();
    assert.deepEqual(await page.locator('.u-person strong').allTextContents(), ['Family']);
    await page.getByRole('button', {name: 'All', exact: true}).click();

    // Direct thread: sent right + accent, received left + neutral, no owner name, header has the contact + platform.
    await james.click();
    await page.locator('.u-row[data-id="j7"]').waitFor(); await settle();
    assert.equal((await page.locator('.u-who-text strong').textContent()).trim(), 'James Carter', 'header shows the contact');
    assert.equal(await page.locator('.u-thread-head .u-net[data-network=whatsapp] svg path').count(), 1, 'header wears the platform icon');
    assert.match(await page.locator('.u-who-text span').textContent(), /WhatsApp/);
    const geo = await page.evaluate(() => {
      const t = document.querySelector('.u-timeline').getBoundingClientRect();
      return [...document.querySelectorAll('.u-row')].map(r => { const b = r.querySelector('.u-message'), x = b.getBoundingClientRect(); return {id: r.dataset.id, dir: r.dataset.direction, out: r.classList.contains('outgoing'), inc: r.classList.contains('incoming'), left: x.left - t.left, right: t.right - x.right, bg: getComputedStyle(b).backgroundColor, sender: !!b.querySelector('.u-sender'), text: b.textContent, pos: [...r.classList].find(c => c.startsWith('pos-'))}; });
    });
    const outs = geo.filter(g => g.dir === 'out'), ins = geo.filter(g => g.dir === 'in');
    assert.deepEqual(outs.map(g => g.id), ['j2', 'j3', 'j6', 'j7'], 'direction follows message.outgoing'); assert.deepEqual(ins.map(g => g.id), ['j1', 'j4', 'j5']);
    assert.ok(outs.every(g => g.out && !g.inc && g.right < 16 && g.left > 40), 'sent bubbles hug the right edge');
    assert.ok(ins.every(g => g.inc && !g.out && g.left < 16 && g.right > 40), 'received bubbles hug the left edge');
    assert.equal(new Set(outs.map(g => g.bg)).size, 1); assert.equal(new Set(ins.map(g => g.bg)).size, 1);
    assert.notEqual(outs[0].bg, ins[0].bg, 'sent and received use different bubble colours');
    const accent = await page.evaluate(() => { const e = document.createElement('i'); e.style.color = 'var(--accent)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; });
    assert.equal(outs[0].bg, accent, 'sent bubbles are the accent colour');
    assert.ok(geo.every(g => !g.sender), 'no sender labels in a direct chat');
    assert.ok(geo.every(g => !g.text.includes(OWNER)), 'own messages never show the owner name');
    assert.deepEqual(geo.filter(g => ['j2', 'j3', 'j4', 'j5'].includes(g.id)).map(g => g.pos), ['pos-first', 'pos-last', 'pos-first', 'pos-last'], 'consecutive messages group');
    assert.equal((await page.locator('.u-row[data-id="j6"] .u-quote strong').textContent()).trim(), 'James Carter', 'reply quote names the other person');
    assert.ok(await page.locator('.u-day').count() >= 2, 'day separators');
    await shot('thread-direct');
    await page.getByRole('button', {name: 'Back', exact: true}).click();

    // Group thread: sender names above incoming runs only; own messages unlabeled.
    await page.locator('.u-person', {hasText: 'Family'}).click();
    await page.locator('.u-row[data-id="f5"]').waitFor(); await settle();
    const names = await page.locator('.u-row').evaluateAll(els => els.map(r => [r.dataset.id, r.dataset.direction, r.querySelector('.u-sender')?.textContent || '', !!r.querySelector('.u-row-av')]));
    assert.deepEqual(names.map(n => n.slice(0, 3)), [['f1', 'in', 'Ana Souza'], ['f2', 'in', ''], ['f3', 'in', 'Pedro Souza'], ['f4', 'out', ''], ['f5', 'in', 'Ana Souza']], 'names above incoming runs only');
    assert.deepEqual(names.filter(n => n[3]).map(n => n[0]), ['f2', 'f3', 'f5'], 'one sender face per incoming run');
    assert.match(await page.locator('.u-who-text span').textContent(), /Group · WhatsApp/);
    await shot('thread-group');
    await page.getByRole('button', {name: 'Back', exact: true}).click();

    // Private (native) thread keeps its engine; same sent/received language and a Private shield in the header.
    await page.locator('.u-person', {hasText: 'Private Alice'}).click();
    await page.locator('#messages', {hasText: 'Great, talk soon'}).waitFor(); await settle();
    assert.equal(await page.locator('#chat-avatar .net-badge[data-network=private] svg path').count(), 1, 'private header shield');
    const pg = await page.evaluate(() => { const s = document.getElementById('message-scroll').getBoundingClientRect(); return [...document.querySelectorAll('#messages .message')].map(m => { const b = m.querySelector('.bubble').getBoundingClientRect(); return [m.dataset.direction, b.left - s.left, s.right - b.right, getComputedStyle(m.querySelector('.bubble')).backgroundColor, [...m.classList].find(c => c.startsWith('pos-'))]; }); });
    assert.deepEqual(pg.map(x => x[0]), ['in', 'in', 'out', 'out', 'in']);
    assert.ok(pg.filter(x => x[0] === 'out').every(x => x[2] < 20 && x[1] > 40 && x[3] === accent), 'private sent: right, accent');
    assert.ok(pg.filter(x => x[0] === 'in').every(x => x[1] < 20 && x[2] > 40 && x[3] !== accent), 'private received: left, neutral');
    assert.deepEqual(pg.map(x => x[4]), ['pos-first', 'pos-last', 'pos-first', 'pos-last', 'pos-single']);
    assert.equal(await page.locator('#messages', {hasText: OWNER}).count(), 0);
    await shot('thread-private');
    await page.locator('#chat-back').click();

    // Accounts sheet cards use the same glyphs.
    await page.locator('.u-acct-open').click();
    await page.locator('.c-card').first().waitFor(); await page.waitForTimeout(450);
    const cards = await page.locator('.c-card').evaluateAll(els => els.map(e => [e.dataset.network, !!e.querySelector('.c-mark svg.brand-icon path')]));
    assert.ok(cards.length >= 6 && cards.every(c => c[1]), 'every account card has its glyph: ' + JSON.stringify(cards));
    await shot('accounts');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no page errors'); assert.deepEqual(external, [], 'no requests outside the app');
    summary.push(`${label}/${scheme}`);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS ui_clarity_browser: ' + summary.join(', ') + ' · sent/received alignment+colour, no owner name, group senders, platform icons, platform filters');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
