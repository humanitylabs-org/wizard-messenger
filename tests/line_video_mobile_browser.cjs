// Issue 443 (bug, James on mobile data): a received LINE video sat on a loading screen in the full-screen player with
// a huge stretched play icon as its poster. On a phone on mobile data:
//   1. the newest received videos (25 MB / 3 per chat) download to the phone in the background like photos, unless
//      this device chose Wi-Fi only;
//   2. one tap plays it with sound from the phone: tap to first moving frame under 300 ms, no network on the tap;
//   3. a video with no thumbnail (LINE sends none) never gets the browser's default poster (Android WebView draws a big
//      play icon): the poster is the video's own first frame at its own aspect ratio, or plain black;
//   4. a video that still streams shows a visible loading state, and the play/pause button says what is happening.
// Messenger is framed in a minimal Wizard shell from the real wizard-ux core files (SHELL_DIR), with
// a cellular Android phone and a box that answers full videos slowly (LATENCY ms).
// SHELL_DIR=<wizard-ux checkout> [STATIC_DIR=<static>] [LATENCY=2500] [SHOTS=1] node tests/line_video_mobile_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'line-video-mobile-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const LATENCY = Number(process.env.LATENCY || 2500);
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
// A 20 s portrait clip, like a phone video; VP9/Opus in MP4 (Playwright's Chromium has no H.264). LINE sends no
// thumbnail and no size in pixels, only the file and its length.
const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video443-')), 'clip.mp4');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '20', '-c:v', 'libvpx-vp9', '-b:v', '120k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-b:a', '24k', '-movflags', '+faststart', clip]);
const VIDEO = fs.readFileSync(clip);
const person = {id: 'nok', display_name: 'Nok', identities: [{id: 'nok-i', network: 'line', kind: 'person', label: 'Nok'}], labels: [], unread: 1, muted: false, low_priority: false, last: {text: 'Video', timestamp: now - min, outgoing: false, msgtype: 'm.video'}, language: '', peer_read_ts: 0};
const TEXTS = Array.from({length: 12}, (_, i) => ({id: '$t' + i, identity_id: 'nok-i', network: 'line', sender: 'Nok', outgoing: i % 3 === 0, original: 'Message number ' + i, timestamp: now - (40 - i) * min, timeline_order: -40 + i, msgtype: 'm.text', reactions: []}));
// As the LINE bridge stores them: mime, size and duration, no thumbnail, no w/h. One video too big to keep (it streams).
const video = (id, order, size) => ({id, identity_id: 'nok-i', network: 'line', sender: 'Nok', outgoing: false, original: '', timestamp: now - (5 - order) * min, timeline_order: order, msgtype: 'm.video', media: {mime: 'video/mp4', size, duration: 20000}, reactions: []});
const MESSAGES = [...TEXTS, video('$big', 1, 60 * 1024 * 1024), video('$clip', 2, 4 * 1024 * 1024)];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36 WizardOS-Android/0.9.0';

async function run(browser, {label, skin, mode}) {
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: skin, userAgent: PHONE_UA});
  await ctx.addInitScript(({mode, skin}) => {
    try { document.documentElement.dataset.colorScheme = skin; } catch {}
    Object.defineProperty(Navigator.prototype, 'connection', {configurable: true, get: () => ({type: 'cellular', effectiveType: '4g', saveData: false, addEventListener() {}})});
    if (mode && location.pathname === '/') try { localStorage.setItem('messenger.photoPrefetch', mode); } catch {}
  }, {mode, skin});
  const page = await ctx.newPage(), errors = [], media = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = [];
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === '__shell/') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/wizard-os-home/core/chats.css"><style>html,body{margin:0;height:100%;background:#111}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style></head>
<body><iframe id="frame" src="/" allow="autoplay; fullscreen"></iframe>
<script>window.WizCore = {apps: () => ({APPS: [{id: 'messenger', name: 'Messenger', url: '/', kind: 'web'}]})};</script>
<script src="/wizard-os-home/core/app-services-windows.js"></script><script src="/wizard-os-home/core/app-services-boundary.js"></script><script src="/wizard-os-home/core/app-services.js"></script><script src="/wizard-os-home/core/chat-kit.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});</script></body></html>`});
    const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
    if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/nok') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      const id = decodeURIComponent(p.split('/').pop()), kind = url.searchParams.get('kind') || 'full';
      media.push(id + ':' + kind);
      if (kind === 'thumb') return route.fulfill({status: 404, contentType: 'application/json', body: '{"ok":false}'}); // LINE: no preview
      await new Promise(r => setTimeout(r, LATENCY)); // mobile data to the box
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range || '');
      if (!range) return route.fulfill({status: 200, contentType: 'video/mp4', headers: {'accept-ranges': 'bytes'}, body: VIDEO});
      const a = Number(range[1]), b = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
      return route.fulfill({status: 206, contentType: 'video/mp4', headers: {'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${VIDEO.length}`}, body: VIDEO.subarray(a, b + 1)});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/__shell/');
  const app = page.frameLocator('#frame');
  await app.locator('.u-person', {hasText: 'Nok'}).first().waitFor({timeout: 20000});
  const frame = page.frames().find(f => /messenger\.test\/$/.test(f.url())) || page.frames()[1];
  // The phone sits on the chat list for a while, as it would before the owner opens the chat.
  await page.waitForTimeout(LATENCY + 5000);
  const kept = await frame.evaluate(async () => { const c = await caches.open('messenger-photos-v1'); return (await c.keys()).map(r => decodeURIComponent(new URL(r.url).pathname.split('/').pop()) + new URL(r.url).search).sort(); });
  const result = {label, skin, mode: mode || 'default', background: media.slice(), kept};
  const wifiOnly = mode === 'wifi';
  if (wifiOnly) assert.deepEqual(kept, [], 'Wi-Fi only on mobile data: nothing is downloaded');
  else assert.deepEqual(kept, ['$clip'], 'on mobile data the received video is already on the phone (not the 60 MB one): ' + kept);
  await app.locator('.u-person', {hasText: 'Nok'}).first().click();
  const box = app.locator('.u-media[aria-label="Play video"]').last();
  await box.waitFor({timeout: 15000});
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  // The bubbles never fall back to the browser's own poster (a play icon in Android WebView).
  result.bubbles = await frame.evaluate(() => [...document.querySelectorAll('.u-media video')].map(v => ({poster: v.getAttribute('poster') || '', src: v.src.slice(0, 5)})));
  for (const b of result.bubbles) assert.ok(b.poster, 'every video bubble has its own poster: ' + JSON.stringify(result.bubbles));
  if (process.env.SHOTS) await page.screenshot({path: path.join(out, `${label}-${skin}-chat.png`)});
  const tapAt = async loc => { const b = await loc.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  // Tap the kept video.
  media.length = 0;
  await tapAt(box);
  const layer = app.locator('.u-video-view');
  await layer.waitFor({timeout: 3000});
  const early = await frame.evaluate(() => { const l = document.querySelector('.u-video-view'), v = l.querySelector('video'); return {poster: v.getAttribute('poster') || ''}; });
  if (process.env.SHOTS) { await page.waitForTimeout(150); await page.screenshot({path: path.join(out, `${label}-${skin}-tap-150ms.png`)}); }
  await frame.waitForFunction(() => document.querySelector('.u-video-view')?.dataset.firstFrame, null, {timeout: LATENCY + 10000});
  await page.waitForTimeout(700);
  const opened = await frame.evaluate(() => {
    const l = document.querySelector('.u-video-view'), v = l.querySelector('video'), spin = l.querySelector('.u-vv-load');
    return {paused: v.paused, muted: v.muted, time: v.currentTime, firstFrame: Number(l.dataset.firstFrame), src: v.src.slice(0, 5),
      loading: !!spin && !spin.hidden && getComputedStyle(spin).display !== 'none', button: l.querySelector('.u-vv-play').getAttribute('aria-label')};
  });
  result.poster = early.poster.slice(0, 30);
  // The poster: never the browser's default; when it is a picture, it has the video's own shape (240 x 426).
  assert.ok(early.poster, 'the full-screen video has its own poster');
  const shape = await frame.evaluate(src => new Promise(res => { const i = new Image(); i.onload = () => res({w: i.naturalWidth, h: i.naturalHeight}); i.onerror = () => res(null); i.src = src; }), early.poster);
  result.posterShape = shape;
  assert.ok(shape, 'the poster loads');
  assert.ok((shape.w === 1 && shape.h === 1) || Math.abs(shape.w / shape.h - 240 / 426) < 0.02, 'poster is plain black or the video\'s own shape: ' + JSON.stringify(shape));
  result.opened = opened;
  if (process.env.SHOTS) await page.screenshot({path: path.join(out, `${label}-${skin}-open.png`)});
  if (!wifiOnly) {
    assert.equal(opened.src, 'blob:', 'it plays from the phone');
    assert.ok(!media.some(x => x.startsWith('$clip:full')), 'no network for the video on the tap: ' + media);
    assert.ok(opened.firstFrame < 300, 'tap to first moving frame under 300 ms: ' + opened.firstFrame);
  }
  assert.equal(opened.paused, false, 'it plays from the one tap');
  assert.equal(opened.muted, false, 'with sound');
  assert.ok(opened.time > 0.2, 'really running: ' + opened.time);
  assert.equal(opened.loading, false, 'no loading sign once it plays');
  assert.equal(opened.button, 'Pause video', 'the button says Pause while it plays');
  await page.keyboard.press('Escape');
  await layer.waitFor({state: 'detached', timeout: 3000}).catch(() => {});
  // Tap the big video: it streams, so the player says it is loading until the first frame moves.
  const big = app.locator('.u-media[aria-label="Play video"]').first();
  await big.scrollIntoViewIfNeeded();
  await tapAt(big);
  await layer.waitFor({timeout: 3000});
  await page.waitForTimeout(400);
  const waiting = await frame.evaluate(() => {
    const l = document.querySelector('.u-video-view'), v = l.querySelector('video'), spin = l.querySelector('.u-vv-load');
    return {loading: !!spin && !spin.hidden && getComputedStyle(spin).display !== 'none' && spin.getBoundingClientRect().width > 0, busy: l.getAttribute('aria-busy'),
      button: l.querySelector('.u-vv-play').getAttribute('aria-label'), time: v.currentTime, poster: (v.getAttribute('poster') || '').slice(0, 30)};
  });
  result.waiting = waiting;
  if (process.env.SHOTS) await page.screenshot({path: path.join(out, `${label}-${skin}-streaming.png`)});
  assert.ok(waiting.poster, 'the streaming video has a poster too');
  assert.equal(waiting.loading, true, 'a still-streaming video shows it is loading');
  assert.equal(waiting.busy, 'true');
  assert.equal(waiting.button, 'Loading video. Tap to stop', 'the button says it is loading, not that it plays');
  await frame.waitForFunction(() => document.querySelector('.u-video-view')?.dataset.firstFrame, null, {timeout: LATENCY + 15000});
  await page.waitForTimeout(600);
  const playing = await frame.evaluate(() => { const l = document.querySelector('.u-video-view'), spin = l.querySelector('.u-vv-load'); return {loading: !!spin && !spin.hidden, button: l.querySelector('.u-vv-play').getAttribute('aria-label')}; });
  result.streamed = playing;
  assert.deepEqual(playing, {loading: false, button: 'Pause video'}, 'once it moves, the loading sign goes and the button says Pause');
  assert.deepEqual(errors.filter(e => !/play\(\) request was interrupted/.test(e)), [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({args: ['--autoplay-policy=user-gesture-required']}), summary = [];
  const only = process.env.ONLY;
  for (const r of [{label: 'cellular', skin: 'dark'}, {label: 'cellular', skin: 'light'}, {label: 'cellular-wifi-only', skin: 'dark', mode: 'wifi'}]) {
    if (only && only !== r.label + '-' + r.skin) continue;
    summary.push(await run(browser, r));
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
