// Drafts at top (issue 133, Miguel 7 Nov 2026): chats with a waiting draft (yours or your Wizard's) lead the Inbox,
// newest draft first, with the existing "Draft:" line. Approved in issue 150, so it is always on: no Settings row, no
// box switch, and the old per-device key is dropped.
// Synthetic API only; phone + desktop x two skins. node tests/drafts_first_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
// STATIC_ROOT points at another build's static dir (the 15.15.1 export) to dump the same rows for the layout comparison.
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'drafts-first-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, ...extra});
// Skin tokens as the Wizard shell posts them: the canvas is transparent when hosted (APPEARANCE.md).
const SKINS = {
  dark: {canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
};
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const scheme of ['dark', 'light']) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [
      person('james', 'James Carter', 'whatsapp', 'On my way, 10 minutes', 2, {last: {text: 'On my way, 10 minutes', timestamp: now - 2 * min, outgoing: true, sender: 'Owner'}, peer_read_ts: now}),
      person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow at the station, bring the documents', 40, {unread: 1}),
      person('marco', 'Marco Bianchi', 'telegram', 'Invoice sent', 300, {unread: 3, muted: true, identities: [{id: 'marco-t', network: 'telegram', kind: 'person', label: 'Marco'}, {id: 'marco-s', network: 'signal', kind: 'person', label: 'Marco'}]}),
    ];
    const GROUPS = [
      {...person('fam', 'Family', 'whatsapp', 'Dinner Sunday?', 12, {unread: 2}), identities: ident('fam', 'whatsapp', 'group', 'Family'), last: {text: 'Dinner Sunday?', timestamp: now - 12 * min, sender: 'Ana Souza', outgoing: false}},
      {...person('dev', 'Wizard devs', 'telegram', 'Shipped', 20), identities: ident('dev', 'telegram', 'group', 'Wizard devs'), last: {text: 'Shipped', timestamp: now - 20 * min, sender: 'Luca Rossi', outgoing: false}},
    ];
    const catalog = ['WizardOS'];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.addInitScript(([s, tokens]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v);
        r.style.background = tokens.glass;
        return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const box = {posts: []};
    const listing = () => ({contract: 'wizard.app-switches/1', switches: []});
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const bad = (status, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'invalid_input', message}})});
      if (p === 'api/view/switches') {
        if (req.method() === 'POST') {
          const h = req.headers(); box.posts.push(body());
          if (h['x-wizard-switch'] !== '1' || h['content-type'] !== 'application/json') return route.fulfill({status: 403, contentType: 'application/json', body: '{"error":"header"}'});
        }
        return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(listing())});
      }
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/drafts') return ok({drafts: [{id: 'd1', person_id: 'marco', identity_id: 'marco-t', state: 'draft', revision: 1, text: 'Here is the PDF\nsecond line', attachments: [], updated: now - 60e3, author: 'agent'}]});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (req.method() === 'POST') { Object.assign(pr, body()); return ok(pr); }
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers: [
        {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'telegram', label: 'Telegram', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'signal', label: 'Signal', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'line', label: 'LINE', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}]});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const order = () => page.$$eval('#unified-inbox .u-person strong', els => els.map(e => e.firstChild?.textContent || e.textContent));
    const marco = () => page.locator('.u-person', {hasText: 'Marco Bianchi'});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await marco().locator('.u-snippet.draft').waitFor({timeout: 10000});
    // Always on (approved, issue 150): the old chat with a draft leads the Inbox, with its Draft line, and no box
    // switch or per-device setting is needed for it.
    await page.waitForTimeout(300);
    let names = await order(); assert.equal(names[0], 'Marco Bianchi', 'the chat with a draft leads ' + JSON.stringify(names));
    assert.match(await marco().locator('.u-snippet').innerText(), /^Draft: Here is the PDF$/, 'the draft line shows its first line');
    await shot('inbox');
    await page.locator('[aria-label="Settings"]').first().click();
    await page.locator('.u-sheet .u-more-view').waitFor();
    assert.equal(await page.locator('.u-sheet .u-more-drafts-first').count(), 0, 'no Drafts at top row in Settings');
    await page.waitForTimeout(150); await shot('settings');
    await page.mouse.click(viewport.width - 4, 4); await page.waitForTimeout(550);
    // A device that had the old per-device key drops it, and the order does not depend on it.
    await page.evaluate(() => localStorage.setItem('messenger.draftsFirst', '0'));
    await page.reload(); await page.locator('.u-person', {hasText: 'James Carter'}).waitFor(); await marco().locator('.u-snippet.draft').waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => localStorage.getItem('messenger.draftsFirst')), null, 'old key dropped');
    names = await order(); assert.equal(names[0], 'Marco Bianchi', 'still drafts first after reload ' + JSON.stringify(names));
    assert.deepEqual(box.posts, [], 'nothing written to the box');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${scheme}-${label}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
