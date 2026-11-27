// Issue 480: tapping Send with photos shows the sending album and empties the box at once, even while the photos are
// still being saved to the draft on a slow phone link. The send carries its own copy of each photo, so a draft copy
// still uploading (or failing) never holds it up; a send the box refuses puts the photos back in the box with a toast.
// A photo already showing Retry (its draft upload failed, issue 463) still blocks Send, as before.
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python3 tests/agent_drafts_stage.py <port> &
//        AGENT_STAGE_DIR=<dir> PHOTOS=<a.jpg,b.jpg,...> node tests/photo_send_instant_browser.cjs
// PHOTOS defaults to four generated 8-12 MP JPEGs. STATIC_DIR=<other>/static runs another unified.js (before).
// SHOTS=<dir> saves phone shots of the sending album (dark and light). LIMIT_MS (default 100) is the tap budget.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/tmp/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
const LIMIT = Number(process.env.LIMIT_MS || 100);
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts.filter(d => d.person_id === st.alice);
const until = async (fn, what, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('timed out: ' + what); };

async function photos(browser) {
  if (process.env.PHOTOS) return process.env.PHOTOS.split(',').map(f => ({name: path.basename(f), mimeType: 'image/jpeg', buffer: fs.readFileSync(f)}));
  // Four camera-size photos (12, 8, 12, 8 MP), drawn in a page so the test needs nothing but Playwright.
  const page = await browser.newPage(), out = [];
  for (const [i, [w, h]] of [[4000, 3000], [3264, 2448], [4000, 3000], [3264, 2448]].entries()) {
    const b64 = await page.evaluate(async ([w, h, i]) => {
      const c = new OffscreenCanvas(w, h), g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, `hsl(${i * 80} 70% 40%)`); grad.addColorStop(1, `hsl(${i * 80 + 140} 70% 60%)`);
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      for (let n = 0; n < 4000; n++) { g.fillStyle = `hsl(${(n * 37) % 360} 60% ${30 + (n % 50)}% / .5)`; g.fillRect((n * 7919) % w, (n * 104729) % h, 40 + n % 90, 40 + n % 70); }
      const blob = await c.convertToBlob({type: 'image/jpeg', quality: 0.92}), bytes = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
      return btoa(s);
    }, [w, h, i]);
    out.push({name: 'IMG_480' + i + '.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64')});
  }
  await page.close();
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
  const files = await photos(browser);
  console.log('photos: ' + files.map(f => (f.buffer.length / 1048576).toFixed(1) + ' MB').join(', '));
  let draftMode = null, sendMode = null, draftPuts = 0, sendUploads = 0, sends = 0;
  async function open(scheme = 'dark') {
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true, colorScheme: scheme});
    await ctx.addInitScript(s => { try { document.documentElement.dataset.colorScheme = s; } catch { /* not yet */ } }, scheme);
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
    await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\?/, r => {
      if (r.request().method() !== 'PUT') return r.continue();
      draftPuts++;
      return draftMode === 'fail' ? r.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'internal', message: 'Draft store failed'}})}) : r.continue();
    });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/upload\?/, r => {
      sendUploads++;
      return sendMode === 'refuse' ? r.fulfill({status: 413, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'too_large', message: 'Photo refused by the box'}})}) : r.continue();
    });
    await ctx.route(/\/api\/unified\/people\/[^/]+\/send(\?|$)/, r => { sends++; return r.continue(); });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1200);
    // A phone on 4G: 150 ms round trip, 750 kbps up, 4x slower CPU.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 150, uploadThroughput: 750000 / 8, downloadThroughput: 9000000 / 8});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    return {ctx, page, field, errors, cdp};
  }
  // Tap Send and time, inside the page, how long until the sending bubble is in the thread and the box is empty.
  async function tap(page, want) {
    await page.evaluate(([want, n]) => {
      window.__sent = null; const albums = document.querySelectorAll('.u-album').length;
      const btn = [...document.querySelectorAll('button[aria-label="Send"]')].pop();
      btn.addEventListener('click', () => {
        const t0 = performance.now();
        const ok = () => {
          const box = document.querySelector('textarea[aria-label="Message"]');
          const empty = box && !box.value && !document.querySelector('.u-attach-strip .ch-att');
          const bubble = want === 'album' ? document.querySelectorAll('.u-album').length > albums && [...document.querySelectorAll('.u-album')].pop().querySelectorAll('img').length === n : (document.querySelector('.u-timeline')?.textContent || '').includes('Quick hello 480');
          return empty && bubble;
        };
        // Counted to the frame that shows it: the next paint after the bubble and the empty box are in the page.
        const shown = () => requestAnimationFrame(() => setTimeout(() => { window.__sent = performance.now() - t0; }, 0));
        const watch = () => { if (ok()) shown(); else if (performance.now() - t0 < 60000) requestAnimationFrame(watch); };
        queueMicrotask(() => { if (ok()) shown(); else requestAnimationFrame(watch); });
      }, {capture: false});
    }, [want, files.length]);
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    if (process.env.SHOTS && want === 'album' && !tap.shot) { // what the phone shows half a second after the tap
      tap.shot = true; await page.waitForTimeout(500);
      await page.screenshot({path: path.join(process.env.SHOTS, 'half-second-after-tap.png')});
    }
    await page.waitForFunction(() => window.__sent !== null, null, {timeout: 60000});
    return page.evaluate(() => window.__sent);
  }
  const attach = async (page) => {
    await page.locator('input[type=file]').setInputFiles(files);
    await page.locator('.u-attach-strip .ch-att').nth(files.length - 1).waitFor({timeout: 60000});
  };
  const results = {};

  // 1. Four photos, Send at once: the album (sending) is in the thread and the box is empty within LIMIT ms.
  {
    assert.equal((await drafts()).length, 0, 'start from a fresh stage (no draft for Alice)');
    draftMode = null; sendMode = null; draftPuts = 0; sendUploads = 0; sends = 0;
    const {ctx, page, field, errors} = await open('dark');
    await field.fill('Photos from the trip');
    await attach(page);
    const inFlight = draftPuts, albums = await page.locator('.u-album').count();
    const ms = await tap(page, 'album');
    results.album = ms;
    console.log(`album: sending bubble + empty box ${ms.toFixed(1)} ms after the tap (draft uploads started before tap: ${inFlight})`);
    if (process.env.SHOTS) { await page.evaluate(s => { document.documentElement.dataset.colorScheme = s; }, 'dark'); await page.screenshot({path: path.join(process.env.SHOTS, 'sending-dark.png')}); }
    assert.ok(ms <= LIMIT, `album shows within ${LIMIT} ms (took ${ms.toFixed(1)} ms)`);
    assert.equal(await page.locator('.u-album').count(), albums + 1, 'one album bubble');
    const tiles = await page.locator('.u-album').last().locator('img').evaluateAll(imgs => imgs.map(i => i.src.slice(0, 5)));
    assert.deepEqual(tiles, files.map(() => 'blob:'), 'the sending album shows the four photos from this phone');
    await until(async () => sends === 1 && (await drafts()).length === 0, 'the album is delivered once and the draft ends', 180000);
    await page.waitForTimeout(1500);
    assert.equal(sends, 1, 'sent once'); assert.equal(sendUploads, files.length, 'each photo uploaded once for the send');
    assert.equal(await page.locator('.u-album').count(), albums + 1, 'still one album after delivery');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  // 2. The draft store refuses every photo: the send still goes, once, with all photos; nothing is lost.
  {
    draftMode = 'fail'; sendMode = null; draftPuts = 0; sendUploads = 0; sends = 0;
    const {ctx, page, field, errors} = await open('light');
    await field.fill('Draft store is down');
    await attach(page);
    const albums = await page.locator('.u-album').count();
    const ms = await tap(page, 'album');
    results.draftFail = ms;
    console.log(`draft copies failing: sending bubble + empty box ${ms.toFixed(1)} ms after the tap`);
    if (process.env.SHOTS) { await page.evaluate(s => { document.documentElement.dataset.colorScheme = s; }, 'light'); await page.screenshot({path: path.join(process.env.SHOTS, 'sending-light.png')}); }
    assert.ok(ms <= LIMIT, `album shows within ${LIMIT} ms (took ${ms.toFixed(1)} ms)`);
    await until(async () => sends === 1, 'the album is delivered once', 180000);
    await page.waitForTimeout(3000);
    assert.equal(sends, 1, 'sent once'); assert.equal(await page.locator('.u-album').count(), albums + 1, 'one album');
    assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 0, 'nothing comes back into the box');
    assert.deepEqual(errors.filter(e => !/Draft store failed/.test(e)), [], 'no page errors');
    await ctx.close();
    for (const d of await drafts()) await fetch(st.origin + '/api/drafts/' + d.id, {method: 'DELETE', headers: {...auth, 'Content-Type': 'application/json'}, body: JSON.stringify({revision: d.revision})}).catch(() => {});
  }
  // 3. The box refuses the photos for the send: the photos come back into the box with a toast; nothing is sent.
  {
    draftMode = null; sendMode = 'refuse'; draftPuts = 0; sendUploads = 0; sends = 0;
    const {ctx, page, field, errors} = await open('dark');
    const before = await page.locator('.u-album').count();
    await field.fill('Refused photos');
    await attach(page);
    const ms = await tap(page, 'album');
    console.log(`refused send: sending bubble + empty box ${ms.toFixed(1)} ms after the tap`);
    await page.locator('.u-attach-strip .ch-att').nth(files.length - 1).waitFor({timeout: 60000});
    assert.equal(await page.locator('.u-attach-strip .ch-att').count(), files.length, 'every photo is back in the box');
    assert.equal(await field.inputValue(), 'Refused photos', 'the words are back too');
    await page.getByText('Your message is back in the box').first().waitFor({timeout: 5000});
    assert.equal(await page.locator('.u-album').count(), before, 'the refused album left the thread');
    assert.equal(sends, 0, 'nothing was sent');
    assert.deepEqual(errors, [], 'no page errors');
    // Clean up the restored draft so the stage can be reused.
    sendMode = null; await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await until(async () => sends === 1 && (await drafts()).length === 0, 'the restored photos send once', 180000);
    await ctx.close();
  }
  // 4. A text-only send is unchanged: the bubble is in the thread within LIMIT ms.
  {
    draftMode = null; sendMode = null; sends = 0;
    const {ctx, page, field, errors} = await open('dark');
    await field.fill('Quick hello 480');
    const ms = await tap(page, 'text');
    results.text = ms;
    console.log(`text: bubble + empty box ${ms.toFixed(1)} ms after the tap`);
    assert.ok(ms <= LIMIT, `text shows within ${LIMIT} ms (took ${ms.toFixed(1)} ms)`);
    await until(async () => sends === 1, 'text sent once');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  await browser.close();
  console.log('RESULT ' + JSON.stringify(results));
  console.log('PASS issue 480: photo sends show at once, sent once; a refused send comes back into the box');
})().catch(e => { console.error(e); process.exitCode = 1; });
