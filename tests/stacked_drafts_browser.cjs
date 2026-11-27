// Issue 353 (on for everyone, no switch): several drafts in one chat wait as stacked bubbles above an empty box, oldest
// first, each with Send, Edit and Remove; one draft alone sits in the box as before. Synthetic API, no container:
//   PLAYWRIGHT_MODULE=... node tests/stacked_drafts_browser.cjs [outdir]      (STALE=1: the box still lists an old stacked-drafts switch as off)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'stacked-drafts-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const STALE = process.env.STALE === '1';
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', avatar: null, identities: [{id: 'ann-i', network: 'whatsapp', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
  low_priority: false, last: {text: 'How did the week go?', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
// The switch is gone: the stack never reads one, even when an older box still answers it as off.
const switches = STALE ? [{id: 'stacked-drafts', name: 'Several drafts in one chat', description: '', on: false, default: false, issues: ['humanitylabs-org/wizard-messenger#353']}] : [];
const oscar = {id: 'agent:oscar', name: 'Oscar'};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      attachChip: {ready: () => Promise.resolve(true), node: c => { const el = document.createElement('span'); el.className = 'ch-att'; el.textContent = c.name; return el; }}};
  });
  const page = await ctx.newPage(), errors = [], sends = [], deletes = [], drafts = new Map(); let draftSeq = 0;
  page.on('pageerror', e => errors.push(e.message));
  const add = (text, by = oscar) => { const d = {id: 'd' + (++draftSeq), person_id: 'ann', identity_id: 'ann-i', text, state: 'draft', revision: 1, attachments: [], updated: now + draftSeq, created_by: by, updated_by: by}; drafts.set(d.id, d); return d; };
  for (const t of ['Week update 1/3: the launch went out on Tuesday.', 'Week update 2/3: two new customers signed.', 'Week update 3/3: next week we hire.']) add(t);
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1), method = req.method();
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) return ok({entries: [], unread: 0, urgent: false, reports_unread: 0, sweep_open: false, read_at: 0});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/directory') return ok({people: [person], groups: []});
    if (p === 'api/unified/people/ann/send') { const b = JSON.parse(req.postData()); sends.push(b); return ok({message: {id: '$s' + sends.length, client_id: b.client_id, identity_id: 'ann-i', network: 'whatsapp', outgoing: true, original: b.text, msgtype: 'm.text', timestamp: Date.now(), reactions: []}}); }
    if (p === 'api/unified/people/ann') return ok({person, messages: [{id: '$hi', identity_id: 'ann-i', network: 'whatsapp', sender: 'Ann Lee', outgoing: false, original: 'How did the week go?', msgtype: 'm.text', timestamp: now - min, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p === 'api/drafts' && method === 'GET') return ok({drafts: [...drafts.values()]});
    if (p === 'api/drafts' && method === 'POST') { const b = JSON.parse(req.postData()); const d = add(b.text, {id: 'owner', name: 'You'}); d.identity_id = b.identity_id; return ok({draft: d}); }
    const dm = /^api\/drafts\/(d\d+)$/.exec(p);
    if (dm) {
      const d = drafts.get(dm[1]);
      if (!d) return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'not_found', message: 'gone'}})});
      if (method === 'DELETE') { deletes.push({id: d.id, ...JSON.parse(req.postData() || '{}')}); drafts.delete(d.id); return ok({deleted: true}); }
      if (method === 'POST') { const b = JSON.parse(req.postData()); Object.assign(d, {text: b.text, identity_id: b.identity_id, updated_by: {id: 'owner', name: 'You'}}); d.revision++; return ok({draft: d}); }
      return ok({draft: d});
    }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.waitForTimeout(800); // the switch listing lands before the chat opens
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const box = page.locator('form textarea[aria-label=Message]');
  await box.waitFor({timeout: 20000}); await page.waitForTimeout(1200);
  const bubbles = page.locator('.u-draft-stack .u-draft-bubble');

  assert.equal(await box.inputValue(), '', 'two or more drafts: the box stays empty');
  assert.deepEqual(await bubbles.locator('.u-draft-text').allTextContents(),
    ['Week update 1/3: the launch went out on Tuesday.', 'Week update 2/3: two new customers signed.', 'Week update 3/3: next week we hire.'], 'oldest at the top');
  for (const name of ['Send', 'Edit', 'Remove']) assert.equal(await bubbles.getByRole('button', {name, exact: true}).count(), 3, 'every bubble has ' + name);
  assert.match(await bubbles.first().locator('.u-draft-by').textContent(), /Oscar/);
  await page.screenshot({path: path.join(out, 'stack.png')});

  // Send the middle one: it goes out as it is, the box stays empty, the others stay.
  await bubbles.nth(1).getByRole('button', {name: 'Send', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.u-draft-stack .u-draft-bubble').length === 2, null, {timeout: 5000});
  await page.waitForTimeout(500);
  assert.deepEqual(sends.map(b => [b.text, b.identity_id]), [['Week update 2/3: two new customers signed.', 'ann-i']], 'Send sends that draft');
  assert.deepEqual(deletes.map(d => [d.id, d.outcome, d.sent_text]), [['d2', 'sent', 'Week update 2/3: two new customers signed.']], 'the sent draft is closed as sent');
  assert.equal(await box.inputValue(), '', 'the box stays empty');
  assert.equal(await page.locator('.u-row.outgoing', {hasText: 'two new customers'}).count(), 1, 'the sent message shows in the thread');

  // Edit the newest: it moves into the box, the other one stays stacked.
  await bubbles.nth(1).getByRole('button', {name: 'Edit', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.u-draft-stack .u-draft-bubble').length === 1, null, {timeout: 5000});
  assert.equal(await box.inputValue(), 'Week update 3/3: next week we hire.', 'Edit moves that draft into the box');
  // The box's own "Drafted by" note shows too: the bubbles left keep the full width, every button on screen.
  await page.locator('.u-bar .u-draft-note').waitFor({timeout: 5000});
  const fit = await page.evaluate(() => [...document.querySelectorAll('.u-draft-stack .u-draft-bubble')].map(b => ({w: b.getBoundingClientRect().width,
    buttons: [...b.querySelectorAll('button')].map(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })})));
  assert.ok(fit.every(f => f.w > 250 && f.buttons.every(Boolean)), 'after Edit the stack keeps its width: ' + JSON.stringify(fit));
  await page.screenshot({path: path.join(out, 'edit-note.png')});
  await box.fill('Week update 3/3: next week we hire two people.');
  await page.waitForTimeout(1200); // autosave
  assert.equal(drafts.get('d3').text, 'Week update 3/3: next week we hire two people.', 'editing in the box saves that draft');
  assert.equal(await bubbles.count(), 1);
  await page.screenshot({path: path.join(out, 'edit.png')});

  // Remove the remaining stacked one (asks first, sends nothing).
  await bubbles.first().getByRole('button', {name: 'Remove', exact: true}).click();
  await page.getByRole('button', {name: 'Remove', exact: true}).last().click();
  await page.waitForFunction(() => !document.querySelector('.u-draft-stack'), null, {timeout: 5000});
  assert.deepEqual(deletes.slice(1).map(d => [d.id, d.outcome]), [['d1', 'discarded']]);
  assert.equal(sends.length, 1, 'Remove sends nothing');
  assert.equal(await box.inputValue(), 'Week update 3/3: next week we hire two people.', 'the box keeps what is being edited');

  // The box's own Send still sends it; then two new agent drafts arrive and wait as a stack, box empty.
  await page.locator('form .u-send').click();
  await page.waitForTimeout(800);
  assert.equal(sends.length, 2); assert.equal(drafts.size, 0);
  add('Follow-up A'); add('Follow-up B');
  await page.waitForFunction(() => document.querySelectorAll('.u-draft-stack .u-draft-bubble').length === 2, null, {timeout: 10000});
  assert.equal(await box.inputValue(), '');

  // Down to one draft: it sits in the box exactly as today.
  await bubbles.first().getByRole('button', {name: 'Send', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('.u-draft-stack'), null, {timeout: 8000});
  await page.waitForFunction(() => document.querySelector('form textarea[aria-label=Message]')?.value === 'Follow-up B', null, {timeout: 8000});
  assert.equal(sends.length, 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({sends: sends.map(b => b.text), deletes, errors}, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
