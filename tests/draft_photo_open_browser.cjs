// Issue 354: a photo staged in the composer (a draft) opens full size on a tap, like a sent photo, so the owner can
// see what they are about to send. Remove still removes. Synthetic API, no container (WizardApp.attachChip mirrors
// Wizard's chip markup; WIZARD_UX_DIR=<wizard-ux checkout> uses the real chip script and styles instead):
//   PLAYWRIGHT_MODULE=... node tests/draft_photo_open_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'draft-photo-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', avatar: null, identities: [{id: 'ann-i', network: 'whatsapp', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false,
  low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const switches = [];
const ux = process.env.WIZARD_UX_DIR, realChip = ux ? fs.readFileSync(path.join(ux, 'web/core/attach-chip.js'), 'utf8') : '', chipCss = ux ? fs.readFileSync(path.join(ux, 'web/core/attach-chip.css'), 'utf8') : '';
// A 600x400 PNG photo with a pattern, so full size is plainly bigger than the tray thumbnail.
const photo = Buffer.from(require('node:zlib').deflateSync(Buffer.concat(Array.from({length: 400}, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({length: 600}, (_, x) => [(x * 255 / 600) | 0, (y * 255 / 400) | 0, ((x ^ y) & 32) ? 220 : 60]).flat())])))));
function png(w, h, idat) {
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true});
  await ctx.addInitScript(([chipSrc, css]) => {
    const noop = () => {};
    if (chipSrc) (0, eval)(chipSrc);
    if (css) document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); });
    const attachChip = {ready: () => Promise.resolve(true), node(c, opts = {}) {
      if (window.WizAttachChip) return window.WizAttachChip.node(c, opts);
      const el = document.createElement('span'); el.className = 'ch-att ch-attimg'; el.dataset.attkey = c.key;
      if (c.preview) { const img = document.createElement('img'); img.src = c.preview; img.alt = c.name; img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:10px'; el.append(img); } else el.append(c.name);
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'ch-attrm'; rm.setAttribute('aria-label', 'Remove'); rm.textContent = '×';
      rm.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); opts.onRemove?.(c.key); }); el.append(rm); return el; }};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}, attachChip};
  }, [realChip, chipCss]);
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
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const input = page.locator('.u-composer input[type=file], form input[type=file]').first();
  await input.waitFor({state: 'attached', timeout: 20000});
  await input.setInputFiles([{name: 'beach.png', mimeType: 'image/png', buffer: png(600, 400, photo)}, {name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('plan')}]);
  const chip = page.locator('.u-attach-strip .ch-att').first();
  await chip.waitFor({timeout: 10000}); await page.waitForTimeout(600);
  await page.screenshot({path: path.join(out, 'draft-tray.png')});
  await chip.locator('img').first().click();
  const shown = page.locator('.u-photo-view img');
  await shown.waitFor({timeout: 5000}).catch(() => {});
  const opened = await shown.count();
  await page.screenshot({path: path.join(out, 'draft-photo-open.png')});
  assert.equal(opened, 1, 'tapping the staged photo opens it full size');
  const size = await shown.evaluate(i => ({w: i.getBoundingClientRect().width, natural: i.naturalWidth}));
  assert.ok(size.w > 300 && size.natural === 600, 'full size, not the thumbnail: ' + JSON.stringify(size));
  await page.locator('.u-photo-view-close').click();
  assert.equal(await page.locator('.u-photo-view').count(), 0, 'Close closes it');
  assert.equal(await page.locator('.u-attach-strip .ch-att').nth(1).getAttribute('role'), null, 'a file chip is not made a photo button');
  await page.locator('.u-attach-strip .ch-att').first().locator('.ch-attrm').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.u-photo-view').count(), 0, 'Remove never opens the viewer');
  assert.equal(await page.locator('.u-attach-strip .ch-attimg').count(), 0, 'Remove still removes the photo');
  console.log(JSON.stringify({opened, size, errors}, null, 2)); assert.deepEqual(errors, []);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
