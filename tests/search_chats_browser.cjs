// Search finds chats by name, not only message text (Miguel, 19 Nov 2026: "If I put James and I search, it's not going
// to search for the contact James"). One field: a Chats section (names, accent/case-insensitive, any folder incl. Low)
// painted at once from the loaded list, then Messages from the server. A chat result opens like the Inbox row; Back
// returns to the results; Enter opens the first result; more than 5 chats fold behind "Show all".
// node tests/search_chats_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'search-chats-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, kind, label) => [{id: id + '-i', network: net, kind, label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, 'person', name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, ...extra});
const SKINS = {
  dark: {canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
  plain: null, // unhosted Messenger, own colours
};
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const scheme of Object.keys(SKINS)) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const PEOPLE = [
      person('james', 'James Carter', 'whatsapp', 'On my way', 2, {unread: 1}),
      person('jaime', 'Jámes Ortega', 'telegram', 'Gracias', 30, {medium_priority: true}),
      person('kenji', 'Kenji Tanaka', 'line', 'Ask James about it', 40),
      person('oldjim', 'Jim', 'telegram', 'ok', 900, {low_priority: true, identities: ident('oldjim', 'telegram', 'person', 'James Old Account')}),
      ...['A', 'B', 'C', 'D', 'E', 'F'].map((k, i) => person('anna' + k, 'Anna ' + k, 'whatsapp', 'hi', 100 + i)),
    ];
    const GROUPS = [{...person('jgroup', "James's Birthday", 'whatsapp', 'Cake!', 12), identities: ident('jgroup', 'whatsapp', 'group', "James's Birthday")}];
    const searches = [], writes = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme === 'light' ? 'light' : 'dark'});
    await ctx.addInitScript(([s, tokens]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      if (!tokens) return;
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v);
        r.style.background = tokens.glass; return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    let release = null; const gate = new Promise(r => { release = r; }); // hold the server's message search
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (req.method() !== 'GET' && p !== 'api/view/session') writes.push(p);
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      if (p === 'api/unified/search') {
        const q = url.searchParams.get('q'); searches.push(q); await gate;
        if (q !== 'james') return ok({messages: [], next_cursor: null});
        return ok({messages: [{message_id: 'm1', person_id: 'kenji', display_name: 'Kenji Tanaka', network: 'line', original: 'Ask James about it', timestamp: now - 40 * min}], next_cursor: null});
      }
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        return ok({person: pr, messages: [{id: 'm1', original: pr.last.text, timestamp: pr.last.timestamp, outgoing: false, network: pr.identities[0].network}], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const chatNames = () => page.locator('.u-list .u-chat-result strong').allTextContents();
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.locator('#unified-inbox .u-header button[aria-label="Search"]').click();
    const field = page.locator('input.u-search');
    assert.equal(await field.getAttribute('placeholder'), 'Search chats and messages');
    assert.match(await page.locator('.u-list').innerText(), /Type a name or any words from a message/);
    await field.fill('james');
    // Chats paint at once, before the server's message search answers.
    await page.locator('.u-search-head', {hasText: 'Chats'}).waitFor({timeout: 2000});
    const names = await chatNames();
    assert.deepEqual([...names].sort(), ['James Carter', "James's Birthday", 'Jim', 'Jámes Ortega'].sort(), 'accent-insensitive names, merged account label, Low/Medium chats and groups: ' + names);
    assert.ok(!names.includes('Kenji Tanaka'), 'a chat whose message mentions James is not a name match');
    assert.match(await page.locator('.u-list').innerText(), /Searching stored messages/);
    assert.equal(await page.locator('.u-chat-result', {hasText: 'Jim'}).locator('.u-state').textContent(), 'Low');
    release();
    await page.locator('.u-list .u-person:not(.u-chat-result)', {hasText: 'Ask James about it'}).waitFor();
    const heads = await page.locator('.u-list .u-search-head').allTextContents();
    assert.deepEqual(heads, ['Chats', 'Messages'], 'Chats section above Messages');
    assert.deepEqual(searches, ['james'], 'one server search (debounced)');
    await page.mouse.move(5, viewport.height - 5); await page.waitForTimeout(250);
    await shot('search-james');
    // Tap a chat result: opens like the Inbox row; Back returns to the same results.
    await page.locator('.u-chat-result', {hasText: 'James Carter'}).click();
    if (viewport.width >= 900) {
      await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'James Carter'}).waitFor();
      assert.equal(await field.inputValue(), 'james', 'desktop split: the results stay beside the chat');
      assert.equal(await page.locator('.u-chat-result.selected strong').textContent(), 'James Carter');
      await shot('search-open');
      await page.keyboard.press('Escape'); await page.locator('#unified-inbox[data-detail=none]').waitFor();
    } else {
      const backBtn = page.getByRole('button', {name: 'Back', exact: true}); await backBtn.waitFor(); await backBtn.click();
    }
    await page.locator('.u-search-head', {hasText: 'Chats'}).waitFor();
    assert.equal(await page.locator('input.u-search').inputValue(), 'james', 'Back returns to the search');
    // Show all: more than five name matches fold.
    await page.locator('input.u-search').fill('ANNA');
    assert.equal(await page.locator('.u-chat-result').count(), 5);
    await page.locator('.u-search-all', {hasText: 'Show all 6 chats'}).click();
    assert.equal(await page.locator('.u-chat-result').count(), 6);
    // No match at all.
    await page.locator('input.u-search').fill('zzzq');
    await page.locator('.u-empty', {hasText: 'No chats or messages match'}).waitFor();
    assert.equal(await page.locator('.u-search-head').count(), 0);
    // Enter opens the first result.
    await page.locator('input.u-search').fill('kenji');
    await page.locator('.u-chat-result', {hasText: 'Kenji Tanaka'}).waitFor();
    await page.locator('input.u-search').press('Enter');
    await page.locator('.u-who-text strong', {hasText: 'Kenji Tanaka'}).waitFor();
    assert.deepEqual(writes.filter(w => !w.endsWith('/read')), [], 'search never writes');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${label}/${scheme}`);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS search_chats_browser: ' + summary.join(', ') + ' · name search finds chats (accents, merged labels, Low/Medium, groups) before Messages; open/Back; Show all; Enter');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
