// Issue 336: on a phone the Unread list (chats, previews, per-chat badges, the total) changed on its own. Each
// refresh Wizard sends (focus, coming back, every minute) reloads the whole list, and when that answer arrived after
// the live feed had already moved some chats on, it put the older copies back: the list stepped back, then forward.
// Now a reload never rolls a chat back, and a chat read on this device stays read.
// Synthetic box only (no container, no shell): a feed that brings a new message every 700 ms, list reloads that answer
// 2 s late with the list as it stood when asked, and a focus event every 700 ms.
//   PLAYWRIGHT_MODULE=... node tests/unread_list_steady_browser.cjs [outdir]   (STATIC_DIR=<main>/static BEFORE=1 for before)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'unread-list-steady-shots');
const before = !!process.env.BEFORE;
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function box() {
  const t0 = Date.now() - 3600e3;
  const names = ['Ana Ruiz', 'Bram de Vries', 'Cora Lim', 'Dan Moss', 'Eva Holt'];
  const chats = names.map((name, i) => ({id: 'c' + i, display_name: name, identities: [{id: 'c' + i + '-i', network: ['whatsapp', 'telegram', 'line', 'signal', 'whatsapp'][i], kind: 'person', label: name}],
    labels: [], muted: false, low_priority: false, language: '', peer_read_ts: 0, last_read_ts: 0, n: 1, unread: i < 4 ? 1 : 0, at: t0 + i * 60e3}));
  const b = {seq: 10, log: [], chats, waiters: [], reads: []};
  const row = c => ({id: c.id, display_name: c.display_name, identities: c.identities, labels: [], muted: false, low_priority: false, language: '', peer_read_ts: 0,
    last_read_ts: c.last_read_ts, unread: c.unread, unread_mentions: 0, last: {text: 'msg ' + c.n, timestamp: c.at, outgoing: false}});
  b.row = row;
  b.change = id => { b.seq++; b.log.push({seq: b.seq, id}); for (const w of b.waiters.splice(0)) w(); };
  b.message = c => { c.n++; c.unread++; c.at = Date.now(); b.change(c.id); };
  b.read = (id, ts) => { const c = chats.find(x => x.id === id); c.unread = 0; c.last_read_ts = ts; b.reads.push(id); b.change(id); };
  b.list = () => [...chats].sort((x, y) => y.at - x.at).map(row);
  b.updates = async since => {
    if (b.seq <= since) await Promise.race([new Promise(r => b.waiters.push(r)), sleep(1500)]);
    const ids = [...new Set(b.log.filter(e => e.seq > since).map(e => e.id))];
    return {seq: b.seq, people: ids.map(id => row(chats.find(c => c.id === id))), removed: [], messages: {}, typing: {}};
  };
  return b;
}

async function run(browser) {
  const b = box();
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  let reloads = 0;
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})}).catch(() => {});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    // A big history makes the whole list slow: the answer is the list as it stood when it was asked, 2 s later.
    if (p === 'api/unified/people') { const seq = b.seq, people = b.list(); reloads++; await sleep(2000); return ok({people, seq}); }
    if (p === 'api/unified/groups') return ok({groups: [], seq: b.seq});
    if (p.startsWith('api/unified/updates')) return ok(await b.updates(+url.searchParams.get('since') || 0));
    const read = /^api\/unified\/people\/([^/]+)\/read$/.exec(p);
    if (read && req.method() === 'POST') { b.read(read[1], req.postDataJSON()?.timestamp || Date.now()); return ok({ok: true}); }
    const one = b.chats.find(x => p === 'api/unified/people/' + x.id);
    if (one) return ok({person: b.row(one), messages: [{id: '$m-' + one.id + '-' + one.n, identity_id: one.id + '-i', network: one.identities[0].network, sender: one.display_name, outgoing: false, original: 'msg ' + one.n, timestamp: one.at, timeline_order: 1, reactions: []}], has_more: false, next_cursor: null, seq: b.seq, typing: []});
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  await page.locator('.u-seg-btn[data-seg="unread"]').click();
  await page.waitForTimeout(300);
  const snap = () => page.evaluate(() => ({
    rows: [...document.querySelectorAll('#unified-inbox .u-list .u-person')].map(c => ({name: c.querySelector('strong')?.textContent, badge: c.querySelector('.u-badge:not(.u-mention-badge)')?.textContent || '', text: c.querySelector('.u-snippet')?.textContent || ''})),
    total: document.querySelector('.u-seg-btn[data-seg="unread"] .u-seg-count')?.textContent || ''}));
  const steps = [];
  let last = await snap(), backs = 0, readBack = 0, readId = null;
  const n = r => +((/msg (\d+)/.exec(r.text) || [])[1] || 0);
  const watch = async (ms, extra = () => {}) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await page.waitForTimeout(100);
      const now = await snap();
      for (const r of now.rows) {
        const o = last.rows.find(x => x.name === r.name);
        if (o && n(r) < n(o)) { backs++; steps.push(`${o.name}: "${o.text}" ${o.badge} -> "${r.text}" ${r.badge}`); }
      }
      extra(now);
      last = now;
    }
  };
  // Part 1: messages keep arriving, Wizard keeps refreshing (focus), nobody touches the list.
  const chats = b.chats.slice(0, 4);
  let i = 0;
  const feed = setInterval(() => b.message(chats[i++ % chats.length]), 700);
  const focus = setInterval(() => page.evaluate(() => dispatchEvent(new Event('focus'))).catch(() => {}), 700);
  await watch(12000);
  await page.screenshot({path: path.join(out, (before ? 'before' : 'after') + '-unread.png')});
  // Part 2: a refresh is asked, then the owner reads Ana's chat and comes back before the refresh answers.
  clearInterval(feed); clearInterval(focus);
  await page.waitForTimeout(2500);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForTimeout(100);
  readId = 'c0';
  await page.locator('.u-person', {hasText: 'Ana Ruiz'}).first().click();
  await page.locator('.u-thread-head').last().waitFor({timeout: 10000});
  await page.waitForFunction(() => true);
  for (let k = 0; k < 30 && !b.reads.includes(readId); k++) await page.waitForTimeout(100);
  await page.getByRole('button', {name: 'Back'}).first().click();
  // Back on Unread: All shows Ana read; the Unread folder must not bring her back.
  await watch(3500, now => { if (now.rows.some(r => r.name === 'Ana Ruiz' && r.badge)) readBack++; });
  // Part 3: quiet; the list must equal the box.
  await page.waitForTimeout(2500);
  const final = await snap();
  const want = b.list().filter(r => r.unread > 0).map(r => ({name: r.display_name, badge: String(r.unread), text: 'msg ' + /\d+$/.exec(r.last.text)[0]}));
  const result = {reloads, backs, steps, readBack, reads: b.reads, final, want};
  fs.writeFileSync(path.join(out, (before ? 'before' : 'after') + '-result.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({reloads, backs, readBack, steps: steps.slice(0, 6)}));
  await ctx.close();
  if (before) return;
  assert.ok(reloads >= 4, 'the list was reloaded while it was watched: ' + reloads);
  assert.ok(b.reads.includes('c0'), 'opening Ana read her chat');
  assert.equal(backs, 0, 'no chat stepped back: ' + steps.join('; '));
  assert.equal(readBack, 0, 'a chat read on this phone never comes back as unread');
  assert.deepEqual(final.rows, want, 'the Unread list shows what the box holds');
  assert.equal(final.total, String(want.length), 'the Unread count is the number of unread chats');
  assert.deepEqual(errors, [], 'page errors');
}

(async () => {
  const browser = await chromium.launch();
  try { await run(browser); } finally { await browser.close(); }
  console.log(before ? 'before run done' : 'unread list steady: ok');
})().catch(e => { console.error(e); process.exit(1); });
