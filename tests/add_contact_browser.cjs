// Add contact on the network (issue 399, on for everyone since its switch-default): a chat from someone who isn't a
// Telegram contact yet shows an Add contact bar under the header (plus the chat menu and Contact info). One tap adds
// them on Telegram through the box and saves them in Wizard Contacts; contacts, WhatsApp chats and groups show
// nothing. There is no switch: the box lists none, and STALE=1 serves an old `add-contact: off` entry, which must
// change nothing. Synthetic box only; phone + desktop.
// PLAYWRIGHT_MODULE=... [STALE=1] [STATIC_DIR=...] node tests/add_contact_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'add-contact-shots');
const STALE = process.env.STALE === '1';
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3, D = ':messenger.internal';
const person = (id, name, net, value, text, ago, kind = 'person') => ({id, display_name: name, identities: [{id: id + '-i', network: net, kind, label: name, address: '!' + id + D}],
  accounts: value ? [{network: net, value, label: name}] : [], labels: [], unread: 0, muted: false, low_priority: false,
  last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0});
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport] of [['412', {width: 412, height: 860}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [person('gil', 'Gil Novak', 'telegram', '555', 'Hi Miguel, Jana gave me your Telegram. Got a minute?', 2),
      person('dana', 'Dana Wu', 'telegram', '101', 'See you tomorrow', 15), person('fern', 'Fern Ito', 'whatsapp', '66810000009', 'Are we still on for Krabi?', 10)];
    const GROUPS = [person('team', 'Team', 'telegram', null, 'Lunch?', 30, 'group')];
    const TG = {gil: false, dana: true};
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: label === '412', hasTouch: label === '412'});
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    });
    const box = {asks: [], adds: [], saved: []};
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const bad = (status, code, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message}})});
      if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: STALE ? [{id: 'add-contact', name: 'Add contact on Telegram', on: false, default: false, vote: null, tried: false}] : []})});
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
      // The Wizard Contacts app (same Wizard address).
      if (p === 'contacts/api/contacts') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contacts: box.saved.map((c, i) => ({id: 'c' + i, name: c.name, accounts: c.accounts}))})});
      if (p === 'contacts/api/save') { const b = JSON.parse(req.postData()); box.saved.push(b); return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({created: true, contact: {id: 'c0', name: b.name}})}); }
      const nc = /^api\/unified\/people\/([^/]+)\/network-contact$/.exec(p);
      if (nc) {
        const id = decodeURIComponent(nc[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (req.method() === 'GET') {
          box.asks.push(id);
          const tg = pr?.identities[0].kind === 'person' && pr.identities[0].network === 'telegram';
          return ok({person_id: id, networks: tg ? [{network: 'telegram', label: 'Telegram', contact: TG[id], can_add: !TG[id]}] : []});
        }
        box.adds.push({id, body: JSON.parse(req.postData() || '{}')});
        await new Promise(r => setTimeout(r, 300));
        TG[id] = true;
        return ok({person_id: id, network: 'telegram', label: 'Telegram', contact: true, can_add: false});
      }
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (!pr) return bad(404, 'not_found', 'Unknown chat');
        return ok({person: pr, messages: [{id: '$' + id, sender: '@x' + D, sender_name: pr.display_name, outgoing: false, original: pr.last.text, timestamp: pr.last.timestamp, msgtype: 'm.text', network: pr.identities[0].network, identity_id: pr.identities[0].id, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}.png`)});
    const open = async name => {
      await page.locator('.u-person', {hasText: name}).first().click();
      await page.locator('.u-thread-head', {hasText: name}).waitFor({timeout: 10000});
      await page.waitForTimeout(700);
    };
    const bar = page.locator('.u-addcontact');
    const menu = async () => { await page.getByRole('button', {name: 'Chat options'}).click(); await page.waitForTimeout(350); const items = await page.locator('[role=menuitem]').allInnerTexts(); await page.keyboard.press('Escape'); await page.waitForTimeout(450); return items; };
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Gil Novak'}).waitFor({timeout: 15000});
    await page.waitForTimeout(600); // switches load
    await open('Gil Novak');
    await bar.waitFor({state: 'visible', timeout: 8000});
    assert.match(await bar.innerText(), /Not a Telegram contact/);
    const box1 = await bar.boundingBox(), head = await page.locator('.u-thread-head').boundingBox();
    assert.ok(Math.abs(box1.y - (head.y + head.height)) < 3, 'the bar sits right under the chat header');
    await shot('bar');
    assert.ok((await menu()).includes('Add contact on Telegram'), 'chat menu offers it');
    await page.getByRole('button', {name: 'Chat options'}).click(); await page.waitForTimeout(300);
    await page.getByRole('menuitem', {name: 'Contact info'}).click();
    await page.locator('.u-net-contact').getByRole('button', {name: 'Add contact on Telegram'}).waitFor({timeout: 5000});
    await shot('info');
    await page.locator('.u-sheet').getByRole('button', {name: 'Close'}).first().click();
    await page.waitForFunction(() => !document.querySelector('.u-overlay:not([hidden]) .u-sheet'), null, {timeout: 5000}).catch(() => {});
    await page.waitForTimeout(700);
    // A double tap adds once, on Telegram and in Wizard Contacts, then the bar goes.
    await page.getByRole('button', {name: 'Add Gil Novak as a Telegram contact'}).dblclick();
    await bar.waitFor({state: 'hidden', timeout: 8000});
    await page.waitForTimeout(400);
    assert.deepEqual(box.adds, [{id: 'gil', body: {network: 'telegram'}}]);
    assert.equal(box.saved.length, 1);
    assert.deepEqual(box.saved[0].accounts, [{network: 'telegram', value: '555', label: 'Gil Novak'}]);
    assert.ok(!(await menu()).includes('Add contact on Telegram'), 'gone from the menu once added');
    await shot('added');
    // Contacts, other networks and groups: nothing.
    for (const name of ['Dana Wu', 'Fern Ito', 'Team']) {
      if (label === '412') { await page.getByRole('button', {name: 'Back'}).first().click(); await page.waitForTimeout(500); }
      if (name === 'Team') { const tab = page.getByRole('tab', {name: /Groups/}); if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(500); } }
      if (!(await page.locator('.u-person', {hasText: name}).count())) continue;
      await open(name);
      assert.equal(await page.locator('.u-addcontact:visible').count(), 0, name + ': no bar');
      assert.ok(!(await menu()).some(t => /Add contact on/.test(t)), name + ': no menu item');
    }
    assert.deepEqual(errors, []);
    summary.push(label + ' on ok');
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
