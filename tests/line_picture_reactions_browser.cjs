// Issue 184: LINE's own reactions are pictures, so their Matrix key is an internal mxc:// address. Under a LINE
// photo the box now sends the emoji (👍) and the view never prints an mxc:// address, even for a row an older box
// sent. Synthetic API only, no container: PLAYWRIGHT_MODULE=... node tests/line_picture_reactions_browser.cjs [outdir]
// BEFORE=1 STATIC_DIR=<main checkout>/static renders what the old box sent with the old view (evidence only).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'line-reaction-shots');
const before = process.env.BEFORE === '1';
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const svg = (fill, w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
const group = {id: 'eng', display_name: 'Engineers Anonymous', identities: [{id: 'eng-i', network: 'line', kind: 'group', label: 'Engineers Anonymous'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: '[Photo]', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0, kind: 'group'};
const photo = (id, i, sender, reactions) => ({id, identity_id: 'eng-i', network: 'line', sender, outgoing: false, original: '', timestamp: now - (9 - i) * min, timeline_order: i + 1, msgtype: 'm.image', media: {w: 800, h: 600, mime: 'image/jpeg', thumb: true}, reactions});
const r = (key, count) => ({key, count, mine: false, reactors: [], identities_complete: false});
// What the box sent before the fix (keys cut to 32 characters), and what it sends now.
const OLD = [photo('$bls', 0, 'Nok', [r('mxc://messenger.internal/SJnEsQh', 2), r('mxc://messenger.internal/CqjbgUW', 1), r('mxc://messenger.internal/Pq3RtZa', 1)]),
             photo('$ai', 1, 'Mike', [r('mxc://messenger.internal/SJnEsQh', 1), r('mxc://messenger.internal/CqjbgUW', 2)])];
const NEW = [photo('$bls', 0, 'Nok', [r('\u{1F44D}', 2), r('\u2764\uFE0F', 1), r('\u{1F606}', 1)]),
             photo('$ai', 1, 'Mike', [r('\u{1F44D}', 1), r('\u2764\uFE0F', 2)]),
             // A row an older box still sends with a picture key: the view never prints it.
             photo('$old', 2, 'Mike', [r('mxc://messenger.internal/CqjbgUW', 1)])];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const messages = before ? OLD : NEW;
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [group], seq: 5});
    if (p === 'api/unified/people/eng') return ok({person: group, messages, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) return route.fulfill({status: 200, contentType: 'image/svg+xml', body: svg('#3a6', 800, 600)});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Engineers Anonymous'}).first().click({timeout: 20000});
  await page.locator('.u-row[data-id="$ai"] .u-react').first().waitFor({timeout: 15000});
  await page.waitForTimeout(800);
  const shot = path.join(out, before ? 'before.png' : 'after.png');
  await page.screenshot({path: shot});
  const text = await page.locator('.u-timeline').innerText();
  const chips = (await page.locator('.u-react').allTextContents()).map(s => s.trim());
  if (!before) {
    assert.ok(!text.includes('mxc://'), 'no mxc:// text in the chat');
    assert.ok(chips.some(c => c.startsWith('\u{1F44D} 2')), 'LINE Like shows as a thumbs up: ' + chips);
    assert.ok(chips.some(c => c.startsWith('\u2728')), 'an unmatched picture reaction shows a neutral emoji: ' + chips);
    assert.deepEqual(errors, []);
  }
  console.log(JSON.stringify({before, chips, shot}));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
