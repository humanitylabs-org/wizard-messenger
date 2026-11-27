// Issue 379 (James; on for everyone, its video-fullscreen switch is gone): one tap on a received video opens it full
// screen on black, already playing with sound, with Messenger's own controls (tap shows or hides them: play/pause,
// scrubber, Close). Back or a swipe down closes it and the chat is where it was. GIFs still loop muted in the bubble.
// STALE=1: a box that still lists the old switch as off (a stale stored value) changes nothing.
// Messenger is framed in a minimal Wizard shell from the real wizard-ux core files (SHELL_DIR), and the browser
// runs with the strict autoplay rule (sound only from a tap), as on a phone.
// SHELL_DIR=<wizard-ux checkout> [FFMPEG=ffmpeg] [STALE=1] [SHOTS_ONLY=412] node tests/video_fullscreen_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'video-fullscreen-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const STALE = process.env.STALE === '1';
const switches = STALE ? [{id: 'video-fullscreen', name: 'Videos open full screen', description: '', on: false, default: false, issues: ['humanitylabs-org/wizard-messenger#379']}] : [];
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
// A 6 s test-card clip with a tone, made fresh (no binary in the repo).
const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video379-')), 'clip.webm');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '6', '-c:v', 'libvpx', '-b:v', '150k', '-c:a', 'libopus', '-b:a', '24k', clip]);
const VIDEO = fs.readFileSync(clip), POSTER = fs.readFileSync(path.join(__dirname, '..', 'icon-192.png'));
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Video', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const TEXTS = Array.from({length: 30}, (_, i) => ({id: '$t' + i, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: i % 3 === 0, original: 'Message number ' + i, timestamp: now - (40 - i) * min, timeline_order: -40 + i, msgtype: 'm.text', reactions: []}));
const MESSAGES = [...TEXTS,
  {id: '$video', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - 2 * min, timeline_order: 1, msgtype: 'm.video', media: {w: 320, h: 240, mime: 'video/webm', duration: 6000, thumb: true}, reactions: []},
  {id: '$gif', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - min, timeline_order: 2, msgtype: 'm.video', media: {w: 320, h: 240, mime: 'video/webm', gif: true}, reactions: []},
];

async function run(browser, label, viewport, mobile, skin) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: skin});
  await ctx.addInitScript(s => { try { document.documentElement.dataset.colorScheme = s; } catch {} }, skin);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
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
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      if (url.searchParams.get('kind') === 'thumb') return route.fulfill({status: 200, contentType: 'image/png', body: POSTER});
      // Like the box, answer byte ranges, so the scrubber can seek.
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers().range || '');
      if (!range) return route.fulfill({status: 200, contentType: 'video/webm', headers: {'accept-ranges': 'bytes'}, body: VIDEO});
      const a = Number(range[1]), b = range[2] ? Math.min(Number(range[2]), VIDEO.length - 1) : VIDEO.length - 1;
      return route.fulfill({status: 206, contentType: 'video/webm', headers: {'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${VIDEO.length}`}, body: VIDEO.subarray(a, b + 1)});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/__shell/');
  const app = page.frameLocator('#frame'), frame = page.frame({url: /messenger\.test\/$/}) || page.frames()[1];
  await app.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const box = app.locator('.u-media[aria-label="Play video"]').first();
  await box.waitFor({timeout: 15000});
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  const tap = async (loc, where) => { const b = await loc.boundingBox(); const x = b.x + (where ? where(b).x : b.width / 2), y = b.y + (where ? where(b).y : b.height / 2); if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); };
  const tag = `${STALE ? 'stale' : 'on'}-${label}-${skin}`;
  await page.screenshot({path: path.join(out, `${tag}-chat.png`)});
  const scrollBefore = await frame.evaluate(() => document.querySelector('.u-timeline, .u-thread-body')?.scrollTop ?? null);
  await tap(box);
  const layer = app.locator('.u-video-view');
  await layer.waitFor({timeout: 3000});
  await frame.waitForFunction(() => document.querySelector('.u-video-view')?.dataset.firstFrame, null, {timeout: 5000});
  await page.waitForTimeout(700);
  const opened = await frame.evaluate(() => {
    const l = document.querySelector('.u-video-view'), v = l.querySelector('video'), r = l.getBoundingClientRect(), vr = v.getBoundingClientRect();
    return {paused: v.paused, muted: v.muted, controls: v.controls, time: v.currentTime, firstFrame: Number(l.dataset.firstFrame),
      covers: r.width === innerWidth && r.height === innerHeight, videoFills: vr.width === innerWidth && vr.height === innerHeight,
      bg: getComputedStyle(l).backgroundColor, poster: !!v.poster, bubblePaused: document.querySelector('.u-media:not(.gif) video').paused};
  });
  await page.screenshot({path: path.join(out, `${tag}-open.png`)});
  assert.equal(opened.paused, false, 'it plays from the one tap');
  assert.equal(opened.muted, false, 'with sound');
  assert.equal(opened.controls, false, 'no browser control box');
  assert.ok(opened.time > 0.2, 'really running: ' + opened.time);
  assert.ok(opened.covers && opened.videoFills, 'fills the screen');
  assert.ok(['rgb(0, 0, 0)', 'color(srgb 0 0 0)'].includes(opened.bg), 'on black: ' + opened.bg);
  assert.ok(opened.poster, 'the poster shows while it starts');
  assert.equal(opened.bubblePaused, true, 'the bubble itself stays still');
  assert.ok(opened.firstFrame < 300, 'tap to first moving frame under 300 ms: ' + opened.firstFrame);
  // The controls fade out while it plays; a tap brings them back, another hides them.
  await page.waitForTimeout(2800);
  assert.equal(await layer.evaluate(l => l.classList.contains('chrome')), false, 'controls hide while playing');
  await page.screenshot({path: path.join(out, `${tag}-playing.png`)});
  await tap(layer, b => ({x: b.width / 2, y: b.height / 3}));
  await page.waitForTimeout(250);
  assert.equal(await layer.evaluate(l => l.classList.contains('chrome')), true, 'a tap shows the controls');
  await page.screenshot({path: path.join(out, `${tag}-controls.png`)});
  const playBtn = app.locator('.u-vv-play');
  assert.equal(await playBtn.getAttribute('aria-label'), 'Pause video');
  await tap(playBtn);
  await page.waitForTimeout(250);
  assert.equal(await frame.evaluate(() => document.querySelector('.u-video-view video').paused), true, 'Pause pauses');
  // The scrubber seeks.
  const scrub = app.locator('.u-vv-scrub');
  await scrub.evaluate(s => { s.value = '500'; s.dispatchEvent(new Event('input', {bubbles: true})); s.dispatchEvent(new Event('change', {bubbles: true})); });
  const at = await frame.evaluate(() => document.querySelector('.u-video-view video').currentTime);
  assert.ok(Math.abs(at - 3) < 0.6, 'scrubber to the middle seeks to about 3 s: ' + at);
  await tap(playBtn);
  await page.waitForTimeout(300);
  assert.equal(await frame.evaluate(() => document.querySelector('.u-video-view video').paused), false, 'Play plays again');
  // Back (the shell's Android Back goes through canGoBack/back) closes it; the chat is where it was.
  const back = await frame.evaluate(() => { const u = window.MessengerUnified; return u && typeof u.back === 'function' ? (u.back(), true) : false; });
  if (!back) await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert.equal(await layer.count(), 0, 'Back closes it');
  const scrollAfter = await frame.evaluate(() => document.querySelector('.u-timeline, .u-thread-body')?.scrollTop ?? null);
  assert.equal(scrollAfter, scrollBefore, 'the chat is at the same place');
  // Swipe down closes it too (phone).
  if (mobile) {
    await tap(box);
    await layer.waitFor({timeout: 3000});
    await page.waitForTimeout(400);
    const cdp = await ctx.newCDPSession(page), x = viewport.width / 2;
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y: 200}]});
    for (let y = 220; y <= 420; y += 20) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y}]});
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitForTimeout(300);
    assert.equal(await layer.count(), 0, 'a swipe down closes it');
  } else {
    await tap(box); await layer.waitFor({timeout: 3000});
    await tap(app.locator('.u-vv-close'));
    await page.waitForTimeout(300);
    assert.equal(await layer.count(), 0, 'Close closes it');
  }
  // GIFs still loop on their own, muted, in the bubble.
  const gif = await frame.evaluate(() => { const v = document.querySelector('.u-media.gif video'); return {paused: v.paused, muted: v.muted, loop: v.loop}; });
  assert.deepEqual(gif, {paused: false, muted: true, loop: true}, 'GIF loops muted');
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return {label, skin, opened, gif};
}

(async () => {
  const browser = await chromium.launch({args: ['--autoplay-policy=user-gesture-required']}), summary = [];
  const runs = [['412', {width: 412, height: 860}, true, 'dark'], ['412', {width: 412, height: 860}, true, 'light'], ['1280', {width: 1280, height: 860}, false, 'dark'], ['1280', {width: 1280, height: 860}, false, 'light']];
  for (const r of runs) summary.push(await run(browser, ...r));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
