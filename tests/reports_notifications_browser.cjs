// Issue 276 (switch reports-notifications): every notification from the Notifications app also shows in Messenger's
// pinned Reports chat, newest at the bottom, with its title, text and link. Reports stays read-only, nothing is marked
// in Notifications, and a new notification after Reports was opened makes the Reports row unread. Switch off: Reports
// shows only the agent's reports and Notifications is never asked.
// Synthetic API (agent_chat.py's owner routes + the Notifications app's /notifications/api/items), no container:
//   PLAYWRIGHT_MODULE=... node tests/reports_notifications_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'reports-notifications-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3, sec = t => Math.floor(t / 1000);
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee'), base('ben', 'Ben Ito')];

async function run(browser, label, on, viewport) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], hits = {items: 0, writes: 0};
  page.on('pageerror', e => errors.push(e.message));
  const box = {reports_read_at: 0, entries: [{id: 'p1', kind: 'report', by: 'agent', agent: 'Oscar', text: 'Weekly social stats\nFollowers +12.', link: null, items: [], at: now - 30 * min}]};
  const items = [
    {id: 'n-old', title: 'Sniper scan done', message: '2 new matches near you', time: sec(now - 50 * min), link: 'https://sniper.example/r/1', read: true, priority: 3},
    {id: 'n-mr', title: 'Morning Report', message: 'Three things today: dentist 10:00, rent due, rain after 4.', time: sec(now - 10 * min), link: '/morning-report/', read: false, priority: 3},
  ];
  const state = () => ({entries: box.entries, unread: 0, urgent: false, sweep_open: false, read_at: 0, agent: {woken: false, checked: true},
    reports_unread: box.entries.filter(e => e.kind === 'report' && e.at > box.reports_read_at).length, reports_read_at: box.reports_read_at});
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = [
    {id: 'reports-notifications', name: 'Notifications in Reports', description: 'x', on: !!on.notices, default: false, tried: false, vote: null, issues: ['humanitylabs-org/wizard-messenger#276']}];
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p.startsWith('notifications/')) {
      if (req.method() !== 'GET') { hits.writes++; return route.fulfill({status: 405, body: ''}); }
      if (p === 'notifications/api/items') { hits.items++; assert.equal(url.searchParams.get('view'), 'all'); return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({items: [...items].reverse()})}); }
      return route.fulfill({status: 404, body: ''});
    }
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) {
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null, sub = p.slice('api/unified/agent-chat'.length);
      if (sub === '/read' && body?.reports) box.reports_read_at = Date.now();
      return ok(state());
    }
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
  await page.waitForTimeout(1500);
  const shot = name => page.screenshot({path: path.join(out, `${label}-${name}.png`)});
  const result = {label};
  const pinned = await page.locator('.u-list > .u-agent-row').evaluateAll(els => els.map(e => e.dataset.mode));
  const phone = viewport.width < 600;
  if (!on.notices) {
    assert.deepEqual(pinned, ['chat', 'reports'], label + ': pinned rows as before');
    await page.locator('.u-agent-row[data-mode="reports"]').click();
    await page.locator('#unified-inbox .u-row.report h3', {hasText: 'Weekly social stats'}).waitFor({timeout: 5000});
    assert.equal(await page.locator('.u-ac-notice').count(), 0, label + ': no notification copies with the switch off');
    await shot('reports');
    assert.equal(hits.items, 0, label + ': Notifications is never asked with the switch off');
    assert.deepEqual(errors, [], label + ' page errors');
    await ctx.close(); return {...result, pinned, asked: hits.items};
  }
  assert.deepEqual(pinned, ['chat', 'reports'], label + ': Agent and Reports are pinned');
  const row = page.locator('.u-agent-row[data-mode="reports"]');
  await row.locator('.u-snippet', {hasText: 'Morning Report'}).waitFor({timeout: 9000});
  // Before Reports was ever opened, old notifications do not count as new (only the agent's own unread report does).
  assert.deepEqual(await row.locator('.u-badge').allTextContents(), ['1'], label + ': no 99+ on day one');
  await shot('1-list');
  await row.click();
  const chat = page.locator('#unified-inbox');
  await chat.locator('.u-row.u-ac-notice h3', {hasText: 'Morning Report'}).waitFor({timeout: 5000});
  const order = await chat.locator('.u-ac-log .u-row h3').allTextContents();
  assert.deepEqual(order, ['Sniper scan done', 'Weekly social stats', 'Morning Report'], label + ': by time, newest at the bottom');
  const mr = chat.locator('.u-row.u-ac-notice', {hasText: 'Morning Report'});
  assert.ok((await mr.textContent()).includes('Three things today'), label + ': the text shows');
  assert.equal(await mr.locator('a[href="https://messenger.test/morning-report/"]').count(), 1, label + ': a box link opens on this box');
  assert.equal(await chat.locator('.u-row.u-ac-notice a[href="https://sniper.example/r/1"]').count(), 1, label + ': its link');
  assert.equal(await chat.locator('.u-composer').count(), 0, label + ': read-only, no reply box');
  await chat.locator('.u-ac-readonly', {hasText: 'copy of your notifications'}).waitFor({timeout: 5000});
  assert.ok(await chat.locator('.u-ac-log').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 4), label + ': opens on the newest');
  await page.waitForTimeout(500);
  assert.ok(box.reports_read_at > 0, label + ': opening Reports sets its read mark on the box');
  await shot('2-reports');
  if (phone) await page.getByRole('button', {name: 'Back'}).click(); else await page.getByRole('button', {name: 'Close chat'}).click();
  // A new notification arrives (the Sniper scan at noon): the copy shows and Reports is unread.
  items.push({id: 'n-new', title: 'Sniper scan: 1 new match', message: 'Flat in Gràcia, 2 rooms', time: sec(Date.now() + 5000), link: '', read: false});
  await row.locator('.u-badge', {hasText: '1'}).waitFor({timeout: 30000});
  assert.equal(await row.locator('.u-snippet').textContent(), 'Sniper scan: 1 new match', label + ': the row names the newest');
  await shot('3-new-notification');
  assert.equal(hits.writes, 0, label + ': nothing is marked or changed in Notifications');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return {...result, pinned, order, asked: hits.items};
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [
      await run(browser, 'phone-notices', {notices: true}, {width: 390, height: 844}),
      await run(browser, 'desktop-notices', {notices: true}, {width: 1280, height: 860}),
      await run(browser, 'switch-off', {}, {width: 390, height: 844})];
    console.log(JSON.stringify({ok: true, results}, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
