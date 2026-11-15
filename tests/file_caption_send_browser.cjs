// Issue 228: a PDF with a caption in a WhatsApp chat goes out as the file, then the text. The box's live sync can
// hand the view the file row before the send answers (two sends take a while), and the view then kept a third
// bubble (the PDF and caption together) stuck on the pending clock. After the fix: two sent bubbles, no pending one.
// Synthetic API and a fake drafts server, no container. The composer's attachment chips come from a wizard-ux
// checkout: SHELL_DIR=<wizard-ux> PLAYWRIGHT_MODULE=... node tests/file_caption_send_browser.cjs [outdir]
// STATIC_DIR=<other checkout>/static runs the same steps against another build (for a before screenshot).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'file-caption-send-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3, CAPTION = "oscar's report";
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'whatsapp', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
  low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const sends = [], drafts = new Map();
  let draftSeq = 0, inflight = null, synced = null;
  const row = (id, extra) => ({id, identity_id: 'ann-i', network: 'whatsapp', sender: '', outgoing: true, original: '', reactions: [], ...extra});
  const fileRow = extra => row('$file', {msgtype: 'm.file', media: {filename: 'report.pdf', size: 2048, mime: 'application/pdf'}, timestamp: now, ...extra});
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1), method = req.method();
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
    if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: [{id: '$hi', identity_id: 'ann-i', network: 'whatsapp', sender: 'Ann Lee', outgoing: false, original: 'Hi', msgtype: 'm.text', timestamp: now - min, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p === 'api/unified/people/ann/upload') return ok({upload_id: 'u1'});
    if (p === 'api/unified/people/ann/send') {
      // Like the box: the file goes first, live sync shows it (no client id yet), then the caption, then the answer.
      const body = JSON.parse(req.postData()); sends.push(body);
      let delivered; synced = new Promise(r => { delivered = r; }); inflight = delivered;
      await Promise.race([synced, sleep(8000)]);
      await sleep(300);
      const rows = [fileRow({client_id: body.client_id}), row('$caption', {msgtype: 'm.text', original: body.text, timestamp: now + 1, client_id: body.client_id + '.caption'})];
      return ok({state: 'sent', event_id: '$file', message: rows[0], messages: rows});
    }
    if (p.startsWith('api/unified/updates')) {
      for (let i = 0; i < 200 && !inflight; i++) await sleep(100);
      if (inflight) { const done = inflight; inflight = null; await ok({seq: 6, messages: {ann: [fileRow()]}}); return done(); }
      return ok({seq: 5});
    }
    if (p === 'api/drafts' && method === 'GET') return ok({drafts: [...drafts.values()]});
    if (p === 'api/drafts' && method === 'POST') { const b = JSON.parse(req.postData()); const d = {id: 'd' + (++draftSeq), person_id: b.person_id, identity_id: b.identity_id, text: b.text, state: 'draft', revision: 1, attachments: [], updated: Date.now()}; drafts.set(d.id, d); return ok({draft: d}); }
    const dm = /^api\/drafts\/(d\d+)(\/attachments(?:\/(\w+))?)?$/.exec(p);
    if (dm) {
      const d = drafts.get(dm[1]);
      if (!d) return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'not_found', message: 'gone'}})});
      if (dm[2] && method === 'PUT') { d.attachments.push({id: 'a' + (d.attachments.length + 1), name: url.searchParams.get('name'), mime: url.searchParams.get('mime'), bytes: 10}); d.revision++; return ok({draft: d}); }
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
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  await page.locator('.u-row[data-id="$hi"]').waitFor({timeout: 15000});
  await page.locator('.u-compose-row input[type=file]').setInputFiles([{name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% fixture\n')}]);
  await page.locator('.u-attach-strip .ch-att').first().waitFor({timeout: 10000});
  await page.locator('.u-composer textarea').fill(CAPTION);
  await page.waitForTimeout(1500); // the draft autosave and attachment upload settle
  await page.locator('.u-composer .u-send').first().click();
  for (let i = 0; i < 80 && !sends.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(2500);
  const state = {
    sends: sends.map(b => ({text: b.text, upload_id: b.upload_id})),
    pending: await page.locator('.u-message.pending').count(),
    failed: await page.locator('.u-message.failed').count(),
    fileRows: await page.locator('.u-row', {hasText: 'report.pdf'}).count(),
    captionRows: await page.locator('.u-row', {hasText: CAPTION}).count(),
    errors,
  };
  await page.screenshot({path: path.join(out, 'file-caption-sent.png')});
  console.log(JSON.stringify(state));
  await browser.close();
  if (process.env.NO_ASSERT) return;
  assert.deepEqual(errors, [], 'no page errors');
  assert.deepEqual(state.sends, [{text: CAPTION, upload_id: 'u1'}], 'one send: the file with its caption');
  assert.equal(state.pending, 0, 'no bubble stuck on the pending clock');
  assert.equal(state.failed, 0, 'nothing failed');
  assert.equal(state.fileRows, 1, 'the file shows once');
  assert.equal(state.captionRows, 1, 'the caption shows once');
  console.log('pass file_caption_send_browser');
})().catch(e => { console.error(e); process.exit(1); });
