// Trusted Wizard never asks for a Messenger passphrase (Miguel, 30 Oct 2026): after a server restart the status
// briefly says "locked" and sessions are gone; the view must keep "Opening…" and come back by itself.
// node tests/trusted_no_password_browser.cjs   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static');
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
(async () => {
  const browser = await chromium.launch();
  for (const scenario of ['status-locked', 'session-401', 'never-recovers']) {
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
    await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    let restarted = false, lockedLeft = 0, sessions = 0;
    await page.route('https://messenger.test/**', async route => {
      const url = new URL(route.request().url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const err = (status, code) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message: 'Enter your passphrase to open Messenger'}})});
      if (p === 'api/view/trusted-owner') return ok({enabled: true, remembered: true});
      if (p === 'api/view/session') {
        sessions++;
        if (restarted && scenario === 'session-401' && lockedLeft-- > 0) return err(401, 'session_unlock_required');
        if (restarted && scenario === 'never-recovers') return err(401, 'remembered_unlock_unavailable');
        return ok({authenticated: true, csrf_token: 'fixture'});
      }
      if (p === 'api/status') { if (restarted && scenario === 'status-locked' && lockedLeft-- > 0) return ok({state: 'locked', account_configured: true}); return ok({state: 'ready', account_configured: true}); }
      if (p === 'api/identity') return ok({identity: {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'}});
      if (['api/contacts', 'api/invites', 'api/dms'].includes(p)) return ok({contacts: [], invites: [], dms: []});
      if (p === 'api/unified/people') return ok({people: [{id: 'a', display_name: 'Ana', identities: [{id: 'i', network: 'whatsapp', kind: 'person'}], labels: [], unread: 0, last: {text: 'hi', timestamp: Date.now(), outgoing: false}}], seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Ana'}).waitFor({timeout: 15000});
    // Server restarts: the next status/session answers say locked for a few seconds.
    restarted = true; lockedLeft = 3;
    let sawPassphrase = false;
    const watch = setInterval(async () => { try { if (await page.locator('#passphrase').isVisible()) sawPassphrase = true; } catch { /* page closing */ } }, 100);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    // Force a fresh snapshot as the shell would on focus.
    await page.evaluate(() => document.getElementById('reconnect').click());
    if (scenario === 'never-recovers') {
      await page.getByText("Messenger couldn't open your messages. Tap Try again.").waitFor({timeout: 120000});
      assert.equal(await page.locator('#reconnect').isVisible(), true);
      // The card is never a dead end: Messenger keeps asking by itself, so once the server answers again the inbox
      // returns with no tap (Miguel, 30 Oct 2026).
      restarted = false;
      await page.locator('.u-person', {hasText: 'Ana'}).waitFor({timeout: 30000});
    } else {
      await page.waitForFunction(() => true); await page.waitForTimeout(15000); // the locked answers have been served by now
      assert.ok(lockedLeft < 0, scenario + ': every locked answer was consumed (' + lockedLeft + ')');
      await page.locator('.u-person', {hasText: 'Ana'}).waitFor({timeout: 30000});
    }
    clearInterval(watch);
    assert.equal(sawPassphrase, false, scenario + ': no passphrase box on a trusted Wizard');
    assert.equal(await page.locator('#gate-title', {hasText: 'Unlock'}).isVisible().catch(() => false), false);
    assert.deepEqual(errors, []);
    console.log('ok', scenario, 'sessions', sessions);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS trusted_no_password_browser: restart lock, session 401 and permanent failure never show a passphrase');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
