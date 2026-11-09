// Issue 144 (James, 9 Nov 2026): tapping a LINE photo must open it full size in Wizard's media viewer.
// Synthetic API only, no container: Messenger's static files framed in a minimal Wizard shell built from the real
// app-client.js, app-services.js, chat-kit.js and chats.css of a wizard-ux checkout (SHELL_DIR).
// SHELL_DIR=<wizard-ux checkout> node tests/line_photo_viewer_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'line-photo-viewer-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const JPEG = fs.readFileSync(path.join(__dirname, '..', 'icon-192.png'));
const person = (id, name, net) => ({id, display_name: name, identities: [{id: id + '-i', network: net, kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Photo', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [person('kenji', 'Kenji Tanaka', 'line'), person('marco', 'Marco Bianchi', 'telegram')];
// What the API sends for a LINE photo since 16.33 (unified.py: no mimetype, no size, thumb true); Telegram has the full info block.
const MESSAGES = {
  kenji: [{id: '$line-photo', identity_id: 'kenji-i', network: 'line', sender: 'Kenji Tanaka', outgoing: false, original: '', timestamp: now - min, timeline_order: 1, msgtype: 'm.image', media: {thumb: true}, reactions: []}],
  marco: [{id: '$tg-photo', identity_id: 'marco-i', network: 'telegram', sender: 'Marco Bianchi', outgoing: false, original: '', timestamp: now - min, timeline_order: 1, msgtype: 'm.image', media: {w: 192, h: 192, mime: 'image/png', thumb: true}, reactions: []}],
};
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, mobile] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, false]]) {
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile});
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('frameattached', () => {});
    const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === '__shell/') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/wizard-os-home/core/chats.css"><style>html,body{margin:0;height:100%;background:#111}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style></head>
<body><iframe id="frame" src="/"></iframe>
<script>window.WizCore = {apps: () => ({APPS: [{id: 'messenger', name: 'Messenger', url: '/', kind: 'web'}]})};</script>
<script src="/wizard-os-home/core/app-services.js"></script><script src="/wizard-os-home/core/chat-kit.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});</script></body></html>`});
      const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
      if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) { const id = decodeURIComponent(thread[1]); return ok({person: PEOPLE.find(x => x.id === id), messages: MESSAGES[id] || [], has_more: false, next_cursor: null, seq: 5, typing: []}); }
      // The media route as unified.py serves it: the bytes are sniffed, so a LINE photo still answers as a picture.
      if (p.startsWith('api/unified/media/')) return route.fulfill({status: 200, contentType: 'image/png', body: JPEG});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto('https://messenger.test/__shell/');
    const app = page.frameLocator('#frame');
    for (const [who, id] of [['Kenji Tanaka', '$line-photo'], ['Marco Bianchi', '$tg-photo']]) {
      await app.locator('.u-person', {hasText: who}).first().click();
      const photo = app.locator('.u-media').first();
      await photo.waitFor({timeout: 15000});
      await page.waitForTimeout(300);
      await page.screenshot({path: path.join(out, `chat-${id.slice(1)}-${label}.png`)});
      if (mobile) await photo.tap(); else await photo.click();
      await page.locator('.mviewer.open .mv-stage img').waitFor({timeout: 5000}).catch(() => {});
      await page.screenshot({path: path.join(out, `viewer-${id.slice(1)}-${label}.png`)});
      const st = await page.evaluate(() => window.WosChat.viewer.state);
      assert.equal(st.open, true, `${who}: tapping the photo opens the viewer (${label})`);
      assert.equal(st.kind, 'image');
      assert.ok((await page.locator('.mviewer .mv-stage img').getAttribute('src')).endsWith('api/unified/media/' + encodeURIComponent(id)), 'the full-size picture, not the thumbnail');
      assert.ok(await page.locator('.mviewer .mv-stage img').evaluate(i => i.naturalWidth > 0 || new Promise(r => { i.onload = () => r(i.naturalWidth > 0); setTimeout(() => r(i.naturalWidth > 0), 3000); })), 'the picture shows');
      await page.evaluate(() => window.WosChat.viewer.close()); await page.waitForTimeout(300);
      await app.locator('[aria-label="Back"]').first().click().catch(() => {});
      await page.waitForTimeout(300);
      summary.push(`${label} ${who}: viewer opened`);
    }
    // The shell does not open it (WizardApp.media.view answers false, as a framed app whose host refuses): before
    // issue 144 the tap did nothing. Messenger now shows the tapped photo full size itself; Close / Back closes it.
    await app.locator('.u-person', {hasText: 'Kenji Tanaka'}).first().click();
    await app.locator('.u-media').first().waitFor({timeout: 15000});
    await page.evaluate(() => { window.__viewer = window.WosChat.viewer; window.WosChat.viewer = null; }); // the host answers false
    if (mobile) await app.locator('.u-media').first().tap(); else await app.locator('.u-media').first().click();
    const own = app.locator('.u-photo-view');
    await own.waitFor({timeout: 5000});
    assert.equal(await page.evaluate(() => window.__viewer.isOpen()), false, 'Wizard viewer stayed shut');
    assert.match(await own.locator('img').getAttribute('src'), /api\/unified\/media\/%24line-photo$/, 'full size, not the thumbnail');
    assert.ok(await own.locator('img').evaluate(i => i.complete && i.naturalWidth > 0 || new Promise(r => { i.onload = () => r(true); setTimeout(() => r(i.naturalWidth > 0), 3000); })), 'the picture shows');
    const box = await own.locator('img').boundingBox();
    assert.ok(box.width >= viewport.width * 0.9 || box.height >= viewport.height * 0.9, 'fit to the screen: ' + JSON.stringify(box));
    await page.screenshot({path: path.join(out, `own-view-${label}.png`)});
    await own.getByRole('button', {name: 'Close'}).click();
    assert.equal(await own.count(), 0, 'Close closes it');
    if (mobile) await app.locator('.u-media').first().tap(); else await app.locator('.u-media').first().click();
    await own.waitFor({timeout: 5000});
    await own.press('Escape');
    assert.equal(await own.count(), 0, 'Esc closes it');
    assert.equal(await app.locator('.u-media').count(), 1, 'still in the chat');
    summary.push(`${label} Kenji Tanaka, shell refuses: Messenger's own view opened and closed`);
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
