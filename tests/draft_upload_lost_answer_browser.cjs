// Issue 463: a photo whose upload answer is lost (the box saved it, the phone saw a 502 / dropped connection) must
// quietly become a saved attachment, and a real failed upload retries by itself, then offers Retry on the photo.
// Never the same photo twice on the server.
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python3 tests/agent_drafts_stage.py <port> &
//        AGENT_STAGE_DIR=<dir> SHELL_DIR=<wizard-ux>/web node tests/draft_upload_lost_answer_browser.cjs
// STATIC_DIR=<other>/static runs another unified.js against the same box (before shots). SHOTS=<dir> saves phone shots.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/tmp/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
const png = fs.readFileSync(path.join(__dirname, '../evidence/01-chats.png'));
const BANNER = '.u-draft-note.conflict';
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts.filter(d => d.person_id === st.alice);
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 150)); } throw new Error('timed out: ' + what); };
(async () => {
  const browser = await chromium.launch();
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
  // mode per case: 'lost' = the box stores the PUT, the answer becomes a 502; 'abort' = stored, connection dropped;
  // 'fail' = refused with a 502 before reaching the box (count times).
  let mode = null, count = 0, puts = 0;
  async function run(name, setup, check) {
    // Each case ends by sending its draft; a leftover means an earlier run failed: start a fresh stage.
    assert.equal((await drafts()).length, 0, 'start from a fresh stage (no draft for Alice)');
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, isMobile: true, hasTouch: true});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route(/\/(unified\.js|unified\.css)(\?|$)/, route => {
      const file = path.basename(new URL(route.request().url()).pathname);
      return route.fulfill({status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(path.join(staticDir, file))});
    });
    await ctx.route('**/wizard-os-home/**', r => {
      const u = new URL(r.request().url());
      if (!process.env.SHELL_DIR) return r.continue();
      const file = path.join(process.env.SHELL_DIR, 'core', path.basename(u.pathname));
      return r.fulfill({status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.existsSync(file) ? fs.readFileSync(file) : ''});
    });
    await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\?/, async r => {
      if (r.request().method() !== 'PUT') return r.continue();
      puts++;
      if (mode === 'lost-then-fail') { mode = 'fail'; const resp = await r.fetch(); await resp.body(); return r.fulfill({status: 502, contentType: 'text/html', body: '<html>502 Bad Gateway</html>'}); }
      if (count > 0 && mode === 'fail') { count--; return r.fulfill({status: 502, contentType: 'text/html', body: '<html>502 Bad Gateway</html>'}); }
      if (count > 0 && (mode === 'lost' || mode === 'abort')) {
        count--; const resp = await r.fetch(); await resp.body(); // the box wrote it; the phone never hears back
        return mode === 'abort' ? r.abort('connectionreset') : r.fulfill({status: 502, contentType: 'text/html', body: '<html>502 Bad Gateway</html>'});
      }
      return r.continue();
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1200);
    await field.fill('Lunch spot'); await until(async () => (await drafts())[0]?.text === 'Lunch spot', 'text draft saved');
    puts = 0; setup();
    await page.locator('input[type=file]').setInputFiles({name: 'lunch.png', mimeType: 'image/png', buffer: png});
    await check(page);
    assert.deepEqual(errors, [], name + ': no page errors');
    await ctx.close();
  }
  const settled = async (page, name) => {
    const seen = async () => JSON.stringify({warning: await page.locator(BANNER).allTextContents(), chips: await page.locator('.u-attach-strip .ch-att').count(),
      box: (await drafts()).map(d => ({revision: d.revision, attachments: d.attachments.length})), puts});
    await until(async () => (await page.locator(BANNER).count()) === 0 && (await page.locator('.u-attach-strip .ch-att').count()) === 1
      && (await drafts())[0]?.attachments?.length === 1, name + ': warning clears with one saved photo').catch(async e => { e.message += ' ' + await seen(); if (process.env.SHOTS) await page.screenshot({path: path.join(process.env.SHOTS, name + '-stuck.png')}); throw e; });
    await page.waitForTimeout(7000); // a drafts poll later: still one photo in the tray and on the box, no warning
    const after = await seen(); console.log(name + ' after a poll: ' + after);
    assert.equal(await page.locator(BANNER).count(), 0, name + ': warning stays away');
    assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 1, name + ': one photo in the tray');
    assert.equal((await drafts())[0].attachments.length, 1, name + ': exactly one attachment on the box');
    if (process.env.SHOTS) await page.screenshot({path: path.join(process.env.SHOTS, name + '.png')});
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await until(async () => (await drafts()).length === 0, name + ': Send goes through and the draft ends');
    assert.equal(await page.locator(BANNER).count(), 0);
  };
  // 1. The answer is lost (gateway 502 after the box stored it).
  await run('lost-answer', () => { mode = 'lost'; count = 1; }, page => settled(page, 'lost-answer'));
  // 2. The connection drops after the box stored it.
  await run('dropped-answer', () => { mode = 'abort'; count = 1; }, page => settled(page, 'dropped-answer'));
  // 3. The upload really fails once, then the automatic retry stores it.
  await run('fail-once', () => { mode = 'fail'; count = 1; }, async page => { await settled(page, 'fail-once'); assert.ok(puts >= 2, 'retried by itself'); });
  // 4. The box stored it, then every retry fails too (the phone stays busy): the next drafts poll finds the saved
  //    photo and it quietly becomes the saved attachment, without a tap and without a second copy.
  await run('lost-then-offline', () => { mode = 'lost-then-fail'; count = 99; }, async page => {
    await page.locator('.u-attach-strip .u-attach-retry').waitFor({timeout: 30000}).catch(() => {}); // may already be adopted
    await settled(page, 'lost-then-offline'); // PUTs still fail: only the poll can have cleared it
  });
  // 5. It keeps failing: after the automatic tries the photo offers Retry; one tap stores it once.
  await run('fail-always', () => { mode = 'fail'; count = 99; }, async page => {
    const retry = page.locator('.u-attach-strip .u-attach-retry');
    await retry.waitFor({timeout: 30000});
    assert.equal(await page.locator(BANNER).count(), 1, 'warning while it is not saved');
    const box = await retry.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 412, 'Retry is fully on screen: ' + JSON.stringify(box));
    const tries = puts; assert.ok(tries >= 3 && tries <= 5, 'a few automatic tries, not endless: ' + tries);
    if (process.env.SHOTS) await page.screenshot({path: path.join(process.env.SHOTS, 'fail-always.png')});
    await page.waitForTimeout(4000); assert.equal(puts, tries, 'no more automatic tries after giving up');
    count = 0; await retry.click();
    await settled(page, 'tap-retry');
  });
  await browser.close();
  console.log('PASS issue 463: lost or dropped upload answers become saved photos, a failed upload retries itself, then tap-to-retry; never two copies');
})().catch(e => { console.error(e); process.exitCode = 1; });
