// Issue 326: while Messenger restarts (every app update), its red notice line showed the raw code server_restarting.
// Now no raw code shows anywhere; a chat the owner opens during the restart says "Messenger is restarting. Try again
// in a moment.", and that line clears by itself once Messenger answers again.
// Synthetic API only, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/restart_notice_browser.cjs [outdir]   (STATIC_DIR=<main>/static BEFORE=1 for the before shot)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'restart-notice-shots');
const before = !!process.env.BEFORE;
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const face = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#205872"/><circle cx="48" cy="36" r="18" fill="#e5c49b"/><path d="M14 96v-12a34 34 0 0 1 68 0v12" fill="#ed925b"/></svg>';
const base = (id, name, avatar) => ({id, display_name: name, avatar, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('top', 'Tom Baker', null), base('nina', 'Nina Park', null)];
const msg = p => [{id: '$m-' + p.id, identity_id: p.id + '-i', network: 'line', sender: p.display_name, outgoing: false, original: 'Hi', timestamp: now - min, timeline_order: 1, reactions: []}];

async function run(browser, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  let restarting = false;
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    if (restarting && p.startsWith('api/') && !p.startsWith('api/unified/updates')) return route.fulfill({status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>'});
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (/^api\/unified\/people\/[^/]+\/avatar$/.test(p)) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: face});
    const one = PEOPLE.find(x => p === 'api/unified/people/' + x.id);
    if (one) return ok({person: one, messages: msg(one), has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  const RAW = /\b[a-z]+_[a-z_]+\b/;
  const visibleText = () => page.evaluate(() => [...document.querySelectorAll('#u-error, .u-toast, [role=alert], [role=status]')].map(e => e.textContent).join(' | '));
  const notice = () => page.evaluate(() => [...document.querySelectorAll('#u-error')].map(e => e.textContent).filter(Boolean).join(' | '));
  await page.locator('.u-person', {hasText: 'Tom Baker'}).first().click({timeout: 20000});
  await page.locator('.u-thread-head').last().waitFor({timeout: 10000});
  if (mobile) { await page.getByRole('button', {name: 'Back'}).first().click(); await page.waitForTimeout(400); }
  restarting = true;
  // The owner opens a chat while Messenger is down: reads retry a few seconds, then the notice line speaks.
  await page.locator('.u-person', {hasText: 'Nina Park'}).first().click({timeout: 10000});
  await page.waitForFunction(() => [...document.querySelectorAll('#u-error')].some(e => e.textContent), null, {timeout: 20000});
  await page.waitForTimeout(6000); // background polls (switches, drafts) fail meanwhile too
  const during = await notice(), all = await visibleText();
  await page.screenshot({path: path.join(out, `${before ? 'before' : 'after'}-${label}.png`)});
  restarting = false;
  let afterBack = during;
  if (!before) {
    await page.waitForFunction(() => ![...document.querySelectorAll('#u-error')].some(e => e.textContent), null, {timeout: 15000});
    afterBack = await notice();
    await page.screenshot({path: path.join(out, `back-${label}.png`)});
  }
  const result = {label, during, all, afterBack};
  if (!before) {
    assert.equal(during, 'Messenger is restarting. Try again in a moment.', label + ': the restarting sentence');
    assert.doesNotMatch(all, RAW, label + ': no raw code anywhere');
    assert.equal(afterBack, '', label + ': the notice clears once Messenger answers');
  }
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [await run(browser, 'desktop', {width: 1280, height: 860}, false), await run(browser, 'phone', {width: 390, height: 844}, true)];
    console.log(JSON.stringify({ok: true, before, results}, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
