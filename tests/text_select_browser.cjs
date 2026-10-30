// Text selection in bubbles (Miguel, 30 Oct 2026: "I can't highlight text in other people's messages").
// Disposable ViewServer + real unified store (tests/agent_drafts_stage.py), synthetic chats, fake provider I/O.
// Desktop: a mouse drag highlights part of an incoming and of a sent bubble; a plain click opens no menu; right-click
// still opens the menu and its Select still starts multi-select. Phone: tap → "Select text" gives a real selection.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const out = process.env.EVIDENCE_DIR || dir; fs.mkdirSync(out, {recursive: true});
async function drag(page, loc) {
  const b = await loc.boundingBox();
  await page.mouse.move(b.x + 4, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2, {steps: 6}); await page.mouse.move(b.x + b.width - 4, b.y + b.height / 2, {steps: 6});
  await page.mouse.up();
  return page.evaluate(() => window.getSelection().toString());
}
(async () => {
  const browser = await chromium.launch();
  const setup = async opts => {
    const ctx = await browser.newContext(opts);
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route('**/wizard-os-home/**', r => { const u = new URL(r.request().url()); r.continue({url: 'http://127.0.0.1:8796' + u.pathname}); });
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/');
    return {ctx, page, errors};
  };
  // ---- desktop, mouse ----
  {
    const {ctx, page, errors} = await setup({viewport: {width: 1280, height: 860}});
    await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const incoming = page.locator('.u-row.incoming .u-text', {hasText: 'lunch tomorrow'});
    await incoming.waitFor(); await page.waitForTimeout(900);
    const picked = await drag(page, incoming);
    assert.ok(picked.length > 5 && 'Are we still on for lunch tomorrow?'.includes(picked.trim().slice(0, 10)), 'drag selects incoming text: ' + JSON.stringify(picked));
    assert.equal(await page.locator('.u-menu').count(), 0, 'releasing a drag opens no menu');
    assert.equal(await page.locator('.u-row.incoming .u-message').first().evaluate(el => getComputedStyle(el).userSelect), 'text');
    await page.screenshot({path: path.join(out, 'select-desktop-incoming.png')});
    // A plain click is just a click.
    await page.mouse.click(10, 10); await incoming.click(); await page.waitForTimeout(300);
    assert.equal(await page.locator('.u-menu').count(), 0, 'plain click opens no menu');
    // Own (sent) bubble: send a synthetic message, then drag across it.
    await page.locator('textarea[aria-label="Message"]').fill('Sounds good, see you at noon');
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    const sent = page.locator('.u-row.outgoing .u-text', {hasText: 'see you at noon'}).last(); await sent.waitFor(); await page.waitForTimeout(1200);
    const mine = await drag(page, sent);
    assert.ok(mine.length > 5 && 'Sounds good, see you at noon'.includes(mine.trim().slice(0, 8)), 'drag selects sent text: ' + JSON.stringify(mine));
    assert.equal(await page.locator('.u-menu').count(), 0);
    // Right-click still opens the menu; Select still starts multi-select, and clicks then pick messages.
    await page.mouse.click(10, 10);
    await incoming.click({button: 'right'}); await page.locator('.u-menu').waitFor();
    await page.getByRole('menuitem', {name: 'Select', exact: true}).click();
    await page.locator('.u-selection:not([hidden])').waitFor();
    assert.equal(await page.locator('.u-selection strong').textContent(), '1 selected');
    await sent.click(); await page.waitForTimeout(150);
    assert.equal(await page.locator('.u-selection strong').textContent(), '2 selected', 'clicks add messages while selecting');
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // ---- phone, touch ----
  {
    const {ctx, page, errors} = await setup({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
    await page.locator('.u-person', {hasText: 'Alice Example'}).first().tap();
    const bubble = page.locator('.u-row.incoming .u-message', {hasText: 'lunch tomorrow'}).first();
    await bubble.waitFor(); await page.waitForTimeout(900);
    await bubble.locator('.u-text').tap(); await page.locator('.u-menu').waitFor();
    await page.screenshot({path: path.join(out, 'select-phone-menu.png')});
    await page.getByRole('menuitem', {name: 'Select text'}).tap();
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.getSelection().toString());
    assert.equal(sel.trim(), 'Are we still on for lunch tomorrow?', 'Select text preselects the bubble text');
    assert.equal(await bubble.evaluate(el => getComputedStyle(el).userSelect), 'text', 'native handles allowed in text mode');
    assert.equal(await page.locator('.u-menu').count(), 0);
    await page.screenshot({path: path.join(out, 'select-phone-text.png')});
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS text_select_browser: desktop drag on incoming and sent bubbles, no click menus, right-click + Select intact, phone Select text');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
