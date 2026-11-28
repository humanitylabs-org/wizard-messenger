// Issue 487: a photo send that is refused comes back into the box with one clean sentence, never
// "Upload failed. Tap to retry.. Your message is back in the box." (the upload's own retry advice plus a second full stop).
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web python3 tests/agent_drafts_stage.py <port> &
//        AGENT_STAGE_DIR=<dir> SHELL_DIR=<wizard-ux>/web node tests/refused_send_toast_browser.cjs
// STATIC_DIR=<other>/static runs another unified.js (before). SHOTS=<dir> saves a phone shot of each toast.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/tmp/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts.filter(d => d.person_id === st.alice);
const clear = async () => { for (const d of await drafts()) await fetch(st.origin + '/api/drafts/' + d.id, {method: 'DELETE', headers: auth, body: JSON.stringify({revision: d.revision})}).catch(() => {}); };

(async () => {
  const browser = await chromium.launch();
  const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
  // A small real JPEG drawn in a page, so the test needs nothing but Playwright.
  const maker = await browser.newPage();
  const b64 = await maker.evaluate(async () => {
    const c = new OffscreenCanvas(640, 480), g = c.getContext('2d'); g.fillStyle = 'teal'; g.fillRect(0, 0, 640, 480);
    const bytes = new Uint8Array(await (await c.convertToBlob({type: 'image/jpeg'})).arrayBuffer());
    let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
  });
  await maker.close();
  const photo = {name: 'IMG_487.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64')};
  let sends = 0;
  // upload: how the phone's own upload of the photo is refused (the draft copy always fails, so the send needs it).
  async function run(name, upload) {
    await clear(); sends = 0;
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
    await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\?/, r => r.request().method() !== 'PUT' ? r.continue()
      : r.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'internal', message: 'Draft store failed'}})}));
    await ctx.route(/\/api\/unified\/people\/[^/]+\/upload\?/, r => r.fulfill(upload));
    await ctx.route(/\/api\/unified\/people\/[^/]+\/send(\?|$)/, r => { sends++; return r.continue(); });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1000);
    await field.fill('Photo for 487');
    await page.locator('input[type=file]').setInputFiles([photo]);
    await page.locator('.u-attach-strip .ch-att').first().waitFor({timeout: 30000});
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    const toast = page.getByText(/back in the box/).first();
    await toast.waitFor({timeout: 30000});
    const text = (await toast.textContent()).trim();
    console.log(`${name}: toast "${text}"`);
    if (process.env.SHOTS) await page.screenshot({path: path.join(process.env.SHOTS, name + '.png')});
    assert.equal(await page.locator('.u-attach-strip .ch-att').count(), 1, 'the photo is back in the box');
    assert.equal(await field.inputValue(), 'Photo for 487', 'the words are back too');
    assert.equal(sends, 0, 'nothing was sent');
    assert.deepEqual(errors.filter(e => !/Draft store failed/.test(e)), [], 'no page errors');
    await ctx.close(); await clear();
    return text;
  }
  // 1. A gateway refuses the upload with no JSON: the view's own "Upload failed" message.
  assert.equal(await run('gateway-refusal', {status: 413, contentType: 'text/html', body: '<html>413</html>'}), 'Upload failed. Your message is back in the box.');
  // 2. The box refuses it with its own sentence (ending in a full stop): no doubled full stop.
  assert.equal(await run('box-refusal', {status: 415, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'unsupported', message: 'This photo type is not supported.'}})}),
    'This photo type is not supported. Your message is back in the box.');
  await browser.close();
  console.log('PASS issue 487: a refused photo send says one clean sentence');
})().catch(e => { console.error(e); process.exit(1); });
