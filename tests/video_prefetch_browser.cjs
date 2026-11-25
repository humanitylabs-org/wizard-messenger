// Issue 320 (on for everyone, its video-prefetch switch is gone): the phone quietly downloads videos up to 25 MB from
// the newest messages of the newest chats (after the photos), keeps them in Cache Storage, and the bubble plays from
// that copy: one tap starts it with no network request. Bigger videos stream on tap; GIFs still loop on their own,
// muted. On cellular, or on a phone that cannot tell its network, nothing downloads. A box that still lists the old
// switch as off (a stale stored value) changes nothing.
// Synthetic API only, no container and no shell:
// PLAYWRIGHT_MODULE=... [FFMPEG=ffmpeg] node tests/video_prefetch_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'video-prefetch-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const clip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'video320-')), 'clip.webm');
execFileSync(process.env.FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '4', '-c:v', 'libvpx', '-b:v', '150k', '-c:a', 'libopus', '-b:a', '24k', clip]);
const VIDEO = fs.readFileSync(clip), POSTER = fs.readFileSync(path.join(__dirname, '..', 'icon-192.png'));
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Video', timestamp: now - min, outgoing: false, msgtype: 'm.video'}, language: '', peer_read_ts: 0};
const msg = (id, order, media) => ({id, identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - (10 - order) * min, timeline_order: order, msgtype: 'm.video', media: {w: 320, h: 240, mime: 'video/webm', ...media}, reactions: []});
// The 10 MB video the issue names (its claimed size; the fixture file is small), one over 25 MB, and a GIF.
const MESSAGES = [msg('$big', 1, {size: 40 * 1024 * 1024, duration: 4000, thumb: true}), msg('$gif', 2, {gif: true, size: 50000}), msg('$video', 3, {size: 10 * 1024 * 1024, duration: 4000, thumb: true})];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

async function run(browser, {label, stale, network}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: PHONE_UA});
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
  const switches = {'photo-prefetch': false, ...(stale ? {'video-prefetch': false} : {})};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: Object.entries(switches).map(([id, v]) => ({id, on: v}))})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') { threads.push('ann:' + url.searchParams.get('limit')); return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []}); }
    if (p.startsWith('api/unified/media/')) {
      const id = decodeURIComponent(p.split('/').pop()), kind = url.searchParams.get('kind') || 'full';
      media.push(id + ':' + kind);
      if (kind === 'thumb') return route.fulfill({status: 200, contentType: 'image/png', body: POSTER});
      return route.fulfill({status: 200, contentType: 'video/webm', body: VIDEO});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().waitFor({timeout: 20000});
  await page.waitForTimeout(5000);
  const kept = await page.evaluate(async () => { const c = await caches.open('messenger-photos-v1'); return (await c.keys()).map(r => decodeURIComponent(new URL(r.url).pathname.split('/').pop()) + new URL(r.url).search).sort(); });
  const result = {label, stale: !!stale, network, threads: threads.slice(), background: media.slice(), kept};
  const expect = network === 'wifi';
  if (expect) {
    assert.deepEqual(threads, ['ann:40'], 'the recent chat read once');
    assert.deepEqual(media, ['$video:full'], 'only the 10 MB video downloads (not the 40 MB one, not the GIF, no photos): ' + media);
    assert.deepEqual(kept, ['$video'], 'and it is kept on the phone');
  } else {
    assert.deepEqual(threads, [], 'no chats read in the background');
    assert.deepEqual(media, [], 'nothing downloads in the background');
    assert.deepEqual(kept, []);
  }
  // Open the chat: the poster is there and one tap plays the video at once.
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click();
  const box = page.locator('.u-media[aria-label="Play video"]').last();
  await box.waitFor({timeout: 15000});
  await page.waitForTimeout(1000);
  const bubble = await page.evaluate(() => { const v = [...document.querySelectorAll('.u-media:not(.gif) video')].pop(); return {src: v.src.slice(0, 5), poster: !!v.poster, kept: v.dataset.kept || ''}; });
  result.bubble = bubble;
  assert.equal(bubble.poster, true, 'the poster is there');
  if (expect) assert.equal(bubble.src, 'blob:', 'the bubble plays from the kept copy');
  else assert.notEqual(bubble.src, 'blob:');
  media.length = 0;
  const b = await box.boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(1200);
  const played = await page.evaluate(() => { const v = [...document.querySelectorAll('.u-media:not(.gif) video')].pop(); return {paused: v.paused, time: v.currentTime}; });
  result.played = played;
  assert.equal(played.paused, false, 'one tap plays it');
  assert.ok(played.time > 0.2, 'it is really running: ' + played.time);
  if (expect) assert.ok(!media.includes('$video:full'), 'no network for the video: ' + media);
  await page.screenshot({path: path.join(out, `${label}-playing.png`)});
  const gif = await page.evaluate(() => { const v = document.querySelector('.u-media.gif video'); return {paused: v.paused, muted: v.muted, loop: v.loop}; });
  assert.deepEqual(gif, {paused: false, muted: true, loop: true}, 'GIF loops muted');
  result.gif = gif;
  assert.deepEqual(errors.filter(e => !/play\(\) request was interrupted/.test(e)), [], 'no page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch(), summary = [];
  summary.push(await run(browser, {label: 'phone-wifi', network: 'wifi'}));
  summary.push(await run(browser, {label: 'phone-cellular', network: 'cellular'}));
  summary.push(await run(browser, {label: 'phone-unknown', network: undefined}));
  summary.push(await run(browser, {label: 'phone-wifi-stale-off', stale: true, network: 'wifi'}));
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
