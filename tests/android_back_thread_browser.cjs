// Issue 341 (James, 20 Nov 2026): on the Android phone, Back from an open chat must close the chat and show Messenger's
// chat list, in both the Inbox (unified) chat and the private Wizard (native) chat; Back at the list is Messenger's root.
// Messenger's static files are framed in a minimal Wizard shell built from the real wizard-ux core files (SHELL_DIR):
// the shell's Back asks the app through WizAppServices.back(frame), exactly as the phone's Back (window.__wosNativeBack)
// does. 'handled' = Messenger took one step; 'atRoot' = the shell takes its own next step (Home).
// SHELL_DIR=<wizard-ux checkout> [BEFORE=1 STATIC_DIR=<main>/static] node tests/android_back_thread_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'android-back-shots');
const SHELL = process.env.SHELL_DIR; assert.ok(SHELL, 'SHELL_DIR (a wizard-ux checkout) is required');
const BEFORE = process.env.BEFORE === '1';
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; SM-S938B Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8103.50 Mobile Safari/537.36 WizardOS-Android/0.10.56';
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi from Telegram', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const MESSAGES = [{id: '$1', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: 'Hi from Telegram', timestamp: now - min, timeline_order: 1, reactions: []}];
const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32);
const identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Private Alice'}, {member_id: ownKey}]};
const PRIVATE = [{message_id: 'e'.repeat(64), group_id: dm.group_id, author: peerKey, direction: 'received', text: 'Hi from the Wizard chat', created_at: (now - 3 * min) / 1000}];

async function open(browser) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: ANDROID});
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === '__shell/') return route.fulfill({status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#111}iframe{border:0;position:fixed;inset:0;width:100%;height:100%}</style></head>
<body><iframe id="frame" src="/"></iframe>
<script>window.WizCore = {apps: () => ({APPS: [{id: 'messenger', name: 'Messenger', url: '/', kind: 'web'}]})};</script>
<script src="/wizard-os-home/core/app-services.js"></script>
<script>WizAppServices.attach(document.getElementById('frame'), {appId: 'messenger', path: '/', isVisible: () => true});
window.__back = () => WizAppServices.back(document.getElementById('frame'), () => {});</script></body></html>`});
    const core = /^wizard-os-home\/core\/([a-z-]+\.(js|css))$/.exec(p);
    if (core) { const f = path.join(SHELL, 'web/core', core[1]); return fs.existsSync(f) ? route.fulfill({status: 200, contentType: TYPES[path.extname(f)], body: fs.readFileSync(f)}) : route.fulfill({status: 404, body: ''}); }
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: [dm]});
    if (p.startsWith('api/dms/') && p.endsWith('/messages')) return ok({messages: PRIVATE, next_cursor: null});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/__shell/');
  const app = page.frameLocator('#frame'), frame = page.frame({url: /messenger\.test\/$/}) || page.frames()[1];
  const row = who => app.locator('.u-person', {hasText: who}).first();
  await row('Private Alice').waitFor({timeout: 20000});
  await row('Ann Lee').waitFor({timeout: 20000});
  await page.waitForTimeout(600);
  // What is on screen: the Inbox list, the Inbox chat (unified thread) or the private Wizard chat (native thread).
  const seen = () => frame.evaluate(() => {
    const shown = el => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
    return {list: shown(document.querySelector('#unified-inbox .u-person')), unified: shown(document.querySelector('#unified-inbox .u-composer textarea')), native: shown(document.querySelector('#chat #draft'))};
  });
  const back = async () => { const r = await page.evaluate(() => window.__back()); await page.waitForTimeout(500); return r; };
  return {ctx, page, app, frame, row, seen, back, errors};
}

(async () => {
  const browser = await chromium.launch(), results = {};
  const shot = (page, name) => page.screenshot({path: path.join(out, `${BEFORE ? 'before' : 'after'}-${name}.png`)});
  try {
    // 1. An Inbox chat (Telegram etc.): Back closes it and shows the list; Back at the list is the root.
    {
      const t = await open(browser);
      await t.row('Ann Lee').tap(); await t.app.locator('.u-composer textarea').first().waitFor();
      await t.page.waitForTimeout(400);
      const r = {open: await t.seen(), back1: await t.back(), after1: await t.seen(), back2: await t.back(), after2: await t.seen(), errors: t.errors};
      results.unified = r;
      if (!BEFORE) {
        assert.deepEqual(r.open, {list: false, unified: true, native: false}, 'the Inbox chat is open');
        assert.equal(r.back1, 'handled', 'Back from the Inbox chat is Messenger\'s step');
        assert.deepEqual(r.after1, {list: true, unified: false, native: false}, 'and shows the chat list');
        assert.equal(r.back2, 'atRoot', 'Back at the chat list is Messenger\'s root');
        assert.deepEqual(t.errors, [], 'no page errors');
      }
      await t.ctx.close();
    }
    // 2. A private Wizard chat (native thread): Back closes it and shows the list.
    {
      const t = await open(browser);
      await t.row('Private Alice').tap(); await t.app.locator('#chat:not([hidden]) #draft').waitFor();
      await t.page.waitForTimeout(400);
      const r = {open: await t.seen(), back1: await t.back(), after1: await t.seen(), back2: await t.back(), after2: await t.seen(), errors: t.errors};
      results.native = r;
      if (!BEFORE) {
        assert.deepEqual(r.open, {list: false, unified: false, native: true}, 'the Wizard chat is open');
        assert.equal(r.back1, 'handled', 'Back from the Wizard chat is Messenger\'s step');
        assert.deepEqual(r.after1, {list: true, unified: false, native: false}, 'and shows the chat list');
        assert.equal(r.back2, 'atRoot', 'Back at the chat list is Messenger\'s root');
        assert.deepEqual(t.errors, [], 'no page errors');
      }
      await t.ctx.close();
    }
    // 3. A Wizard chat is open and an Inbox chat opens on top of it (a share to Ann): the Inbox chat is what shows,
    //    and one Back goes from it to the list (it used to stay hidden behind the Wizard chat).
    {
      const t = await open(browser);
      await t.row('Private Alice').tap(); await t.app.locator('#chat:not([hidden]) #draft').waitFor();
      await t.page.waitForTimeout(400);
      await t.frame.evaluate(() => window.MessengerUnified.receiveShare({kind: 'text', text: 'Shared words', target: 'ann'}));
      await t.page.waitForTimeout(1200);
      await shot(t.page, 'share-over-wizard-chat');
      const r = {open: await t.seen(), back1: await t.back(), after1: await t.seen(), back2: await t.back(), after2: await t.seen(), errors: t.errors};
      results.shareOverNative = r;
      if (!BEFORE) {
        assert.deepEqual(r.open, {list: false, unified: true, native: false}, 'the Inbox chat shows, not the Wizard chat');
        assert.equal(r.back1, 'handled');
        assert.deepEqual(r.after1, {list: true, unified: false, native: false}, 'one Back shows the chat list');
        assert.equal(r.back2, 'atRoot');
      }
      await t.ctx.close();
    }
    // 4. The Wizard chats view with no chat or sheet of its own (Messenger's list is hidden): Back shows the list again
    //    instead of handing Back to the shell (which went Home).
    {
      const t = await open(browser);
      await t.frame.evaluate(() => window.MessengerUnified.showNative());
      await t.page.waitForTimeout(300);
      const r = {listHidden: !(await t.seen()).list, back1: await t.back(), after1: await t.seen(), back2: await t.back(), errors: t.errors};
      results.nativeEmpty = r;
      if (!BEFORE) {
        assert.equal(r.listHidden, true, 'the Wizard chats view hides the list');
        assert.equal(r.back1, 'handled', 'Back is Messenger\'s step');
        assert.equal(r.after1.list, true, 'and shows the chat list');
        assert.equal(r.back2, 'atRoot');
      }
      await t.ctx.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(out, `${BEFORE ? 'before' : 'after'}-summary.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
