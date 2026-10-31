// Wizard inbox "Open" link: the shell opens /messenger/#chat=<chat id> (api/inbox item `open`), and Messenger opens
// that chat on load or, in an already-open window, on hashchange; the fragment is dropped at once.
// Synthetic APIs only (no server, no accounts, nothing is sent). node tests/inbox_link_browser.cjs
// (PLAYWRIGHT_MODULE=<playwright>).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../static');
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
const NAMES = ['Ana Souza', 'Ben Okafor', 'Chloe Martin', 'Dev Patel', 'Elena Rossi', 'Farid Haddad'];

function fixture() {
  const people = NAMES.map((name, i) => ({id: 'p' + i, display_name: name, identities: [{id: 'p' + i + '-i', network: 'telegram', kind: 'person', label: name}],
    labels: [], unread: i === 4 ? 2 : 0, muted: false, low_priority: false, language: '', peer_read_ts: 0, last_read_ts: 0,
    last: {text: 'Hello from ' + name.split(' ')[0], timestamp: now - (i + 1) * 9 * min, outgoing: false}}));
  const threads = {};
  for (const p of people) threads[p.id] = [0, 1].map(k => ({id: p.id + '-m' + k, sender: p.display_name, outgoing: false, original: 'Hello from ' + p.display_name.split(' ')[0] + ' ' + k,
    translated: '', timestamp: now - (20 - k) * min, identity_id: p.identities[0].id, network: 'telegram', reactions: [], msgtype: 'm.text'}));
  return {people, threads};
}

(async () => {
  const browser = await chromium.launch(), results = [];
  for (const width of [390, 1280]) {
    const {people, threads} = fixture(), reads = [];
    const ctx = await browser.newContext({viewport: {width, height: 844}});
    await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://messenger.test/**', route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (req.method() !== 'GET' && !p.endsWith('/read') && p !== 'api/view/session') return ok({});  // nothing else is written
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: {account_id: '11'.repeat(32), display_name: 'Owner'}});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/unified/people') return ok({people, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) { const id = decodeURIComponent(thread[1]); return ok({person: people.find(x => x.id === id), messages: threads[id], has_more: false, next_cursor: null, seq: 5, typing: []}); }
      if (p.endsWith('/read')) { reads.push(p.split('/')[3]); return ok({ok: true}); }
      if (p.startsWith('api/unified/updates')) return new Promise(r => setTimeout(r, 1500)).then(() => ok({seq: 5}));
      if (p.startsWith('api/') || p.startsWith('contacts/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    // Fresh window: the link opens the chat (and reads it, like opening it from the list).
    await page.goto('https://messenger.test/#chat=p4');
    const header = page.locator('.u-who-text strong', {hasText: 'Elena Rossi'});
    await header.first().waitFor({timeout: 15000});
    assert.equal(await page.evaluate(() => location.hash), '', width + ': fragment dropped');
    await page.waitForFunction(() => document.querySelector('.u-message'));
    for (let i = 0; i < 20 && !reads.includes('p4'); i++) await page.waitForTimeout(100);
    assert.ok(reads.includes('p4'), width + ': opening from the link marks the chat read');
    // Already-open window: a new link switches chats without reloading the document.
    await page.evaluate(() => { window.__same = true; location.hash = '#chat=p1'; });
    await page.locator('.u-who-text strong', {hasText: 'Ben Okafor'}).first().waitFor({timeout: 10000});
    assert.equal(await page.evaluate(() => window.__same === true && location.hash === ''), true, width + ': same document, fragment dropped');
    // Anything else in the fragment is ignored.
    await page.evaluate(() => { location.hash = '#chat=../x'; });
    await page.waitForTimeout(300);
    await page.locator('.u-who-text strong', {hasText: 'Ben Okafor'}).first().waitFor();
    assert.deepEqual(errors, [], width + ': no page errors');
    results.push({width, reads});
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({pass: true, results}));
})().catch(e => { console.error(e); process.exit(1); });
