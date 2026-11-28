// Issue 485: photos picked with + show in the box at once (a chip per photo, in a "preparing" state), are prepared a
// couple at a time, and each photo's draft upload starts as soon as that photo is ready, not after the whole batch.
// Sent photos keep today's size (long edge 2048, JPEG) and orientation (EXIF).
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python3 tests/agent_drafts_stage.py <port> &
//        AGENT_STAGE_DIR=<dir> SHELL_DIR=<wizard-ux>/web node tests/photo_pick_instant_browser.cjs
// Four generated 8-12 MP JPEGs (one carries EXIF orientation 6). Phone on 4G: 150 ms RTT, 750 kbps up, 4x slower CPU.
// STATIC_DIR=<other>/static runs another unified.js (before). REPORT=1 prints numbers without asserting.
// SHOTS=<dir> saves phone shots of the tray with its chips preparing (dark and light).
// FIRST_MS (default 150) and ALL_MS (default 300) are the budgets from the picker closing.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/tmp/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
const FIRST = Number(process.env.FIRST_MS || 150), ALL = Number(process.env.ALL_MS || 300), REPORT = !!process.env.REPORT;
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts.filter(d => d.person_id === st.alice);
const until = async (fn, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('timed out: ' + what); };
const check = (ok, msg) => { if (REPORT) { if (!ok) console.log('WOULD FAIL: ' + msg); } else assert.ok(ok, msg); };

// An EXIF APP1 segment saying "rotate 90° clockwise" (orientation 6), put right after the JPEG's start marker.
function withOrientation6(jpeg) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]), len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpeg.subarray(2)]);
}
const SIZES = [[4000, 3000], [3264, 2448], [4000, 3000], [3264, 2448]];
// What each sent photo must measure: long edge 2048, and the EXIF-rotated one stands upright.
const WANT = [[2048, 1536], [2048, 1536], [1536, 2048], [2048, 1536]];
async function photos(browser) {
  const page = await browser.newPage(), out = [];
  for (const [i, [w, h]] of SIZES.entries()) {
    const b64 = await page.evaluate(async ([w, h, i]) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${i * 80} 70% 40%)`); grad.addColorStop(1, `hsl(${i * 80 + 140} 70% 60%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      for (let n = 0; n < 4000; n++) { g.fillStyle = `hsl(${(n * 37) % 360} 60% ${30 + (n % 50)}% / .5)`; g.fillRect((n * 7919) % w, (n * 104729) % h, 40 + n % 90, 40 + n % 70); }
      const blob = await c.convertToBlob({type: 'image/jpeg', quality: 0.92}), bytes = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      return btoa(s);
    }, [w, h, i]);
    const jpeg = Buffer.from(b64, 'base64');
    out.push({name: 'IMG_485' + i + '.jpg', mimeType: 'image/jpeg', buffer: i === 2 ? withOrientation6(jpeg) : jpeg});
  }
  await page.close();
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
  const files = await photos(browser);
  console.log('photos: ' + files.map((f, i) => SIZES[i].join('x') + ' ' + (f.buffer.length / 1048576).toFixed(1) + ' MB').join(', '));
  const results = {};
  // This checkout's view (or STATIC_DIR's), the owner's cookie, and Wizard's shared parts from SHELL_DIR.
  const serve = async ctx => {
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
  };
  // Each run sends its photos, so the draft ends; a leftover draft (an earlier broken run) would refill the box.
  assert.equal((await drafts()).length, 0, 'start from a fresh stage (no draft for Alice)');
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true, colorScheme: scheme});
    await ctx.addInitScript(s => {
      try { document.documentElement.dataset.colorScheme = s; } catch { /* not yet */ }
      // The picker closing is the file input's change event; time every later step from it, inside the page.
      window.__pick = null;
      // Chip times are paint times (Element Timing: when each chip's picture was really on screen).
      new PerformanceObserver(list => { const p = window.__pick; if (!p) return; for (const e of list.getEntries()) if (e.identifier === 'chip-485' && e.renderTime >= p.t0) { (p.paints ||= []).push(e.renderTime - p.t0); if (String(e.url).startsWith('blob:')) (p.pictures ||= []).push(e.renderTime - p.t0); } }).observe({type: 'element', buffered: false});
      const mark = () => { for (const img of document.querySelectorAll('.u-attach-strip .ch-att img:not([elementtiming])')) img.setAttribute('elementtiming', 'chip-485'); };
      new MutationObserver(mark).observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ['src']});
      document.addEventListener('change', e => { if (e.target?.type === 'file') { window.__pick = {t0: performance.now(), ready: null, paints: [], pictures: []}; watch(); } }, true);
      const watch = () => {
        const p = window.__pick; if (!p) return; const now = performance.now(), chips = document.querySelectorAll('.u-attach-strip .ch-att');
        if (chips.length >= window.__n && !document.querySelector('.u-attach-strip .u-attach-preparing') && p.ready === null) p.ready = now - p.t0;
        if (p.ready === null && now - p.t0 < 60000) requestAnimationFrame(watch);
      };
    }, scheme);
    await serve(ctx);
    const puts = [];
    let sends = 0, sendUploads = 0;
    await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\?/, r => {
      if (r.request().method() === 'PUT') puts.push({name: new URL(r.request().url()).searchParams.get('name'), body: r.request().postDataBuffer()});
      return r.continue();
    });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/upload\?/, r => { sendUploads++; return r.continue(); });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/send(\?|$)/, r => { sends++; return r.continue(); });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1200);
    await page.evaluate(n => { window.__n = n; }, files.length);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 150, uploadThroughput: 750000 / 8, downloadThroughput: 9000000 / 8});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    if (process.env.TRACE && scheme === 'dark') await browser.startTracing(page, {path: process.env.TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline']});
    await page.locator('input[type=file]').setInputFiles(files);
    if (process.env.TRACE && scheme === 'dark') { await page.waitForTimeout(800); await browser.stopTracing(); }
    if (process.env.SHOTS) { // the tray right after the pick, chips still preparing
      await page.locator('.u-attach-strip .u-attach-preparing img[src^="blob:"]').first().waitFor({timeout: 60000});
      await page.evaluate(s => { document.documentElement.dataset.colorScheme = s; }, scheme);
      await page.screenshot({path: path.join(process.env.SHOTS, 'preparing-' + scheme + '.png')});
    }
    await page.waitForFunction(() => window.__pick && typeof window.__pick.ready === 'number' && window.__pick.paints.length >= window.__n, null, {timeout: 120000});
    const pick = await page.evaluate(() => window.__pick); pick.paints.sort((a, b) => a - b); pick.pictures.sort((a, b) => a - b);
    // Upload start times, on the same clock, from the page's resource timings.
    const firstPut = await page.waitForFunction(() => {
      const e = performance.getEntriesByType('resource').filter(x => /\/attachments\?/.test(x.name));
      return e.length ? Math.min(...e.map(x => x.startTime)) - window.__pick.t0 : null;
    }, null, {timeout: 120000, polling: 100}).then(h => h.jsonValue());
    const r = {first: pick.paints[0], all: pick.paints[files.length - 1], firstPicture: pick.pictures[0], lastReady: pick.ready, firstUploadStart: firstPut};
    results[scheme] = r;
    console.log(`${scheme}: first chip ${r.first.toFixed(0)} ms (its picture ${(r.firstPicture ?? NaN).toFixed(0)} ms), all ${files.length} chips ${r.all.toFixed(0)} ms, last photo prepared ${r.lastReady.toFixed(0)} ms, first upload started ${r.firstUploadStart.toFixed(0)} ms`);
    check(r.first <= FIRST, `first chip within ${FIRST} ms of the picker closing (took ${r.first.toFixed(0)} ms)`);
    check(r.all <= ALL, `all ${files.length} chips within ${ALL} ms (took ${r.all.toFixed(0)} ms)`);
    check(r.firstUploadStart < r.lastReady, `the first upload starts (${r.firstUploadStart.toFixed(0)} ms) before the last photo is prepared (${r.lastReady.toFixed(0)} ms)`);
    // Each photo goes up once, at today's size and the right way up.
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
    await until(() => puts.length >= files.length, 'every photo saved to the draft', 180000);
    const dims = await page.evaluate(async bodies => Promise.all(bodies.map(async b64 => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u], {type: 'image/jpeg'})); const out = [bmp.width, bmp.height]; bmp.close(); return out;
    })), puts.map(p => p.body.toString('base64')));
    const byName = Object.fromEntries(puts.map((p, i) => [p.name, dims[i]]));
    console.log('sent sizes: ' + files.map(f => f.name + ' ' + (byName[f.name] || []).join('x')).join(', '));
    assert.equal(puts.length, files.length, 'each photo saved to the draft once');
    assert.deepEqual(files.map(f => byName[f.name]), WANT, 'long edge 2048, EXIF orientation applied');
    assert.ok(puts.every(p => p.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))), 'every photo goes as a JPEG');
    // Send: one album of four, from the draft copies (no second upload).
    await field.fill('Trip photos 485');
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await until(async () => sends === 1 && (await drafts()).length === 0, 'the album is delivered once and the draft ends', 180000);
    await page.locator('.u-album').last().locator('img').nth(files.length - 1).waitFor({timeout: 30000});
    assert.equal(sendUploads, 0, 'the send uses the draft copies');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  // Send tapped while the photos are still preparing: the album still goes once with all four, each uploaded once.
  {
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true});
    await serve(ctx);
    let puts = 0, sends = 0, sendUploads = 0, sent = null;
    await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\?/, r => { if (r.request().method() === 'PUT') puts++; return r.continue(); });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/upload\?/, r => { sendUploads++; return r.continue(); });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/send(\?|$)/, r => { sends++; sent = JSON.parse(r.request().postData() || '{}'); return r.continue(); });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1200);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    await field.fill('Sent while preparing 485');
    await page.locator('input[type=file]').setInputFiles(files);
    await page.locator('.u-attach-strip .ch-att').nth(files.length - 1).waitFor({timeout: 60000});
    const albums = await page.locator('.u-album').count();
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.locator('.u-album').nth(albums).waitFor({timeout: 10000});
    await until(async () => sends === 1 && (await drafts()).length === 0, 'the album sent while preparing is delivered once', 180000);
    await page.waitForTimeout(1500);
    console.log(`send while preparing: ${sends} send, ${sent?.upload_ids?.length} photos, ${puts} draft uploads, ${sendUploads} send uploads`);
    assert.equal(sends, 1, 'sent once'); assert.equal(sent.upload_ids.length, files.length, 'all four photos in the album');
    assert.ok(sent.upload_ids.every(x => /^draft:image:/.test(x)), 'the album uses the draft copies');
    assert.equal(puts, files.length, 'each photo saved to the draft once'); assert.equal(sendUploads, 0, 'no second upload');
    assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 0, 'the box is empty');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  await browser.close();
  console.log('RESULT ' + JSON.stringify(results));
  console.log('PASS issue 485: picked photos show at once, prepare side by side, and upload as each is ready');
})().catch(e => { console.error(e); process.exitCode = 1; });
