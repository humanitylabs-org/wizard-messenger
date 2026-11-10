// Issue 157: tapping a PDF shows at once that it is downloading, with its size and progress, and extra taps never
// start a second download. Synthetic API; the media route answers only after a delay, like the box, which fetches the
// whole file from its homeserver first. Also the Android app path (real URL to the download manager).
// PLAYWRIGHT_MODULE=~/work/pw/node_modules/playwright node tests/file_download_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '../static'), out = path.resolve(process.argv[2] || 'file-download-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3, PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1048576 - 9, 120)]);
const person = {id: 'ana', display_name: 'Ana Souza', identities: [{id: 'ana-i', network: 'whatsapp', kind: 'person', label: 'Ana'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'report.pdf', timestamp: now - min, outgoing: false}};
const messages = [
  {id: 'ana-m1', sender: 'Ana Souza', outgoing: false, original: 'Here is the report', translated: '', timestamp: now - 3 * min, identity_id: 'ana-i', network: 'whatsapp', reactions: [], msgtype: 'm.text'},
  {id: 'ana-pdf', sender: 'Ana Souza', outgoing: false, original: 'report.pdf', translated: '', timestamp: now - min, identity_id: 'ana-i', network: 'whatsapp', reactions: [], msgtype: 'm.file', media: {filename: 'report.pdf', size: PDF.length, mime: 'application/pdf'}},
];
async function run(browser, {android}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, acceptDownloads: true,
    ...(android ? {userAgent: 'Mozilla/5.0 (Linux; Android 14) WizardOS-Android/0.9.2'} : {})});
  await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
  const page = await ctx.newPage(), errors = [], media = [], downloads = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('download', d => downloads.push(d));
  const ownKey = '11'.repeat(32), own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity: own});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ana') return ok({person, messages, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) {
      media.push(p); await new Promise(r => setTimeout(r, 1500)); // the box is still fetching it from the homeserver
      return route.fulfill({status: 200, headers: {'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="report.pdf"', 'Content-Length': String(PDF.length)}, body: PDF});
    }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  const tag = android ? 'android' : 'browser', shot = name => page.screenshot({path: path.join(out, `${name}-${tag}.png`)});
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ana Souza'}).click();
  const file = page.locator('.u-file', {hasText: 'report.pdf'}); await file.waitFor({timeout: 15000});
  assert.equal(await file.locator('.u-file-size').innerText(), '2.0 MB', 'size before the tap');
  await shot('1-before');
  await file.click();
  await page.waitForTimeout(80);
  assert.equal(await file.getAttribute('aria-busy'), 'true', 'loading the moment it is tapped');
  assert.match(await file.locator('.u-file-size').innerText(), /^Downloading… · 2\.0 MB$/);
  assert.ok(await file.locator('.u-file-bar').isVisible(), 'progress bar shows');
  await shot('2-downloading');
  // Real taps at the attachment's spot (Playwright's click() would wait for aria-disabled to clear).
  const box = await file.boundingBox();
  for (let i = 0; i < 4; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(60); }
  assert.equal(media.length, 1, 'repeat taps start no second download');
  assert.equal(downloads.length, 0, "nothing saved yet: " + downloads.map(d => d.url()).join(" ") + " media " + media.length + " busy " + await file.getAttribute("aria-busy"));
  const done = android ? /^Saving to Downloads$/ : /^Downloaded$/;
  await page.waitForFunction(re => new RegExp(re).test(document.querySelector('.u-file .u-file-size')?.textContent || ''), done.source, {timeout: 10000});
  await shot('3-done');
  assert.equal(downloads.length, 1, 'saved exactly once');
  assert.equal(downloads[0].suggestedFilename(), 'report.pdf');
  if (android) assert.match(downloads[0].url(), /\/api\/unified\/media\/ana-pdf$/, 'Android gets the real URL for its download manager');
  else assert.match(downloads[0].url(), /^blob:/, 'browser saves the bytes it already has');
  // Browser: one fetch only. Android: the in-app fetch, then the download manager fetches the now-cached file
  // itself (Chromium's download request bypasses page.route, so it may not be counted here).
  assert.ok(android ? media.length <= 2 : media.length === 1, 'five taps, one download: ' + JSON.stringify(media));
  assert.deepEqual(errors, [], 'no page errors');
  await ctx.close();
  return `${tag}: ok (${media.length} media request(s), ${downloads.length} download)`;
}
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const android of [false, true]) summary.push(await run(browser, {android}));
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
