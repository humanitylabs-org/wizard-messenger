// Miguel, 31 Oct 2026: (1) "drag and resize the divider between the session list and the chats" like Wizard's Chats;
// (2) "when I send a message it shouldn't be a draft anymore, it should just be sent".
// Synthetic APIs only (no server, no accounts, nothing is sent anywhere): the send route is held or refused here.
// node tests/split_divider_send_browser.cjs [outdir]   (PLAYWRIGHT_MODULE=<playwright>; SKIN=dark|landscapes for shots)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../static');
const out = path.resolve(process.argv[2] || process.env.EVIDENCE_DIR || 'divider-send-shots'); fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};
const now = Date.now(), min = 60e3;
const NETS = ['whatsapp', 'telegram', 'signal', 'instagram', 'line'];
const DARK = {scheme: 'dark', canvas: 'transparent', base: '#05030c', surface: 'color-mix(in srgb, #f3efff 6%, transparent)', 'surface-raised': 'color-mix(in srgb, #f3efff 10%, transparent)', text: '#f3efff', 'text-secondary': '#b9b0d8', 'text-muted': '#a59abf', border: 'rgba(205,190,255,.24)', accent: '#b99bff', 'accent-soft': 'color-mix(in srgb, #b99bff 16%, transparent)', 'on-accent': '#05030c', glass: '#1d1533'};
const NAMES = ['Ana Souza', 'Ben Okafor', 'Chloe Martin', 'Dev Patel', 'Elena Rossi', 'Farid Haddad', 'Grace Lee', 'Hiro Sato', 'Ines Duarte', 'Jonas Berg', 'Kira Novak', 'Liam Walsh'];

function fixture() {
  const people = NAMES.map((name, i) => ({id: 'p' + i, display_name: name, identities: [{id: 'p' + i + '-i', network: NETS[i % NETS.length], kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false,
    last: {text: 'Message ' + i + ' from ' + name.split(' ')[0], timestamp: now - (i + 1) * 9 * min, outgoing: false}, language: '', peer_read_ts: 0}));
  const threads = {}; for (const p of people) threads[p.id] = Array.from({length: 6}, (_, k) => ({id: p.id + '-m' + k, sender: k % 2 ? '' : p.display_name, outgoing: !!(k % 2), original: (k % 2 ? 'My reply ' : 'Hi from ' + p.display_name.split(' ')[0] + ' ') + k, translated: '', timestamp: now - (40 - k * 4) * min, identity_id: p.identities[0].id, network: p.identities[0].network, reactions: [], msgtype: 'm.text'}));
  return {people, threads};
}

async function stage(browser, {width, height, tokens = DARK}) {
  const {people, threads} = fixture(), st = {drafts: [], draftPosts: [], sendHold: 0, sendFail: null, sends: [], seq: 0};
  const ctx = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, colorScheme: tokens.scheme});
  await ctx.addInitScript(([s, tk]) => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = s; r.style.colorScheme = s;
      for (const [k, v] of Object.entries(tk)) if (!['glass', 'scheme', 'source'].includes(k)) r.style.setProperty('--wz-' + k, v); r.style.background = tk.glass; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  }, [tokens.scheme, tokens]);
  await ctx.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    const no = (status, code, message) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code, message}})});
    const body = () => JSON.parse(req.postData() || '{}');
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity: {account_id: '11'.repeat(32), display_name: 'Owner'}});
    if (['api/contacts', 'api/invites', 'api/dms'].includes(p)) return ok({contacts: [], invites: [], dms: []});
    if (p === 'api/unified/people') return ok({people, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/directory') return ok({people, groups: []});
    const send = /^api\/unified\/people\/([^/]+)\/send$/.exec(p);
    if (send) {
      const b = body(), id = decodeURIComponent(send[1]); st.sends.push(b);
      if (st.sendHold) await new Promise(r => setTimeout(r, st.sendHold));
      if (st.sendFail) return no(st.sendFail.status, st.sendFail.code, st.sendFail.message);
      const m = {id: '$sent' + st.sends.length, client_id: b.client_id, sender: '', outgoing: true, original: b.text, translated: '', timestamp: Date.now(), identity_id: id + '-i', network: 'whatsapp', reactions: [], msgtype: 'm.text'};
      threads[id].push(m); return ok({state: 'sent', event_id: m.id, message: m});
    }
    const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
    if (thread) { const id = decodeURIComponent(thread[1]); return ok({person: people.find(x => x.id === id), messages: threads[id], has_more: false, next_cursor: null, seq: 5, typing: []}); }
    if (p.endsWith('/read') || p.endsWith('/typing')) return ok({});
    if (p === 'api/drafts' && req.method() === 'GET') return ok({drafts: st.drafts});
    if (p === 'api/drafts' && req.method() === 'POST') {
      const b = body(); st.draftPosts.push(b.text);
      if (st.drafts.some(d => d.person_id === b.person_id)) return no(409, 'draft_exists', 'exists');
      const d = {id: 'd' + (++st.seq), person_id: b.person_id, identity_id: b.identity_id, text: b.text || '', revision: 1, state: 'draft', attachments: [], created_by: {id: 'owner', name: 'You'}, updated: Date.now()};
      st.drafts.push(d); return ok({draft: d});
    }
    const dr = /^api\/drafts\/([^/]+)$/.exec(p);
    if (dr) {
      const d = st.drafts.find(x => x.id === dr[1]); if (!d) return no(404, 'not_found', 'gone');
      if (req.method() === 'DELETE') { st.drafts.splice(st.drafts.indexOf(d), 1); return ok({deleted: true}); }
      if (req.method() === 'POST') { const b = body(); Object.assign(d, {text: b.text, identity_id: b.identity_id, revision: d.revision + 1, updated: Date.now(), updated_by: {id: 'owner'}}); return ok({draft: d}); }
      return ok({draft: d});
    }
    if (p === 'api/unified/connectors') return ok({providers: []});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 2500)); return ok({seq: 5}); }
    if (p.startsWith('api/') || p.startsWith('contacts/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await ctx.route('**/wizard-os-home/**', r => r.fulfill({status: 200, contentType: 'application/javascript', body: ''}));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://messenger.test/');
  return {ctx, page, st, errors};
}

(async () => {
  const browser = await chromium.launch();
  const listWidth = page => page.locator('#u-pane-list').boundingBox().then(b => b.width);

  // ---------- 1. Divider: drag, limits, keyboard, double-click reset, saved across a reload ----------
  {
    const {ctx, page, errors} = await stage(browser, {width: 1280, height: 860});
    // 15.12 list and detail: with nothing open the list fills the window and there is no divider; open a chat first.
    const openChat = async name => { await page.locator('#u-pane-list .u-person', {hasText: name}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: name}).waitFor(); await page.waitForTimeout(300); };
    await page.locator('#u-pane-list .u-person', {hasText: 'Ana Souza'}).waitFor(); await page.waitForTimeout(300);
    await openChat('Ana Souza');
    const handle = page.locator('#u-pane-split');
    assert.equal(await handle.getAttribute('role'), 'separator');
    const start = await listWidth(page); assert.ok(start >= 320 && start <= 380, 'default list width (' + start + ')');
    let hb = await handle.boundingBox(); assert.ok(Math.abs(hb.x + hb.width / 2 - start) < 4, 'divider sits on the list edge');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('u-pane-split')).cursor), 'col-resize');
    await page.mouse.move(hb.x + 3, hb.y + 200); await page.mouse.down(); await page.mouse.move(hb.x + 100, hb.y + 220, {steps: 6}); await page.mouse.move(hb.x + 183, hb.y + 240, {steps: 6});
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('u-splitting')), 'dragging state on');
    await page.mouse.up();
    const dragged = await listWidth(page); assert.ok(Math.abs(dragged - (start + 180)) < 6, 'drag widened the list to ~' + (start + 180) + ' (' + dragged + ')');
    assert.equal(await page.evaluate(() => localStorage.getItem('messenger.listW')), String(Math.round(dragged)), 'width saved');
    assert.ok(!await page.evaluate(() => document.documentElement.classList.contains('u-splitting')), 'dragging state off');
    // limits: never under 260, never over 60% of the window
    hb = await handle.boundingBox(); await page.mouse.move(hb.x + 3, 300); await page.mouse.down(); await page.mouse.move(40, 300, {steps: 5}); await page.mouse.up();
    assert.equal(Math.round(await listWidth(page)), 260, 'min 260');
    hb = await handle.boundingBox(); await page.mouse.move(hb.x + 3, 300); await page.mouse.down(); await page.mouse.move(1200, 300, {steps: 5}); await page.mouse.up();
    assert.equal(Math.round(await listWidth(page)), 640, 'max 640 at 1280 (60% = 768)');
    // keyboard: focus + arrows nudge 24px
    await handle.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
    assert.equal(Math.round(await listWidth(page)), 592, 'ArrowLeft x2 = -48');
    await page.keyboard.press('ArrowRight'); assert.equal(Math.round(await listWidth(page)), 616, 'ArrowRight = +24');
    assert.equal(await handle.getAttribute('aria-valuenow'), '616');
    // open a chat, then reload: the width comes back
    await page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
    await page.reload(); await page.locator('#u-pane-list .u-person', {hasText: 'Ana Souza'}).waitFor(); await page.waitForTimeout(300);
    await openChat('Kira Novak');
    assert.equal(Math.round(await listWidth(page)), 616, 'width restored after reload');
    // double-click resets to the default
    hb = await handle.boundingBox(); await page.mouse.dblclick(hb.x + 3, hb.y + 300);
    const reset = await listWidth(page); assert.ok(Math.abs(reset - start) < 2, 'double-click resets (' + reset + ')');
    assert.equal(await page.evaluate(() => localStorage.getItem('messenger.listW')), null, 'reset forgets the saved width');
    // a narrower window caps a saved width at 60%
    await page.evaluate(() => localStorage.setItem('messenger.listW', '640')); await page.reload(); await page.locator('#u-pane-list .u-person').first().waitFor();
    await openChat('Kira Novak');
    await page.setViewportSize({width: 960, height: 860}); await page.waitForTimeout(300);
    assert.ok(await listWidth(page) <= 960 * 0.6 + 1, '60% cap at 960');
    // phone width: no split, no divider
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-split')), false, 'no split on a phone');
    assert.equal(await page.locator('#u-pane-split').count(), 0, 'no divider on a phone');
    if (await page.locator('#unified-inbox .u-back').count()) await page.locator('#unified-inbox .u-back').click();
    await page.locator('#unified-inbox .u-person').first().waitFor();
    const row = await page.locator('#unified-inbox .u-person').first().boundingBox(); assert.ok(row.width > 360, 'phone list is full width');
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---------- 2. Send: the draft ends at once, the bubble shows sending then sent ----------
  {
    const {ctx, page, st, errors} = await stage(browser, {width: 1280, height: 860});
    await page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();
    const field = page.locator('textarea[aria-label="Message"]');
    await field.fill('See you at seven'); await page.waitForTimeout(1500);
    assert.equal(st.drafts.length, 1, 'typing autosaves a draft');
    st.sendHold = 3000; // the provider takes its time
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.waitForTimeout(250);
    assert.equal(await field.inputValue(), '', 'composer empty at once');
    assert.equal(await page.locator('#u-pane-thread .u-message.outgoing.pending', {hasText: 'See you at seven'}).count(), 1, 'bubble shows sending');
    await page.waitForTimeout(400);
    assert.deepEqual(st.drafts, [], 'server draft gone while the send is still in flight');
    await page.locator('#u-pane-thread .u-message.outgoing:not(.pending)', {hasText: 'See you at seven'}).waitFor({timeout: 6000});
    assert.equal(await page.locator('#u-pane-thread .u-message', {hasText: 'See you at seven'}).count(), 1, 'one bubble once sent');
    assert.equal(st.sends.length, 1);
    // typed and sent before the autosave fired: no draft is ever created for it
    st.sendHold = 1500; const posts = st.draftPosts.length;
    await field.fill('Quick one'); await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.waitForTimeout(2500);
    assert.equal(st.draftPosts.length, posts, 'Send never creates a draft');
    assert.deepEqual(st.drafts, []);
    // narrow window: back in the Inbox right after Send, the row never says "Draft:"
    await page.setViewportSize({width: 700, height: 860}); await page.waitForTimeout(400);
    await field.fill('Narrow send'); await page.waitForTimeout(1400); assert.equal(st.drafts.length, 1);
    st.sendHold = 3000;
    await page.locator('#unified-inbox').getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.locator('#unified-inbox .u-back').click(); await page.locator('#unified-inbox > .u-list').waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#unified-inbox .u-person', {hasText: 'Kira Novak'}).locator('.u-snippet-who', {hasText: 'Draft'}).count(), 0, 'no Draft: label while sending');
    await page.waitForTimeout(3500);
    assert.equal(await page.locator('#unified-inbox .u-person', {hasText: 'Kira Novak'}).locator('.u-snippet-who', {hasText: 'Draft'}).count(), 0, 'no Draft: label after sending');
    await page.setViewportSize({width: 1280, height: 860}); await page.waitForTimeout(400);
    await page.locator('#u-pane-list .u-person', {hasText: 'Kira Novak'}).click(); await page.locator('#u-pane-thread .u-who-text strong', {hasText: 'Kira Novak'}).waitFor();

    // ---------- 3. A refused send comes back into the box and the server draft ----------
    st.sendHold = 800; st.sendFail = {status: 409, code: 'review_required', message: 'This chat translates before sending'};
    const f2 = page.locator('textarea[aria-label="Message"]');
    await f2.fill('This will be refused'); await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.waitForTimeout(200); assert.equal(await f2.inputValue(), '');
    await page.waitForFunction(() => document.querySelector('#u-pane-thread textarea[aria-label="Message"]')?.value === 'This will be refused', null, {timeout: 5000});
    assert.equal(await page.locator('#u-pane-thread .u-message', {hasText: 'This will be refused'}).count(), 0, 'refused bubble leaves the thread');
    await page.waitForTimeout(1500);
    assert.equal(st.drafts.length, 1, 'restored as the server draft'); assert.equal(st.drafts[0].text, 'This will be refused');
    // ---------- 4. A 5xx keeps the Retry bubble (it may still land; Retry reuses the client id) ----------
    st.sendFail = {status: 502, code: 'bridge_unavailable', message: 'Bridge did not answer'};
    await page.getByRole('button', {name: 'Send', exact: true}).last().click();
    await page.locator('#u-pane-thread .u-message.failed', {hasText: 'This will be refused'}).waitFor({timeout: 5000});
    assert.equal(await f2.inputValue(), '', 'box stays empty for an unsure failure');
    st.sendFail = null; const ids = st.sends.length;
    await page.locator('#u-pane-thread .u-retry').click();
    await page.locator('#u-pane-thread .u-message.outgoing:not(.pending):not(.failed)', {hasText: 'This will be refused'}).waitFor({timeout: 5000});
    assert.equal(st.sends[ids].client_id, st.sends[ids - 1].client_id, 'Retry reuses the client id');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS divider (drag, 260/640/60% limits, keys, saved + restored on reload, double-click reset, none on phone) and send (box empties and draft ends at once, sending -> sent, no draft for a quick send, no Draft: label, refused send restored, 5xx Retry keeps client id)');
})().catch(e => { console.error(e); process.exitCode = 1; });
