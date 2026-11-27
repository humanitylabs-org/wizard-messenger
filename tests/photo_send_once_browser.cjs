// Issue 481: every photo, video and file is uploaded once. The composer saves each attachment to the chat's draft
// while you attach it (2-3 at a time), and Send then sends those saved copies from the box: no second upload from
// the phone. Throttled like a phone on 4G (150 ms round trip, 750 kbps up, 4x CPU).
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python3 tests/agent_drafts_stage.py <port> &
//        AGENT_STAGE_DIR=<dir> SHELL_DIR=<wizard-ux>/web node tests/photo_send_once_browser.cjs
// STATIC_DIR=<other>/static runs another unified.js (before). REPORT=1 prints the numbers without asserting.
// SHOTS=<dir> saves a phone shot of the delivered album.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/tmp/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
const REPORT = !!process.env.REPORT;
const check = (ok, what) => { if (REPORT) { if (!ok) console.log('  (would fail) ' + what); } else assert.ok(ok, what); };
const drafts = async who => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts.filter(d => d.person_id === who);
const sentLog = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'sent.json'))); } catch { return {mx: [], engine: []}; } };
const until = async (fn, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('timed out: ' + what); };

async function photos(browser, n = 4) {
  // Camera-size photos (12 and 8 MP), drawn in a page so the test needs nothing but Playwright.
  const page = await browser.newPage(), out = [];
  for (const [i, [w, h]] of [[4000, 3000], [3264, 2448], [4000, 3000], [3264, 2448]].slice(0, n).entries()) {
    const b64 = await page.evaluate(async ([w, h, i]) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${i * 80} 70% 40%)`); grad.addColorStop(1, `hsl(${i * 80 + 140} 70% 60%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      for (let n = 0; n < 4000; n++) { g.fillStyle = `hsl(${(n * 37) % 360} 60% ${30 + (n % 50)}% / .5)`; g.fillRect((n * 7919) % w, (n * 104729) % h, 40 + n % 90, 40 + n % 70); }
      const blob = await c.convertToBlob({type: 'image/jpeg', quality: 0.92}), bytes = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      return btoa(s);
    }, [w, h, i]);
    out.push({name: 'IMG_481' + i + '.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64')});
  }
  await page.close();
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
  const four = await photos(browser);
  // A tiny WebM-named video and a PDF: the box keeps them as they are.
  const video = {name: 'clip481.webm', mimeType: 'video/webm', buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60000, 7)])};
  const pdf = {name: 'notes481.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40000, 32)])};
  let log = [];
  async function open(who) {
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true, colorScheme: 'dark'});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route(/\/(unified\.js|unified\.css)(\?|$)/, route => {
      const file = path.basename(new URL(route.request().url()).pathname);
      return route.fulfill({status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(path.join(staticDir, file))});
    });
    await ctx.route('**/wizard-os-home/**', r => {
      if (!process.env.SHELL_DIR) return r.continue();
      const file = path.join(process.env.SHELL_DIR, 'core', path.basename(new URL(r.request().url()).pathname));
      return r.fulfill({status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.existsSync(file) ? fs.readFileSync(file) : ''});
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Every upload-ish request, with its body size and when it started and finished.
    const kind = u => /\/api\/drafts\/[0-9a-f]+\/attachments\?/.test(u) ? 'draft' : /\/api\/unified\/people\/[^/]+\/upload\?/.test(u) ? 'upload' : /\/api\/unified\/people\/[^/]+\/send(\?|$)/.test(u) ? 'send' : null;
    const live = new Map();
    page.on('request', r => { const k = kind(r.url()); if (!k || (k !== 'send' && r.method() !== 'PUT')) return; const e = {k, bytes: (r.postDataBuffer() || Buffer.alloc(0)).length, start: Date.now(), end: null}; live.set(r, e); log.push(e); });
    page.on('requestfinished', r => { const e = live.get(r); if (e) e.end = Date.now(); });
    page.on('requestfailed', r => { const e = live.get(r); if (e) { e.end = Date.now(); e.failed = true; } });
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: who}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1200);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 150, uploadThroughput: 750000 / 8, downloadThroughput: 9000000 / 8});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    return {ctx, page, field, errors};
  }
  const attach = async (page, files) => {
    await page.locator('input[type=file]').setInputFiles(files);
    await page.locator('.u-attach-strip .ch-att').nth(files.length - 1).waitFor({timeout: 60000});
  };
  const sendTap = page => page.getByRole('button', {name: 'Send', exact: true}).last().click();
  const sum = (k) => log.filter(e => e.k === k).reduce((n, e) => n + e.bytes, 0);
  const count = (k) => log.filter(e => e.k === k).length;
  const results = {};

  // 1. Four photos to a Telegram chat. a: Send right after attaching (the draft copies are still uploading);
  //    b: Send after the draft copies are saved (the way the issue measured it).
  for (const wait of [false, true]) {
    log = [];
    const mxBefore = sentLog().mx.length;
    assert.equal((await drafts(st.alice)).length, 0, 'start from a fresh stage (no draft for Alice)');
    const {ctx, page, field, errors} = await open('Alice Example');
    await field.fill('Four photos 481');
    const t0 = Date.now();
    await attach(page, four);
    if (wait) await until(() => log.filter(e => e.k === 'draft' && e.end).length >= 4, 'the draft copies saved', 180000);
    const tapAt = Date.now();
    await sendTap(page);
    await until(() => log.some(e => e.k === 'send' && e.end), 'the album send', 300000);
    await until(async () => (await drafts(st.alice)).length === 0, 'the draft ends', 60000);
    await page.waitForTimeout(1500);
    const draftPuts = log.filter(e => e.k === 'draft'), photoBytes = sum('draft'), total = photoBytes + sum('upload');
    // From the last attachment PUT, or from the tap when the owner tapped Send after the uploads were done.
    const lastPut = Math.max(tapAt, ...log.filter(e => e.k !== 'send').map(e => e.end || 0)), send = log.find(e => e.k === 'send');
    // Most draft PUTs in flight at the same moment (ask 3: 2-3 at a time).
    const overlap = Math.max(0, ...draftPuts.map(a => draftPuts.filter(b => b.start <= a.start && (b.end || Infinity) > a.start).length));
    const name = wait ? 'albumAfterSaved' : 'albumAtOnce';
    results[name] = {draftPuts: draftPuts.length, uploadPuts: count('upload'), photoMB: +(photoBytes / 1048576).toFixed(2), totalMB: +(total / 1048576).toFixed(2), ratio: +(total / photoBytes).toFixed(3),
      sendAfterLastPutMs: send.end - lastPut, tapToSentS: +((send.end - t0) / 1000).toFixed(1), parallel: overlap, sends: count('send')};
    console.log(name + ': ' + JSON.stringify(results[name]));
    check(draftPuts.length === 4, 'exactly 4 photo PUTs (draft attachments), got ' + draftPuts.length);
    check(count('upload') === 0, 'zero /upload PUTs, got ' + count('upload'));
    check(total <= photoBytes * 1.05, `upload bytes ${total} within 1.05x the photo bytes ${photoBytes}`);
    check(send.end - lastPut <= 2000, `send finished ${send.end - lastPut} ms after the last attachment PUT (2 s budget)`);
    check(overlap >= 2 && overlap <= 3, 'draft uploads run 2-3 at a time, saw ' + overlap);
    check(count('send') === 1, 'one send');
    const events = sentLog().mx.slice(mxBefore).filter(a => a[0].includes('/send/m.room.message/'));
    const pics = events.reduce((n, a) => { const k = (a[2].match(/'url': 'mxc/g) || []).length; return n + (a[2].includes('org.wizard.gallery') ? k - 1 : k); }, 0);
    check(events.length === 1 && pics === 4, `the box sent one album of 4 photos to Telegram (${events.length} events, ${pics} photos)`);
    check(await page.locator('.u-album').last().locator('img').count() === 4, 'the album shows 4 photos');
    if (process.env.SHOTS) await page.screenshot({path: path.join(process.env.SHOTS, name + '.png')});
    check(errors.length === 0, 'no page errors: ' + errors.join('; '));
    await ctx.close();
  }
  // 2. One photo, a video and a file to the same chat: each goes once, from the draft.
  {
    log = [];
    const {ctx, page, field, errors} = await open('Alice Example');
    await field.fill('Mixed 481');
    await attach(page, [four[1], video, pdf]);
    await sendTap(page);
    await until(() => log.filter(e => e.k === 'send' && e.end).length === 3, 'three sends (photo, video, file)', 300000);
    await until(async () => (await drafts(st.alice)).length === 0, 'the draft ends', 60000);
    results.mixed = {draftPuts: count('draft'), uploadPuts: count('upload'), uploadBytes: sum('upload'), sends: count('send')};
    console.log('photo + video + file: ' + JSON.stringify(results.mixed));
    check(count('draft') === 3, 'three draft PUTs');
    // The video's first frame (a small JPEG this phone draws) is the only phone upload left; this one can't be drawn.
    check(sum('upload') <= 120000, 'no video or file bytes uploaded twice: ' + sum('upload'));
    check(errors.length === 0, 'no page errors: ' + errors.join('; '));
    await ctx.close();
  }
  // 3. A Wizard (Marmot) chat: the photo goes from the draft into the private outbox.
  {
    log = [];
    const before = sentLog().engine.length;
    const {ctx, page, field, errors} = await open('Bob Wizard');
    await field.fill('Wizard photo 481');
    await attach(page, [four[2]]);
    await sendTap(page);
    await until(() => log.some(e => e.k === 'send' && e.end), 'the Wizard send', 300000);
    await until(() => sentLog().engine.length > before, 'Bob got it', 30000);
    results.wizard = {draftPuts: count('draft'), uploadPuts: count('upload')};
    console.log('wizard chat: ' + JSON.stringify(results.wizard));
    const got = JSON.stringify(sentLog().engine.slice(before));
    check(count('upload') === 0 && /marmot-outbox/.test(got) && /"sizes":\[[1-9]/.test(got), 'sent from the draft copy: ' + got.slice(0, 300));
    check(errors.length === 0, 'no page errors: ' + errors.join('; '));
    await ctx.close();
  }
  await browser.close();
  console.log('RESULT ' + JSON.stringify(results));
  if (!REPORT) console.log('PASS issue 481: each attachment uploads once; Send uses the draft copies on the box');
})().catch(e => { console.error(e); process.exitCode = 1; });
