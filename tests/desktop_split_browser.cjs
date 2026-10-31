// Desktop split (Miguel, 31 Oct 2026): "see the message list and the messages at the same time, like the session list
// and the chats in the chat interface". A wide Messenger window shows the chat list on the left and the open chat on the
// right; narrow windows keep the one-pane Inbox. Synthetic APIs only (no server, no accounts, nothing is sent).
// node tests/desktop_split_browser.cjs [outdir]   (PLAYWRIGHT_MODULE=<playwright>; WIZARD_WEB_DIR=<wizard-ux>/web reads
// the real Landscapes Light skin tokens from the shell CSS, else a fixed copy is used).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static');
const out = path.resolve(process.argv[2] || process.env.EVIDENCE_DIR || 'desktop-split-shots'); fs.mkdirSync(out, {recursive: true});
const WEB = process.env.WIZARD_WEB_DIR || '';
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};
const now = Date.now(), min = 60e3;
const NETS = ['whatsapp', 'telegram', 'signal', 'instagram', 'line'];
// Skin tokens as the Wizard shell posts them (appearance-host.js): the canvas is transparent when hosted.
const SKINS = {
  dark: {scheme: 'dark', canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'},
  light: {scheme: 'light', canvas: 'transparent', base: '#f5f2ec', surface: 'color-mix(in srgb, #211c17 5%, transparent)', 'surface-raised': 'color-mix(in srgb, #211c17 9%, transparent)', text: '#211c17', 'text-secondary': '#62584c', 'text-muted': '#756958', border: '#d4c7b8', accent: '#674a29', 'accent-soft': '#e9ddcb', 'on-accent': '#ffffff', glass: '#ece6dc'},
};
// Landscapes Light: the shell's own palette for that skin (core/skins.js, painted from JS at runtime), turned into app
// tokens the way the shell's appearance-host.js does. Falls back to a fixed copy of the same values.
async function landscapesLight() {
  let t = {bg: '#EEF1F4', ink: '#111216', 'ink-2': 'rgba(17,18,22,.76)', 'ink-3': 'rgba(17,18,22,.54)', 'line-2': 'rgba(0,0,0,.26)', 'violet-2': '#4A30CC', 'sk-win': 'rgba(250,250,252,.85)'}, source = 'fixed copy of core/skins.js';
  try {
    const src = fs.readFileSync(path.join(WEB, 'core/skins.js'), 'utf8'), m = /id: 'landscapes-light'[\s\S]*?t: T\((\{[\s\S]*?\})\) \}/.exec(src);
    if (WEB && m) { t = new Function('return ' + m[1])(); source = 'core/skins.js'; }
  } catch { /* fixed copy */ }
  return {scheme: 'light', canvas: 'transparent', base: t.bg, surface: `color-mix(in srgb, ${t.ink} 6%, transparent)`, 'surface-raised': `color-mix(in srgb, ${t.ink} 10%, transparent)`,
    text: t.ink, 'text-secondary': t['ink-2'], 'text-muted': t['ink-3'], border: t['line-2'], accent: t['violet-2'], 'accent-soft': `color-mix(in srgb, ${t['violet-2']} 16%, transparent)`, 'on-accent': '#fffdf8',
    glass: 'linear-gradient(' + t['sk-win'] + ', ' + t['sk-win'] + '), linear-gradient(160deg, #9cc3e6, #f1e2c6 55%, #8fb08a)', source};
}
const NAMES = ['Ana Souza', 'Ben Okafor', 'Chloe Martin', 'Dev Patel', 'Elena Rossi', 'Farid Haddad', 'Grace Lee', 'Hiro Sato', 'Ines Duarte', 'Jonas Berg', 'Kira Novak', 'Liam Walsh', 'Maya Cohen', 'Nico Ferraro', 'Olga Petrova', 'Pablo Ruiz', 'Quinn Adler', 'Rosa Lima', 'Sam Turner', 'Tara Singh', 'Umar Khan', 'Vera Lind', 'Wes Carter', 'Xia Wang', 'Yusuf Demir', 'Zoe Hart', 'Arjun Rao', 'Bea Klein', 'Caio Prado', 'Dana Wolfe'];
function fixture() {
  const people = NAMES.map((name, i) => {
    const id = 'p' + i, net = NETS[i % NETS.length];
    return {id, display_name: name, identities: [{id: id + '-i', network: net, kind: 'person', label: name}], labels: [], unread: i % 7 === 3 ? 2 : 0, muted: false, low_priority: false,
      last: {text: 'Message number ' + i + ' from ' + name.split(' ')[0], timestamp: now - (i + 1) * 9 * min, outgoing: i % 4 === 0}, language: '', peer_read_ts: 0};
  });
  const threads = {};
  for (const p of people) threads[p.id] = Array.from({length: 8}, (_, k) => ({id: p.id + '-m' + k, sender: k % 2 ? '' : p.display_name, outgoing: !!(k % 2), original: (k % 2 ? 'My reply ' : 'Hi from ' + p.display_name.split(' ')[0] + ', line ') + k + (k === 3 ? ' with a somewhat longer sentence so the bubble wraps across a couple of lines on a desktop window.' : ''), translated: '', timestamp: now - (40 - k * 4) * min, identity_id: p.identities[0].id, network: p.identities[0].network, reactions: [], msgtype: 'm.text'}));
  return {people, threads};
}

(async () => {
  const browser = await chromium.launch(), results = [];
  SKINS['landscapes-light'] = await landscapesLight();
  console.log('landscapes-light tokens from', SKINS['landscapes-light'].source);
  // Full behaviour run once (dark), screenshots for every skin at 1280 and 1600.
  for (const skin of ['dark', 'light', 'landscapes-light']) {
    const full = skin === 'dark', tokens = SKINS[skin];
    const {people, threads} = fixture();
    const drafts = [], updates = [];
    let draftSeq = 0;
    const ctx = await browser.newContext({viewport: {width: 1280, height: 860}, deviceScaleFactor: 1, colorScheme: tokens.scheme});
    await ctx.addInitScript(([s, tk]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tk)) if (!['glass', 'scheme', 'source'].includes(k)) r.style.setProperty('--wz-' + k, v);
        r.style.background = tk.glass; return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [tokens.scheme, tokens]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Private Alice'}, {member_id: ownKey}]};
    const PRIVATE = [{message_id: 'e'.repeat(64), group_id: dm.group_id, author: peerKey, direction: 'received', text: 'Hi there from the Wizard chat', created_at: (now - 3 * min) / 1000}];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const body = () => JSON.parse(req.postData() || '{}');
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: [dm]});
      if (p.startsWith('api/dms/') && p.endsWith('/messages')) return ok({messages: PRIVATE, next_cursor: null});
      if (p === 'api/unified/people') return ok({people, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/directory') return ok({people: people.map(({id, display_name, identities}) => ({id, display_name, identities})), groups: []});
      if (p === 'api/unified/search') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const hits = []; for (const pr of people) for (const m of threads[pr.id]) if (m.original.toLowerCase().includes(q)) hits.push({person_id: pr.id, message_id: m.id, display_name: pr.display_name, network: m.network, original: m.original, timestamp: m.timestamp});
        return ok({messages: hits.slice(0, 5), next_cursor: null});
      }
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = people.find(x => x.id === id);
        if (req.method() === 'POST') { Object.assign(pr, body()); return ok(pr); }
        return ok({person: pr, messages: threads[id], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/drafts' && req.method() === 'GET') return ok({drafts});
      if (p === 'api/drafts' && req.method() === 'POST') { const b = body(); const d = {id: 'd' + (++draftSeq), person_id: b.person_id, identity_id: b.identity_id, text: b.text || '', revision: 1, state: 'draft', attachments: [], created_by: {id: 'owner', name: 'You'}, updated: Date.now()}; drafts.push(d); return ok({draft: d}); }
      const dr = /^api\/drafts\/([^/]+)$/.exec(p);
      if (dr) {
        const d = drafts.find(x => x.id === dr[1]); if (!d) return route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'not_found', message: 'gone'}})});
        if (req.method() === 'DELETE') { drafts.splice(drafts.indexOf(d), 1); return ok({}); }
        if (req.method() === 'POST') { const b = body(); Object.assign(d, {text: b.text, identity_id: b.identity_id, revision: d.revision + 1, updated: Date.now(), updated_by: {id: 'owner'}}); return ok({draft: d}); }
        return ok({draft: d});
      }
      if (p === 'api/unified/connectors') return ok({providers: NETS.map(n => ({network: n, label: n, supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}))});
      if (p.startsWith('api/unified/updates')) {
        for (let i = 0; i < 30 && !updates.length; i++) await new Promise(r => setTimeout(r, 100));
        return ok(updates.length ? updates.shift() : {seq: 5});
      }
      if (p.startsWith('api/') || p.startsWith('contacts/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto('https://messenger.test/');
    await page.locator('#u-pane-list .u-person', {hasText: 'Ana Souza'}).waitFor(); await page.waitForTimeout(400);
    const box = sel => page.locator(sel).first().boundingBox();
    assert.ok(await page.evaluate(() => document.documentElement.hasAttribute('data-split')), skin + ': split on at 1280');
    // List and detail (Miguel, 31 Oct 2026): nothing open = the list fills the window, no right pane, compact rows.
    { const lb = await box('#u-pane-list'); assert.ok(lb.width >= 1270, skin + ': list fills the window with nothing open (' + lb.width + ')'); }
    assert.equal(await page.locator('#u-pane-thread').isVisible(), false, skin + ': no detail pane with nothing open');
    assert.equal(await page.locator('#u-pane-list .u-person .u-snippet').count(), 0, skin + ': compact list has no previews');
    assert.ok((await box('#u-pane-list .u-person')).height <= 56, skin + ': compact rows');
    await page.screenshot({path: path.join(out, 'split-list-only-' + skin + '-1280.png')});
    await page.locator('#u-pane-list .u-person', {hasText: 'Ana Souza'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Ana Souza'}).waitFor(); await page.waitForTimeout(250);
    const listBox = await box('#u-pane-list'), threadBox = await box('#u-pane-thread');
    assert.ok(listBox.width >= 320 && listBox.width <= 380, skin + ': list pane ~340-380px (' + listBox.width + ')');
    assert.ok(threadBox.x >= listBox.x + listBox.width - 1 && threadBox.width > 800, skin + ': thread pane fills the right');
    await page.screenshot({path: path.join(out, 'split-detail-' + skin + '-1280.png')});
    await page.locator('#u-pane-thread').getByRole('button', {name: 'Close chat'}).click(); await page.locator('#unified-inbox[data-detail=none]').waitFor();
    const frame = await box('#unified-inbox'); assert.ok(frame.width >= 1279, skin + ': no max-width on the frame in split mode (' + frame.width + ')');
    if (full) {
      // ---- open two chats in turn: the right pane switches, the list keeps its node and scroll ----
      const list = page.locator('#u-pane-list .u-list');
      await list.evaluate(el => { el.__kept = true; el.scrollTop = 400; }); await page.waitForTimeout(150);
      const scrolled = await list.evaluate(el => el.scrollTop); assert.ok(scrolled > 300, 'list scrolls (' + scrolled + ')');
      const rowA = page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}), rowB = page.locator('#u-pane-list .u-person', {hasText: 'Maya Cohen'});
      await rowA.click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor(); await page.waitForTimeout(300);
      assert.equal(await list.evaluate(el => el.__kept === true), true, 'list was not rebuilt');
      assert.ok(Math.abs(await list.evaluate(el => el.scrollTop) - scrolled) < 2, 'list scroll kept after opening a chat');
      assert.equal(await rowA.getAttribute('aria-current'), 'true'); assert.ok((await rowA.getAttribute('class')).includes('selected'));
      assert.equal(await page.locator('#u-pane-thread .u-back').isVisible(), false, 'no Back in the split thread header');
      // ---- ✕ closes the chat: the full-width list comes back, same node and scroll ----
      await page.locator('#u-pane-thread').getByRole('button', {name: 'Close chat'}).click(); await page.locator('#unified-inbox[data-detail=none]').waitFor();
      assert.equal(await page.locator('#u-pane-thread').isVisible(), false, 'detail pane gone after ✕');
      assert.ok(Math.abs(await list.evaluate(el => el.scrollTop) - scrolled) < 2, 'list scroll kept after ✕');
      assert.equal(await page.locator('#u-pane-list .u-person[aria-current]').count(), 0, 'no row selected after ✕');
      assert.equal(await list.evaluate(el => el.__kept === true), true, 'list not rebuilt by ✕');
      // ---- New chat button opens New message with the search focused; picking someone opens that chat ----
      await rowA.click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
      await page.locator('#u-pane-list .u-fab').click(); await page.locator('#u-pane-thread .u-newmsg').waitFor();
      assert.equal(await page.locator('.u-sheet').count(), 0, 'no New chat sheet in the split');
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Search people and groups', 'search focused');
      await page.screenshot({path: path.join(out, 'split-new-message-1280.png')});
      // Escape closes New message back to the full list; the New chat button opens it again
      await page.keyboard.press('Escape'); await page.locator('#unified-inbox[data-detail=none]').waitFor();
      await page.locator('#u-pane-list .u-fab').click(); await page.locator('#u-pane-thread .u-newmsg').waitFor();
      await page.locator('#u-pane-thread .u-newmsg-close').click(); await page.locator('#unified-inbox[data-detail=none]').waitFor();
      await page.locator('#u-pane-list .u-fab').click(); await page.locator('#u-pane-thread .u-newmsg').waitFor(); await page.waitForTimeout(100);
      await page.keyboard.type('pablo'); await page.locator('#u-pane-thread .u-directory-row').first().waitFor();
      assert.equal(await page.locator('#u-pane-thread .u-directory-row').count(), 1, 'typing shows only matching people');
      await page.screenshot({path: path.join(out, 'split-new-message-typed-1280.png')});
      await page.locator('#u-pane-thread .u-directory-row', {hasText: 'Pablo Ruiz'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Pablo Ruiz'}).waitFor();
      assert.equal(await page.locator('#u-pane-list .u-person', {hasText: 'Pablo Ruiz'}).getAttribute('aria-current'), 'true', 'picked chat highlighted in the list');
      await rowA.click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
      assert.ok(await page.locator('#u-pane-thread .u-message', {hasText: 'Hi from Kira'}).count() > 0, 'timeline shows the chat');
      const field = page.locator('#u-pane-thread textarea[aria-label="Message"]');
      await field.fill('Draft for Kira'); await page.waitForTimeout(1500);
      assert.equal(drafts.find(d => d.person_id === 'p10')?.text, 'Draft for Kira', 'draft autosaved to the server');
      await rowB.click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Maya Cohen'}).waitFor(); await page.waitForTimeout(300);
      assert.equal(await list.evaluate(el => el.__kept === true), true, 'list still not rebuilt');
      assert.ok(Math.abs(await list.evaluate(el => el.scrollTop) - scrolled) < 2, 'list scroll kept after switching');
      assert.equal(await rowA.getAttribute('aria-current'), null); assert.equal(await rowB.getAttribute('aria-current'), 'true');
      // typing then switching at once still saves (the pending save is flushed, not dropped)
      await field.fill('Quick note for Maya'); await rowA.click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor(); await page.waitForTimeout(1200);
      assert.equal(drafts.find(d => d.person_id === 'p12')?.text, 'Quick note for Maya', 'switching chats flushes the pending draft save');
      assert.equal(await field.inputValue(), 'Draft for Kira', 'the first chat keeps its draft');
      // ---- live feed: unread on another row + a new message in the open chat, both panes update ----
      const zoe = people.find(x => x.display_name === 'Zoe Hart');
      updates.push({seq: 6, people: [{...zoe, unread: 4, last: {text: 'Are you there?', timestamp: Date.now(), outgoing: false}}], messages: {p10: [{id: 'p10-live', sender: 'Kira Novak', outgoing: false, original: 'Live message for Kira', translated: '', timestamp: Date.now(), identity_id: 'p10-i', network: 'line', reactions: [], msgtype: 'm.text'}]}, typing: {}});
      await page.locator('#u-pane-thread .u-message', {hasText: 'Live message for Kira'}).waitFor({timeout: 6000});
      const zoeRow = page.locator('#u-pane-list .u-person', {hasText: 'Zoe Hart'});
      await zoeRow.locator('.u-badge').waitFor({timeout: 3000}); assert.equal(await zoeRow.locator('.u-badge').textContent(), '4', 'unread count updates in the list');
      assert.equal(await page.locator('#u-pane-list .u-person.selected').count(), 1, 'one row selected after a live update');
      // ---- menus are placed inside Messenger's box ----
      const target = await rowB.boundingBox();
      await page.mouse.click(target.x + 60, target.y + 20, {button: 'right'}); await page.locator('.u-menu').waitFor();
      const m = await box('.u-menu .u-actions'); assert.ok(Math.abs(m.x - (target.x + 60)) < 30 && Math.abs(m.y - (target.y + 20)) < 60, 'row menu at the pointer');
      await page.keyboard.press('Escape'); await page.locator('.u-menu').waitFor({state: 'detached'});
      // ---- search in the left pane while a chat stays open on the right ----
      await page.locator('#u-pane-list').getByRole('button', {name: 'Search', exact: true}).click();
      await page.locator('#u-pane-list input.u-search').fill('line 2'); await page.locator('#u-pane-list .u-person', {hasText: 'Hi from'}).first().waitFor();
      assert.equal(await page.locator('#u-pane-thread .u-who-text strong').textContent(), 'Kira Novak', 'chat stays open while searching');
      await page.locator('#u-pane-list .u-person', {hasText: 'Ben Okafor'}).click();
      await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Ben Okafor'}).waitFor();
      assert.equal(await page.locator('#u-pane-list input.u-search').count(), 1, 'search results stay on the left');
      // ---- Escape: first clears the chat (empty state), then closes search ----
      await page.locator('#u-pane-thread .u-timeline').click({position: {x: 5, y: 5}});
      await page.keyboard.press('Escape'); await page.locator('#unified-inbox[data-detail=none]').waitFor();
      assert.equal(await page.locator('#u-pane-list input.u-search').count(), 1, 'Escape closed the chat, search still open');
      await page.keyboard.press('Escape'); await page.locator('#u-pane-list .u-chips').waitFor();
      assert.equal(await page.locator('#u-pane-list input.u-search').count(), 0, 'second Escape closes search');
      // ---- settings sheet centred over the window ----
      await page.locator('#u-pane-list .u-settings-btn').click(); const sheet = await box('.u-sheet');
      assert.ok(Math.abs(sheet.x + sheet.width / 2 - 640) < 40, 'settings sheet centred'); await page.keyboard.press('Escape'); await page.locator('.u-sheet').waitFor({state: 'detached'});
      // ---- native Wizard chat opens on the right, list stays ----
      const priv = page.locator('#u-pane-list .u-person', {hasText: 'Private Alice'});
      await priv.click(); await page.locator('#chat-name', {hasText: 'Private Alice'}).waitFor();
      const ws = await box('#workspace'), lp = await box('#u-pane-list');
      assert.ok(lp && lp.width > 300 && ws.x >= lp.x + lp.width - 1, 'native thread sits right of the list');
      assert.equal(await page.locator('#chat-back').isVisible(), false, 'no Back in the native thread in split');
      assert.equal(await priv.getAttribute('aria-current'), 'true', 'native row highlighted');
      await page.screenshot({path: path.join(out, 'split-native-1280.png')});
      await page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
      assert.equal(await page.locator('#workspace').isVisible(), false, 'native thread gives way to the unified chat');
      assert.equal(await page.evaluate(() => 'privateView' in document.documentElement.dataset), false);
      // ---- resize: narrow shows the same chat alone, wide brings the split back ----
      await page.setViewportSize({width: 600, height: 860}); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-split')), false, 'split off at 600');
      assert.equal(await page.locator('#u-pane-list').count(), 0, 'single pane at 600');
      assert.equal(await page.locator('#unified-inbox .u-who-text strong').textContent(), 'Kira Novak', 'same chat after narrowing');
      assert.equal(await page.locator('#unified-inbox .u-back').isVisible(), true, 'Back is back on narrow');
      assert.equal(await page.locator('#unified-inbox textarea[aria-label="Message"]').inputValue(), 'Draft for Kira', 'draft survives the resize');
      await page.screenshot({path: path.join(out, 'narrow-600-thread.png')});
      await page.locator('#unified-inbox .u-back').click(); await page.locator('#unified-inbox > .u-list').waitFor();
      { // narrow: the chat slides over the list and Back returns to the same scroll position
        const nl = page.locator('#unified-inbox > .u-list'); await nl.evaluate(el => { el.scrollTop = 400; }); await page.waitForTimeout(120);
        const at = await nl.evaluate(el => el.scrollTop); assert.ok(at > 300, 'narrow list scrolls (' + at + ')');
        await page.locator('#unified-inbox .u-person', {hasText: 'Maya Cohen'}).click(); await page.locator('#unified-inbox .u-who-text strong', {hasText: 'Maya Cohen'}).waitFor();
        await page.locator('#unified-inbox .u-back').click(); await page.locator('#unified-inbox > .u-list').waitFor(); await page.waitForTimeout(150);
        const after = await page.locator('#unified-inbox > .u-list').evaluate(el => el.scrollTop); assert.ok(Math.abs(after - at) < 2, 'narrow Back keeps the list scroll (' + at + ' -> ' + after + ')');
      }
      await page.locator('#unified-inbox .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#unified-inbox .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
      await page.setViewportSize({width: 1280, height: 860}); await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-split')), true, 'split back at 1280');
      assert.equal(await page.locator('#u-pane-thread .u-who-text strong').textContent(), 'Kira Novak', 'same chat after widening');
      assert.equal(await page.locator('#u-pane-list .u-person.selected').textContent().then(t => t.includes('Kira Novak')), true, 'its row highlighted');
      assert.equal(await page.locator('#u-pane-thread textarea[aria-label="Message"]').inputValue(), 'Draft for Kira');
      assert.equal(drafts.filter(d => d.person_id === 'p10').length, 1, 'no duplicate draft after resizing');
    } else {
      await page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
    }
    await page.waitForTimeout(250);
    await page.screenshot({path: path.join(out, 'split-' + skin + '-1280.png')});
    await page.setViewportSize({width: 1600, height: 960}); await page.waitForTimeout(400);
    const lw = (await box('#u-pane-list')).width; assert.ok(lw >= 340 && lw <= 380, skin + ': list width at 1600 (' + lw + ')');
    await page.screenshot({path: path.join(out, 'split-' + skin + '-1600.png')});
    await page.keyboard.press('Escape'); await page.locator('#unified-inbox[data-detail=none]').waitFor();
    assert.equal(await page.locator('#u-pane-list .u-person.selected, #u-pane-list .u-person[aria-current]').count(), 0, skin + ': no row selected on the empty state');
    await page.mouse.move(1500, 900); await page.waitForTimeout(150);
    await page.screenshot({path: path.join(out, 'split-' + skin + '-1600-empty.png')});
    assert.deepEqual(errors, [], skin + ': no page errors');
    results.push(skin); await ctx.close();
  }
  await browser.close();
  console.log('PASS desktop split: both panes at 1280/1600, list kept (node + scroll), selected row, autosaved drafts across switches,'
    + ' live unread + timeline, search on the left, list-only with nothing open, Escape/✕ close the detail, New chat opens New message beside the list, narrow Back keeps the scroll, compact rows, menus/sheets placed, native Wizard thread on the right,'
    + ' resize 1280 -> 600 -> 1280 keeps the chat; skins ' + results.join(', ') + '; shots in ' + out);
})().catch(e => { console.error(e); process.exitCode = 1; });
