// Standard Try new features (issue 217, wizard-os 627; approved, so always on): Settings ends with
// the shared Wizard section (static/wizard-try-features.js): title, note, one row per box switch with On/Off and
// thumbs. Flips and votes go to api/view/switches and reach the rest of Messenger at once; a flip made elsewhere (the
// Tracker) shows up on the next switch poll. No switches: no section, and Messenger's old own section is gone.
// PLAYWRIGHT_MODULE=... node tests/try_features_kit_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'try-features-kit-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await fn()) return; throw new Error('timed out: ' + fn); };
const ident = (id, net, label) => [{id: id + '-i', network: net, kind: 'person', label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0, ...extra});
const SW = [['add-contact', 'Add contact on Telegram', 'A chat from someone not yet your contact shows an Add contact bar.'], ['photo-timings', 'Photo timings', 'Messenger measures how fast photos appear.'],
  ['new-group', 'New group', 'New chat offers New group on networks that can make one.']];
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, kit] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, true], ['390-none', {width: 390, height: 844}, false]]) {
    const PEOPLE = [person('james', 'James Carter', 'whatsapp', 'Can you do Tuesday at 3?', 2, {unread: 1})];
    const watch = {watched: [], all_unread: false, stats: {sent_as_drafted: 2, edited: 1, discarded: 0, total: 3}};
    const box = {watch: [], flips: [], votes: [], on: {}, feedback: {}};
    const listing = () => ({contract: 'wizard.app-switches/1', switches: (kit ? SW : []).map(([id, name, description]) => ({id, name, description, on: box.on[id] === true, default: false, issues: ['humanitylabs-org/wizard-messenger#202'], tried: box.feedback[id]?.tried === true, vote: box.feedback[id]?.vote || null})), feedback: box.feedback});
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark'});
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    const LV = [['no_access', 'No access'], ['read_only', 'Read-only'], ['draft_only', 'Draft-only']];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const json = data => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
      if (p === 'api/view/switches') {
        if (req.method() === 'POST') {
          const b = body();
          assert.equal(req.headers()['x-wizard-switch'], '1');
          if ('vote' in b) { box.votes.push(b); const e = {tried: false, ...box.feedback[b.id]}; delete e.vote; if (b.vote) e.vote = b.vote; box.feedback[b.id] = e; }
          else { box.flips.push(b); box.on[b.id] = b.on; if (b.on) box.feedback[b.id] = {...box.feedback[b.id], tried: true}; }
        }
        return json(listing());
      }
      if (p === 'api/view/switches/feedback') {
        const b = body(); box.votes.push(b); const e = {tried: false, ...box.feedback[b.id]}; delete e.vote; if (b.vote) e.vote = b.vote; box.feedback[b.id] = e;
        return json(listing());
      }
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/view/agents') return ok({wizard_agents: [{id: 'hermes', label: 'Oscar', level: 'draft_only', level_label: 'Draft-only', main: true}], wizard_levels: LV.map(([id, l]) => ({id, label: l})), agents: [], app_key: {level: 'no_access'}, levels: [], log: [], gateway_connected: true});
      if (p === 'api/view/push') return ok({enabled: false});
      if (p === 'api/drafts') return ok({drafts: []});
      if (p === 'api/unified/merge-suggestions') return ok({suggestions: [{a: 'x'}, {a: 'y'}]});
      if (p === 'api/unified/catch-up/settings') return ok({models: ['glm-5-3'], default: 'glm-5-3', model: 'glm-5-3', grants: [{person_id: 'james', name: 'James Carter', mode: 'always'}]});
      if (p === 'api/unified/connectors') return ok({providers: [{network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: '+155****0199'}]},
        {network: 'signal', label: 'Signal', supported: true, state: 'not_configured', flows: []}]});
      if (p === 'api/unified/draft-watch') {
        if (req.method() === 'POST') { const b = body(); box.watch.push(b); if ('all_unread' in b) watch.all_unread = b.all_unread; }
        return ok({on: true, ...watch});
      }
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/directory') return ok({people: PEOPLE, groups: []});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const tag = label, shot = (name, full = false) => page.screenshot({path: path.join(out, `${name}-${tag}.png`), fullPage: full});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.waitForTimeout(900);
    await page.locator('.u-settings-btn').first().click();
    await page.locator('.u-sheet .u-more-agent').waitFor({timeout: 10000});
    const sheet = page.locator('.u-sheet');
    if (!kit) {
      await page.waitForTimeout(500);
      assert.equal(await sheet.locator('.u-try-kit:not([hidden])').count(), 0, 'no switches: no section');
      assert.equal(await sheet.locator('.u-try:not(.u-try-kit), .u-try-row').count(), 0, "Messenger's old own section is gone");
      await shot('settings-none', true);
    } else {
      const kitBox = sheet.locator('.u-try-kit');
      await kitBox.locator('.wz-try-row').first().waitFor({timeout: 8000});
      assert.equal(await sheet.locator('.u-try:not(.u-try-kit), .u-try-row').count(), 0, "no second (Messenger's own) section");
      const order = await sheet.evaluate(el => [...el.children].filter(c => !c.hidden && getComputedStyle(c).display !== 'none').map(c => c.className || c.tagName));
      assert.ok(String(order.at(-1)).includes('u-try-kit'), 'the shared section ends Settings: ' + JSON.stringify(order));
      assert.equal(await kitBox.locator('h2').innerText().then(t => t.trim()), 'Try new features');
      assert.equal(await kitBox.locator('.wz-try-note').innerText(), 'Features still being tested. Approved ones become part of the app; the rest go away. Thumbs up the ones you like.');
      assert.deepEqual(await kitBox.locator('.wz-try-row .wz-main b').allInnerTexts(), SW.map(x => x[1]));
      const warm = kitBox.locator('[data-try-id="add-contact"]'), toggle = warm.getByRole('switch');
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await toggle.click();
      await until(async () => await warm.getByRole('switch').getAttribute('aria-checked') === 'true');
      assert.deepEqual(box.flips.at(-1), {id: 'add-contact', on: true});
      await warm.getByRole('button', {name: 'Thumbs up for Add contact on Telegram'}).click();
      await until(async () => await warm.getByRole('button', {name: 'Thumbs up for Add contact on Telegram'}).getAttribute('aria-pressed') === 'true');
      assert.deepEqual(box.votes.at(-1), {id: 'add-contact', vote: 'up'});
      assert.deepEqual(box.feedback['add-contact'], {tried: true, vote: 'up'});
      // Tapping the active thumb takes it back.
      await warm.getByRole('button', {name: 'Thumbs up for Add contact on Telegram'}).click();
      await until(async () => box.votes.at(-1)?.vote === null);
      assert.deepEqual(box.feedback['add-contact'], {tried: true});
      // A flip in the shared section reaches the box at once.
      await kitBox.locator('[data-try-id="new-group"]').getByRole('switch').click();
      await until(async () => box.flips.at(-1)?.id === 'new-group' && box.flips.at(-1)?.on === true);
      // Flipped from the Tracker: the section follows on the next switch poll.
      box.on['photo-timings'] = true;
      await until(async () => await kitBox.locator('[data-try-id="photo-timings"]').getByRole('switch').getAttribute('aria-checked') === 'true', 12000);
      const fits = await kitBox.locator('.wz-try-row').evaluateAll(rs => rs.every(r => r.scrollWidth <= r.clientWidth + 1));
      assert.ok(fits, 'rows fit the width');
      await page.mouse.move(1, 1); await page.locator('body').evaluate(() => document.activeElement?.blur());
      await kitBox.scrollIntoViewIfNeeded(); await shot('settings-try');
      await shot('settings', true);
    }
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${tag}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
