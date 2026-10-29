// Inbox tweaks (Miguel, 30 Oct 2026): readable selected chips on hosted skins (transparent canvas), icon-only platform
// chips, no bottom tab bar, and a Low priority folder that keeps chats out of the Inbox, unread counts and the badge.
// node tests/inbox_tweaks_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'inbox-tweaks-shots');
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
      person('james', 'James Carter', 'whatsapp', 'On my way', 2, {unread: 1}),
      person('kenji', 'Kenji Tanaka', 'line', 'See you tomorrow', 40),
      person('marco', 'Marco Bianchi', 'telegram', 'Invoice sent', 300, {unread: 3}),
    ];
    const GROUPS = [
      {...person('promo', 'Deals Channel', 'telegram', 'Flash sale!', 5, {unread: 7, low_priority: true}), identities: ident('promo', 'telegram', 'group', 'Deals Channel')},
      {...person('fam', 'Family', 'whatsapp', 'Dinner Sunday?', 12, {unread: 2}), identities: ident('fam', 'whatsapp', 'group', 'Family')},
    ];
    const posted = [], badges = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: scheme});
    await ctx.exposeBinding('__badge', (_, n) => badges.push(n));
    await ctx.addInitScript(([s, tokens]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: n => window.__badge(n)}};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
        for (const [k, v] of Object.entries(tokens)) if (k !== 'glass') r.style.setProperty('--wz-' + k, v);
        r.style.background = tokens.glass; // the shell's window glass behind a transparent app canvas
        return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [scheme, SKINS[scheme]]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32);
    const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Private Alice'}, {member_id: ownKey}]};
    const PRIVATE = [{message_id: 'e'.repeat(64), group_id: dm.group_id, author: peerKey, direction: 'received', text: 'Hi there', created_at: (now - 30 * min) / 1000}];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: [dm]});
      if (p.startsWith('api/dms/') && p.endsWith('/messages')) return ok({messages: PRIVATE, next_cursor: null});
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: GROUPS, seq: 5});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) {
        const id = decodeURIComponent(thread[1]), pr = [...PEOPLE, ...GROUPS].find(x => x.id === id);
        if (req.method() === 'POST') { const body = JSON.parse(req.postData() || '{}'); posted.push([id, body]); Object.assign(pr, body); return ok(pr); }
        return ok({person: pr, messages: [], has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      if (p === 'api/unified/connectors') return ok({providers: [
        {network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'telegram', label: 'Telegram', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'line', label: 'LINE', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]},
        {network: 'instagram', label: 'Instagram DMs', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}]});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}-${scheme}.png`)});
    const rows = () => page.locator('.u-list > .u-person:not(.u-low-row) strong').allTextContents();
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'Private Alice'}).waitFor({timeout: 15000});
    await page.locator('#u-filters .u-chip.net').first().waitFor();

    // No bottom tab bar: one Inbox needs none.
    assert.equal(await page.locator('#inbox-tabs').isVisible(), false, 'bottom tab bar is gone');

    // Platform chips: icon only, name kept for screen readers and the tooltip.
    const nets = await page.locator('#u-filters .u-chip.net').evaluateAll(els => els.map(e => [e.getAttribute('aria-label'), e.title, e.querySelector('.u-chip-text')?.textContent || '', !!e.querySelector('svg.brand-icon path'), e.getBoundingClientRect().width]));
    assert.ok(nets.length >= 4, 'one chip per platform');
    for (const [name, title, text, glyph, w] of nets) { assert.equal(text, '', name + ' chip prints no word'); assert.ok(glyph, name + ' glyph'); assert.ok(title.startsWith(name), name + ' tooltip'); assert.ok(w <= 72, name + ' chip is compact: ' + w); }

    // Low priority: out of the Inbox, out of Unread and every count; a folder row on top of All.
    assert.ok(!(await rows()).includes('Deals Channel'), 'low priority chat is not in the Inbox');
    const folder = page.locator('.u-low-row');
    assert.equal(await folder.count(), 1, 'Low priority folder row');
    assert.match(await folder.textContent(), /Low priority/); assert.match(await folder.textContent(), /1 chat/);
    assert.equal(await page.locator('[data-filter=unread] .u-chip-count').textContent(), '4', 'Unread chip ignores Low priority (james, marco, fam, private)');
    assert.equal(await page.locator('[data-filter="net:telegram"] .u-chip-count').textContent(), '1', 'Telegram count ignores Low priority');
    await page.waitForTimeout(300);
    assert.equal(badges.at(-1), 4, 'app badge = unread chats (james, marco, fam, private), Low priority ignored');
    await page.locator('[data-filter=unread]').click(); await page.waitForTimeout(300); // chip colour transition; mouse stays hovering
    assert.equal(await page.locator('.u-low-row').count(), 0, 'folder row only on All');
    assert.ok(!(await rows()).includes('Deals Channel'), 'Unread never shows Low priority');

    // Selected chip stays readable on a transparent hosted canvas (the white-on-white report).
    const pressed = await page.evaluate(() => {
      const c = document.createElement('canvas').getContext('2d', {willReadFrequently: true});
      const rgb = css => { c.clearRect(0, 0, 1, 1); c.fillStyle = '#000'; c.fillStyle = css; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; };
      const el = document.querySelector('[data-filter=unread]'), cs = getComputedStyle(el), text = el.querySelector('.u-chip-text');
      return {bg: rgb(cs.backgroundColor), fg: rgb(getComputedStyle(text).color), pressed: el.getAttribute('aria-pressed'), raw: [cs.backgroundColor, cs.color, getComputedStyle(text).color, getComputedStyle(document.documentElement).getPropertyValue('--chip-on-ink'), getComputedStyle(document.documentElement).getPropertyValue('--on-accent')]};
    });
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + .05) / (y + .05); };
    assert.equal(pressed.pressed, 'true'); assert.equal(pressed.fg[3], 255, 'selected chip text is opaque, not the transparent canvas');
    assert.ok(contrast(pressed.bg, pressed.fg) >= 4.5, 'selected chip contrast ' + contrast(pressed.bg, pressed.fg).toFixed(2) + JSON.stringify(pressed));
    await shot('unread-selected');
    await page.locator('[data-filter=all]').click();

    // Move a chat to Low priority from its menu (right-click on desktop): it leaves the Inbox in place.
    await page.locator('.u-person', {hasText: 'Kenji Tanaka'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Move to Low priority'}).click();
    assert.deepEqual(posted.at(-1), ['kenji', {low_priority: true}], 'saved on the server');
    assert.ok(!(await rows()).includes('Kenji Tanaka'), 'row left the Inbox');
    assert.match(await page.locator('.u-low-row').textContent(), /2 chats/);
    // A private Wizard chat moves too (kept on this device like its mute).
    await page.locator('.u-person', {hasText: 'Private Alice'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Move to Low priority'}).click();
    assert.ok(!(await rows()).includes('Private Alice'));
    await page.waitForTimeout(300);
    assert.equal(badges.at(-1), 3, 'badge drops the private chat');
    await shot('inbox');

    // The folder: its own header, only quiet chats, gray badges, Back returns to the Inbox.
    await page.locator('.u-low-row').click();
    assert.deepEqual((await rows()).sort(), ['Deals Channel', 'Kenji Tanaka', 'Private Alice'].sort());
    assert.equal(await page.locator('#u-filters').isVisible(), false, 'no chips inside the folder');
    assert.equal(await page.locator('.u-person', {hasText: 'Deals Channel'}).locator('.u-badge.muted').count(), 1, 'quiet badge');
    await shot('low-folder');
    // Opening a chat from the folder and coming back lands in the folder again.
    await page.locator('.u-person', {hasText: 'Deals Channel'}).click();
    await page.getByRole('button', {name: 'Back', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Back', exact: true}).click();
    await page.locator('.u-low-head').waitFor();
    // Move back to the Inbox from inside the folder.
    await page.locator('.u-person', {hasText: 'Kenji Tanaka'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Move to Inbox'}).click();
    assert.deepEqual(posted.at(-1), ['kenji', {low_priority: false}]);
    assert.ok(!(await rows()).includes('Kenji Tanaka'), 'left the folder in place');
    await page.getByRole('button', {name: 'Back to Inbox'}).click();
    assert.ok((await rows()).includes('Kenji Tanaka'), 'back in the Inbox');
    assert.equal(await page.locator('.u-low-row').count(), 1);
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${label}/${scheme}`);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS inbox_tweaks_browser: ' + summary.join(', ') + ' · readable selected chip on hosted skins, icon-only platform chips, no tab bar, Low priority folder (bridged + private)');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
