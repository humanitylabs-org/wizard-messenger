// Issue 219: tapping the chat header opens the Contact sheet, and its large circle shows the same profile picture
// as the chat-list row and header. A person without a picture still shows initials.
// Synthetic API only, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/contact_sheet_picture_browser.cjs [outdir]   (STATIC_DIR=<main>/static BEFORE=1 for the before shot)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'contact-sheet-picture-shots');
const before = !!process.env.BEFORE;
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const face = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#205872"/><circle cx="48" cy="36" r="18" fill="#e5c49b"/><path d="M14 96v-12a34 34 0 0 1 68 0v12" fill="#ed925b"/></svg>';
const base = (id, name, avatar) => ({id, display_name: name, avatar, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('top', 'Top', 'pic-v1'), base('nopic', 'Nina Park', null)];
const msg = p => [{id: '$m-' + p.id, identity_id: p.id + '-i', network: 'line', sender: p.display_name, outgoing: false, original: 'Hi', timestamp: now - min, timeline_order: 1, reactions: []}];

async function run(browser, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  // A hosting shell stub (no media viewer): without one the inbox never boots in this harness.
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
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
  const result = {label};
  for (const p of PEOPLE) {
    await page.locator('.u-person', {hasText: p.display_name}).first().click({timeout: 20000});
    const head = page.locator('.u-thread-head').last();
    await head.waitFor({timeout: 10000});
    if (p.avatar) await head.locator('.u-avatar.has-img img').waitFor({timeout: 10000});
    await head.locator('.u-avatar').first().click();
    const hero = page.locator('.u-sheet .u-hero .u-avatar.large').last();
    await hero.waitFor({timeout: 5000});
    if (p.avatar && !before) await hero.locator('img.u-av-img').evaluate(i => i.complete && i.naturalWidth ? 0 : new Promise(r => i.addEventListener('load', r, {once: true})));
    await page.waitForTimeout(300);
    const state = await hero.evaluate(el => {
      const img = el.querySelector('img.u-av-img');
      return {img: !!img, shown: !!img && !img.hidden && img.naturalWidth > 0, hasImg: el.classList.contains('has-img'), initials: el.firstChild?.nodeType === 3 ? el.firstChild.textContent : '', w: el.getBoundingClientRect().width};
    });
    await page.screenshot({path: path.join(out, `${before ? 'before' : 'after'}-${p.id}-${label}.png`)});
    result[p.id] = state;
    if (!before) {
      if (p.avatar) { assert.equal(state.shown, true, `${label}: ${p.display_name}'s picture shows in the Contact sheet`); assert.equal(state.hasImg, true); assert.equal(state.w, 80); }
      else { assert.equal(state.img, false, `${label}: no picture, no img`); assert.equal(state.initials, 'NP', 'initials stay'); }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (mobile) { const back = page.getByRole('button', {name: 'Back'}).first(); if (await back.isVisible().catch(() => false)) await back.click(); await page.waitForTimeout(300); }
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
