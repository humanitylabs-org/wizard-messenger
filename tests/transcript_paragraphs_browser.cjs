// Issue 248 (switch transcript-paragraphs): a transcript saved with paragraph breaks shows as separate paragraphs in the
// voice-note bubble, both for one already saved and right after Transcribe. Old one-block transcripts are unchanged.
// Synthetic API only, no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/transcript_paragraphs_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'transcript-paragraphs-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const RAW = 'hey its me so about saturday i can come at five then on sunday we could go hiking what do you think let me know';
const FORMATTED = "Hey, it's me. So about Saturday, I can come at five.\n\nThen on Sunday we could go hiking. What do you think?\n\nLet me know.";
const SAVED = 'Saved earlier.\n\nSecond paragraph of an old note.';
const OLD = 'an old transcript in one block with no breaks at all stays as it was';
const PERSON = {id: 'amy', display_name: 'Amy', avatar: null, identities: [{id: 'amy-i', network: 'line', kind: 'person', label: 'Amy'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Voice message', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0};
const voice = (id, n, transcript) => ({id, identity_id: 'amy-i', network: 'line', sender: 'Amy', outgoing: false, original: '', msgtype: 'm.audio', media: {voice: true, duration: 90000, mime: 'audio/ogg'}, transcript, timestamp: now - (5 - n) * min, timeline_order: n, reactions: []});
const MESSAGES = [voice('$old', 1, OLD), voice('$saved', 2, SAVED), voice('$new', 3, null)];

async function run(browser, label, viewport, mobile, scheme) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: scheme});
  await ctx.addInitScript(raw => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop},
      voice: {transcribe: async () => ({text: raw})}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, RAW);
  const page = await ctx.newPage(), errors = [], posted = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
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
    if (p === 'api/unified/people') return ok({people: [PERSON], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/amy') return ok({person: PERSON, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p.startsWith('api/unified/media/')) return route.fulfill({status: 200, contentType: 'audio/ogg', body: Buffer.alloc(64)});
    if (p === 'api/unified/messages/%24new/transcript') { posted.push(JSON.parse(req.postData()).text); return ok({id: '$new', text: FORMATTED}); }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Amy'}).first().click({timeout: 20000});
  const row = id => page.locator('.u-row[data-id="' + id + '"], [data-id="' + id + '"]').first();
  await row('$saved').locator('.u-transcript:not([hidden])').waitFor({timeout: 10000});
  await row('$new').locator('.u-transcribe').click();
  await row('$new').locator('.u-transcript:not([hidden])').waitFor({timeout: 10000});
  await page.waitForTimeout(300);
  const lines = id => row(id).locator('.u-transcript').evaluate(el => {
    // Count the rendered paragraphs: the top of each text line box, via a range over every character.
    const tops = new Set(), r = document.createRange(), t = el.firstChild;
    for (let i = 0; t && i < t.length; i++) { r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect(); if (b.height && t.data[i].trim()) tops.add(Math.round(b.top)); }
    return {text: el.textContent, ws: getComputedStyle(el).whiteSpace, lines: tops.size, height: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 20};
  });
  const res = {label, saved: await lines('$saved'), fresh: await lines('$new'), old: await lines('$old')};
  await row('$new').scrollIntoViewIfNeeded();
  await page.screenshot({path: path.join(out, `after-${label}.png`)});
  assert.deepEqual(posted, [RAW], label + ': the raw transcript is what the view sends');
  assert.equal(res.fresh.text, FORMATTED, label + ': the box answer is shown');
  assert.equal(res.fresh.ws, 'pre-wrap', label);
  // Three paragraphs with blank lines in between: at least 5 line rows (3 text + 2 blank).
  assert.ok(res.fresh.height >= 5 * res.fresh.lh - 2, label + ': paragraphs render on their own lines ' + JSON.stringify(res.fresh));
  assert.ok(res.saved.height >= 3 * res.saved.lh - 2, label + ': a saved transcript with breaks shows them ' + JSON.stringify(res.saved));
  assert.equal(res.old.text, OLD, label + ': old one-block transcripts stay as they are');
  assert.equal(await row('$new').locator('.u-transcribe').count(), 0, label + ': the button is gone after saving');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return res;
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [await run(browser, 'desktop-dark', {width: 1280, height: 860}, false, 'dark'), await run(browser, 'phone-light', {width: 390, height: 844}, true, 'light'),
      await run(browser, 'phone-dark', {width: 390, height: 844}, true, 'dark')];
    console.log(JSON.stringify({ok: true, results}, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
