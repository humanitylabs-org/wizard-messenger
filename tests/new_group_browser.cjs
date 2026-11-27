// New group (issue 397, on for everyone since its switch-default): New chat offers New group only for networks whose
// bridge can create groups; the owner picks a network, people and a name (optional photo), taps Create, and the group
// opens ready to send. The box lists no switches at all, so it needs none. Synthetic box only; phone + desktop.
// NONE=1: no network can make groups, so no New group button anywhere.
// PLAYWRIGHT_MODULE=... [NONE=1] [STATIC_DIR=...] node tests/new_group_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'new-group-shots');
const NONE = process.env.NONE === '1';
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3, D = ':messenger.internal';
const ident = (id, net, kind, label, address) => [{id: id + '-i', network: net, kind, label, address: address || '!' + id + D}];
const person = (id, name, net, text, ago, kind = 'person') => ({id, display_name: name, identities: ident(id, net, kind, name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0});
const NETWORKS = [
  {network: 'telegram', label: 'Telegram', type: 'group', name_required: true, name_max: 255, min: 2, max: 200, photo: true},
  {network: 'whatsapp', label: 'WhatsApp', type: 'group', name_required: false, name_max: 100, min: 2, max: null, photo: true}];
const CONTACTS = {
  whatsapp: [['Ann Lee', '66810000001'], ['Bob Ray', '66810000002'], ['Cy Moss', '66810000003'], ['Fern Ito', '66810000009']].map(([name, n]) => ({id: '@whatsapp_' + n + D, name})),
  telegram: [['Dana Wu', '101'], ['Eli Park', '102']].map(([name, n]) => ({id: '@telegram_' + n + D, name}))};
// A small JPEG made by the page itself is enough for the photo path.
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport] of [['412', {width: 412, height: 860}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [person('james', 'James Carter', 'whatsapp', 'On my way, 10 minutes', 2)], GROUPS = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: label === '412', hasTouch: label === '412'});
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    });
    const box = {creates: [], photos: 0, groupCalls: 0};
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const bad = (status, code, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message}})});
      if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: {display_name: 'Owner'}});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/drafts') return ok({drafts: []});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      if (p === 'api/unified/directory') return ok({people: PEOPLE, groups: GROUPS});
      if (p === 'api/unified/new-group') {
        box.groupCalls++;
        if (req.method() === 'GET') return ok({networks: NONE ? [] : NETWORKS});
        const b = body(); box.creates.push(b);
        const done = box.creates.find(c => c.client_id === b.client_id && c !== b);
        const g = person('g-' + b.client_id, b.name || 'Ann and Bob', b.network, '', 0, 'group');
        g.started = true;
        if (!done) GROUPS.unshift(g);
        return ok({chat_id: g.id, channel_id: g.id + '-i', network: b.network, name: g.display_name, not_added: [], photo: b.photo ? 'set' : null});
      }
      if (p === 'api/unified/new-group/people') return ok({network: url.searchParams.get('network'), people: CONTACTS[url.searchParams.get('network')] || []});
      if (p === 'api/unified/new-group/photo') { box.photos++; assert.equal(req.method(), 'PUT'); return ok({photo: 'pic' + box.photos}); }
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (!pr) return bad(404, 'not_found', 'Unknown chat');
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}.png`)});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.waitForTimeout(600); // switches load
    if (label === '412') {
      await page.getByRole('button', {name: 'New chat'}).first().click();
      await page.locator('.u-sheet .u-directory-row', {hasText: 'James Carter'}).waitFor({timeout: 10000});
    } else {
      await page.getByRole('button', {name: 'New chat'}).first().click();
      await page.locator('.u-newmsg').waitFor({timeout: 10000});
    }
    await page.waitForTimeout(500);
    const entry = page.getByRole('button', {name: 'New group', exact: true});
    if (NONE) {
      assert.equal(await entry.isVisible(), false, 'no network can make groups: no New group button');
      assert.ok(box.groupCalls >= 1, 'the box is asked which networks can make groups');
      await shot('none');
      summary.push(label + ' none ok');
      await ctx.close();
      continue;
    }
    await entry.waitFor({timeout: 5000});
    await shot('entry');
    await entry.click();
    const sheet = page.locator('.u-sheet.u-new-group');
    await sheet.waitFor({timeout: 5000});
    // Both networks offered (radio row), Telegram first; WhatsApp chosen by tap.
    assert.deepEqual(await sheet.locator('.u-group-nets [role=radio]').allInnerTexts(), ['Telegram', 'WhatsApp']);
    await sheet.getByRole('radio', {name: 'WhatsApp'}).click();
    await sheet.getByRole('checkbox', {name: /Ann Lee/}).waitFor({timeout: 5000});
    const create = sheet.getByRole('button', {name: 'Create group'});
    assert.equal(await create.isDisabled(), true, 'no one picked: Create is off');
    await sheet.getByRole('checkbox', {name: /Ann Lee/}).click();
    assert.match(await sheet.locator('.u-group-note').innerText(), /Pick at least 2 people/);
    assert.equal(await create.isDisabled(), true, 'one person: still off');
    await sheet.getByRole('searchbox').fill('bob');
    await sheet.getByRole('checkbox', {name: /Bob Ray/}).click();
    await sheet.getByRole('searchbox').fill('');
    assert.equal(await sheet.getByRole('checkbox', {name: /Bob Ray/}).getAttribute('aria-checked'), 'true');
    assert.equal(await create.isDisabled(), false, 'two people: Create on');
    assert.equal(await sheet.locator('.u-group-name').getAttribute('placeholder'), 'Ann and Bob');
    // Optional photo.
    const jpeg = await page.evaluate(async () => {
      const c = Object.assign(document.createElement('canvas'), {width: 40, height: 30}); const x = c.getContext('2d'); x.fillStyle = '#c84'; x.fillRect(0, 0, 40, 30);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg')); return [...new Uint8Array(await b.arrayBuffer())];
    });
    const chooser = page.waitForEvent('filechooser');
    await sheet.getByRole('button', {name: 'Add group photo'}).click();
    await (await chooser).setFiles({name: 'pic.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg)});
    await sheet.locator('.u-group-photo img').waitFor({timeout: 5000});
    await sheet.locator('.u-group-name').fill('Trip to Krabi');
    await shot('sheet');
    await create.click();
    await page.locator('.u-thread-head, .u-head', {hasText: 'Trip to Krabi'}).first().waitFor({timeout: 10000});
    assert.equal(box.creates.length, 1);
    const sent = box.creates[0];
    assert.equal(sent.network, 'whatsapp');
    assert.deepEqual(sent.people, CONTACTS.whatsapp.slice(0, 2).map(c => c.id));
    assert.equal(sent.name, 'Trip to Krabi');
    assert.equal(sent.photo, 'pic1');
    assert.match(sent.client_id, /^[A-Za-z0-9_-]{8,64}$/);
    // Opens ready to send.
    await page.getByRole('textbox', {name: /message/i}).first().waitFor({timeout: 5000});
    await shot('opened');
    assert.deepEqual(errors, []);
    summary.push(label + ' ok');
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'), '\nshots in', out);
})().catch(e => { console.error(e); process.exit(1); });
