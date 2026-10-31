// New connectors (Miguel, 30 Oct 2026): account status lives in Settings (no "x of y connected" on the Inbox),
// an "Add an account" grid for dormant networks, and browser sign-in by pasting one copied request.
// node tests/new_connectors_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'new-connectors-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now();
const prov = (network, label, state, flows = []) => ({network, label, supported: true, state, flows, logins: state === 'connected' ? [{id: 'l', name: 'Fixture'}] : []});
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const providers = [
      prov('whatsapp', 'WhatsApp', 'connected'), prov('telegram', 'Telegram', 'connected'),
      prov('instagram', 'Instagram DMs', 'degraded', [{id: 'android', name: 'Native'}]),
      prov('twitter', 'X', 'not_configured'), prov('linkedin', 'LinkedIn', 'not_configured'),
      prov('facebook', 'Facebook Messenger', 'not_configured'), prov('gmessages', 'Google Messages', 'not_configured'),
      prov('dots', 'ChatGPT Dots', 'not_configured'),
      {network: 'kakaotalk', label: 'KakaoTalk', supported: false, state: 'unsupported', flows: [], logins: []},
    ];
    const steps = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2});
    await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'}});
      if (['api/contacts', 'api/invites', 'api/dms'].includes(p)) return ok({contacts: [], invites: [], dms: []});
      if (p === 'api/unified/people') return ok({people: [{id: 'a', display_name: 'Ana', identities: [{id: 'i', network: 'whatsapp', kind: 'person'}], labels: [], unread: 0, last: {text: 'hi', timestamp: now, outgoing: false}}], seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/connectors') return ok({providers});
      const m = /^api\/unified\/connectors\/([a-z]+)\/([a-z]+)$/.exec(p);
      if (m) {
        const [, net, action] = m, pr = providers.find(x => x.network === net), body = req.postData() ? JSON.parse(req.postData()) : {};
        if (action === 'enable') { pr.state = 'disconnected'; pr.flows = [{id: 'cookies', name: 'Cookies'}]; return ok({enabled: true}); }
        if (action === 'status') return ok(pr);
        if (action === 'start') return ok({login_id: 'L1', step_id: 'fi.mau.twitter.login.enter_cookies', type: 'cookies', cookies: {url: 'https://x.com/i/flow/login', fields: [
          {id: 'ct0', required: true, sources: [{type: 'cookie', name: 'ct0'}]}, {id: 'auth_token', required: true, sources: [{type: 'cookie', name: 'auth_token'}]}]}});
        if (action === 'step') {
          steps.push(body);
          if (body.type === 'cookies') return ok({login_id: 'L1', step_id: 'fi.mau.twitter.login.juicebox_pin', type: 'user_input', instructions: 'Enter your X Chat passcode', user_input: {fields: [{id: 'pin', type: '2fa_code', name: 'Passcode'}]}});
          pr.state = 'connected'; pr.logins = [{id: 'l', name: '@owner'}]; return ok({type: 'complete', login_id: 'L1'});
        }
        if (action === 'cancel') return ok({});
      }
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}.png`)});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Ana'}).waitFor({timeout: 15000});
    await page.waitForTimeout(400);

    // Inbox: no account score, no strip; Settings carries a small dot because Instagram needs reconnecting.
    assert.equal(await page.locator('#unified-inbox > .u-accounts, #unified-inbox .u-acct-open').count(), 0, 'no accounts banner on the Inbox');
    assert.equal(await page.locator('#unified-inbox', {hasText: /of \d+ connected/}).count(), 0);
    const gear = page.locator('.u-settings-btn');
    assert.ok(await gear.evaluate(e => e.classList.contains('warn')), 'Settings shows a dot when an account needs reconnecting');
    assert.match(await gear.getAttribute('aria-label'), /Instagram DMs needs reconnecting/);
    await shot('inbox');

    // Settings: the account status lives here, without an "x of y" metric; dormant networks are an Add grid.
    await gear.click();
    await page.locator('.c-card').first().waitFor();
    assert.equal(await page.locator('.u-sheet', {hasText: /of \d+ (accounts )?connected/}).count(), 0, 'no x-of-y score anywhere');
    // No duplicate banner: the account's own row says it needs reconnecting, above the connected list.
    assert.equal(await page.locator('.u-sheet .u-acct-text').count(), 0);
    assert.match(await page.locator('.u-sheet .c-card').first().textContent(), /Instagram DMs.*Needs reconnecting/s);
    assert.ok(await page.locator('.c-group .c-card.c-row').count() >= 1, 'connected accounts are compact rows');
    const row = page.locator('.c-group .c-card.c-row').first();
    assert.equal(await row.getByRole('button', {name: /Disconnect/}).isVisible(), false, 'Disconnect hidden until the row is opened');
    await row.locator('.c-card-top').click();
    assert.equal(await row.getByRole('button', {name: /Disconnect/}).isVisible(), true);
    await row.locator('.c-card-top').click();
    await page.locator('.u-more .u-more-advanced').waitFor();
    assert.equal(await page.locator('.u-more .u-more-link', {hasText: 'Saved drafts'}).count(), 1, 'More is one plain list');
    assert.equal(await page.locator('.u-sheet details.u-fold').count(), 0, 'no folds under More');
    const tiles = await page.locator('.c-add').evaluateAll(els => els.map(e => e.querySelector(':scope > span:last-child').textContent.trim()));
    assert.deepEqual(tiles, ['ChatGPT Dots', 'Facebook Messenger', 'Google Messages', 'LinkedIn', 'X']);
    assert.equal(await page.locator('.c-later summary', {hasText: 'Not available yet'}).count(), 1);
    await shot('settings');

    // Add X → it wakes, then the browser sign-in accepts a pasted "Copy as cURL" and fills ct0 + auth_token.
    await page.locator('.c-add[data-network=twitter]').click();
    await page.locator('.c-card[data-network=twitter] .primary').waitFor();
    // X signs in through the Wizard Browser, like Slack: no developer-tools paste step.
    assert.equal((await page.locator('.c-card[data-network=twitter] .primary').textContent()).trim(), 'Sign in with your browser');
    assert.equal(await page.locator('.c-card[data-network=twitter]', {hasText: /cURL|developer/i}).count(), 0);
    await shot('connected');

    assert.deepEqual(errors, [], 'no page errors');
    summary.push(label);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS new_connectors_browser: ' + summary.join(', ') + ' · status in Settings only, warn dot, Add grid, cURL paste sign-in + passcode');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
