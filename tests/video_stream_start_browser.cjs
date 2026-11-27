// Issue 343: a received video that is not on the phone yet starts within about a second on Wi-Fi. Two parts:
// the box keeps the video with its index (moov) in front (unified.py faststart), and on Wi-Fi a bubble near the
// screen buffers its first seconds before the tap (videoPreload). This serves the real static view and a real
// VP9 MP4 from a small HTTP server with Range, a fixed delay per request and a bandwidth cap, like a box over the
// tailnet, then times tap -> first moving frame.
// PLAYWRIGHT_MODULE=... [FFMPEG=ffmpeg] [PYTHON=python3] [BEFORE=1 STATIC_DIR=<main>/static] node tests/video_stream_start_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const BEFORE = process.env.BEFORE === '1';
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'video-stream-start-shots');
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const LATENCY = Number(process.env.LATENCY || 150), BYTES_PER_S = Number(process.env.BANDWIDTH || 2.5e6);
// A 20 s phone-style clip (about 5 MB), moov at the end as most phone recorders and ffmpeg write it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video343-')), slow = path.join(dir, 'slow.mp4');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '20', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M', '-c:a', 'libopus', '-b:a', '32k', slow]);
// What the box keeps: before the fix the file as received, after it the faststart copy unified.py makes.
let served = slow;
if (!BEFORE) {
  served = path.join(dir, 'fast.mp4');
  execFileSync(process.env.PYTHON || 'python3', ['-c', 'import sys, unified; sys.exit(0 if unified.faststart(sys.argv[1], sys.argv[2]) else 1)', slow, served], {cwd: path.join(__dirname, '..')});
}
const VIDEO = fs.readFileSync(served), POSTER = fs.readFileSync(path.join(__dirname, '..', 'icon-192.png'));
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Video', timestamp: now - min, outgoing: false, msgtype: 'm.video'}, language: '', peer_read_ts: 0};
const MESSAGES = [{id: '$video', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - min, timeline_order: 1, msgtype: 'm.video', media: {w: 640, h: 360, mime: 'video/mp4', duration: 20000, size: VIDEO.length, thumb: true}, reactions: []}];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const wait = ms => new Promise(r => setTimeout(r, ms));

function server(log) {
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname.slice(1);
    const ok = result => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ok: true, result})); };
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') { res.writeHead(200, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({contract: 'wizard.app-switches/1', switches: []})); }
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      if (url.searchParams.get('kind') === 'thumb') { res.writeHead(200, {'Content-Type': 'image/png'}); return res.end(POSTER); }
      // The box's Range rules (web.py _blob), over a link with a delay per request and a bandwidth cap.
      const size = VIDEO.length, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = size - 1, status = 200;
      if (m) { if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; } else if (m[2]) start = Math.max(0, size - +m[2]); status = 206; }
      log.push({at: Date.now(), range: req.headers.range || '', start});
      await wait(LATENCY);
      const head = {'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'};
      if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status, head);
      let at = start, closed = false;
      res.on('close', () => { closed = true; });
      while (at <= end && !closed) {
        const n = Math.min(32768, end - at + 1);
        res.write(VIDEO.subarray(at, at + n)); at += n;
        await wait(n / BYTES_PER_S * 1000);
      }
      return res.end();
    }
    if (p.startsWith('api/unified/updates')) { await wait(20000); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'});
    res.end(fs.readFileSync(file));
  });
}

async function run(browser, {label, network, mode}) {
  const log = [], srv = server(log);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: PHONE_UA});
  await ctx.addInitScript(({net, mode}) => {
    if (mode) try { localStorage.setItem('messenger.photoPrefetch', mode); } catch {}
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    Object.defineProperty(Navigator.prototype, 'connection', {configurable: true, get: () => ({type: net, saveData: false, addEventListener: noop})});
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, {net: network, mode});
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const box = page.locator('.u-media[aria-label="Play video"]').first();
  await box.waitFor({timeout: 15000});
  // The owner reads the chat for a moment before tapping, as people do.
  await page.waitForTimeout(Number(process.env.READ_MS || 1000));
  const ready = await page.evaluate(() => { const v = document.querySelector('.u-media video'); return {preload: v.preload, readyState: v.readyState, buffered: v.buffered.length ? v.buffered.end(0) : 0}; });
  // Issue 379: the tap opens the full-screen player (a new video element); time the tap to its first moving frame.
  await page.evaluate(() => {
    window.__clock = {};
    document.addEventListener('pointerdown', () => { window.__clock.tap = performance.now(); }, {capture: true, once: true});
    new MutationObserver((_, obs) => {
      const v = document.querySelector('.u-video-view video'); if (!v) return; obs.disconnect();
      const moving = () => { if (v.currentTime > 0 && !window.__clock.frame) window.__clock.frame = performance.now(); else if (!window.__clock.frame) v.requestVideoFrameCallback(moving); };
      v.requestVideoFrameCallback(moving);
      v.addEventListener('timeupdate', () => { if (v.currentTime > 0 && !window.__clock.frame) window.__clock.frame = performance.now(); });
    }).observe(document.documentElement, {childList: true, subtree: true});
  });
  const b = await box.boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForFunction(() => window.__clock.frame, null, {timeout: 20000});
  const clock = await page.evaluate(() => window.__clock);
  await page.waitForTimeout(300);
  const playing = await page.evaluate(() => { const v = document.querySelector('.u-video-view video'); return {paused: v.paused, muted: v.muted, time: v.currentTime}; });
  await page.screenshot({path: path.join(out, `${BEFORE ? 'before' : 'after'}-${label}.png`)});
  await ctx.close(); srv.close();
  const result = {label, before: BEFORE, network, ready, tapToFrameMs: Math.round(clock.frame - clock.tap), playing, requests: log.length, errors};
  assert.equal(playing.paused, false, 'one tap plays it');
  assert.deepEqual(errors.filter(e => !/play\(\) request was interrupted/.test(e)), [], 'no page errors');
  return result;
}

(async () => {
  const browser = await chromium.launch({args: ['--autoplay-policy=user-gesture-required']}), summary = [];
  summary.push(await run(browser, {label: 'wifi', network: 'wifi'}));
  summary.push(await run(browser, {label: 'cellular', network: 'cellular'}));
  summary.push(await run(browser, {label: 'cellular-wifi-only', network: 'cellular', mode: 'wifi'}));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (BEFORE) return;
  const [wifi, cell, cellWifiOnly] = summary;
  assert.equal(wifi.ready.preload, 'auto', 'on Wi-Fi the bubble buffers ahead');
  assert.ok(wifi.ready.buffered >= 1, 'with the first seconds already on the phone before the tap: ' + wifi.ready.buffered);
  assert.ok(wifi.tapToFrameMs < 300, 'on Wi-Fi the first moving frame comes within 300 ms of the tap: ' + wifi.tapToFrameMs);
  // Issue 443: on mobile data too (James is on it a lot), unless this device chose Wi-Fi only.
  assert.equal(cell.ready.preload, 'auto', 'on mobile data the bubble buffers ahead too');
  assert.equal(cellWifiOnly.ready.preload, 'metadata', 'a device that chose Wi-Fi only just reads the header on mobile data');
  assert.ok(cellWifiOnly.tapToFrameMs < 1000, 'and still starts within a second (index in front): ' + cellWifiOnly.tapToFrameMs);
})().catch(e => { console.error(e); process.exit(1); });
