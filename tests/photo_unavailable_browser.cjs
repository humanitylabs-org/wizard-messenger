// Issue 404: a received photo the box can't serve as a picture shows an honest "📷 Photo not available · Tap to try
// again" in its bubble. A tap asks the box again (never a viewer with nothing to show or save); once the box answers
// with a picture it shows, and the next tap opens it. Photos that load are untouched.
// Synthetic API only, no container: PLAYWRIGHT_MODULE=... node tests/photo_unavailable_browser.cjs [outdir]
// STATIC_DIR=<main>/static runs the old view (BEFORE=1 skips the asserts and only takes the shot).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-unavailable-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, label, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="50%" y="50%" font-size="${w / 8}" text-anchor="middle" fill="white">${label}</text></svg>`;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'line', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
// LINE photos carry only a url and a body: no mime, no size (the box still says it has a thumbnail).
const MESSAGES = ['$ok', '$gone'].map((id, i) => ({id, identity_id: 'ann-i', network: 'line', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (3 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {thumb: true}, reactions: []}));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.__viewed = [];
    window.WizardApp = {hosted: true, ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      media: {view: (items, at) => { window.__viewed.push({items, at}); return true; }}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], asked = [];
  let fixed = false; // the box can't serve $gone as a picture until this is set
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
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      const id = decodeURIComponent(p.split('/').pop()), kind = url.searchParams.get('kind') || 'full';
      asked.push(id + ':' + kind + (url.searchParams.get('retry') ? ':retry' : ''));
      if (id === '$gone' && !fixed) return route.fulfill({status: 410, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'media_unavailable', message: "This photo can't be shown"}})});
      return route.fulfill({status: 200, contentType: 'image/svg+xml', body: svg(id === '$ok' ? '#3a5' : '#36a', id.slice(1), 400, 300)});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const good = page.locator('.u-media').nth(0), gone = page.locator('.u-media').nth(1);
  await good.locator('img.in').waitFor({timeout: 15000});
  await gone.locator('.u-broken').waitFor({timeout: 15000});
  await page.screenshot({path: path.join(out, 'unavailable.png')});
  if (process.env.BEFORE) { console.log('before shot:', path.join(out, 'unavailable.png')); await browser.close(); return; }
  assert.match(await gone.locator('.u-broken').innerText(), /Photo not available[\s\S]*Tap to try again/, 'an honest state, with what a tap does');
  assert.equal(await gone.getAttribute('aria-label'), 'Photo not available. Tap to try again');

  // A tap on it asks the box again; no viewer opens (so nothing offers to save a photo that isn't there).
  asked.length = 0;
  await gone.tap();
  await page.waitForTimeout(600);
  assert.deepEqual(await page.evaluate(() => window.__viewed.length), 0, 'no viewer for a photo that is not there');
  assert.ok(asked.includes('$gone:thumb:retry'), 'the tap asked the box again: ' + asked);
  if (process.env.DEBUG) await page.screenshot({path: path.join(out, 'after-first-tap.png')});
  await gone.locator('.u-broken').waitFor({timeout: 5000}); // still not available: says so again, once
  assert.equal(await gone.locator('.u-broken').count(), 1);

  // The box can serve it now (a retry after a box update, or the homeserver back): the next tap shows it.
  fixed = true;
  await gone.tap();
  await gone.locator('img.in').waitFor({timeout: 5000});
  assert.equal(await gone.locator('.u-broken').count(), 0);
  assert.equal(await gone.evaluate(b => b.classList.contains('broken')), false);
  await page.screenshot({path: path.join(out, 'retried.png')});
  await gone.tap();
  await page.waitForFunction(() => window.__viewed.length === 1, null, {timeout: 5000});
  const viewed = await page.evaluate(() => window.__viewed[0]);
  assert.equal(viewed.items[viewed.at].url.includes('%24gone'), true, 'now it opens in the viewer');

  // A photo that loads was never touched.
  assert.equal(await good.evaluate(b => b.classList.contains('broken')), false);
  assert.deepEqual(errors, []);
  console.log('photo unavailable: honest state, tap retries, then opens;', out);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
