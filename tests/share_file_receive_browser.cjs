// Issue 314 (on for everyone): a file shared from another Wizard app (an .md from a chat, a PDF) lands in the
// chosen chat's composer as an attachment chip, exactly like one added with +, and is never sent on its own.
// Synthetic API, no container and no shell (WizardApp.share and attachChip are stubs):
//   PLAYWRIGHT_MODULE=... node tests/share_file_receive_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'share-file-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', avatar: null, identities: [{id: 'ann-i', network: 'whatsapp', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
  low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const switches = []; // no switch: files are always taken

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.__accepts = []; window.__receive = null;
    const attachChip = {node(it) { const el = document.createElement('div'); el.className = 'wz-attach-chip'; el.dataset.kind = it.kind; el.textContent = it.name + ' · ' + it.bytes + ' B'; return el; }};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}, attachChip,
      share: {receive(o) { window.__accepts.push(o.accepts.join()); window.__receive = o.receive; return true; }, targets: () => Promise.resolve(true), check: () => Promise.resolve(0)}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], sends = [], drafts = new Map(); let draftSeq = 0;
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (/\/(send|messages)$/.test(p) && req.method() !== 'GET') sends.push(p);
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
    if (p === 'api/unified/people/ann') return ok({person, messages: [{id: '$hi', identity_id: 'ann-i', network: 'whatsapp', sender: 'Ann Lee', outgoing: false, original: 'Hi', msgtype: 'm.text', timestamp: now - min, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    // A small drafts server, so the staged file uploads to the chat's draft the way a + pick does.
    const method = req.method();
    if (p === 'api/drafts' && method === 'GET') return ok({drafts: [...drafts.values()]});
    if (p === 'api/drafts' && method === 'POST') { const b = JSON.parse(req.postData()); const d = {id: 'd' + (++draftSeq), person_id: b.person_id, identity_id: b.identity_id, text: b.text, state: 'draft', revision: 1, attachments: [], updated: Date.now()}; drafts.set(d.id, d); return ok({draft: d}); }
    const dm = /^api\/drafts\/(d\d+)(\/attachments(?:\/(\w+))?)?$/.exec(p);
    if (dm) {
      const d = drafts.get(dm[1]);
      if (!d) return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'not_found', message: 'gone'}})});
      if (dm[2] && method === 'PUT') { d.attachments.push({id: 'a' + (d.attachments.length + 1), name: url.searchParams.get('name'), mime: url.searchParams.get('mime'), bytes: req.postDataBuffer()?.length || 0}); d.revision++; return ok({draft: d}); }
      if (dm[2] && method === 'DELETE') { d.attachments = d.attachments.filter(a => a.id !== dm[3]); d.revision++; return ok({draft: d}); }
      if (method === 'DELETE') { drafts.delete(d.id); return ok({}); }
      if (method === 'POST') { const b = JSON.parse(req.postData()); Object.assign(d, {text: b.text, identity_id: b.identity_id}); d.revision++; return ok({draft: d}); }
      return ok({draft: d});
    }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().waitFor({timeout: 20000});
  await page.waitForTimeout(1200); // switches load at 300 ms
  const accepts = await page.evaluate(() => window.__accepts);
  const share = extra => page.evaluate(x => window.__receive({id: 's1', kind: 'file', file: new Blob(['# Plan\n\nShip it.\n'], {type: 'text/markdown'}), name: 'plan.md', mime: 'text/markdown', size: 17, ...x}), extra);
  assert.ok(accepts.length && accepts.every(a => a === 'text,url,image,file'), 'Messenger tells the share sheet it takes files: ' + accepts);

  // 1. A person picked in the share sheet: the chat opens with the file as a chip in the composer, nothing sent.
  assert.equal(await share({target: 'ann'}), true);
  const chip = page.locator('.u-composer .wz-attach-chip');
  await chip.waitFor({timeout: 10000});
  assert.equal(await chip.count(), 1); assert.equal(await chip.getAttribute('data-kind'), 'file');
  assert.match(await chip.textContent(), /^plan\.md · 17 B$/);
  await page.screenshot({path: path.join(out, 'shared-file-in-composer.png')});

  // 2. Messenger picked (no person): the Send to… picker, then the same chip in the chosen chat.
  await page.locator('.u-composer .wz-attach-chip').first().waitFor();
  const second = share({target: null, id: 's2', name: 'notes.md'});
  await page.locator('.u-directory-row', {hasText: 'Ann Lee'}).waitFor({timeout: 10000});
  await page.screenshot({path: path.join(out, 'send-to-picker.png')});
  await page.locator('.u-directory-row', {hasText: 'Ann Lee'}).click();
  assert.equal(await second, true);
  await page.locator('.u-composer .wz-attach-chip', {hasText: 'notes.md'}).waitFor({timeout: 10000});

  // 3. Over 25 MB: "too big", nothing staged.
  const big = await page.evaluate(() => window.__receive({id: 's3', kind: 'file', file: new Blob([new Uint8Array(25 * 1048576 + 1)]), name: 'huge.zip', mime: 'application/zip'}));
  assert.equal(big, true);
  await page.getByText('huge.zip is too big to send (over 25 MB)').first().waitFor({timeout: 5000});
  assert.equal(await page.locator('.u-composer .wz-attach-chip').count(), 2);
  await page.screenshot({path: path.join(out, 'too-big.png')});

  await page.waitForTimeout(1500);
  const held = [...drafts.values()].flatMap(d => d.attachments.map(a => a.name + ':' + a.mime + ':' + a.bytes));
  assert.deepEqual(held, ['plan.md:text/markdown:17', 'notes.md:text/markdown:17'], 'both files are kept in the chat draft like a + pick');
  assert.equal(await page.getByText('An attachment could not be saved').count(), 0);
  assert.deepEqual(sends, [], 'Messenger never sends a shared file on its own');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({accepts, held, sends, errors, shots: out}, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
