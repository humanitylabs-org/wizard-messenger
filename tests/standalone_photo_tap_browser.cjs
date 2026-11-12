// Issue 180 (James, 12 Nov 2026): in Messenger opened as its own installed app (Android PWA, no Wizard around it)
// tapping a photo did nothing: the shared client's media.view only tried window.open, which an installed app never
// shows, and still answered true. Messenger now opens its own full-screen view there; Close and Back close it and stay
// in the chat. Synthetic API only, no container; the real app-client.js comes from a wizard-ux checkout (SHELL_DIR).
// SHELL_DIR=<wizard-ux checkout> node tests/standalone_photo_tap_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'standalone-photo-tap-shots');
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
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
      userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' : undefined});
    // An installed app: display-mode standalone, and a window.open that shows nothing (counted).
    await ctx.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = q => /display-mode:\s*standalone/.test(q) ? Object.assign(mm('(min-width: 0px)'), {media: q}) : mm(q);
      window.__opened = []; window.open = (...a) => { window.__opened.push(String(a[0])); return null; };
    });
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
    await page.goto('https://messenger.test/');
    for (const [who, id] of [['Kenji Tanaka', '$line-photo'], ['Marco Bianchi', '$tg-photo']]) {
      await page.locator('.u-person', {hasText: who}).first().click();
      const photo = page.locator('.u-media').first();
      await photo.waitFor({timeout: 15000});
      await page.waitForTimeout(300);
      await page.screenshot({path: path.join(out, `chat-${id.slice(1)}-${label}.png`)});
      if (mobile) await photo.tap(); else await photo.click();
      const own = page.locator('.u-photo-view');
      await own.waitFor({timeout: 5000});
      assert.deepEqual(await page.evaluate(() => window.__opened), [], 'no new-window attempt');
      assert.ok((await own.locator('img').getAttribute('src')).endsWith('api/unified/media/' + encodeURIComponent(id)), 'the full-size picture');
      assert.ok(await own.locator('img').evaluate(i => i.complete && i.naturalWidth > 0 || new Promise(r => { i.onload = () => r(true); setTimeout(() => r(i.naturalWidth > 0), 3000); })), 'the picture shows');
      const box = await own.locator('img').boundingBox();
      assert.ok(box.width >= viewport.width * 0.9 || box.height >= viewport.height * 0.9, 'fit to the screen: ' + JSON.stringify(box));
      await page.screenshot({path: path.join(out, `own-view-${id.slice(1)}-${label}.png`)});
      await own.getByRole('button', {name: 'Close'}).click();
      assert.equal(await own.count(), 0, 'Close closes it');
      // Android Back: the browser goes back one history entry.
      if (mobile) await photo.tap(); else await photo.click();
      await own.waitFor({timeout: 5000});
      await page.goBack({waitUntil: 'commit'}).catch(() => {});
      await page.waitForTimeout(400);
      assert.equal(await own.count(), 0, 'Back closes it');
      assert.equal(new URL(page.url()).hostname, 'messenger.test', 'Back stays in Messenger');
      assert.equal(await page.locator('.u-media').count(), 1, 'still in the chat');
      summary.push(`${label} ${who}: Messenger's own view opened; Close and Back closed it, still in the chat`);
      await page.locator('[aria-label="Back"]').first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
