// Unified Inbox + Accounts visual/behaviour proof on the static view with fixture APIs (no real accounts).
// node tests/inbox_ux_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'inbox-ux-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: [{id: id + '-i', network: net, kind: 'person', label: name}], labels: [], unread: 0, muted: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', ...extra});
const group = (id, name, net, text, ago, extra = {}) => ({...person(id, name, net, text, ago, extra), identities: [{id: id + '-g', network: net, kind: 'group', label: name}], last: {text, timestamp: now - ago * min, sender: '@ana:x', outgoing: false}});
const PEOPLE = [
  person('p1', 'Ana Souza', 'whatsapp', 'See you at 7?', 3, {unread: 2}),
  person('p2', 'Kenji Tanaka', 'line', 'ありがとう!', 40),
  person('p3', 'Priya Raman', 'slack', 'Deck is in the shared folder', 95, {unread: 1}),
  person('p4', 'Marco Bianchi', 'telegram', 'Sent the invoice', 300),
  person('p5', 'Lucía Gómez', 'instagram', 'Loved the photos 😍', 1500),
];
const GROUPS = [
  group('g1', 'Family', 'whatsapp', 'Dinner Sunday', 12, {unread: 4, labels: ['Family']}),
  group('g2', 'AIW Founders', 'slack', 'Shipping Friday', 70),
];
let providers = [
  {network: 'telegram', label: 'Telegram', supported: true, state: 'not_configured', flows: [], logins: []},
  {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [{id: 'qr', name: 'QR'}, {id: 'phone', name: 'Pairing code'}], logins: [{id: 'l', name: '+66 ••• 4821', state: 'CONNECTED'}]},
  {network: 'signal', label: 'Signal', supported: true, state: 'not_configured', flows: [], logins: []},
  {network: 'slack', label: 'Slack', supported: true, state: 'disconnected', flows: [{id: 'email', name: 'Email'}], logins: []},
  {network: 'line', label: 'LINE', supported: true, state: 'disconnected', flows: [{id: 'dev.highest.matrix.line.email_login', name: 'Login'}, {id: 'dev.highest.matrix.line.qr_login', name: 'QR Code'}], logins: []},
  {network: 'instagram', label: 'Instagram DMs', supported: true, state: 'disconnected', flows: [{id: 'android', name: 'Native Android'}, {id: 'instagram-password', name: 'Native Web'}], logins: []},
  {network: 'kakaotalk', label: 'KakaoTalk', supported: false, state: 'unsupported', flows: [], logins: []},
];
(async () => {
  const browser = await chromium.launch();
  const result = {};
  for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2});
    await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(); const errors = [], starts = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://messenger.test/**', async route => {
      const req = route.request(), p = new URL(req.url()).pathname.replace(/^\//, '');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: {npub: 'npub1fixture', display_name: 'Miguel'}});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      if (p === 'api/unified/connectors') return ok({providers});
      if (p === 'api/unified/connectors/slack/start') { starts.push('slack'); return ok({login_id: 'l1', step_id: 'email', type: 'user_input', user_input: {fields: [{id: 'email', type: 'email', name: 'Work email'}]}}); }
      if (p === 'api/unified/connectors/line/start') { starts.push(JSON.parse(req.postData()).flow); return ok({login_id: 'l2', step_id: 'qr', type: 'display_and_wait', display_and_wait: {type: 'qr', data: 'https://example.invalid/fixture-only-not-a-login'}}); }
      if (p.endsWith('/step')) return new Promise(() => {}); // phone never scans in this fixture
      if (p.endsWith('/cancel')) return ok({});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p === 'api/view/push') return ok({enabled: false});
      if (p === 'api/view/agent-access') return ok({mode: 'no_access', enabled: false, log: []});
      if (p.startsWith('api/')) return ok({contacts: [], invites: [], dms: []});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto('http://messenger.test/');
    await page.locator('.u-person').first().waitFor({timeout: 15000});
    await page.locator('.u-settings-btn').waitFor();
    const rows = await page.locator('.u-person').count();
    assert.equal(rows, PEOPLE.length + GROUPS.length, 'one Inbox lists direct chats and groups together');
    const order = await page.locator('.u-person strong').allTextContents();
    assert.equal(order[0].trim(), 'Ana Souza', 'newest first across networks');
    assert.equal(order[1].trim(), 'Family', 'groups interleave by recency');
    assert.equal(await page.locator('#inbox-tabs [data-tab="groups"]').count(), 0, 'no separate Groups tab');
    assert.equal(await page.locator('#unified-inbox .u-acct-open').count(), 0, 'account status lives in Settings, not the Inbox');
    const chips = await page.locator('#u-filters .u-chip').evaluateAll(els => els.map(e => e.getAttribute('aria-label'))); // platform chips are icon-only; the name is the accessible label
    for (const c of ['All', 'Unread', 'Direct', 'Groups', 'WhatsApp', 'LINE', 'Slack', 'Telegram', 'Instagram', 'Family']) assert.ok(chips.includes(c), 'chip ' + c + ' in ' + chips);
    assert.ok(await page.locator('.u-person .u-net').count() >= rows, 'every row wears its network badge');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, 'no horizontal overflow');
    const chipBoxes = await page.locator('#u-filters .u-chip').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right, e.scrollWidth <= e.clientWidth + 1]; }));
    for (let i = 1; i < chipBoxes.length; i++) assert.ok(chipBoxes[i][0] >= chipBoxes[i - 1][1] - 0.5, 'chips do not overlap');
    assert.ok(chipBoxes.every(b => b[2]), 'chip labels are not clipped');
    await page.screenshot({path: path.join(out, `inbox-${label}.png`)});
    await page.getByRole('button', {name: 'WhatsApp', exact: true}).click();
    assert.equal(await page.locator('.u-person').count(), 2, 'WhatsApp filter: Ana + Family');
    await page.getByRole('button', {name: 'Unread', exact: true}).click();
    assert.deepEqual((await page.locator('.u-person strong').allTextContents()).map(s => s.trim()), ['Ana Souza', 'Family', 'Priya Raman']);
    await page.screenshot({path: path.join(out, `inbox-unread-${label}.png`)});
    await page.getByRole('button', {name: 'Groups', exact: true}).click();
    assert.equal(await page.locator('.u-person').count(), 2, 'Groups filter');
    await page.getByRole('button', {name: 'All', exact: true}).click();
    // Accounts sheet: one tap from the Inbox, QR first.
    await page.locator('.u-settings-btn').click();
    await page.locator('.c-card').first().waitFor();
    await page.locator('.c-tile.c-on').first().waitFor();
    const cards = await page.locator('.c-card strong, .c-tile.c-on .c-tile-name').allTextContents();
    assert.deepEqual(cards, ['Slack', 'LINE', 'Instagram DMs', 'Telegram', 'WhatsApp'], 'unconnected first, connected last');
    assert.equal(await page.locator('.c-card[data-network=line] .primary').textContent(), 'Show QR code', 'QR is LINE\'s primary action');
    assert.equal(await page.locator('.u-sheet', {hasText: /of \d+ (accounts )?connected/}).count(), 0, 'no x-of-y score');
    await page.waitForTimeout(450); // let the sheet finish sliding in
    await page.screenshot({path: path.join(out, `accounts-${label}.png`), fullPage: false});
    await page.locator('.c-card[data-network=line] .primary').click();
    await page.locator('.c-qr').waitFor();
    assert.deepEqual(starts.slice(-1), ['dev.highest.matrix.line.qr_login']);
    assert.match(await page.locator('.c-howto').textContent(), /QR scanner/);
    assert.match(await page.locator('.c-waiting').textContent(), /Waiting for your phone/);
    const box = await page.locator('.c-qr').boundingBox();
    assert.ok(box.width >= 220, 'QR is large enough to scan: ' + box.width);
    await page.screenshot({path: path.join(out, `qr-${label}.png`)});
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await page.locator('.c-card[data-network=slack]').getByRole('button', {name: /Sign in with email/}).click();
    const email = page.locator('.c-form input');
    assert.equal(await email.getAttribute('type'), 'email', 'email stays readable');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no page errors');
    result[label] = {rows, chips, cards, qr: Math.round(box.width)};
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(result));
  console.log('PASS inbox_ux_browser: unified Inbox, filters, network badges, accounts strip, QR-first linking');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
