// Issue 445 (switch calls): the call button in a chat header. Stage: tests/catchup_stage.py (real ViewServer + real
// static view, synthetic chats). The switch listing and the call answer are routed here, so no call server is needed
// (tests/test_call_door.py covers the box side). Checks: switch off = no button; on = a Call button left of
// Catch me up, >= 44 px; a tap opens the call in its own window at the box's answer; with no public door the Call link
// sheet offers to connect the owner's Cloudflare account; with one, the join link goes into the chat as a message.
// Where the owner's own call opens: a plain tab opens a window; the WizardOS phone app (WizardOSNative.openCall) gets
// the address with controlledAudioDevices=true (Element Call lets the phone route earpiece / speaker / headset) and no
// window; inside the Wizard shell (the real wizard-ux links.js guarding the frame) the call goes to the owner's browser
// as a new tab, never into the shell's link sheet (a frame without a camera).
// SHOTS=<dir> writes off.png / on.png / tapped.png / sent.png (412 px phone).
// Usage: AGENT_STAGE_DIR=<dir> WIZARD_WEB_DIR=<wizard-ux>/web node tests/call_button_browser.cjs
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR; const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR, TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json'};
const json = body => ({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
const SWITCH = on => ({contract: 'wizard.app-switches/1', switches: [{id: 'calls', name: 'Calls', description: '', on, default: false,
  issues: ['humanitylabs-org/wizard-messenger#445'], tried: on, vote: null}], feedback: {}});

const SHELL = '<!doctype html><title>Shell</title><body style="margin:0"><script src="/wizard-os-home/core/links.js"></script>'
  + '<iframe class="appframe" src="/" style="width:412px;height:860px;border:0"></iframe><script>'
  + 'const L=WizLinks.mount({parent:document.body});const f=document.querySelector("iframe");'
  + 'f.addEventListener("load",()=>WizLinks.guardFrame(f.contentWindow,"/",L));</script>';
async function run(browser, on, link = null, host = 'tab') {
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => {
    const f = WEB && path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
    return f && fs.existsSync(f) && fs.statSync(f).isFile() ? r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)}) : r.fulfill({status: 404, body: ''});
  });
  await ctx.route('**/api/view/switches', r => r.request().method() === 'GET' ? r.fulfill(json(SWITCH(on))) : r.continue());
  const asked = [];
  await ctx.route('**/api/view/calls', r => { asked.push(r.request().postDataJSON()); return r.fulfill(json({ok: true, result: {call: 'c1', open: '/call/k/OWNERKEY0123456789abcd/join/#/Lena?roomId=%21r&password=p', link, reach: link ? 'everyone' : 'tailnet'}})); });
  await ctx.route('**/api/view/calls/cloudflare', r => r.fulfill(json({ok: true, result: {connected: false, zone: null, zones: [], host: null, reach: 'tailnet', problem: null,
    token_page: 'https://dash.cloudflare.com/profile/api-tokens?name=Wizard%20calls', permissions: ['Account · Cloudflare Tunnel · Edit']}})));
  const sent = [];
  await ctx.route('**/messages', r => { if (r.request().method() === 'POST') { sent.push(r.request().postDataJSON()); return r.fulfill(json({ok: true, result: {id: '$sent1', client_id: r.request().postDataJSON().client_id}})); } return r.continue(); });
  await ctx.route('**/call/k/**', r => r.fulfill({status: 200, contentType: 'text/html', body: '<title>Element Call</title>'}));
  await ctx.route('**/shell-445.html', r => r.fulfill({status: 200, contentType: 'text/html', body: SHELL}));
  if (host === 'phone') await ctx.addInitScript(() => { window.WizardOSNative = {openCall: u => { window.__calls = (window.__calls || []).concat(u); return true; }}; });
  const top = await ctx.newPage(), errors = []; top.on('pageerror', e => errors.push(e.message));
  if (host === 'shell') await top.goto(st.origin + '/shell-445.html'); else await top.goto(st.origin + '/');
  const page = host === 'shell' ? top.frameLocator('iframe.appframe') : top;
  await page.locator('.u-person').first().waitFor({timeout: 20000});
  await page.locator('.u-person', {hasText: 'Lena'}).first().tap(); await page.locator('.u-thread-body .u-row').first().waitFor();
  await top.waitForTimeout(800);
  const btn = page.locator('.u-thread-head .u-call-btn');
  if (!on) {
    assert.equal(await btn.isVisible(), false, 'switch off: no call button');
    if (SHOTS) await top.screenshot({path: path.join(SHOTS, 'off.png')});
  } else {
    assert.equal(await btn.isVisible(), true, 'switch on: call button');
    assert.equal(await btn.getAttribute('aria-label'), 'Call');
    const b = await btn.boundingBox(); assert.ok(b.width >= 44 && b.height >= 44, 'call button >= 44 px ' + JSON.stringify(b));
    const order = await page.locator('.u-thread-head .icon-button').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    assert.ok(order.indexOf('Call') === order.indexOf('Catch me up') - 1, 'Call sits left of Catch me up: ' + order);
    if (SHOTS && host === 'tab') await top.screenshot({path: path.join(SHOTS, 'on.png')});
    if (host === 'phone') {
      let opened = 0; ctx.on('page', () => opened++);
      await btn.tap();
      await top.waitForFunction(() => (window.__calls || []).length === 1, null, {timeout: 5000});
      const [u] = await top.evaluate(() => window.__calls);
      assert.deepEqual(asked, [{title: 'Lena'}]);
      assert.equal(u, st.origin + '/call/k/OWNERKEY0123456789abcd/join/#/Lena?roomId=%21r&password=p&controlledAudioDevices=true');
      await top.waitForTimeout(500); assert.equal(opened, 0, 'the phone app opens its own call window, no browser window');
      assert.equal(await top.locator('.u-sheet', {hasText: 'Open the call'}).count(), 0);
    } else {
      const [win] = await Promise.all([ctx.waitForEvent('page'), btn.tap()]);
      await win.waitForURL(/\/call\/k\/OWNERKEY/, {timeout: 5000});
      assert.deepEqual(asked, [{title: 'Lena'}]);
      assert.ok(new URL(win.url()).hash.startsWith('#/Lena?roomId='), win.url());
      assert.ok(!new URL(win.url()).hash.includes('controlledAudioDevices'), 'a browser keeps its own audio choice: ' + win.url());
      if (host === 'shell') {
        const frames = await top.evaluate(() => [...document.querySelectorAll('iframe')].map(f => { try { return f.contentWindow.location.href; } catch (_) { return f.src; } }));
        assert.ok(!frames.some(h => /\/call\/k\//.test(h)), 'the call never opens inside the shell: ' + frames);
        assert.equal(frames.filter(h => h === st.origin + '/').length, 1, 'Messenger is not opened again inside the shell: ' + frames);
        assert.equal(await page.getByRole('link', {name: 'Open the call'}).getAttribute('data-wizard-browse'), '');
      }
    }
    if (!link) {
      const sheet = page.getByRole('dialog', {name: 'Call link'}); await sheet.waitFor();
      assert.match(await sheet.textContent(), /Your call is open on this device/);
      assert.equal(await sheet.getByRole('link', {name: 'Make a token on Cloudflare'}).getAttribute('href'), 'https://dash.cloudflare.com/profile/api-tokens?name=Wizard%20calls');
      assert.equal(await sheet.getByLabel('Cloudflare API token').getAttribute('type'), 'password');
      if (SHOTS && host === 'tab') await top.screenshot({path: path.join(SHOTS, 'tapped.png')});
    } else {
      const toast = page.locator('.u-toast'); await toast.waitFor();
      assert.match(await toast.textContent(), /Call link sent/);
      const bubble = page.locator('.u-thread-body .u-row', {hasText: 'Join my video call: ' + link}); await bubble.waitFor({timeout: 5000});
      assert.equal(await page.getByRole('dialog', {name: 'Call link'}).count(), 0);
      if (SHOTS && host === 'tab') await top.screenshot({path: path.join(SHOTS, 'sent.png')});
    }
  }
  assert.deepEqual(errors, []);
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch();
  try { await run(browser, false); await run(browser, true); await run(browser, true, 'https://call-0a1b2c.example.org/c/GUESTKEY0123456789abcdef');
    await run(browser, true, null, 'phone'); await run(browser, true, null, 'shell'); console.log('call button: ok'); }
  finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
