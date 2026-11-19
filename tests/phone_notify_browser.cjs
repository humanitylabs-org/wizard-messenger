// Issue 308 (switch phone-notifications): the view tells the box its own Messenger address once per page while the
// switch is on (so a phone notification can link to the chat), never while it is off; and the link a notification
// carries (`#chat=<id>`, also `#chat=agent:notes` for an urgent Agent chat ping) opens that chat.
// Synthetic API, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/phone_notify_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'phone-notify-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee'), base('ben', 'Ben Ito')];
const SWITCH = on => [{id: 'phone-notifications', name: 'Messages on your phone', description: 'x', on, default: false, tried: on, vote: null, issues: ['humanitylabs-org/wizard-messenger#308']}];

async function open(browser, {on, hash = '', viewport = {width: 390, height: 800}}) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const agentState = {entries: [{id: 'p1', kind: 'ping', by: 'agent', agent: 'Oscar', text: 'Your flight moved to 9:40', link: null, items: [], at: now}],
    unread: 1, urgent: true, reports_unread: 0, sweep_open: false, read_at: 0, agent: {woken: false, checked: true}};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: SWITCH(on)})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/phone-notify') { posts.push({method: req.method(), body: JSON.parse(req.postData() || 'null')}); return ok({ok: true}); }
    if (p.startsWith('api/unified/agent-chat')) return ok(agentState);
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p.startsWith('api/unified/people/')) { const who = PEOPLE.find(x => p.startsWith('api/unified/people/' + x.id)); if (who && !p.includes('/', 'api/unified/people/'.length)) return ok({person: who, messages: [], has_more: false, seq: 5}); }
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/' + hash);
  return {ctx, page, errors, posts};
}

(async () => {
  const browser = await chromium.launch();
  try {
    // Switch on: one POST with this Messenger's address, even across the 5 s switch polls.
    let r = await open(browser, {on: true});
    await r.page.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
    await r.page.waitForTimeout(6500);
    assert.deepEqual(r.posts, [{method: 'POST', body: {base: 'https://messenger.test/'}}], 'switch on: the view tells the box its address once');
    assert.deepEqual(r.errors, []);
    await r.ctx.close();

    // Switch off: nothing is sent.
    r = await open(browser, {on: false});
    await r.page.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
    await r.page.waitForTimeout(1500);
    assert.deepEqual(r.posts, [], 'switch off: the view sends nothing');
    await r.ctx.close();

    // A message notification's link opens that chat.
    r = await open(browser, {on: true, hash: '#chat=anna'});
    await r.page.locator('#unified-inbox .u-thread-head', {hasText: 'Anna Lee'}).waitFor({timeout: 20000});
    assert.equal(new URL(r.page.url()).hash, '', 'the link is dropped once used');
    await r.page.screenshot({path: path.join(out, 'chat-link.png')});
    await r.ctx.close();

    // An urgent ping's link opens the Agent chat.
    r = await open(browser, {on: true, hash: '#chat=agent:notes'});
    await r.page.locator('#unified-inbox .u-thread-head.u-agent-head').waitFor({timeout: 20000});
    await r.page.locator('#unified-inbox', {hasText: 'Your flight moved to 9:40'}).waitFor({timeout: 5000});
    await r.page.screenshot({path: path.join(out, 'agent-link.png')});
    assert.deepEqual(r.errors, []);
    await r.ctx.close();
    console.log('phone_notify_browser: ok');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
