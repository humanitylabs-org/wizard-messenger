// Issue 170: with "Photos ready in Wizard's viewer" on, a tapped photo goes to Wizard's shared viewer with a
// placeholder per still photo: the view copy this phone already downloaded (a blob: URL of this origin), else the
// thumbnail; url stays the original, so Save and Share deliver it. Off, the items are as before. With "Photo timings"
// on, each hand-over is timed (photo_wizard). Synthetic chats and a stub WizardApp.media, no container:
// PLAYWRIGHT_MODULE=... node tests/viewer_placeholder_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'viewer-placeholder-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, label, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="50%" y="50%" font-size="${w / 8}" text-anchor="middle" fill="white">${label}</text></svg>`;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [0, 1, 2].map(i => ({id: '$p' + i, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (3 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true}, reactions: []}));
const THUMB_MS = Number(process.env.THUMB_MS || 60), VIEW_MS = Number(process.env.VIEW_MS || 400), OPENS = 5;
const stats = list => { const v = [...list].sort((a, b) => a - b); return {n: v.length, p50: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.floor(v.length * 9 / 10))], max: v[v.length - 1], sum: v.reduce((a, b) => a + b, 0)}; };

async function run(browser, on, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.__views = [];
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      media: {view: (items, at) => { window.__views.push({items: JSON.parse(JSON.stringify(items)), at, t: performance.now()}); return true; }}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], posted = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'viewer-placeholder', on}, {id: 'photo-timings', on}]})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p === 'api/unified/photos/timings') { const s = JSON.parse(req.postData() || '{}').samples || []; posted.push(...s); return ok({ok: true, kept: s.length}); }
    if (p.startsWith('api/unified/media/')) {
      const kind = url.searchParams.get('kind') || 'full';
      if (kind === 'thumb') return route.fulfill({status: 200, contentType: 'image/svg+xml', headers: {'Cache-Control': 'private, max-age=86400'}, body: svg('#a33', 'thumb', 400, 300)});
      return route.fulfill({status: 200, contentType: 'image/svg+xml', body: kind === 'view' ? svg('#36a', 'view', 1600, 1200) : svg('#3a5', 'original', 4000, 3000)});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  // This phone already downloaded the view copy of the middle photo in the background (issue 166's cache and index).
  const viewOf = id => 'api/unified/media/' + encodeURIComponent(id) + '?kind=view';
  await page.evaluate(async u => {
    const c = await caches.open('messenger-photos-v1'), blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#36a"/></svg>'], {type: 'image/svg+xml'});
    await c.put(u, new Response(blob, {headers: {'Content-Type': 'image/svg+xml'}}));
    localStorage.setItem('messenger.photoPrefetchIndex', JSON.stringify({[u]: {kind: 'view', size: blob.size, at: Date.now()}}));
  }, viewOf('$p1'));
  await page.reload();
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const photo = page.locator('.u-media').nth(1);
  await photo.locator('img.in').waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  if (mobile) await photo.tap(); else await photo.click();
  await page.waitForFunction(() => window.__views.length === 1, null, {timeout: 5000});
  const [seen] = await page.evaluate(() => window.__views);
  assert.equal(await page.locator('.u-photo-view').count(), 0, 'Wizard opened it: no Messenger view');
  assert.equal(seen.at, 1);
  assert.deepEqual(seen.items.map(x => x.url), MESSAGES.map(m => 'api/unified/media/' + encodeURIComponent(m.id)), 'url stays the original');
  const result = {label, on, placeholders: seen.items.map(x => x.placeholder ?? null)};
  if (!on) assert.ok(seen.items.every(x => !('placeholder' in x)), 'off: items as before');
  else {
    assert.equal(seen.items[0].placeholder, 'api/unified/media/%24p0?kind=thumb');
    assert.equal(seen.items[2].placeholder, 'api/unified/media/%24p2?kind=thumb');
    assert.ok(seen.items[1].placeholder.startsWith('blob:https://messenger.test/'), 'the downloaded view copy goes as a blob: of this origin: ' + seen.items[1].placeholder);
    result.blob = await page.evaluate(async u => (await (await fetch(u)).text()).includes('#36a'), seen.items[1].placeholder);
    assert.ok(result.blob, 'the blob is the view copy');
    await page.waitForTimeout(3600);
    result.timed = posted.filter(x => x.name === 'photo_wizard');
    assert.equal(result.timed.length, 1, 'the hand-over is timed once: ' + JSON.stringify(posted));
    assert.ok(result.timed[0].ms < 150, 'a warm cache hands over within 150 ms');
    if (mobile) await page.getByRole('button', {name: 'Back'}).first().click();
    await page.locator('#u-filters').waitFor({timeout: 15000});
    await page.locator('.u-settings-btn').first().click({timeout: 15000});
    const row = page.locator('.u-more-viewer-placeholder');
    await row.scrollIntoViewIfNeeded();
    result.row = (await row.innerText()).split('\n');
    await page.screenshot({path: path.join(out, `settings-${label}.png`)});
  }
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, mobile] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, false]]) {
    for (const on of [true, false]) summary.push(await run(browser, on, label, viewport, mobile));
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
