// Issue 392 (James, 24 Nov 2026): on a phone on mobile data, opening a chat showed blank photo boxes for 5-10 s, and
// tapping a photo already on screen showed Wizard's loading wheel for another 5-10 s. Photos must already be on the
// phone: the chat paints them at once, and a tap opens full screen in the tap's frame with no wheel over the photo.
// With every photo switch on, Messenger runs framed in a minimal Wizard shell built from the real wizard-ux core
// (app-services*.js, chat-kit.js, chats.css from SHELL_DIR), on a phone whose network says 'cellular'.
//   1. The box is quick: Messenger is opened once and left on the chat list for a moment (as an owner does).
//   2. The box becomes slow (every photo request takes SLOW_MS, default 5000): reopen Messenger, open the chat, tap.
// page.route bypasses the browser's HTTP cache, so anything not kept on the phone waits on the slow box.
// SHELL_DIR=<wizard-ux checkout> PLAYWRIGHT_MODULE=... node tests/photos_ready_mobile_browser.cjs [outdir]
// STATIC_DIR=<another static dir> runs that build instead (the before numbers); EXPECT=broken only reports.
// SHOTS=1 takes phone shots 700 ms after opening the chat and after the tap (chat-early.png, tap-early.png) instead of
// timing (Before/After pictures).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photos-ready-mobile-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const L = require(path.join(__dirname, '../static/app.js'));
const SLOW_MS = Number(process.env.SLOW_MS || 5000), REPORT = process.env.EXPECT === 'broken';
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
function png(w, h, [r, g, b]) {
  const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (r + x) & 255; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({length: h}, (_, y) => { const copy = Buffer.from(row); copy[2] = (g + y) & 255; return copy; }));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const THUMB = png(400, 300, [200, 40, 40]), VIEW = png(1600, 1200, [40, 80, 200]), ORIGINAL = png(3000, 2250, [40, 170, 80]);
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'line', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false, msgtype: 'm.image'}, language: '', peer_read_ts: 0};
const N = 10;
const MESSAGES = Array.from({length: N}, (_, i) => ({id: '$p' + i, identity_id: 'ann-i', network: 'line', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (N + 1 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/jpeg', thumb: true, size: 900000}, reactions: []}));
const SWITCHES = ['photo-warm', 'photo-instant', 'photo-prefetch', 'photo-timings', 'viewer-placeholder'].map(id => ({id, name: id, on: true}));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 412, height: 915}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: PHONE_UA});
  await ctx.addInitScript(() => {
    const noop = () => {};
    Object.defineProperty(Navigator.prototype, 'connection', {configurable: true, get: () => ({type: 'cellular', effectiveType: '4g', saveData: false, addEventListener: noop})});
  });
  const page = await ctx.newPage(), errors = [], media = [];
  page.on('pageerror', e => errors.push(e.message));
  let slow = false;
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === '__shell/') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/wizard-os-home/core/base.css"><link rel="stylesheet" href="/wizard-os-home/core/chats.css"><style>html,body{margin:0;height:100%;background:#111}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style></head>
<body><iframe id="frame" src="/"></iframe>
<script>window.WizCore = {apps: () => ({APPS: [{id: 'messenger', name: 'Messenger', url: '/', kind: 'web'}]})};</script>
<script src="/wizard-os-home/core/app-services-windows.js"></script><script src="/wizard-os-home/core/app-services-boundary.js"></script><script src="/wizard-os-home/core/app-services.js"></script><script src="/wizard-os-home/core/chat-kit.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});</script></body></html>`});
    const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
    if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: SWITCHES})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      const kind = url.searchParams.get('kind') || 'full'; media.push({kind, slow, at: Date.now()});
      await new Promise(r => setTimeout(r, slow ? SLOW_MS : 30));
      const body = kind === 'thumb' ? THUMB : kind === 'view' ? VIEW : ORIGINAL;
      return route.fulfill({status: 200, contentType: 'image/png', headers: {'Cache-Control': 'private, max-age=86400, immutable'}, body}).catch(() => {});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}).catch(() => {}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  const app = page.frameLocator('#frame'), frame = () => page.frames().find(f => f !== page.mainFrame());
  const result = {};

  // 1. Quick box, mobile data: Messenger open on the chat list for a while. The phone downloads ahead.
  await page.goto('https://messenger.test/__shell/');
  await app.locator('.u-person', {hasText: 'Ann Lee'}).first().waitFor({timeout: 20000});
  const kept = () => frame().evaluate(() => { try { return Object.values(JSON.parse(localStorage.getItem('messenger.photoPrefetchIndex') || '{}')).map(e => e.kind); } catch { return []; } });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { const k = await kept(); if (k.filter(x => x === 'thumb').length >= N && k.filter(x => x === 'view').length >= N) break; await page.waitForTimeout(300); }
  const k = await kept();
  result.keptOnPhone = {thumb: k.filter(x => x === 'thumb').length, view: k.filter(x => x === 'view').length};

  // 2. The box is now slow. Reopen Messenger and the chat: how long until every photo bubble shows its picture?
  slow = true;
  await page.reload();
  await app.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const opened = Date.now();
  const photos = app.locator('.u-media');
  if (process.env.SHOTS) { await page.waitForTimeout(700); await page.screenshot({path: path.join(out, 'chat-early.png')}); }
  await photos.nth(N - 1).waitFor({timeout: 10000});
  await frame().waitForFunction(n => [...document.querySelectorAll('.u-media img')].filter(i => i.classList.contains('in')).length >= n, N, {timeout: SLOW_MS + 8000});
  result.chatPaintedMs = Date.now() - opened;
  await page.screenshot({path: path.join(out, 'chat.png')});

  // 3. Tap a photo that is on screen: Wizard's viewer shows a picture at once, and the loading wheel is gone soon.
  await page.waitForTimeout(800);
  const target = photos.nth(N - 2);
  await target.scrollIntoViewIfNeeded();
  const before = media.length;
  await page.evaluate(() => {
    window.__t = {};
    const tick = () => {
      const el = document.querySelector('.mviewer'), t = window.__t;
      if (el && !el.hidden && t.tap) {
        const img = el.querySelector('.mv-stage img'), op = Number(getComputedStyle(el).opacity), at = performance.now() - t.tap;
        if (t.picture == null && img && img.complete && img.naturalWidth > 0 && op >= 0.99) t.picture = at;
        if (t.picture != null && t.wheelGone == null && !el.querySelector('.mv-load')) t.wheelGone = at;
        if (t.sharp == null && img && img.naturalWidth >= 1600) t.sharp = at;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => { window.__t.tap = performance.now(); });
  await target.tap();
  if (process.env.SHOTS) { await page.waitForTimeout(700); await page.screenshot({path: path.join(out, 'tap-early.png')}); }
  await page.waitForFunction(() => window.__t.picture != null, null, {timeout: SLOW_MS + 5000});
  await page.screenshot({path: path.join(out, 'tap.png')});
  await page.waitForFunction(() => window.__t.wheelGone != null, null, {timeout: SLOW_MS * 2 + 5000}).catch(() => {});
  Object.assign(result, await page.evaluate(() => ({tapPictureMs: Math.round(window.__t.picture), tapWheelGoneMs: window.__t.wheelGone == null ? null : Math.round(window.__t.wheelGone), tapSharpMs: window.__t.sharp == null ? null : Math.round(window.__t.sharp)})));
  result.viewerItem = await page.evaluate(() => { const img = document.querySelector('.mviewer .mv-stage img'); return {w: img?.naturalWidth || 0, src: (img?.currentSrc || img?.src || '').slice(0, 5)}; });
  await page.screenshot({path: path.join(out, 'viewer.png')});
  // Swipe to the next photo and back; Save is there; Back closes.
  await page.locator('.mviewer [data-mv="next"]').click();
  await page.waitForTimeout(300);
  result.nextShown = await page.evaluate(() => { const img = document.querySelector('.mviewer .mv-stage img'); return !!img && img.naturalWidth > 0; });
  result.saveButton = await page.locator('.mviewer [data-mv="save"]').isVisible();
  result.closed = await page.evaluate(() => window.WosChat.viewer.close() === true && !window.WosChat.viewer.isOpen());
  result.boxPhotoRequestsAfterTap = media.slice(before).filter(m => m.slow).map(m => m.kind);
  result.errors = errors;
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (REPORT || process.env.SHOTS) return;
  assert.deepEqual(errors, [], 'no page errors');
  assert.ok(result.keptOnPhone.thumb >= N && result.keptOnPhone.view >= N, 'on mobile data the phone keeps every photo of a recent chat: ' + JSON.stringify(result.keptOnPhone));
  assert.ok(result.chatPaintedMs < 1500, `every photo in the chat painted from the phone in ${result.chatPaintedMs} ms (box ${SLOW_MS} ms per photo)`);
  assert.ok(result.tapPictureMs < 300, `tap to full-screen picture ${result.tapPictureMs} ms`);
  assert.ok(result.tapWheelGoneMs != null && result.tapWheelGoneMs < 1000, `no loading wheel over the photo: gone after ${result.tapWheelGoneMs} ms`);
  assert.ok(result.tapSharpMs != null && result.tapSharpMs < 1000, `sharp screen copy in ${result.tapSharpMs} ms`);
  assert.ok(result.nextShown, 'swiping to the next photo shows it');
  assert.ok(result.saveButton, 'Save is offered');
  assert.ok(result.closed, 'Back closes the viewer');
})().catch(e => { console.error(e); process.exit(1); });
