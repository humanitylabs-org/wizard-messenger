// Issue 266 (switch agent-chat): the Agent chat takes a photo or a voice note as a note. Add (plus) picks a photo,
// the mic records through Wizard's shared recorder (a stub here) and saves on the second tap, Wizard's transcription
// is kept for the agent, and the note shows the photo or a player, with a tick once the agent picks it up.
// Synthetic API (a small fake of agent_chat.py's owner routes), no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/agent_chat_media_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-chat-media-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee')];
// A 64x48 PNG (orange), small enough to inline.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAU0lEQVR4nO3PQQ3AIADAQEANYhGLhIngcVnSU9DOe/b4s6UDXjWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaB9TU4CBLTTxEUAAAAASUVORK5CYII=', 'base64');

function fakeBox() {
  const box = {seq: 0, read_at: 0, entries: [], files: {}, uploads: [], transcripts: []};
  const state = () => ({entries: box.entries, unread: 0, urgent: false, reports_unread: 0, sweep_open: false, read_at: box.read_at});
  return {box, state,
    put(query, bytes) {
      const kind = query.get('kind'), id = 'n' + ++box.seq;
      const media = {type: kind, mime: kind === 'photo' ? 'image/png' : 'audio/ogg', size: bytes.length, file: 'f'.repeat(32)};
      if (query.get('duration')) media.duration = Number(query.get('duration'));
      box.files[id] = bytes; box.uploads.push({kind, size: bytes.length, duration: media.duration || null});
      box.entries.push({id, kind: 'note', by: 'owner', text: '', media, at: Date.now() + box.seq, seen: null});
      return state();
    },
    post(p, body) {
      if (p === '' && body) box.entries.push({id: 'n' + ++box.seq, kind: 'note', by: 'owner', text: body.text, at: Date.now() + box.seq, seen: null});
      if (p === '/transcript') { box.transcripts.push(body); box.entries.find(e => e.id === body.id).media.transcript = body.text; }
      return state();
    },
    ack(id) { box.entries.find(e => e.id === id).seen = {at: Date.now(), by: 'Oscar'}; },
  };
}

async function run(browser, label, viewport) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.__capture = {started: 0, stopped: 0, acked: [], cancelled: 0};
    const take = () => ({id: 'take-' + window.__capture.started, durationMs: 3200, blob: new Blob([new Uint8Array([79, 103, 103, 83, ...new Array(60).fill(0)])], {type: 'audio/ogg'})});
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      voice: {transcribe: async blob => ({text: 'Remind me to call the vet (' + blob.size + ' bytes)'})},
      capture: {current: () => null, pending: async () => [], ack: async id => { window.__capture.acked.push(id); },
        start: async o => { window.__capture.started++; window.__capture.meta = o.meta; return {getInfo: () => ({startedAt: Date.now()}),
          stop: async () => { window.__capture.stopped++; return take(); }, cancel: async () => { window.__capture.cancelled++; }}; }}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], fake = fakeBox();
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = [];  // Issue 265: the Agent chat has no switch any more.
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/agent-chat/media' && req.method() === 'PUT') {
      assert.equal(req.headers()['x-messenger-csrf'], 'fixture', 'the upload carries the CSRF header');
      return ok(fake.put(url.searchParams, req.postDataBuffer()));
    }
    if (p.startsWith('api/unified/agent-chat/media/')) {
      const id = decodeURIComponent(p.split('/').pop()), bytes = fake.box.files[id];
      return bytes ? route.fulfill({status: 200, contentType: id && fake.box.entries.find(e => e.id === id).media.type === 'photo' ? 'image/png' : 'audio/ogg', body: bytes}) : route.fulfill({status: 404, body: ''});
    }
    if (p.startsWith('api/unified/agent-chat')) {
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
      return ok(req.method() === 'POST' ? fake.post(p.slice('api/unified/agent-chat'.length), body) : fake.state());
    }
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-agent-row[data-mode="chat"]').waitFor({timeout: 20000});
  const shot = name => page.screenshot({path: path.join(out, `${label}-${name}.png`)});
  const result = {label};
  await page.locator('.u-agent-row[data-mode="chat"]').click();
  const sheet = page.locator('#unified-inbox');
  await sheet.locator('.u-thread-head.u-agent-head').waitFor({timeout: 5000});
  assert.equal(await sheet.getByRole('button', {name: 'Add a photo or voice note'}).count(), 1, label + ': Add is in the composer');
  // A photo note.
  await sheet.locator('input.u-ac-file').setInputFiles({name: 'receipt.png', mimeType: 'image/png', buffer: PNG});
  await sheet.locator('.u-ac-row.out img.u-ac-photo').waitFor({timeout: 5000});
  await page.waitForFunction(() => document.querySelector('.u-ac-photo')?.naturalWidth === 64, null, {timeout: 5000});
  assert.deepEqual(fake.box.uploads[0], {kind: 'photo', size: PNG.length, duration: null});
  // A voice note: the mic starts Wizard's recorder, a second tap stops and saves it.
  await sheet.getByRole('button', {name: 'Record a voice note'}).click();
  await sheet.locator('.u-ac-rec', {hasText: 'Recording'}).waitFor({timeout: 5000});
  assert.ok(await sheet.locator('.u-ac-field').isHidden(), label + ': the field gives way to the recording strip');
  await shot('1-recording');
  await sheet.getByRole('button', {name: 'Stop and save the voice note'}).click();
  await sheet.locator('.u-ac-row.out audio.u-ac-voice').waitFor({timeout: 5000});
  await sheet.locator('.u-ac-transcript', {hasText: 'Remind me to call the vet'}).waitFor({timeout: 5000});
  assert.equal(fake.box.uploads[1].kind, 'voice');
  assert.equal(fake.box.uploads[1].duration, 3200);
  result.capture = await page.evaluate(() => window.__capture);
  assert.deepEqual(result.capture.acked, ['take-1'], label + ': the saved take is released from Wizard\'s recordings');
  assert.equal(result.capture.meta.purpose, 'messenger-agent-note');
  assert.ok(await sheet.locator('.u-ac-field').isVisible(), label + ': the field is back');
  // Discard drops a recording; nothing is uploaded.
  await sheet.getByRole('button', {name: 'Record a voice note'}).click();
  await sheet.getByRole('button', {name: 'Discard the voice note'}).click();
  await sheet.locator('.u-ac-rec').waitFor({state: 'hidden', timeout: 5000});
  assert.equal(fake.box.uploads.length, 2, label + ': a discarded recording is not saved');
  assert.equal(await page.evaluate(() => window.__capture.cancelled), 1);
  // The agent picks both up: ticks.
  fake.ack('n1'); fake.ack('n2');
  await page.waitForFunction(() => document.querySelectorAll('.u-ac-row.out .u-ac-tick').length === 2, null, {timeout: 9000});
  await shot('2-media-notes');
  await page.getByRole('button', {name: label === 'phone' ? 'Back' : 'Close chat'}).click();
  await page.locator('.u-agent-head').waitFor({state: 'detached', timeout: 5000});
  result.snippet = await page.locator('.u-agent-row[data-mode="chat"] .u-snippet').textContent().catch(() => null);
  assert.equal(result.snippet, 'You: Voice note');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [await run(browser, 'phone', {width: 390, height: 844}), await run(browser, 'desktop', {width: 1280, height: 860})];
    console.log(JSON.stringify({ok: true, results}, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
