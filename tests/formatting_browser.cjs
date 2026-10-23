// Browser proof: Telegram formatting (bold, italic, code, spoiler) renders in a thread, and **bold** typed in
// Messenger is sent as real formatting. Runs against a disposable preview only (PREVIEW_URL), never the installed app.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://127.0.0.1:19253/';
  const chat = process.env.CHAT || 'Ben Carter';
  const evidence = process.env.EVIDENCE_DIR || './evidence-formatting'; fs.mkdirSync(evidence, {recursive: true});
  const browser = await chromium.launch({headless: true});
  const page = await browser.newPage({viewport: {width: 390, height: 844}, colorScheme: 'dark', ignoreHTTPSErrors: true});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.locator('.u-person').first().waitFor({state: 'visible'});
  await page.locator('.u-person').filter({hasText: chat}).first().click();
  const rich = page.locator('.u-text.rich').filter({hasText: 'Formatting proof'}).last();
  await rich.waitFor({state: 'visible', timeout: 20000});
  assert.equal(await rich.locator('strong').first().textContent(), 'bold');
  assert.equal(await rich.locator('em').first().textContent(), 'italic');
  assert.equal(await rich.locator('code').first().textContent(), 'code');
  const weight = await rich.locator('strong').first().evaluate(el => getComputedStyle(el).fontWeight);
  assert.ok(+weight >= 600, 'bold is visibly bold: ' + weight);
  const spoiler = rich.locator('.u-spoiler').first();
  assert.equal(await spoiler.evaluate(el => getComputedStyle(el).color), 'rgba(0, 0, 0, 0)', 'spoiler hidden until tapped');
  await rich.scrollIntoViewIfNeeded(); await page.screenshot({path: evidence + '/incoming-formatting.png'});
  const stamp = Date.now().toString(36);
  await page.getByRole('textbox', {name: 'Message'}).last().fill('Sent **bold ' + stamp + '** and __italic__');
  await page.locator('.u-send').last().click();
  await page.waitForTimeout(4000); await page.screenshot({path: evidence + '/after-send.png'});
  const mine = page.locator('.u-text.rich').filter({hasText: 'bold ' + stamp}).last();
  await mine.waitFor({state: 'visible', timeout: 20000});
  assert.equal(await mine.locator('strong').first().textContent(), 'bold ' + stamp);
  assert.equal(await mine.locator('em').first().textContent(), 'italic');
  assert.ok(!(await mine.textContent()).includes('**'), 'markers are not shown');
  await page.screenshot({path: evidence + '/sent-formatting.png'});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok: true, stamp, weight}));
  await browser.close();
})().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
