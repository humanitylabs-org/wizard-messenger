// Issue 166: Background photo download (on for everyone since issue 468, no switch): the phone quietly fetches
// thumbnails and the box's view copies of the newest photos in the most recent chats after the list loads, keeps them
// in Cache Storage, and a tapped photo sharpens from that copy. "Wi-Fi only" on cellular downloads nothing in the
// background. Since issue 392 a phone downloads on any network unless the device chose Wi-Fi only (localStorage
// messenger.photoPrefetch). A listing that still says the old switches are off changes nothing.
// Synthetic API only, no container and no shell: PLAYWRIGHT_MODULE=... node tests/photo_prefetch_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-prefetch-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
// PNG, not SVG: since issue 404 the phone keeps only JPEG/PNG/GIF/WebP thumbnails and view copies (keepable).
function png(w, h, [r, g, b]) {
  const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (r + x) & 255; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({length: h}, (_, y) => { const copy = Buffer.from(row); copy[2] = (g + y) & 255; return copy; }));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PICS = {thumb: png(400, 300, [170, 50, 50]), view: png(1600, 1200, [50, 100, 170]), full: png(4000, 3000, [50, 170, 80])};
const chat = (id, name, at) => ({id, display_name: name, identities: [{id: id + '-i', network: 'telegram', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: at, outgoing: false, msgtype: 'm.image'}, language: '', peer_read_ts: 0});
const PEOPLE = [chat('ann', 'Ann Lee', now - min), chat('bob', 'Bob Ray', now - 5 * min)];
const photos = id => [0, 1, 2].map(i => ({id: '$' + id + i, identity_id: id + '-i', network: 'telegram', sender: id, outgoing: false, original: '', timestamp: now - (10 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true}, reactions: []}));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

async function run(browser, {label, on, network, viewport, phone, mode, listing = {}, settings}) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: 'dark', ...(phone ? {userAgent: PHONE_UA} : {})});
  await ctx.addInitScript(({net, mode}) => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    Object.defineProperty(Navigator.prototype, 'connection', {configurable: true, get: () => ({type: net, saveData: false, addEventListener: noop})});
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    if (mode) { try { localStorage.setItem('messenger.photoPrefetch', mode); } catch {} }
  }, {net: network, mode});
  const page = await ctx.newPage(), errors = [], media = [], threads = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = {...listing};
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
      const body = PICS[kind] || PICS.full;
      return route.fulfill({status: 200, contentType: 'image/png', headers: {'Cache-Control': 'private, max-age=86400, immutable'}, body});
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
  const expect = on && (mode !== 'wifi' || network === 'wifi' || !phone);
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
  if (settings) {
    // Issue 468: Settings has no Background photo download switch any more (the box no longer lists it).
    await page.locator('[aria-label="Settings"]').first().click();
    await page.locator('.u-settings').first().waitFor({timeout: 5000});
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.u-settings [data-try-id="photo-prefetch"], .u-settings [data-try-id="photo-instant"]').count(), 0, 'no photo switch in Settings');
    await page.screenshot({path: path.join(out, `${label}-settings.png`)});
    result.settings = 'no photo switch';
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
  summary.push(await run(browser, {label: 'phone-cellular-wifi-only', on: true, network: 'cellular', viewport: phone, phone: true, mode: 'wifi'}));
  summary.push(await run(browser, {label: 'phone-unknown-wifi-only', on: true, network: undefined, viewport: phone, phone: true, mode: 'wifi'}));
  // What a fresh box lists (switches.py: Photo timings is the only photo switch left), and Settings shows no photo
  // download switch.
  summary.push(await run(browser, {label: 'phone-wifi-fresh-box', on: true, network: 'wifi', viewport: phone, phone: true, listing: {'photo-timings': false}, settings: true}));
  // A listing from before issue 468 with the old switches off: downloads all the same.
  summary.push(await run(browser, {label: 'phone-wifi-old-listing-off', on: true, network: 'wifi', viewport: phone, phone: true, listing: {'photo-prefetch': false, 'photo-instant': false, 'viewer-placeholder': false, 'photo-warm': false}}));
  summary.push(await run(browser, {label: 'desktop-on', on: true, network: undefined, viewport: desk, phone: false}));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
