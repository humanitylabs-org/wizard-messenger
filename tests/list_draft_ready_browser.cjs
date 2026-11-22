// Draft ready from the chat list (issue 201, on for everyone; its switch list-draft-ready was removed): holding a chat
// row (phone) or right-clicking it (desktop) offers "Agent keeps a draft ready" / "Stop keeping a draft ready" without
// opening the chat, and the open chat's header has a one-tap Drafts toggle instead of the ⋯ item. A box that still
// lists the old switch as off changes nothing. Synthetic API only; phone + desktop.
// PLAYWRIGHT_MODULE=... node tests/list_draft_ready_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'list-draft-ready-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, label) => [{id: id + '-i', network: net, kind: 'person', label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0, ...extra});
(async () => {
  const browser = await chromium.launch(), summary = [];
  const stale = [{id: 'list-draft-ready', name: 'Draft ready from the chat list', on: false, default: false, issues: ['humanitylabs-org/wizard-messenger#201']}];
  for (const [label, viewport, switches] of [['390', {width: 390, height: 844}, []], ['1280', {width: 1280, height: 860}, []], ['1280-stale-off', {width: 1280, height: 860}, stale]]) {
    const PEOPLE = [person('james', 'James Carter', 'whatsapp', 'Can you do Tuesday at 3?', 2, {unread: 1})];
    let DRAFTS = [{id: 'd1', person_id: 'james', identity_id: 'james-i', state: 'draft', revision: 1, text: 'Tuesday at 3 works for me.', attachments: [], updated: now - 30e3, created_by: {id: 'agent:a', name: 'Oscar'}, agent_text: 'Tuesday at 3 works for me.'}];
    const watch = {watched: [], all_unread: false, stats: {sent_as_drafted: 2, edited: 1, discarded: 0, total: 3}};
    const box = {watch: [], deletes: [], sends: []};
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: 'dark'});
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32), own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
    const LV = [['no_access', 'No access'], ['read_only', 'Read-only'], ['draft_only', 'Draft-only']];
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const body = () => JSON.parse(req.postData() || '{}');
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (/\/send$|\/preview$/.test(p)) { box.sends.push([p, body()]); return ok({state: 'sent', message: null}); }
      if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/view/agents') return ok({wizard_agents: [{id: 'hermes', label: 'Oscar', level: 'draft_only', level_label: 'Draft-only', main: true}], wizard_levels: LV.map(([id, l]) => ({id, label: l})), agents: [], app_key: {level: 'no_access'}, levels: [], log: []});
      if (p === 'api/drafts') return ok({drafts: DRAFTS});
      const d = /^api\/drafts\/([^/]+)$/.exec(p);
      if (d && req.method() === 'DELETE') { box.deletes.push([d[1], body()]); DRAFTS = DRAFTS.filter(x => x.id !== d[1]); return ok({deleted: true}); }
      if (d && req.method() === 'POST') { const b = body(), row = DRAFTS.find(x => x.id === d[1]); Object.assign(row, {text: b.text, revision: row.revision + 1, updated: Date.now(), updated_by: {id: 'owner', name: 'You'}}); return ok({draft: row}); }
      if (d) return ok({draft: DRAFTS.find(x => x.id === d[1])});
      if (p === 'api/unified/draft-watch') {
        if (req.method() === 'POST') {
          const b = body(); box.watch.push(b);
          if ('all_unread' in b) watch.all_unread = b.all_unread;
          else watch.watched = b.on ? [...new Set([...watch.watched, b.person_id])] : watch.watched.filter(x => x !== b.person_id);
        }
        return ok({on: true, ...watch});
      }
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/directory') return ok({people: PEOPLE, groups: []});
      const thread = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (thread) return ok({person: PEOPLE[0], messages: [{id: 'm1', person_id: 'james', identity_id: 'james-i', network: 'whatsapp', sender: 'James Carter', outgoing: false, original: 'Can you do Tuesday at 3?', timestamp: now - 2 * min, msgtype: 'm.text'}], has_more: false, next_cursor: null, seq: 5, typing: []});
      if (p.endsWith('/read')) return ok({});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const tag = label, shot = name => page.screenshot({path: path.join(out, `${name}-${tag}.png`)});
    await page.goto('https://messenger.test/');
    const row = page.locator('.u-person', {hasText: 'James Carter'});
    await row.waitFor({timeout: 15000});
    await page.waitForTimeout(800); // switches + draft-watch sync
    const phone = viewport.width < 600;
    const rowMenu = async () => {
      if (phone) { // a real touch long-press (CDP), not a contextmenu event
        const b = await row.boundingBox(), cdp = await ctx.newCDPSession(page), pt = {x: b.x + b.width / 2, y: b.y + b.height / 2};
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [pt]});
        await page.waitForTimeout(650);
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      } else await row.click({button: 'right'});
      await page.locator('.u-menu').waitFor({timeout: 5000});
      return page.locator('.u-menu .u-act').allInnerTexts();
    };
    const closeMenu = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.u-menu'), null, {timeout: 5000}); };
    let items = await rowMenu();
    {
      assert.ok(items.includes('Mute'), JSON.stringify(items));
      assert.equal(items.at(-1), 'Agent keeps a draft ready', JSON.stringify(items));
      await shot('row-menu');
      await page.locator('.u-menu .u-act', {hasText: 'Agent keeps a draft ready'}).click();
      await page.waitForFunction(() => !document.querySelector('.u-menu'));
      assert.deepEqual(box.watch.at(-1), {person_id: 'james', on: true});
      assert.equal(await page.locator('.u-composer textarea').count(), 0, 'the chat did not open');
      await page.waitForTimeout(300);
      items = await rowMenu();
      assert.equal(items.at(-1), 'Stop keeping a draft ready', JSON.stringify(items));
      await shot('row-menu-watched');
      await page.locator('.u-menu .u-act', {hasText: 'Stop keeping a draft ready'}).click();
      await page.waitForFunction(() => !document.querySelector('.u-menu'));
      assert.deepEqual(box.watch.at(-1), {person_id: 'james', on: false});
      assert.deepEqual(watch.watched, []);
    }
    // The open chat: a one-tap Drafts toggle sits in the header next to Catch me up and the ⋯ menu drops the item.
    // (After a CDP touch hold the first synthetic click can be eaten by swallowRelease, so tap again if needed.)
    for (let i = 0; i < 3 && !(await page.locator('.u-composer textarea').count()); i++) { await row.click(); await page.waitForTimeout(1500); }
    await page.locator('.u-composer textarea').waitFor({timeout: 10000});
    const toggle = page.locator('.u-thread-head .u-draft-toggle').last();
    {
      await toggle.waitFor({state: 'visible', timeout: 5000});
      const order = await page.locator('.u-thread-head').last().evaluate(h => [...h.children].map(c => c.getAttribute('aria-label') || '').filter(Boolean));
      const at = order.indexOf('Agent keeps a draft ready');
      assert.ok(at >= 0 && order[at + 1] === 'Catch me up' && order[at + 2] === 'Chat options', JSON.stringify(order));
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      assert.equal((await toggle.innerText()).trim(), 'Drafts');
      await shot('header-off');
      await toggle.click();
      await page.waitForFunction(() => [...document.querySelectorAll('.u-thread-head .u-draft-toggle')].some(b => b.getAttribute('aria-pressed') === 'true'), null, {timeout: 5000});
      assert.deepEqual(box.watch.at(-1), {person_id: 'james', on: true});
      await shot('header-on');
      await toggle.click();
      await page.waitForFunction(() => [...document.querySelectorAll('.u-thread-head .u-draft-toggle')].every(b => b.getAttribute('aria-pressed') === 'false'), null, {timeout: 5000});
      assert.deepEqual(box.watch.at(-1), {person_id: 'james', on: false});
    }
    await page.locator('[aria-label="Chat options"]').last().click(); await page.locator('.u-menu').waitFor();
    items = await page.locator('.u-menu .u-act').allInnerTexts();
    assert.ok(!items.some(t => /draft ready/.test(t)), 'the header toggle replaces the ⋯ item ' + JSON.stringify(items));
    await closeMenu();
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${tag}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
