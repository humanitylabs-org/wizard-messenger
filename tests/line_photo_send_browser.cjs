// Issue 186: photos send with an empty text box, and LINE photos plus text arrive as the photos then a separate
// text message, each shown as sent; a failed part shows failed + Retry on that part only.
// Synthetic API and a fake drafts server, no container. The composer's attachment chips come from a wizard-ux
// checkout: SHELL_DIR=<wizard-ux> PLAYWRIGHT_MODULE=... node tests/line_photo_send_browser.cjs [outdir]
// STATIC_DIR=<other checkout>/static runs the same steps against another build (for a before screenshot).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'line-photo-send-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ONLY = process.env.ONLY || '';

function personFor(network) {
  return {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network, kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
    low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
}

// Answers like the box: the photo rows (words on the first, as a photo send carries them) or the text row.
function sendAnswer(network, body, sendsSoFar, failText) {
  if (failText) return {status: 502, json: {ok: false, error: {code: 'upstream_unavailable', message: 'LINE did not answer'}}};
  const ids = body.upload_ids || (body.upload_id ? [body.upload_id] : []), rows = [];
  const base = (id, extra) => ({id, identity_id: 'ann-i', network, sender: '', outgoing: true, original: '', timestamp: now + sendsSoFar, reactions: [], client_id: body.client_id, ...extra});
  ids.forEach((u, i) => rows.push(base('$' + body.client_id + '-p' + i, {msgtype: 'm.image', media: {w: 64, h: 48, mime: 'image/jpeg', thumb: true, album_index: i, album_count: ids.length}, album: ids.length > 1 ? 'line:' + body.client_id : null, original: i ? '' : body.text || ''})));
  if (!ids.length) rows.push(base('$' + body.client_id, {msgtype: 'm.text', original: body.text}));
  return {status: 200, json: {ok: true, result: {state: 'sent', event_id: rows[0].id, message: rows[0], messages: rows}}};
}

async function run(browser, {network, text, failTextOnce = false, shot}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const person = personFor(network);
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const uploads = [], sends = [], drafts = new Map();
  let draftSeq = 0, failedOnce = false;
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
    if (p === 'api/unified/people/ann') return ok({person, messages: [{id: '$hi', identity_id: 'ann-i', network, sender: 'Ann Lee', outgoing: false, original: 'Hi', msgtype: 'm.text', timestamp: now - min, reactions: []}], has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p === 'api/unified/people/ann/upload') { uploads.push(url.searchParams.get('kind')); return ok({upload_id: 'u' + uploads.length}); }
    if (p === 'api/unified/people/ann/send') {
      const body = JSON.parse(req.postData()); sends.push(body);
      const failText = failTextOnce && !failedOnce && !!body.text;
      if (failText) failedOnce = true;
      const a = sendAnswer(network, body, sends.length, failText);
      return route.fulfill({status: a.status, contentType: 'application/json', body: JSON.stringify(a.json)});
    }
    // A small drafts server: enough for the composer's autosave and attachment uploads.
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
    if (p.startsWith('api/unified/media/')) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#36a"/></svg>'});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  await page.locator('.u-row[data-id="$hi"]').waitFor({timeout: 15000});
  const shots = await page.evaluate(async () => Promise.all(['#c33', '#3c3'].map(async c => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 64, 48); const b = await new Promise(r => cv.toBlob(r, 'image/png')); return Array.from(new Uint8Array(await b.arrayBuffer())); })));
  await page.locator('.u-compose-row input[type=file]').setInputFiles(shots.map((bytes, i) => ({name: 'p' + i + '.png', mimeType: 'image/png', buffer: Buffer.from(bytes)})));
  await page.locator('.u-attach-strip .ch-att').nth(1).waitFor({timeout: 10000});
  if (text) await page.locator('.u-composer textarea').fill(text);
  await page.waitForTimeout(1500); // the draft autosave and attachment uploads settle
  const send = page.locator('.u-composer .u-send').first();
  const state = {network, text, sendVisible: await send.isVisible(), sendEnabled: await send.isEnabled().catch(() => false)};
  if (shot) await page.screenshot({path: path.join(out, shot + '-ready.png')});
  if (state.sendVisible && state.sendEnabled) await send.click();
  for (let i = 0; i < 40 && !sends.length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1200);
  state.sends = sends.map(b => ({text: b.text, upload_ids: b.upload_ids, upload_id: b.upload_id}));
  state.photoRows = await page.locator('.u-row:has(.u-media)').count();
  state.photosFailed = await page.locator('.u-row:has(.u-media) .u-message.failed').count();
  state.trayLeft = await page.locator('.u-attach-strip .ch-att').count();
  state.failed = await page.locator('.u-message.failed').count();
  state.retry = await page.getByText(/retry/i).count();
  state.textRow = text ? await page.locator('.u-row', {hasText: text}).count() : 0;
  state.pending = await page.locator('.u-message.pending').count();
  if (shot) await page.screenshot({path: path.join(out, shot + '-sent.png')});
  if (failTextOnce && state.retry) {
    await page.getByText(/retry/i).first().click();
    for (let i = 0; i < 30 && sends.length < 3; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(800);
    state.afterRetry = sends.slice(2).map(b => ({text: b.text, upload_ids: b.upload_ids, upload_id: b.upload_id, client_id: b.client_id}));
    state.textClient = sends[1].client_id;
    state.retryFailed = await page.getByText(/retry/i).count();
    state.failedAfter = await page.locator('.u-message.failed').count();
    state.textRowAfter = await page.locator('.u-row', {hasText: text}).count();
    if (shot) await page.screenshot({path: path.join(out, shot + '-retried.png')});
  }
  state.errors = errors;
  await ctx.close();
  return state;
}

(async () => {
  const browser = await chromium.launch(), results = [];
  const cases = [
    {name: 'line-photos-only', network: 'line', text: '', shot: 'line-photos-only'},
    {name: 'telegram-photos-only', network: 'telegram', text: ''},
    {name: 'whatsapp-photos-only', network: 'whatsapp', text: ''},
    {name: 'signal-photos-only', network: 'signal', text: ''},
    {name: 'instagram-photos-only', network: 'instagram', text: ''},
    {name: 'line-photos-text', network: 'line', text: 'Two from the trip', shot: 'line-photos-text'},
    {name: 'line-text-fails', network: 'line', text: 'Two from the trip', failTextOnce: true, shot: 'line-text-fails'},
  ].filter(c => !ONLY || c.name === ONLY);
  for (const c of cases) { const r = await run(browser, c); r.name = c.name; results.push(r); console.log(JSON.stringify(r)); }
  await browser.close();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2));
  if (process.env.NO_ASSERT) return;
  for (const r of results) {
    assert.deepEqual(r.errors, [], r.name + ': no page errors');
    assert.ok(r.sendVisible && r.sendEnabled, r.name + ': Send is there with photos and no text');
    assert.equal(r.trayLeft, 0, r.name + ': tray emptied');
    assert.deepEqual(r.sends[0].upload_ids, ['u1', 'u2'], r.name + ': both photos go');
    if (!r.text) {
      assert.equal(r.sends.length, 1, r.name + ': one send');
      assert.equal(r.sends[0].text, '', r.name + ': photos with no text');
      assert.equal(r.failed + r.pending, 0, r.name + ': shown as sent');
    }
    if (r.name === 'line-photos-text') {
      assert.equal(r.sends.length, 2, 'LINE: photos, then the text, as two sends');
      assert.equal(r.sends[0].text, '', 'LINE: no words on the photos');
      assert.deepEqual(r.sends[1], {text: 'Two from the trip', upload_ids: undefined, upload_id: undefined}, 'LINE: the text on its own');
      assert.ok(r.textRow >= 1, 'the text shows as its own message');
      assert.equal(r.failed + r.pending, 0, 'each part shows as sent');
    }
    if (r.name === 'line-text-fails') {
      assert.equal(r.photosFailed, 0, 'the photos that went through show as sent');
      assert.equal(r.failed, 1, 'only the text shows failed');
      assert.ok(r.retry >= 1, 'the failed text shows Retry');
      assert.equal(r.afterRetry.length, 1, 'Retry sends once');
      assert.deepEqual([r.afterRetry[0].text, r.afterRetry[0].upload_ids, r.afterRetry[0].client_id], ['Two from the trip', undefined, r.textClient], 'Retry resends only the text, same id');
      assert.equal(r.failedAfter, 0, 'after Retry nothing is failed');
    }
  }
  console.log('pass line_photo_send_browser');
})().catch(e => { console.error(e); process.exit(1); });
