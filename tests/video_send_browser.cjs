// Issue 402: a video picked with + → "Photo or video" goes out as a real video on every network, not a paperclip file.
// Staged by tests/video_send_stage.py (real ViewServer + UnifiedInbox upload and send path; Matrix, the Synapse upload
// and the Wizard chat engine are faked and recorded). For LINE, Telegram, WhatsApp, Signal and a Wizard chat:
//  - the tray shows the video's first frame with a play badge and its length (not a file chip);
//  - Send uploads it as a video and sends ONE m.video with mimetype, size, w, h, duration and a JPEG thumbnail_url
//    (a Wizard chat sends the video file itself);
//  - the sent bubble is an inline video (first-frame poster, Play video) that plays on tap, never a paperclip card.
// Also: "File" still sends a video as a file; 2 photos + 1 video send without errors and each keeps its own type; LINE
// gets the words after the video (LINE refuses captions on videos); a video over 25 MB says so.
// AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python tests/video_send_stage.py <port> &
// AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web node tests/video_send_browser.cjs [shots dir]
// FFMPEG=<ffmpeg> (default: ffmpeg on PATH). NO_ASSERT=1 prints what happened without failing (for a before run).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), {execFileSync} = require('node:child_process');
const dir = process.env.AGENT_STAGE_DIR; assert.ok(dir, 'AGENT_STAGE_DIR is required');
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const out = path.resolve(process.argv[2] || path.join(dir, 'shots')); fs.mkdirSync(out, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR; assert.ok(WEB, 'WIZARD_WEB_DIR (wizard-ux/web) is required');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'};
const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const sends = () => lines(st.sends).filter(x => x.method === 'PUT' && /\/send\/m\.room\.message\//.test(x.path)).map(x => x.body);
const NAMES = {line: 'Lin (LINE)', telegram: 'Zoe (Telegram)', whatsapp: 'Bram (WhatsApp)', signal: 'Sam (Signal)', wizard: 'Ana (Wizard)'};

// A 3 s phone-shaped clip with sound. Playwright's Chromium has no H.264, so VP9/Opus in an MP4 (a phone's .mp4 is
// H.264; the send path is the same, only the codec inside differs).
const clip = path.join(dir, 'clip.mp4');
if (!fs.existsSync(clip)) execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=3:r=24', '-f', 'lavfi', '-i', 'sine=f=440:d=3',
  '-c:v', 'libvpx-vp9', '-b:v', '300k', '-c:a', 'libopus', '-shortest', '-movflags', '+faststart', clip]);
const big = path.join(dir, 'big.mp4');
if (!fs.existsSync(big)) { const b = Buffer.alloc(26 * 1048576); fs.readFileSync(clip).copy(b); fs.writeFileSync(big, b); }

async function setup(browser) {
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const f = path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
    if (!fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
    return r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
  });
  await ctx.addInitScript(() => {
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = 'dark'; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], uploads = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {
    const u = new URL(r.url());
    if (/\/upload$/.test(u.pathname)) uploads.push(u.searchParams.get('kind'));
    if (r.method() === 'POST' && /\/send$/.test(u.pathname)) posts.push(r.postDataJSON());
  });
  await page.goto(st.origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  return {ctx, page, errors, uploads, posts};
}

async function openChat(page, network) {
  if (await page.locator('.u-thread-body').count()) { await page.locator('.u-back').first().tap(); await page.locator('.u-person').first().waitFor(); }
  await page.locator('.u-person', {hasText: NAMES[network]}).first().tap();
  await page.locator('.u-composer textarea').waitFor({timeout: 15000});
}

async function pick(page, item, files) {
  await page.locator('.u-composer .u-attach').tap();
  const menu = page.locator('.u-menu.u-attach-menu'); await menu.waitFor({timeout: 5000});
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', {timeout: 5000}), menu.getByRole('menuitem', {name: item, exact: true}).tap()]);
  await chooser.setFiles(files);
}

const pngs = page => page.evaluate(async () => Promise.all(['#c33', '#3c3'].map(async c => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 64, 48); const b = await new Promise(r => cv.toBlob(r, 'image/png')); return Array.from(new Uint8Array(await b.arrayBuffer())); })));

async function tray(page) {
  return page.evaluate(() => [...document.querySelectorAll('.u-attach-strip .ch-att')].map(c => ({video: c.classList.contains('u-attach-video'),
    picture: !!c.querySelector('img')?.naturalWidth, badge: !!c.querySelector('.u-attach-play'), dur: c.querySelector('.u-attach-dur')?.textContent || '',
    file: !c.classList.contains('ch-attimg')})));
}

async function settle(page, before, want) {
  for (let i = 0; i < 100; i++) { if (sends().length + lines(st.marmot).length >= before + want && !(await page.locator('.u-message.pending').count())) break; await page.waitForTimeout(150); }
  await page.waitForTimeout(600);
}

async function sentBubble(page) {
  const row = page.locator('.u-row:has(.u-media video)').last();
  const r = {videoBubble: await row.count(), paperclip: await page.locator('.u-row .u-file').count()};
  if (!r.videoBubble) return r;
  r.poster = await row.locator('video').evaluate(v => v.poster || '');
  r.label = await row.locator('.u-media').getAttribute('aria-label');
  r.dur = await row.locator('.u-vdur').textContent().catch(() => '');
  await row.locator('.u-media').tap();
  await page.waitForTimeout(1200);
  r.played = await row.locator('video').evaluate(v => !v.paused && v.currentTime > 0);
  return r;
}

(async () => {
  const browser = await chromium.launch({args: ['--autoplay-policy=user-gesture-required']}), results = {};
  for (const network of ['line', 'telegram', 'whatsapp', 'signal', 'wizard']) {
    const t = await setup(browser);
    await openChat(t.page, network);
    const before = sends().length + lines(st.marmot).length;
    await pick(t.page, 'Photo or video', [clip]);
    await t.page.locator('.u-attach-strip .ch-att').first().waitFor({timeout: 10000});
    await t.page.waitForTimeout(800);
    const r = {tray: await tray(t.page)};
    await t.page.screenshot({path: path.join(out, network + '-tray.png')});
    await t.page.locator('.u-composer .u-send').first().tap();
    await settle(t.page, before, 1);
    r.uploads = t.uploads; r.post = t.posts[0] && {upload_id: !!t.posts[0].upload_id, thumb: !!t.posts[0].thumb_upload_id, media: t.posts[0].media};
    if (network === 'wizard') r.marmot = lines(st.marmot).slice(-1)[0];
    else { const b = sends().slice(-1)[0]; r.event = b && {msgtype: b.msgtype, mimetype: b.info?.mimetype, size: b.info?.size, w: b.info?.w, h: b.info?.h, duration: b.info?.duration, thumb: b.info?.thumbnail_url, thumbInfo: b.info?.thumbnail_info, body: b.body}; }
    r.bubble = await sentBubble(t.page);
    await t.page.screenshot({path: path.join(out, network + '-sent.png')});
    // Opened again later (no phone copy any more): the box's thumbnail is the frame, and it loads.
    await t.page.reload(); await t.page.locator('.u-person, .u-thread-body').first().waitFor({timeout: 20000}); await t.page.waitForTimeout(500); await openChat(t.page, network);
    const again = t.page.locator('.u-row:has(.u-media video)').last(); await again.waitFor({timeout: 10000});
    r.reopened = await again.locator('video').evaluate(async v => { const u = v.poster; if (!u) return {poster: ''}; const res = await fetch(u, {credentials: 'same-origin'}); return {poster: u, status: res.status, type: res.headers.get('content-type')}; });
    r.errors = t.errors; results[network] = r; console.log(network, JSON.stringify(r));
    await t.ctx.close();
  }
  { // "File" still sends a video as a file.
    const t = await setup(browser); await openChat(t.page, 'telegram'); const before = sends().length;
    await pick(t.page, 'File', [clip]);
    await t.page.locator('.u-attach-strip .ch-att').first().waitFor({timeout: 10000}); await t.page.waitForTimeout(500);
    const r = {tray: await tray(t.page)};
    await t.page.locator('.u-composer .u-send').first().tap(); await settle(t.page, before, 1);
    r.uploads = t.uploads; r.msgtypes = sends().slice(before).map(b => b.msgtype); r.errors = t.errors;
    results.file = r; console.log('file', JSON.stringify(r)); await t.ctx.close();
  }
  for (const network of ['line', 'telegram']) { // 2 photos + 1 video in one pick, with words
    const t = await setup(browser); await openChat(t.page, network); const before = sends().length;
    const shots = await pngs(t.page);
    await pick(t.page, 'Photo or video', [...shots.map((b, i) => ({name: 'p' + i + '.png', mimeType: 'image/png', buffer: Buffer.from(b)})), {name: 'clip.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(clip)}]);
    await t.page.locator('.u-attach-strip .ch-att').nth(2).waitFor({timeout: 10000}); await t.page.waitForTimeout(800);
    await t.page.locator('.u-composer textarea').fill('From the beach');
    const r = {tray: await tray(t.page)};
    await t.page.locator('.u-composer .u-send').first().tap(); await settle(t.page, before, network === 'line' ? 4 : 2);
    r.msgtypes = sends().slice(before).map(b => b.msgtype + (b.body === 'From the beach' ? ':words' : ''));
    r.failed = await t.page.locator('.u-message.failed').count(); r.errors = t.errors;
    results['mixed-' + network] = r; console.log('mixed-' + network, JSON.stringify(r));
    await t.page.screenshot({path: path.join(out, 'mixed-' + network + '.png')}); await t.ctx.close();
  }
  { // Over 25 MB: a clear message, nothing staged.
    const t = await setup(browser); await openChat(t.page, 'whatsapp');
    await pick(t.page, 'Photo or video', [big]); await t.page.waitForTimeout(800);
    results.big = {toast: await t.page.locator('.u-toast, [role=status]').allInnerTexts().catch(() => []), tray: await tray(t.page)};
    console.log('big', JSON.stringify(results.big)); await t.ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2));
  if (process.env.NO_ASSERT) return;
  for (const network of ['line', 'telegram', 'whatsapp', 'signal', 'wizard']) {
    const r = results[network], n = network;
    assert.deepEqual(r.errors, [], n + ': no page errors');
    assert.equal(r.tray.length, 1, n + ': one item in the tray');
    assert.ok(r.tray[0].video && r.tray[0].picture && r.tray[0].badge, n + ': tray shows the first frame with a play badge');
    assert.equal(r.tray[0].dur, '0:03', n + ': tray shows the length');
    assert.equal(r.bubble.paperclip, 0, n + ': no paperclip card');
    assert.equal(r.bubble.videoBubble, 1, n + ': the sent bubble is an inline video');
    assert.equal(r.bubble.label, 'Play video', n + ': the bubble plays');
    assert.ok(r.bubble.played, n + ': the video plays on tap');
    if (network === 'wizard') {
      assert.deepEqual(r.marmot.files, ['clip.mp4'], 'Wizard chat: the video file goes');
      continue;
    }
    assert.ok(r.bubble.poster, n + ': the sent bubble shows the first frame');
    assert.match(r.reopened.poster, /kind=thumb/, n + ': opened later, the bubble shows the box thumbnail');
    assert.deepEqual([r.reopened.status, r.reopened.type], [200, 'image/jpeg'], n + ': that thumbnail is the JPEG frame');
    assert.equal(r.bubble.dur, '0:03', n + ': the sent bubble shows the length');
    assert.deepEqual(r.uploads, ['video', 'image'], n + ': the video, then its first-frame thumbnail');
    const e = r.event;
    assert.equal(e.msgtype, 'm.video', n + ': sent as m.video');
    assert.equal(e.mimetype, 'video/mp4', n + ': mimetype');
    assert.ok(e.size > 1000 && e.w === 360 && e.h === 640 && e.duration >= 2900 && e.duration <= 3100, n + ': size, w, h and duration');
    assert.match(e.thumb || '', /^mxc:\/\//, n + ': thumbnail_url');
    assert.equal(e.thumbInfo?.mimetype, 'image/jpeg', n + ': thumbnail is a JPEG');
  }
  assert.deepEqual(results.file.uploads, ['file'], 'File: uploaded as a file');
  assert.deepEqual(results.file.msgtypes, ['m.file'], 'File: sent as a file');
  assert.ok(results.file.tray[0].file && !results.file.tray[0].video, 'File: a file chip');
  assert.deepEqual(results['mixed-line'].msgtypes, ['m.image', 'm.image', 'm.video', 'm.text:words'], 'LINE: photos as a group, the video, then the words');
  assert.deepEqual(results['mixed-telegram'].msgtypes, ['m.image:words', 'm.video'], 'Telegram: the album with the words, then the video');
  for (const k of ['mixed-line', 'mixed-telegram']) {
    assert.deepEqual(results[k].tray.map(x => x.video), [false, false, true], k + ': each keeps its own type in the tray');
    assert.equal(results[k].failed, 0, k + ': nothing failed'); assert.deepEqual(results[k].errors, [], k + ': no page errors');
  }
  assert.equal(results.big.tray.length, 0, 'over 25 MB: nothing staged');
  assert.ok(results.big.toast.some(s => /25 MB/.test(s)), 'over 25 MB: says videos go up to 25 MB');
  console.log('pass video_send_browser');
})().catch(e => { console.error(e); process.exit(1); });
