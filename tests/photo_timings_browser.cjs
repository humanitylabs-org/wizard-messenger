// Issue 168: with "Photo timings" on, the view times each photo stage (thumbnail request, tap to picture, tap to sharp
// copy, black first frames), sends only names and milliseconds to the box, and Settings shows the summary. Off, it
// sends nothing. Both with "Photos open instantly" on and off. Synthetic chats only, no container and no shell:
// PLAYWRIGHT_MODULE=... node tests/photo_timings_browser.cjs [outdir]   (THUMB_MS / VIEW_MS set the fake box delays)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-timings-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, label, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="50%" y="50%" font-size="${w / 8}" text-anchor="middle" fill="white">${label}</text></svg>`;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [0, 1, 2].map(i => ({id: '$p' + i, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (3 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true}, reactions: []}));
const THUMB_MS = Number(process.env.THUMB_MS || 60), VIEW_MS = Number(process.env.VIEW_MS || 400), OPENS = 5;
const stats = list => { const v = [...list].sort((a, b) => a - b); return {n: v.length, p50: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.floor(v.length * 9 / 10))], max: v[v.length - 1], sum: v.reduce((a, b) => a + b, 0)}; };

async function run(browser, timings, instant, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], posted = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const box = {'photo_handover.telegram': [1800, 2100, 2600], 'photo_ready.telegram': [2300, 2900, 3400], 'photo_kb.telegram': [210, 260, 330]};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'photo-instant', on: instant}, {id: 'photo-timings', on: timings}]})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p === 'api/unified/photos/timings') { const s = JSON.parse(req.postData() || '{}').samples || []; posted.push(...s); for (const x of s) (box[x.name] ||= []).push(x.ms); return ok({ok: true, kept: s.length}); }
    if (p === 'api/unified/status') return ok({timings: Object.fromEntries(Object.entries(box).map(([k, v]) => [k, stats(v)]))});
    if (p.startsWith('api/unified/media/')) {
      const kind = url.searchParams.get('kind') || 'full';
      await new Promise(r => setTimeout(r, kind === 'thumb' ? THUMB_MS : VIEW_MS));
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
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const photo = page.locator('.u-media').nth(1), own = page.locator('.u-photo-view');
  await photo.locator('img.in').waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  for (let i = 0; i < OPENS; i++) {
    if (mobile) await photo.tap(); else await photo.click();
    await own.waitFor({timeout: 5000});
    await page.waitForTimeout(VIEW_MS + 300);
    await own.press('Escape');
  }
  await page.waitForTimeout(3600); // one batch, a few seconds later
  const names = posted.map(x => x.name), result = {label, timings, instant, samples: {}};
  for (const name of new Set(names)) result.samples[name] = stats(posted.filter(x => x.name === name).map(x => x.ms));
  if (!timings) assert.deepEqual(posted, [], 'off: nothing is sent');
  else {
    assert.ok(names.includes('photo_thumb'), 'thumbnail requests are timed: ' + names);
    assert.equal(names.filter(x => x === 'photo_tap').length, OPENS, 'every open is timed');
    assert.equal(names.filter(x => x === 'photo_black').length, OPENS, 'every first frame is checked');
    if (instant) {
      assert.equal(names.filter(x => x === 'photo_sharp').length, OPENS, 'each sharp copy is timed');
      assert.equal(result.samples.photo_black.sum, 0, 'thumbnail first: no black first frame');
    } else assert.ok(!names.includes('photo_sharp'));
    if (mobile) await page.getByRole('button', {name: 'Back'}).first().click(); // back to the list, where Settings is
    await page.locator('#u-filters').waitFor({timeout: 15000});
    await page.locator('.u-settings-btn').first().click({timeout: 15000});
    const sum = page.locator('.u-more-photo-timings .u-more-timings');
    await page.waitForFunction(() => /Tap to picture/.test(document.querySelector('.u-more-photo-timings .u-more-timings')?.innerText || ''), null, {timeout: 5000});
    result.settings = (await sum.innerText()).split('\n');
    assert.ok(result.settings.some(x => x.startsWith('Telegram: hand-over 2100 ms')), 'per network: ' + result.settings);
    await page.locator('.u-more-photo-timings').scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(out, `settings-${instant ? 'instant' : 'original'}-${label}.png`)});
  }
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, mobile] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, false]]) {
    for (const [timings, instant] of [[true, true], [true, false], [false, true]]) summary.push(await run(browser, timings, instant, label, viewport, mobile));
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
