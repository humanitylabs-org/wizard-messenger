// Issue 284: Instagram answers its sign-in page with 429 "too many requests" for some internet addresses. Instead of
// Chrome's opaque "This page isn't working / HTTP ERROR 429" picture, the sign-in screen says what happened, holds
// Start again for a short while (no hammering Instagram) and offers Instagram's username-and-password sign-in.
// Real connectors.js + CSS on a faked box. node tests/signin_rate_limit_browser.cjs [outdir]
// Env: PLAYWRIGHT_MODULE, FRAME_FILE, STATIC_DIR=<main>/static BEFORE=1 for the before shot.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static'));
const out = path.resolve(process.argv[2] || 'signin-rate-limit-shots'); fs.mkdirSync(out, {recursive: true});
const before = process.env.BEFORE === '1';
// The picture Chrome draws for a 429 (what the owner saw), as the live frame.
const ERROR_PAGE = `<!doctype html><meta charset=utf-8><body style="margin:0;font:15px sans-serif;color:#202124;background:#fff">
<div style="padding:90px 24px 0"><div style="width:48px;height:48px;background:#8a8a8a;border-radius:4px"></div>
<h1 style="font-size:22px;font-weight:400;margin:28px 0 14px">This page isn’t working</h1>
<p style="color:#5f6368">If the problem continues, contact the site owner.</p><p style="color:#5f6368">HTTP ERROR 429</p>
<button style="margin-top:40px;background:#1a73e8;color:#fff;border:0;border-radius:4px;padding:9px 16px">Reload</button></div>`;
const PAGE = `<!doctype html><html data-color-scheme="dark"><meta charset=utf-8><meta name=viewport content="width=device-width">
<link rel=stylesheet href="/app.css"><link rel=stylesheet href="/unified.css"><body><main id="messenger"><div id="u-overlay"><div class="u-sheet u-settings"><section id=networks class="u-connected-networks"></section></div></div></main>
<script src="/connectors.js"></script><script>
  window.calls = [];
  const flows = [{id: 'instagram', name: 'Cookies'}, {id: 'android', name: 'Native'}, {id: 'instagram-password', name: 'Password'}];
  const providers = [{network: 'instagram', label: 'Instagram DMs', supported: true, state: 'disconnected', flows, logins: []}];
  let polls = 0;
  async function api(p, method, body) {
    calls.push([p, method, body]);
    if (p === '/api/unified/connectors') return {providers};
    if (p === '/api/unified/connectors/browser/start') return {id: 'b1', title: 'Instagram'};
    if (p.startsWith('/api/unified/connectors/browser/b1/frame')) {
      polls += 1;
      await new Promise(r => setTimeout(r, 150));
      if (polls < 3 || window.keepOpen) return {seq: polls, frame: window.FRAME, state: 'signing_in', message: '', host: 'chromewebdata', result: null};
      return {seq: polls, frame: null, state: 'rate_limited', retry_in: 30, host: 'chromewebdata', result: null,
              message: 'Instagram is not letting this Wizard open its sign-in page right now (it answered \\u201ctoo many requests\\u201d). This is a short limit on Instagram\\u2019s side for this Wizard\\u2019s internet connection, not a problem with your account. Wait a few minutes and start again, or sign in with your username and password instead.'};
    }
    if (p.endsWith('/cancel')) return {};
    if (p === '/api/unified/connectors/instagram/start') return {login_id: 'l1', step_id: 'creds', type: 'user_input', user_input: {fields: [{id: 'username', type: 'username', name: 'Username'}, {id: 'password', type: 'password', name: 'Password'}]}};
    return {};
  }
  window.ctl = MessengerConnectors(document.getElementById('networks'), api, {});
  ctl.show();
</script>`;
(async () => {
  const browser = await chromium.launch();
  const shooter = await browser.newPage({viewport: {width: 412, height: 700}});
  await shooter.setContent(ERROR_PAGE);
  // FRAME_FILE: a real screencast frame from the sign-in browser (e.g. the engine's own 429 page) for the shots.
  const frame = process.env.FRAME_FILE ? fs.readFileSync(process.env.FRAME_FILE).toString('base64') : (await shooter.screenshot({type: 'jpeg', quality: 70})).toString('base64');
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, colorScheme: 'dark'});
  await ctx.addInitScript(f => { window.FRAME = f; if (new URLSearchParams(location.search).has('keep')) window.keepOpen = true; }, frame);
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install();
  await page.route('https://msg.test/**', route => {
    const f = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (f === 'index.html') return route.fulfill({contentType: 'text/html', body: PAGE});
    const file = path.join(root, f); if (!fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    route.fulfill({contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file)});
  });
  await page.goto('https://msg.test/' + (before ? '?keep=1' : ''));
  await page.locator('.c-tile[data-network="instagram"]').click();
  await page.getByRole('button', {name: /Sign in with browser \(recommended\)/}).click();
  if (before) {
    // Main never learns the page was refused: the owner keeps looking at Chrome's error picture.
    await page.locator('.c-live-img').waitFor({state: 'visible'});
    await page.clock.runFor(3000);
    await page.screenshot({path: out + '/before.png'});
    assert.equal(await page.locator('.c-problem').count(), 0);
    console.log('signin rate limit browser (before): opaque error picture -> ' + out);
    await browser.close(); return;
  }
  const problem = page.locator('.c-problem');
  await problem.waitFor({state: 'visible'});
  const text = await problem.textContent();
  assert.match(text, /Instagram is not letting this Wizard open its sign-in page/);
  assert.match(text, /not a problem with your account/);
  assert.equal(await page.locator('.c-live-img').count(), 0, 'the error picture is gone');
  const again = page.getByRole('button', {name: /^Start again/});
  assert.equal(await again.isDisabled(), true, 'Start again waits');
  assert.match(await again.textContent(), /^Start again in 30 s$/);
  const other = page.getByRole('button', {name: 'Username and password', exact: true});
  assert.equal(await other.isEnabled(), true, 'another way is open at once');
  await page.screenshot({path: out + '/after.png'});
  await page.clock.runFor(10000);
  assert.match(await again.textContent(), /^Start again in 2\d s$/);
  await page.clock.runFor(21000);
  assert.equal(await again.textContent(), 'Start again');
  assert.equal(await again.isEnabled(), true);
  const starts = () => page.evaluate(() => calls.filter(c => c[0] === '/api/unified/connectors/browser/start').length);
  assert.equal(await starts(), 1, 'nothing retried on its own');
  await other.click();
  await page.getByRole('textbox', {name: 'Username'}).waitFor({state: 'visible'});
  assert.deepEqual(await page.evaluate(() => calls.find(c => c[0] === '/api/unified/connectors/instagram/start')[2]), {flow: 'android'});
  assert.deepEqual(errors, []);
  console.log('signin rate limit browser: ok -> ' + out);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
