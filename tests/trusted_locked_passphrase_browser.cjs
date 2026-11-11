// Trusted Wizard whose key Wizard no longer holds must show the passphrase box, not loop on "Opening your messages…"
// (James, 11 Nov 2026, issues 162/164: Messenger restarted, the remembered envelope was missing, the phone sat on Opening forever).
// node tests/trusted_locked_passphrase_browser.cjs   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
//  a) trusted-owner remembered:false + session_unlock_required  -> passphrase box; wrong passphrase stays on the card;
//     right passphrase POSTs api/view/unlock with remember_wizard:true and the inbox opens.
//  b) remembered:true + remembered_unlock_unavailable (envelope no longer opens) -> same box.
//  c) remembered:true + session_unlock_required (a restart still settling) -> still Opening, no box (see trusted_no_password_browser).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static');
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const evidence = process.env.EVIDENCE_DIR;
(async () => {
  const browser = await chromium.launch();
  for (const scenario of ['never-remembered', 'envelope-unreadable', 'restart-settling']) {
    for (const [name, viewport, extra] of [['phone', {width: 390, height: 844}, {isMobile: true, hasTouch: true}], ['desktop', {width: 1280, height: 800}, {}]]) {
      if (scenario === 'restart-settling' && name === 'desktop') continue;
      const ctx = await browser.newContext({viewport, ...extra});
      await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
      const page = await ctx.newPage(), errors = [], unlocks = [];
      page.on('pageerror', e => errors.push(e.message));
      const ownKey = '11'.repeat(32);
      let unlocked = false;
      await page.route('https://messenger.test/**', async route => {
        const url = new URL(route.request().url()), p = url.pathname.slice(1);
        const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
        const err = (status, code) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message: 'Enter your passphrase to open Messenger'}})});
        if (p === 'api/view/trusted-owner') return ok({enabled: true, remembered: scenario !== 'never-remembered' || unlocked});
        if (p === 'api/view/session') {
          if (unlocked) return ok({authenticated: true, csrf_token: 'fixture'});
          return err(401, scenario === 'envelope-unreadable' ? 'remembered_unlock_unavailable' : 'session_unlock_required');
        }
        if (p === 'api/view/unlock') {
          const body = JSON.parse(route.request().postData() || '{}'); unlocks.push(body);
          if (body.vault_password !== 'correct horse battery staple') return err(401, 'vault_unlock_failed');
          unlocked = true; return ok({authenticated: true, csrf_token: 'fixture', status: {state: 'ready'}});
        }
        if (p === 'api/status') return ok({state: 'ready', account_configured: true});
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
      if (scenario === 'restart-settling') {
        await page.waitForTimeout(6000);
        assert.equal(await page.locator('#passphrase').isVisible(), false, 'a settling restart must keep Opening');
        assert.match(await page.locator('#gate-description').textContent(), /Opening your messages/);
        console.log('ok', scenario); await ctx.close(); continue;
      }
      await page.locator('#passphrase').waitFor({state: 'visible', timeout: 15000});
      assert.equal(await page.locator('#gate-title').textContent(), 'Unlock Messenger');
      assert.match(await page.locator('#gate-description').textContent(), /one last time/);
      if (evidence) await page.screenshot({path: path.join(evidence, `trusted-locked-${scenario}-${name}.png`)});
      // Stays put (no flicker back to Opening) for several retry periods.
      await page.waitForTimeout(6000);
      assert.equal(await page.locator('#passphrase').isVisible(), true, 'box stays');
      await page.fill('#passphrase', 'wrong'); await page.click('#setup-submit');
      await page.locator('#setup-error').filter({hasText: /./}).waitFor({timeout: 10000});
      assert.equal(await page.locator('#passphrase').isVisible(), true, 'wrong passphrase keeps the card');
      await page.fill('#passphrase', 'correct horse battery staple'); await page.click('#setup-submit');
      await page.locator('.u-person', {hasText: 'Ana'}).waitFor({timeout: 15000});
      assert.ok(unlocks.at(-1)?.remember_wizard === true, 'unlock asks Wizard to remember');
      assert.deepEqual(errors, []);
      console.log('ok', scenario, name);
      await ctx.close();
    }
  }
  await browser.close();
  console.log('PASS trusted_locked_passphrase_browser: no remembered key shows the passphrase box and unlocking remembers this Wizard');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
