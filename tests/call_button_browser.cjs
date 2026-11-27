// Issue 445 (switch calls): the call button in a chat header. Stage: tests/catchup_stage.py (real ViewServer + real
// static view, synthetic chats). The switch listing and the call answer are routed here, so no call server is needed
// (tests/test_call_door.py covers the box side). Checks: switch off = no button; on = a Call button left of
// Catch me up, >= 44 px; a tap opens the call in its own window at the box's answer; with no public door the toast
// says calls stay on the owner's devices. SHOTS=<dir> writes off.png / on.png (412 px phone).
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web node tests/call_button_browser.cjs
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR; const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR, TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json'};
const json = body => ({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
const SWITCH = on => ({contract: 'wizard.app-switches/1', switches: [{id: 'calls', name: 'Calls', description: '', on, default: false,
  issues: ['humanitylabs-org/wizard-messenger#445'], tried: on, vote: null}], feedback: {}});

async function run(browser, on) {
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const f = WEB && path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
    return f && fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)}) : r.fulfill({status: 404, body: ''});
  });
  await ctx.route('**/api/view/switches', r => r.request().method() === 'GET' ? r.fulfill(json(SWITCH(on))) : r.continue());
  const asked = [];
  await ctx.route('**/api/view/calls', r => { asked.push(r.request().postDataJSON()); return r.fulfill(json({ok: true, result: {call: 'c1', open: '/call/k/OWNERKEY0123456789abcd/join/#/Lena?roomId=%21r&password=p', link: null, reach: 'tailnet'}})); });
  await ctx.route('**/call/k/**', r => r.fulfill({status: 200, contentType: 'text/html', body: '<title>Element Call</title>'}));
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(st.origin + '/'); await page.locator('.u-person').first().waitFor({timeout: 20000});
  await page.locator('.u-person', {hasText: 'Lena'}).first().tap(); await page.locator('.u-thread-body .u-row').first().waitFor();
  await page.waitForTimeout(800);
  const btn = page.locator('.u-thread-head .u-call-btn');
  if (!on) {
    assert.equal(await btn.isVisible(), false, 'switch off: no call button');
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, 'off.png')});
  } else {
    assert.equal(await btn.isVisible(), true, 'switch on: call button');
    assert.equal(await btn.getAttribute('aria-label'), 'Call');
    const b = await btn.boundingBox(); assert.ok(b.width >= 44 && b.height >= 44, 'call button >= 44 px ' + JSON.stringify(b));
    const order = await page.locator('.u-thread-head .icon-button').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    assert.ok(order.indexOf('Call') === order.indexOf('Catch me up') - 1, 'Call sits left of Catch me up: ' + order);
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, 'on.png')});
    const [win] = await Promise.all([ctx.waitForEvent('page'), btn.tap()]);
    await win.waitForURL(/\/call\/k\/OWNERKEY/, {timeout: 5000});
    assert.deepEqual(asked, [{title: 'Lena'}]);
    assert.ok(new URL(win.url()).hash.startsWith('#/Lena?roomId='), win.url());
    const toast = page.locator('.u-toast'); await toast.waitFor();
    assert.match(await toast.textContent(), /own devices/);
    if (SHOTS) await page.screenshot({path: path.join(SHOTS, 'tapped.png')});
  }
  assert.deepEqual(errors, []);
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch();
  try { await run(browser, false); await run(browser, true); console.log('call button: ok'); }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
