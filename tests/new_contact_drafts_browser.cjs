// Drafts to new contacts (issue 176, switch new-contact-drafts): a chat an agent started for someone new is listed
// with its waiting draft, and New chat takes a WhatsApp number / Telegram @username / LINE ID. Nothing is sent.
// Synthetic API only; phone + desktop. PLAYWRIGHT_MODULE=... node tests/new_contact_drafts_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'new-contact-drafts-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0, ...extra});
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const on of [false, true]) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [
      person('james', 'James Carter', 'whatsapp', 'On my way, 10 minutes', 2),
      person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow', 40, {unread: 1}),
    ];
    // What the box lists for a chat an agent started (messenger_start_draft): no message yet, only the draft.
    if (on) PEOPLE.push(person('scout', 'Property Scout', 'line', '', 1, {started: true, last: {text: '', outgoing: false, sender: '', timestamp: now - min}}));
    const DRAFTS = on ? [{id: 'd1', person_id: 'scout', identity_id: 'scout-i', state: 'draft', revision: 1, text: 'Hi, is the condo on Sukhumvit 24 still available?', attachments: [], updated: now - 30e3, created_by: {id: 'agent:a', name: 'Oscar'}}] : [];
    const NEW = person('somchai', 'Khun Somchai', 'whatsapp', '', 0, {started: true});
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark'});
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    });
    const box = {starts: [], sends: []};
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const bad = (status, code, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message}})});
      if (/\/send$|\/preview$/.test(p)) { box.sends.push(p); return ok({}); }
      if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [{id: 'new-contact-drafts', name: 'Drafts to new contacts', on, default: false, issues: []}]})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/drafts') return ok({drafts: DRAFTS});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/directory') return ok({people: PEOPLE, groups: []});
      if (p === 'api/unified/start-chat') {
        const b = body(); box.starts.push(b);
        if (b.to.replace(/\s/g, '') === '+66811111111') return bad(404, 'contact_not_found', "This number isn't on WhatsApp");
        return ok({chat_id: 'somchai', channel_id: 'somchai-i', network: 'WhatsApp', name: 'Khun Somchai'});
      }
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, NEW].find(x => x.id === id);
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers: [
        {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'line', label: 'LINE', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}]});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const tag = `${on ? 'on' : 'off'}-${label}`, shot = name => page.screenshot({path: path.join(out, `${name}-${tag}.png`)});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    if (on) {
      const scout = page.locator('.u-person', {hasText: 'Property Scout'});
      await scout.locator('.u-snippet.draft').waitFor({timeout: 10000});
      await page.waitForTimeout(300);
      const names = await page.$$eval('#unified-inbox .u-person strong', els => els.map(e => e.firstChild?.textContent || e.textContent));
      assert.equal(names[0], 'Property Scout', 'the started chat with its draft leads the list ' + JSON.stringify(names));
      assert.match(await scout.locator('.u-snippet').innerText(), /^Draft: Hi, is the condo/);
      await shot('inbox');
    }
    await page.locator('[aria-label="New chat"]').first().click();
    const form = page.locator('.u-start-chat');
    if (!on) {
      await page.waitForTimeout(600);
      assert.equal(await form.count(), 0, 'switch off: New chat has no number field');
      await shot('new-chat');
    } else {
      await form.waitFor({timeout: 5000});
      assert.equal(await form.locator('select').inputValue(), 'whatsapp');
      await form.locator('input').fill('+66 81 111 1111');
      await form.locator('button[type="submit"]').click();
      await page.waitForFunction(() => /isn't on WhatsApp/.test(document.querySelector('.u-start-note')?.textContent || ''));
      await shot('not-on-whatsapp');
      await form.locator('input').fill('+66 92 000 0000');
      await form.locator('button[type="submit"]').click();
      await page.locator('.u-composer textarea').waitFor({timeout: 10000});
      await page.waitForFunction(() => /Khun Somchai/.test(document.body.innerText));
      await page.waitForTimeout(300);
      await shot('started');
      assert.deepEqual(box.starts.map(b => [b.network, b.to]), [['whatsapp', '+66 81 111 1111'], ['whatsapp', '+66 92 000 0000']]);
    }
    assert.deepEqual(box.sends, [], 'nothing sent');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${tag}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
