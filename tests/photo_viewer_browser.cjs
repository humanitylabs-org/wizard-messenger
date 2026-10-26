// Loopback disposable preview. Tapping a Messenger photo inside Wizard opens Wizard's one media viewer (the one
// Chats uses): pinch and double-tap zoom, swipe through the chat's photos, Back closes (James, 26 Oct 2026).
// The shell side is the real app-services.js + chat-kit.js + chats.css from SHELL_DIR (a wizard-ux checkout).
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  assert.match(new URL(base).hostname, /^(localhost|127\.0\.0\.1)$/);
  const out = process.env.EVIDENCE_DIR || 'voicefix/viewer'; fs.mkdirSync(out, {recursive: true});
  const b = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await b.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true, ignoreHTTPSErrors: true});
  const person = {id: 'album-fixture', display_name: 'Album preview', identities: [{id: 'album-id', network: 'telegram'}], last: {text: 'Photos', timestamp: 1000}, unread: 0};
  let rows = [], uploads = [], sends = []; const shares = [], reactions = [];
  const ok = result => ({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
  await ctx.route(/api\/unified\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*api\/unified\//, '');
    if (path === 'people') return route.fulfill(ok({people: [person], seq: 1}));
    if (path === 'groups') return route.fulfill(ok({groups: [], seq: 1}));
    if (path === 'people/album-fixture') return route.fulfill(ok({person, messages: rows, has_more: false, seq: 1}));
    if (path.endsWith('/react')) { const id = decodeURIComponent(path.split('/')[1]); reactions.push(id); const m = rows.find(r => r.id === id); m.reactions = []; return route.fulfill(ok({message: m})); }
    if (path.includes('updates')) return new Promise(() => {});
    if (path.endsWith('/upload')) { uploads.push(route.request().postDataBuffer().length); return route.fulfill(ok({upload_id: 'u' + uploads.length})); }
    if (path.endsWith('/send')) { sends.push(JSON.parse(route.request().postData())); return route.fulfill(ok({state: 'sent'})); }
    if (path.includes('media/')) {
      const n = Number(decodeURIComponent(path).match(/photo-(\d+)/)?.[1] || 0);
      const colors = ['#608a96','#ddb586','#ad7698','#6d8a68'];
      return route.fulfill({status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${colors[n % 4]}"/><circle cx="420" cy="140" r="65" fill="#f9e7bc"/><path d="M0 480L240 160L410 480L500 280L640 480" fill="#263f50"/></svg>`});
    }
    if (/(read|typing)$/.test(path)) return route.fulfill(ok({}));
    return route.continue();
  });
  // Serve this checkout's view files and the shell checkout's shared files; the preview container is not touched.
  const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
  if (process.env.STATIC_DIR) await ctx.route(/\/(unified\.js|unified\.css)(\?|$)/, route => { const f = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({status: 200, contentType: f.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(process.env.STATIC_DIR + '/' + f)}); });
  await ctx.route(/\/wizard-os-home\/core\/[a-z-]+\.(js|css)(\?|$)/, route => { const f = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({status: 200, contentType: f.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(SHELL + '/web/core/' + f)}); });
  // A minimal Wizard shell: the real app host (app-services.js) and media viewer (chat-kit.js, chats.css) with
  // Messenger installed at this origin's root, framed exactly as Wizard frames an app.
  await ctx.route(/\/__shell\/$/, route => route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/wizard-os-home/core/chats.css"><style>html,body{margin:0;height:100%;background:#111}#device{position:fixed;inset:0}iframe{border:0;width:100%;height:100%}</style></head>
<body><div id="device"><iframe id="frame" src="/"></iframe></div>
<script>window.WizCore = {apps: () => ({APPS: [{id: 'messenger', name: 'Messenger', url: '/', kind: 'web'}]})};</script>
<script src="/wizard-os-home/core/app-services.js"></script><script src="/wizard-os-home/core/chat-kit.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});</script></body></html>`}));

  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const ticket = JSON.parse(execFileSync('curl', ['-sf','-X','POST','-H','Authorization: Bearer ' + process.env.MESSENGER_API_TOKEN,'-H','Content-Type: application/json','-d','{"bootstrap":true}','http://127.0.0.1:19252/api/view/ticket'])).result.ticket;
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(1000);
  await page.locator('#setup-form:visible, #inbox-tabs:visible').first().waitFor({timeout: 60000});
  if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.locator('#confirm-passphrase').waitFor({state: 'visible'});
  const pw = 'disposable-album-fixture-' + Date.now(); await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  // Address sheet opens after the asynchronous post-create snapshot, not at first ready paint.
  await page.locator('#sheet-layer:not([hidden])').waitFor({state: 'visible', timeout: 30000});
  await page.click('#close-sheet');
  await page.click('#inbox-tabs [data-tab="people"]');
  const stamp = Date.now() - 10000;
  rows = Array.from({length: 3}, (_, i) => ({id: '$photo-' + i, album: 'telegram:1234567890123456789', identity_id: 'album-id', network: 'telegram', sender: 'Album preview', outgoing: false,
    original: i === 0 ? 'Beach day' : '', timeline_order: i + 1, timestamp: stamp, msgtype: 'm.image', media: {w: 640, h: 480, mime: 'image/jpeg'}, reactions: []}));
  await page.goto(base + '__shell/');
  const app = page.frameLocator('#frame');
  await app.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  if (await app.locator('#sheet-layer:not([hidden])').isVisible()) await app.locator('#close-sheet').click();
  await app.locator('#inbox-tabs [data-tab="people"]').click();
  await app.locator('.u-person', {hasText: 'Album preview'}).click();
  await app.locator('.u-album .u-media').nth(2).waitFor();
  // Tap the second photo: the shell's viewer opens over the app with all three photos, second one showing.
  await app.locator('.u-album .u-media').nth(1).tap();
  await page.locator('.mviewer.open .mv-stage img').waitFor({timeout: 10000});
  let st = await page.evaluate(() => window.WosChat.viewer.state);
  assert.equal(st.open, true); assert.equal(st.n, 3, 'swipe through every photo in the chat'); assert.equal(st.i, 1, 'opens on the tapped photo');
  assert.match(await page.locator('.mviewer .mv-stage img').getAttribute('src'), /api\/unified\/media\/%24photo-1$/);
  assert.match(st.name, /Album preview/);
  assert.equal(await app.locator('.u-viewer').count(), 0, 'Messenger keeps no viewer of its own');
  await page.waitForTimeout(400);
  // Pinch out with two fingers (real touch events): the photo zooms.
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map(([x, y], id) => ({x, y, id}))});
  await touch('touchStart', [[170, 420], [220, 420]]);
  for (let k = 1; k <= 8; k++) await touch('touchMove', [[170 - k * 12, 420], [220 + k * 12, 420]]);
  await touch('touchEnd', []);
  await page.waitForTimeout(300);
  st = await page.evaluate(() => window.WosChat.viewer.state);
  assert.ok(st.scale > 1.5, 'pinch zooms the photo: scale ' + st.scale);
  await page.screenshot({path: out + '/viewer-pinched.png'});
  // Double-tap toggles back to fit.
  await page.touchscreen.tap(195, 420); await page.waitForTimeout(60); await page.touchscreen.tap(195, 420); await page.waitForTimeout(400);
  st = await page.evaluate(() => window.WosChat.viewer.state);
  assert.ok(st.scale < 1.05, 'double-tap returns to fit: scale ' + st.scale);
  // Next photo, then Back closes the viewer (the shell's Back closes it before the app).
  await page.locator('.mviewer [data-mv="next"]').click();
  assert.equal((await page.evaluate(() => window.WosChat.viewer.state)).i, 2);
  assert.equal(await page.evaluate(() => window.WosChat.viewer.close()), true);
  assert.equal((await page.evaluate(() => window.WosChat.viewer.state)).open, false);
  // An app cannot make the shell open another origin's URL.
  const foreign = await page.frames().find(f => f.parentFrame()).evaluate(() => WizardApp.media.view([{url: 'https://example.org/x.png'}]));
  assert.equal(foreign, false, 'off-origin media is refused');
  assert.deepEqual(errors, []);
  console.log('pass photo_viewer_browser'); await b.close();
})().catch(e => { console.error('FAIL', e.stack || e); process.exit(1); });
