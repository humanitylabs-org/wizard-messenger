// Trusted Wizard never logs the owner out (Miguel, 30 Oct 2026: "must stay signed in or I go back to Beeper").
// Real ViewServer behind tests/trusted_restart_fixture.py's signing gateway (run that file, not this one):
//  1. Messenger restarts under an open page (502s while down, vault locked when back): inbox returns by itself.
//  2. Reload during a burst of transient 502/503s on trusted-owner, session, status and list calls: inbox appears.
//  3. Every server session forgotten (expiry/eviction): the next read re-opens a session silently.
//  4. A longer outage while the shell keeps refocusing the window: recovers by itself once Messenger is back.
// At no point may a passphrase box or "Unlock Messenger" appear; the "Couldn't reach" card must not stick.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const url = process.env.FIXTURE_URL;
const fixture = (p) => fetch(url + p, {method: 'POST'}).then(r => r.text());
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
  const page = await ctx.newPage(), errors = [], seen = {passphrase: false, unlock: false};
  page.on('pageerror', e => errors.push(e.message));
  const watch = setInterval(async () => {
    try {
      if (await page.locator('#passphrase').isVisible()) seen.passphrase = true;
      if (await page.locator('#gate-title', {hasText: 'Unlock'}).isVisible()) seen.unlock = true;
    } catch { /* navigating */ }
  }, 100);
  await ctx.request.post(url + '/fixture/login');
  const inbox = async () => {
    try { await page.locator('.u-person', {hasText: 'Ana Restart'}).first().waitFor({timeout: 45000}); }
    catch (e) { console.error('gate:', await page.locator('#gate-description').textContent().catch(() => '?'), 'requests:', (await (await fetch(url + '/fixture/log', {method: 'POST'})).text()).slice(-1500)); throw e; }
  };
  await page.goto(url + '/'); await inbox();
  console.log('ok first open');

  // 1. Restart under the open page; the shell refocuses it (visibilitychange) while Messenger is still down.
  await fixture('/fixture/restart?down=4');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await inbox(); assert.equal(await page.locator('#gate').isVisible(), false, 'gate gone after restart');
  console.log('ok restart under open page');

  // 2. Reload into a burst of transient gateway refusals.
  await fixture('/fixture/flaky?view/trusted-owner=2&view/session=3&status=2&unified/people=3&unified/groups=2&identity=1');
  const t0 = Date.now(); await page.reload(); await inbox();
  console.log('ok reload through 502/503 burst in', Date.now() - t0, 'ms');

  // 3. The server forgot every session (30-day expiry, table eviction): the next read opens a fresh one silently.
  await fixture('/fixture/forget-sessions');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(1500); await inbox();
  assert.equal(await page.locator('#reconnect').isVisible(), false, 'no Try again card after sessions were forgotten');
  console.log('ok forgotten session reopened');

  // 4. A longer outage while the shell keeps refocusing the window: it keeps asking and opens once Messenger is back.
  await fixture('/fixture/restart?down=12');
  for (let i = 0; i < 4; i++) { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(1500); }
  await inbox();
  assert.equal(await page.locator('#reconnect').isVisible(), false);
  console.log('ok long outage under open page, recovered by itself');

  clearInterval(watch);
  assert.equal(seen.passphrase, false, 'no passphrase box on a trusted Wizard');
  assert.equal(seen.unlock, false, 'never "Unlock Messenger"');
  assert.deepEqual(errors, []);
  await page.screenshot({path: (process.env.EVIDENCE_DIR || '/home/oscar/.hermes/cache/scratch') + '/trusted-restart-recovered.png'});
  await browser.close();
  console.log('PASS trusted_restart_browser: restart, 502/503 burst, forgotten sessions and long downtime all recover with no tap and no passphrase');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
