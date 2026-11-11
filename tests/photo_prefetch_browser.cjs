// Issue 166: with "Background photo download" on, the phone quietly fetches thumbnails and the box's view copies of
// the newest photos in the most recent chats after the list loads, keeps them in Cache Storage, and a tapped photo
// sharpens from that copy. "Wi-Fi only" on cellular, and the switch off, download nothing in the background.
// Synthetic API only, no container and no shell: PLAYWRIGHT_MODULE=... node tests/photo_prefetch_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-prefetch-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, label, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><text x="50%" y="50%" font-size="${w / 8}" text-anchor="middle" fill="white">${label}</text></svg>`;
const chat = (id, name, at) => ({id, display_name: name, identities: [{id: id + '-i', network: 'telegram', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: at, outgoing: false, msgtype: 'm.image'}, language: '', peer_read_ts: 0});
const PEOPLE = [chat('ann', 'Ann Lee', now - min), chat('bob', 'Bob Ray', now - 5 * min)];
const photos = id => [0, 1, 2].map(i => ({id: '$' + id + i, identity_id: id + '-i', network: 'telegram', sender: id, outgoing: false, original: '', timestamp: now - (10 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true}, reactions: []}));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

async function run(browser, {label, on, network, viewport, phone}) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: 'dark', ...(phone ? {userAgent: PHONE_UA} : {})});
  await ctx.addInitScript(net => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    Object.defineProperty(Navigator.prototype, 'connection', {configurable: true, get: () => ({type: net, saveData: false, addEventListener: noop})});
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, network);
  const page = await ctx.newPage(), errors = [], media = [], threads = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = {'photo-prefetch': on, 'photo-instant': on};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') {
      if (req.method() === 'POST') { const b = JSON.parse(req.postData()); switches[b.id] = b.on; }
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: Object.entries(switches).map(([id, v]) => ({id, on: v}))})});
    }
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    const thread = /^api\/unified\/people\/(ann|bob)$/.exec(p);
    if (thread) { threads.push(thread[1] + ':' + url.searchParams.get('limit')); return ok({person: PEOPLE.find(x => x.id === thread[1]), messages: photos(thread[1]), has_more: false, next_cursor: null, seq: 5, typing: []}); }
    if (p.startsWith('api/unified/media/')) {
      const id = decodeURIComponent(p.split('/').pop()), kind = url.searchParams.get('kind') || 'full';
      media.push(id + ':' + kind);
      const body = kind === 'thumb' ? svg('#a33', 'thumb', 400, 300) : kind === 'view' ? svg('#36a', 'view', 1600, 1200) : svg('#3a5', 'original', 4000, 3000);
      return route.fulfill({status: 200, contentType: 'image/svg+xml', headers: {'Cache-Control': 'private, max-age=86400, immutable'}, body});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Bob Ray'}).first().waitFor({timeout: 20000});
  // The switch poll (300 ms) and the 1.5 s settle, then two chat reads and 12 files two at a time.
  await page.waitForTimeout(6000);
  const kept = await page.evaluate(async () => { const c = await caches.open('messenger-photos-v1'); return (await c.keys()).map(r => new URL(r.url).pathname.split('/').pop() + new URL(r.url).search).sort(); });
  const result = {label, on, network, threads: threads.slice(), background: media.slice(), kept};
  await page.screenshot({path: path.join(out, `${label}-list.png`)});
  const expect = on && (network === 'wifi' || !phone);
  if (expect) {
    assert.deepEqual(threads.sort(), ['ann:40', 'bob:40'], 'each recent chat read once: ' + threads);
    for (const id of ['ann0', 'ann1', 'ann2', 'bob0', 'bob1', 'bob2']) {
      assert.ok(media.includes('$' + id + ':thumb') && media.includes('$' + id + ':view'), id + ' fetched: ' + media);
      assert.ok(kept.includes('%24' + id + '?kind=thumb') && kept.includes('%24' + id + '?kind=view'), id + ' kept: ' + kept);
    }
    assert.ok(!media.some(x => x.endsWith(':full')), 'never the originals: ' + media);
    const firstView = media.findIndex(x => x.endsWith(':view')), lastThumb = media.map(x => x.endsWith(':thumb')).lastIndexOf(true);
    assert.ok(lastThumb < firstView, 'every thumbnail before any view copy: ' + media);
  } else {
    assert.deepEqual(threads, [], 'no chats read in the background');
    assert.deepEqual(media, [], 'nothing downloads in the background');
    assert.deepEqual(kept, []);
  }
  if (label === 'phone-wifi-off') {
    // Settings > Background photo download: Off, Wi-Fi only, Always. Picking Wi-Fi only turns the box switch on, and the
    // phone (on Wi-Fi) starts downloading in the background.
    await page.locator('[aria-label="Settings"]').first().click();
    const row = page.locator('.u-settings .u-more-photo-prefetch');
    await row.waitFor({timeout: 5000});
    const choices = () => row.locator('[role="radio"]').evaluateAll(bs => bs.map(b => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')));
    assert.deepEqual(await choices(), ['Off*', 'Wi-Fi only', 'Always']);
    await row.screenshot({path: path.join(out, `${label}-settings-row.png`)});
    media.length = 0;
    await row.getByRole('radio', {name: 'Wi-Fi only'}).click();
    assert.equal(switches['photo-prefetch'], true, 'the box switch is on');
    assert.deepEqual(await choices(), ['Off', 'Wi-Fi only*', 'Always']);
    await page.waitForTimeout(5000);
    assert.ok(media.includes('$bob0:thumb') && media.includes('$bob0:view'), 'downloads start once it is on: ' + media);
    await row.getByRole('radio', {name: 'Always'}).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('messenger.photoPrefetch')), 'always', 'Always is kept on this device');
    await row.getByRole('radio', {name: 'Off'}).click();
    assert.equal(switches['photo-prefetch'], false, 'Off turns the box switch off');
    await page.screenshot({path: path.join(out, `${label}-settings.png`)});
    result.settings = await choices();
    await page.keyboard.press('Escape');
    await page.locator('#u-overlay .u-sheet').waitFor({state: 'detached', timeout: 5000});
  }
  // Open Ann's chat and tap the middle photo: with the copy kept, it sharpens from Cache Storage.
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click();
  const photo = page.locator('.u-media').nth(1);
  await photo.locator('img.in').waitFor({timeout: 15000});
  media.length = 0;
  if (phone) await photo.tap(); else await photo.click();
  const own = page.locator('.u-photo-view'), img = own.locator('img');
  await own.waitFor({timeout: 5000});
  if (on) {
    await page.waitForFunction(() => document.querySelector('.u-photo-view')?.dataset.stage === 'view', null, {timeout: 5000});
    const src = await img.getAttribute('src');
    result.viewSrc = src.slice(0, 5);
    if (expect) { assert.match(src, /^blob:/, 'sharpened from the kept copy'); assert.ok(!media.includes('$ann1:view'), 'no network for the view copy: ' + media); }
    else assert.match(src, /%24ann1\?kind=view$/);
    await page.screenshot({path: path.join(out, `${label}-viewer.png`)});
  }
  await own.getByRole('button', {name: 'Close'}).click();
  assert.equal(await own.count(), 0, 'Close closes it');
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  const phone = {width: 390, height: 844}, desk = {width: 1280, height: 860};
  summary.push(await run(browser, {label: 'phone-wifi-on', on: true, network: 'wifi', viewport: phone, phone: true}));
  summary.push(await run(browser, {label: 'phone-cellular-on', on: true, network: 'cellular', viewport: phone, phone: true}));
  summary.push(await run(browser, {label: 'phone-unknown-on', on: true, network: undefined, viewport: phone, phone: true}));
  summary.push(await run(browser, {label: 'phone-wifi-off', on: false, network: 'wifi', viewport: phone, phone: true}));
  summary.push(await run(browser, {label: 'desktop-on', on: true, network: undefined, viewport: desk, phone: false}));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
