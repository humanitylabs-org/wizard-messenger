// Issue 319 (James, 19 Nov 2026): one tap on a received video plays it, with sound, in the bubble. It used to open
// Wizard's media viewer, an extra screen whose browser-default player had to be started with a second tap.
// Messenger's static files are framed in a minimal Wizard shell built from the real wizard-ux core files (SHELL_DIR),
// and the browser runs with the strict autoplay rule (sound only from a tap), as on a phone.
// SHELL_DIR=<wizard-ux checkout> [FFMPEG=ffmpeg] [BEFORE=1 STATIC_DIR=<main>/static] node tests/video_one_tap_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'video-one-tap-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const BEFORE = process.env.BEFORE === '1';
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
// A 6 s test-card clip with a tone, made fresh (no binary in the repo).
const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video319-')), 'clip.webm');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '6', '-c:v', 'libvpx', '-b:v', '150k', '-c:a', 'libopus', '-b:a', '24k', clip]);
const VIDEO = fs.readFileSync(clip), POSTER = fs.readFileSync(path.join(__dirname, '..', 'icon-192.png'));
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Video', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [
  {id: '$video', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - 2 * min, timeline_order: 1, msgtype: 'm.video', media: {w: 320, h: 240, mime: 'video/webm', duration: 6000, thumb: true}, reactions: []},
  {id: '$gif', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - min, timeline_order: 2, msgtype: 'm.video', media: {w: 320, h: 240, mime: 'video/webm', gif: true}, reactions: []},
];

async function run(browser, label, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: 'dark'});
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
<script src="/wizard-os-home/core/app-services.js"></script><script src="/wizard-os-home/core/chat-kit.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});</script></body></html>`});
    const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
    if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
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
      return route.fulfill({status: 200, contentType: 'video/webm', body: VIDEO});
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
  await page.waitForTimeout(800);
  const tap = async (loc, where) => { const b = await loc.boundingBox(); const x = b.x + (where ? where(b).x : b.width / 2), y = b.y + (where ? where(b).y : b.height / 2); if (mobile) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y); };
  await page.screenshot({path: path.join(out, `${BEFORE ? 'before' : 'after'}-bubble-${label}.png`)});
  await tap(box);
  await page.waitForTimeout(1500);
  const shellVideo = await page.evaluate(() => { const v = document.querySelector('video'); return v ? {paused: v.paused, controls: v.controls} : null; });
  const inner = await frame.evaluate(() => { const v = document.querySelector('.u-media:not(.gif) video'); return {paused: v.paused, muted: v.muted, time: v.currentTime, own: !!document.querySelector('.u-photo-view')}; });
  await page.screenshot({path: path.join(out, `${BEFORE ? 'before' : 'after'}-one-tap-${label}.png`)});
  const result = {label, before: BEFORE, shellViewer: shellVideo, bubble: inner};
  if (BEFORE) { await ctx.close(); return result; }
  assert.equal(shellVideo, null, 'one tap opens no Wizard viewer screen');
  assert.equal(inner.own, false, 'and no Messenger viewer screen');
  assert.equal(inner.paused, false, 'the video plays from the one tap');
  assert.equal(inner.muted, false, 'with sound');
  assert.ok(inner.time > 0.3, 'it is really running: ' + inner.time);
  const playing = app.locator('.u-media.playing');
  assert.equal(await playing.getAttribute('aria-label'), 'Pause video');
  await tap(playing, b => ({x: b.width / 3, y: b.height / 3}));
  await page.waitForTimeout(300);
  assert.equal(await frame.evaluate(() => document.querySelector('.u-media:not(.gif) video').paused), true, 'a second tap pauses');
  assert.equal(await box.getAttribute('aria-label'), 'Play video');
  await tap(box);
  await page.waitForTimeout(500);
  assert.equal(await frame.evaluate(() => document.querySelector('.u-media:not(.gif) video').paused), false, 'and a third plays again');
  // The corner button goes full screen, with the browser's controls only there.
  const full = app.locator('.u-vfull');
  assert.equal(await full.isVisible(), true, 'a full-screen button once it plays');
  await tap(full);
  await page.waitForFunction(() => document.querySelector('#frame').contentDocument.fullscreenElement?.controls === true, null, {timeout: 5000});
  result.fullscreen = await frame.evaluate(() => ({controls: document.fullscreenElement.controls, paused: document.fullscreenElement.paused}));
  assert.equal(result.fullscreen.controls, true);
  await page.screenshot({path: path.join(out, `after-fullscreen-${label}.png`)});
  await frame.evaluate(() => document.exitFullscreen());
  await page.waitForTimeout(400);
  assert.equal(await frame.evaluate(() => document.querySelector('.u-media:not(.gif) video').controls), false, 'controls go away back in the bubble');
  // GIFs still loop on their own, muted, and a tap does not unmute them.
  const gif = await frame.evaluate(() => { const v = document.querySelector('.u-media.gif video'); return {paused: v.paused, muted: v.muted, loop: v.loop}; });
  assert.deepEqual(gif, {paused: false, muted: true, loop: true}, 'GIF loops muted');
  result.gif = gif;
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({args: ['--autoplay-policy=user-gesture-required']}), summary = [];
  for (const [label, viewport, mobile] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, false]]) summary.push(await run(browser, label, viewport, mobile));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
