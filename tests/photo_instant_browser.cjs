// Issue 164: with "Photos open instantly" on, Messenger's own photo view (used when Wizard's viewer does not open)
// shows the thumbnail the bubble already has on the first frame, swaps to the box's view copy, fetches the photos
// either side, and loads the original only on zoom (double tap). Off, it opens the original as before.
// Synthetic API only, no container and no shell: PLAYWRIGHT_MODULE=... node tests/photo_instant_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-instant-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, label, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="50%" y="50%" font-size="${w / 8}" text-anchor="middle" fill="white">${label}</text></svg>`;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [0, 1, 2].map(i => ({id: '$p' + i, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (3 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true}, reactions: []}));
const VIEW_DELAY = 1500;

async function run(browser, instant, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  // A hosting shell with no media viewer (WizardApp.media missing), so Messenger's own photo view opens.
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], media = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'photo-instant', on: instant}]})});
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
      media.push(id + ':' + kind);
      if (kind === 'thumb') return route.fulfill({status: 200, contentType: 'image/svg+xml', headers: {'Cache-Control': 'private, max-age=86400'}, body: svg('#a33', 'thumb', 400, 300)});
      await new Promise(r => setTimeout(r, VIEW_DELAY));
      return route.fulfill({status: 200, contentType: 'image/svg+xml', body: kind === 'view' ? svg('#36a', 'view', 1600, 1200) : svg('#3a5', 'original', 4000, 3000)});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const photo = page.locator('.u-media').nth(1);
  await photo.locator('img.in').waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  media.length = 0;
  if (mobile) await photo.tap(); else await photo.click();
  const own = page.locator('.u-photo-view'), img = own.locator('img');
  await own.waitFor({timeout: 5000});
  const first = await img.getAttribute('src'), stage = await own.getAttribute('data-stage');
  const painted = await img.evaluate(i => new Promise(r => requestAnimationFrame(() => r(i.complete && i.naturalWidth > 0))));
  await page.screenshot({path: path.join(out, `${instant ? 'on' : 'off'}-first-frame-${label}.png`)});
  const result = {label, instant, first, painted};
  if (instant) {
    assert.match(first, /%24p1\?kind=thumb$/, 'opens from the thumbnail');
    assert.equal(painted, true, 'an image on the first frame, never black');
    assert.equal(stage, 'thumb');
    await page.waitForFunction(() => document.querySelector('.u-photo-view')?.dataset.stage === 'view', null, {timeout: 5000});
    assert.match(await img.getAttribute('src'), /%24p1\?kind=view$/, 'sharpens to the view copy');
    await page.screenshot({path: path.join(out, `on-view-${label}.png`)});
    assert.ok(media.includes('$p0:view') && media.includes('$p2:view'), 'the photos either side are fetched: ' + media);
    assert.ok(!media.includes('$p1:full'), 'no original before zoom: ' + media);
    await img.dblclick();
    await page.waitForFunction(() => document.querySelector('.u-photo-view')?.dataset.stage === 'full', null, {timeout: 5000});
    assert.match(await img.getAttribute('src'), /%24p1$/, 'zoom loads the original');
    result.stages = 'thumb > view > full';
  } else {
    assert.match(first, /%24p1$/, 'off: the original, as before');
    assert.ok(!media.some(x => x.endsWith(':view')), 'off: no view copies: ' + media);
    assert.equal(stage, null);
  }
  await own.press('Escape');
  assert.equal(await own.count(), 0, 'Esc closes it');
  if (mobile) await photo.tap(); else await photo.click();
  await own.waitFor({timeout: 5000});
  await own.getByRole('button', {name: 'Close'}).click();
  assert.equal(await own.count(), 0, 'Close closes it');
  assert.deepEqual(errors, [], 'no page errors');
  result.requests = media.join(' ');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, mobile] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, false]]) {
    for (const instant of [true, false]) summary.push(await run(browser, instant, label, viewport, mobile));
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
