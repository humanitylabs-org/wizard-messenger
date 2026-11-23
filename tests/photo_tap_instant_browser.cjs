// Issue 348 (James, 20 Nov 2026): a tapped photo must be on screen full size in the frame of the tap, like Telegram,
// with every photo speed switch on (photo-warm, photo-instant, photo-prefetch, viewer-placeholder, photo-timings) and
// the photo's screen copy already on the phone. Messenger is framed in a minimal Wizard shell built from the real
// app-services.js, chat-kit.js and chats.css of a wizard-ux checkout (SHELL_DIR), so the tap goes through Wizard's
// shared viewer exactly as on a box. The box is slow on purpose (view copy and original take seconds), so anything
// that waits on it shows. The page runs at 2x CPU slowdown (CPU=4 for a slow phone), and a tap counts as shown in the first frame
// where the viewer is fully opaque and its picture is decoded.
// SHELL_DIR=<wizard-ux checkout> PLAYWRIGHT_MODULE=... node tests/photo_tap_instant_browser.cjs [outdir]
// STATIC_DIR=<another static dir> measures that build instead (the before numbers); LIMIT_MS (default 100) is the p50
// bar, 0 to only report; EXPECT_PREVIEW=1 also checks the shell sharpened to the screen copy. DEBUG=1 logs when the viewer opened, its picture loaded and was decoded.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'photo-tap-instant-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const L = require(path.join(__dirname, '../static/app.js'));
const LIMIT = Number(process.env.LIMIT_MS ?? 100), OPENS = Number(process.env.OPENS || 6), CPU = Number(process.env.CPU || 2);
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
// Real raster pictures (decoding them costs time like a photo does): a flat PNG of the given size and colour.
function png(w, h, [r, g, b]) {
  const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const row = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { row[1 + x * 3] = (r + x) & 255; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({length: h}, (_, y) => { const copy = Buffer.from(row); copy[2] = (g + y) & 255; return copy; }));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// THUMB_FILE / ORIGINAL_FILE: real JPEGs instead (e.g. a 320 px thumbnail and a 4000 x 3000 camera photo).
const file = (env, made) => process.env[env] ? fs.readFileSync(process.env[env]) : made();
const THUMB = file('THUMB_FILE', () => png(400, 300, [200, 40, 40])), VIEW = png(1600, 1200, [40, 80, 200]), ORIGINAL = file('ORIGINAL_FILE', () => png(4000, 3000, [40, 170, 80]));
const VIEW_MS = Number(process.env.VIEW_MS || 1500), ORIGINAL_MS = Number(process.env.ORIGINAL_MS || 3000);
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [0, 1, 2].map(i => ({id: '$p' + i, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (3 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 1600, h: 1200, mime: 'image/png', thumb: true}, reactions: []}));
const SWITCHES = ['photo-warm', 'photo-instant', 'viewer-placeholder', 'photo-prefetch', 'photo-timings'].map(id => ({id, name: id, on: true}));
const servers = [];
const stats = list => { const v = [...list].sort((a, b) => a - b); return {n: v.length, p50: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)], max: v[v.length - 1]}; };

async function run(browser, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
  // In the app frame: the tap's moment on the shared clock. In the shell: the first frame the viewer is fully shown
  // with a decoded picture, and whether any open frame had no picture (black).
  if (process.env.DEBUG) await ctx.addInitScript(() => { window.__debug = true; });
  await ctx.addInitScript(() => {
    if (window.top !== window) {
      addEventListener('click', e => { if (e.target.closest?.('.u-media')) window.top.__tap = performance.timeOrigin + e.timeStamp; }, true);
      return;
    }
    window.__opens = [];
    if (window.__debug) {
      const t = () => Math.round(performance.timeOrigin + performance.now() - (window.__tap || 0));
      window.__log = [];
      const wrap = () => { const v = window.WosChat?.viewer; if (!v || v.__w) return setTimeout(wrap, 50); v.__w = 1; const o = v.open; v.open = (...a) => { window.__log.push('open@' + t() + JSON.stringify(a[0].map(x => [x.placeholder, x.preview].map(u => String(u).slice(-14))).concat([a[1]]))); const r = o(...a); const img = document.querySelector('.mv-stage img'); img?.decode?.().then(() => window.__log.push('decoded@' + t()), () => {}); img?.addEventListener('load', () => window.__log.push('load@' + t())); return r; }; };
      wrap();
    }
    const watch = () => {
      const el = document.querySelector('.mviewer');
      if (el && !el.hidden && window.__tap) {
        const img = el.querySelector('.mv-stage img'), op = Number(getComputedStyle(el).opacity);
        const pic = !!img && !img.hidden && img.complete && img.naturalWidth > 0;
        const cur = window.__cur || (window.__cur = {tap: window.__tap, black: false, first: {at: Math.round(performance.timeOrigin + performance.now() - window.__tap), src: (img?.src || '').slice(-30), complete: !!img?.complete, w: img?.naturalWidth || 0, op}});
        if (!pic && op > 0.01) cur.black = true; // a frame the owner sees with no picture: black
        if (window.__debug && window.__log) window.__log.push('f@' + Math.round(performance.timeOrigin + performance.now() - cur.tap) + ':' + op.toFixed(2) + (pic ? 'P' : '-'));
        if (pic && op >= 0.99 && !cur.shown) { cur.shown = performance.timeOrigin + performance.now() - cur.tap; cur.src = img.currentSrc || img.src; window.__opens.push(cur); }
      } else window.__cur = null;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  const page = await ctx.newPage(), errors = [], posted = [], media = [], sharp = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  // A real local HTTP server, not page.route: Playwright turns the browser's HTTP cache off while it routes, and the
  // thumbnail a bubble shows is on the phone from the browser's cache when it is tapped.
  const handle = async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === '__shell/') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
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
    if (p === 'api/unified/photos/timings') { posted.push(...(JSON.parse(req.postData() || '{}').samples || [])); return ok({kept: 1}); }
    if (p.startsWith('api/unified/media/')) {
      const kind = url.searchParams.get('kind') || 'full'; media.push(kind);
      if (kind === 'thumb') return route.fulfill({status: 200, contentType: 'image/png', headers: {'Cache-Control': 'private, max-age=86400'}, body: THUMB});
      await new Promise(r => setTimeout(r, kind === 'view' ? VIEW_MS : ORIGINAL_MS)); // the box is far away
      return route.fulfill({status: 200, contentType: 'image/png', headers: {'Cache-Control': 'private, max-age=86400'}, body: kind === 'view' ? VIEW : ORIGINAL}).catch(() => {});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}).catch(() => {}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handle({
      request: () => ({url: () => 'http://' + req.headers.host + req.url, postData: () => Buffer.concat(chunks).toString()}),
      fulfill: async ({status, contentType, headers = {}, body}) => { if (res.destroyed) throw new Error('gone'); res.writeHead(status, {'Content-Type': contentType || 'text/plain', ...headers}); res.end(body); },
    }).catch(() => {}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  await page.goto(`http://127.0.0.1:${server.address().port}/__shell/`);
  const app = page.frameLocator('#frame'), frame = () => page.frames().find(f => f !== page.mainFrame());
  // This phone already downloaded every photo's screen copy in the background (issue 166's cache and its index).
  await app.locator('.u-person').first().waitFor({timeout: 20000});
  // Each is a 1600 x 1200 JPEG at quality 0.8 with photo-like detail, as the box's shrink_photo makes them.
  await frame().evaluate(async ids => {
    const c = await caches.open('messenger-photos-v1'), index = {};
    for (const [n, id] of ids.entries()) {
      const canvas = new OffscreenCanvas(1600, 1200), g = canvas.getContext('2d');
      for (let y = 0; y < 1200; y += 8) for (let x = 0; x < 1600; x += 8) { g.fillStyle = `rgb(${(x * 7 + n * 60) % 256},${(y * 5 + x) % 256},${(x * y + n * 90) % 256})`; g.fillRect(x, y, 8, 8); }
      const blob = await canvas.convertToBlob({type: 'image/jpeg', quality: 0.8});
      const u = 'api/unified/media/' + encodeURIComponent(id) + '?kind=view';
      await c.put(u, new Response(blob, {headers: {'Content-Type': 'image/jpeg'}}));
      index[u] = {kind: 'view', size: blob.size, at: Date.now()};
    }
    localStorage.setItem('messenger.photoPrefetchIndex', JSON.stringify(index));
  }, MESSAGES.map(m => m.id));
  await page.reload();
  await app.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const photos = app.locator('.u-media');
  await photos.nth(2).locator('img.in').waitFor({timeout: 15000});
  await page.waitForTimeout(5500); // the switch poll has run
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: CPU});
  const before = media.length;
  for (let n = 0; n < OPENS; n++) {
    const photo = photos.nth(n % 3);
    await page.evaluate(() => { window.__tap = 0; });
    if (mobile) await photo.tap(); else await photo.click();
    await page.waitForFunction(k => window.__opens.length > k, n, {timeout: 8000}).catch(async e => {
      console.error(JSON.stringify({errors, tap: await page.evaluate(() => [window.__tap, window.__cur, window.WosChat?.viewer?.isOpen(), document.querySelector('.mviewer')?.outerHTML?.slice(0, 600)])}));
      throw e;
    });
    if (n === 0) await page.screenshot({path: path.join(out, `open-${label}.png`)});
    await page.waitForTimeout(400);
    // Sharpened past the thumbnail by now: to the screen copy on the phone (a blob: URL) while the original is still on
    // its way, or to the original itself when the browser already has it from an earlier open.
    sharp.push(await page.evaluate(() => { const src = document.querySelector('.mv-stage img')?.src || ''; return !!src && !/kind=thumb/.test(src); }));
    if (process.env.DEBUG) console.error('src@400', await page.evaluate(() => document.querySelector('.mv-stage img')?.src));
    if (process.env.DEBUG) console.error(label, JSON.stringify(await page.evaluate(() => [window.__opens.at(-1)?.shown, window.__log.splice(0)])));
    assert.equal(await page.evaluate(() => window.WosChat.viewer.isOpen()), true, 'Wizard\'s shared viewer opened it');
    await page.evaluate(() => window.WosChat.viewer.close());
    await page.waitForTimeout(500);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
  const opens = await page.evaluate(() => window.__opens.map(o => ({ms: Math.round(o.shown), black: o.black, first: o.first, src: o.src.replace(/^.*\/media\//, '')})));
  await page.waitForTimeout(3600);
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  const viewHits = media.slice(before).filter(k => k === 'view').length;
  return {label, tap: stats(opens.map(o => o.ms)), black: opens.filter(o => o.black).length, sharpened: sharp.filter(Boolean).length, opens, viewFetches: viewHits, timings: posted.filter(x => x.name === 'photo_wizard').map(x => x.ms)};
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, mobile] of [['412', {width: 412, height: 915}, true], ['1280', {width: 1280, height: 860}, false]]) summary.push(await run(browser, label, viewport, mobile));
  await browser.close();
  for (const sv of servers) { sv.closeAllConnections?.(); sv.close(); }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (LIMIT > 0) for (const s of summary) {
    // p50: this test box shares its CPUs with other work, so single opens can be slow for reasons outside the page.
    assert.ok(s.tap.p50 < LIMIT, `${s.label}: tap to full-screen picture p50 ${s.tap.p50} ms (bar ${LIMIT} ms)`);
    assert.equal(s.black, 0, `${s.label}: no black first frame`);
    // A shell whose viewer takes a `preview` (wizard-ux, issue 348) shows the screen copy 0.4 s after the tap.
    if (process.env.EXPECT_PREVIEW === '1') assert.equal(s.sharpened, s.opens.length, `${s.label}: sharpened to the screen copy`);
  }
})().catch(e => { console.error(e); process.exit(1); });
