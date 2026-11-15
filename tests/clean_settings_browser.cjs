// Clean Settings (issue 202, on for everyone since its switch was removed): Settings shows only Accounts, Agent access
// (with its drafts line) and one Agent drafts choice, then Try new features at the very bottom (one row per box
// switch: name, what it does, Off / On, thumbs up / down; the shared kit section since issue 217). Inbox view and Suggested merges are in the list's own ⋯
// menu. Also with no switches listing at all (an older box), Settings stays clean. Synthetic API only; phone + desktop.
// PLAYWRIGHT_MODULE=... node tests/clean_settings_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'clean-settings-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const until = async (fn, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (await fn()) return; throw new Error('timed out: ' + fn); };
const ident = (id, net, label) => [{id: id + '-i', network: net, kind: 'person', label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0, ...extra});
const SW = [['photo-warm', 'Photos ready on arrival', 'The box fetches incoming photos as they arrive.'], ['photo-timings', 'Photo timings', 'Messenger measures how fast photos appear.'],
  ['list-draft-ready', 'Draft ready from the chat list', 'Holding a chat also offers Agent keeps a draft ready.']];
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport, listed] of [['390', {width: 390, height: 844}, true], ['1280', {width: 1280, height: 860}, true], ['1280-noswitches', {width: 1280, height: 860}, false]]) {
    const PEOPLE = [person('james', 'James Carter', 'whatsapp', 'Can you do Tuesday at 3?', 2, {unread: 1})];
    const watch = {watched: [], all_unread: false, stats: {sent_as_drafted: 2, edited: 1, discarded: 0, total: 3}};
    const box = {watch: [], flips: [], votes: [], on: {}, feedback: {}};
    const listing = () => ({contract: 'wizard.app-switches/1', switches: SW.map(([id, name, description]) => ({id, name, description, on: box.on[id] === true, default: false, issues: ['humanitylabs-org/wizard-messenger#202'], tried: box.feedback[id]?.tried === true, vote: box.feedback[id]?.vote || null})), feedback: box.feedback});
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
      const json = data => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(data)});
      if (p === 'api/view/switches') {
        if (!listed) return route.fulfill({status: 404, contentType: 'application/json', body: '{"error":"not_found"}'});
        if (req.method() === 'POST') {
          const b = body();
          if ('vote' in b) { box.votes.push(b); const e = {tried: false, ...box.feedback[b.id]}; delete e.vote; if (b.vote) e.vote = b.vote; box.feedback[b.id] = e; }
          else { box.flips.push(b); box.on[b.id] = b.on; if (b.on) box.feedback[b.id] = {...box.feedback[b.id], tried: true}; }
        }
        return json(listing());
      }
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: own});
      if (p === 'api/contacts') return ok({contacts: []});
      if (p === 'api/invites') return ok({invites: []});
      if (p === 'api/dms') return ok({dms: []});
      if (p === 'api/view/agents') return ok({wizard_agents: [{id: 'hermes', label: 'Oscar', level: 'draft_only', level_label: 'Draft-only', main: true}], wizard_levels: LV.map(([id, l]) => ({id, label: l})), agents: [], app_key: {level: 'no_access'}, levels: [], log: [], gateway_connected: true});
      if (p === 'api/view/push') return ok({enabled: false});
      if (p === 'api/drafts') return ok({drafts: []});
      if (p === 'api/unified/merge-suggestions') return ok({suggestions: [{a: 'x'}, {a: 'y'}]});
      if (p === 'api/unified/catch-up/settings') return ok({models: ['glm-5-3'], default: 'glm-5-3', model: 'glm-5-3', grants: [{person_id: 'james', name: 'James Carter', mode: 'always'}]});
      if (p === 'api/unified/connectors') return ok({providers: [{network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: '+155****0199'}]},
        {network: 'signal', label: 'Signal', supported: true, state: 'not_configured', flows: []}]});
      if (p === 'api/unified/draft-watch') {
        if (req.method() === 'POST') { const b = body(); box.watch.push(b); if ('all_unread' in b) watch.all_unread = b.all_unread; }
        return ok({on: true, ...watch});
      }
      if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
      if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
      if (p === 'api/unified/directory') return ok({people: PEOPLE, groups: []});
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const tag = label, shot = (name, full = false) => page.screenshot({path: path.join(out, `${name}-${tag}.png`), fullPage: full});
    await page.goto('https://messenger.test/');
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.waitForTimeout(900); // switches + draft-watch sync
    const inboxMore = page.locator('.u-inbox-more');
    const openSettings = async () => {
      await page.locator('.u-settings-btn').first().click();
      await page.locator('.u-sheet .u-more-agent').waitFor({timeout: 10000});
      await page.waitForTimeout(500);
    };
    const sheet = page.locator('.u-sheet');
    {
      assert.equal(await inboxMore.isVisible(), true, 'inbox ⋯ shows');
      await openSettings();
      if (!listed) {
        // An older box with no switches listing: the same clean Settings, no old rows, no Try new features.
        const rows = await sheet.evaluate(el => [...el.querySelectorAll('.u-more-row')].filter(r => r.offsetParent).map(r => r.querySelector('.u-more-label, .u-agent-name')?.textContent));
        assert.deepEqual(rows, ['Oscar', 'Agent drafts'], 'Settings rows: ' + JSON.stringify(rows));
        assert.equal(await sheet.locator('.u-try-kit:not([hidden])').count(), 0, 'no Try new features without switches');
        assert.equal(await sheet.locator('.u-cu-settings, .u-more-view, .u-more-photo-warm').count(), 0, 'no old Settings rows');
        await shot('settings', true);
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
        if (await sheet.count()) { await page.getByRole('button', {name: 'Back'}).first().click().catch(() => {}); await page.waitForTimeout(400); }
        await inboxMore.click(); await page.locator('.u-menu.u-inbox-menu').waitFor({timeout: 5000});
        assert.deepEqual(await page.locator('.u-menu .u-act').allInnerTexts(), ['Chats', 'Compact', 'Suggested merges (2)']);
      } else {
      // Order: accounts, Agent access, the drafts line, the one drafts choice, then Try new features last.
      const order = await sheet.evaluate(el => [...el.children].filter(c => !c.hidden && getComputedStyle(c).display !== 'none').map(c => c.className || c.tagName));
      const at = cls => order.findIndex(c => String(c).includes(cls));
      assert.ok(at('u-connected-networks') >= 0 && at('u-connected-networks') < at('u-more-agents'), JSON.stringify(order));
      assert.ok(at('u-more-agents') < at('u-agent-draft-stats') && at('u-agent-draft-stats') < at('u-more-drafts') && at('u-more-drafts') < at('u-try-kit'), JSON.stringify(order));
      assert.equal(at('u-try-kit'), order.length - 1, 'Try new features is the last part: ' + JSON.stringify(order));
      assert.equal(await sheet.locator('.u-cu-settings').count(), 0, 'Catch me up settings left Settings');
      // Outside Try new features: no switch row, no Inbox view, no timings, no merges.
      const outside = await sheet.evaluate(el => [...el.querySelectorAll('.u-more-row')].filter(r => !r.closest('.u-try-kit') && r.offsetParent).map(r => r.querySelector('.u-more-label, .u-agent-name')?.textContent));
      assert.deepEqual(outside, ['Oscar', 'Agent drafts'], 'Settings rows: ' + JSON.stringify(outside));
      assert.match(await sheet.locator('.u-agent-draft-stats').innerText(), /2 sent as drafted · 1 edited · 0 discarded/);
      const pick = sheet.locator('.u-more-agent-drafts-pick');
      assert.deepEqual(await pick.locator('.u-view-btn').allInnerTexts(), ['Chats I pick', 'Every unread chat']);
      assert.match(await pick.innerText(), /Pick chats with a chat’s ⋯ > Agent keeps a draft ready/);
      assert.equal(await pick.locator('[aria-checked="true"]').innerText(), 'Chats I pick');
      await pick.getByRole('radio', {name: 'Every unread chat'}).click();
      await until(async () => await pick.locator('[aria-checked="true"]').innerText() === 'Every unread chat');
      assert.deepEqual(box.watch.at(-1), {all_unread: true});
      // Try new features: the note and one row per switch.
      const tryBox = sheet.locator('.u-try-kit');
      await tryBox.locator('.wz-try-row').first().waitFor({timeout: 8000});
      assert.match(await tryBox.locator('.wz-try-note').innerText(), /^Features still being tested\. Approved ones become part of the app; the rest go away\. Thumbs up the ones you like\.$/);
      assert.deepEqual(await tryBox.locator('.wz-try-row .wz-main b').allInnerTexts(), SW.map(x => x[1]));
      assert.equal(await tryBox.locator('.u-more-timings').count(), 0, 'no timing numbers');
      const warm = tryBox.locator('[data-try-id="photo-warm"]');
      assert.match(await warm.innerText(), /fetches incoming photos/);
      await warm.getByRole('switch').click();
      await until(async () => await warm.getByRole('switch').getAttribute('aria-checked') === 'true');
      assert.deepEqual(box.flips.at(-1), {id: 'photo-warm', on: true});
      await warm.getByRole('button', {name: 'Thumbs up for Photos ready on arrival'}).click();
      await until(async () => await warm.getByRole('button', {name: 'Thumbs up for Photos ready on arrival'}).getAttribute('aria-pressed') === 'true');
      assert.deepEqual(box.votes.at(-1), {id: 'photo-warm', vote: 'up'});
      assert.deepEqual(box.feedback['photo-warm'], {tried: true, vote: 'up'});
      // With Draft ready from the chat list on, the hint says right-click / hold.
      await tryBox.locator('[data-try-id="list-draft-ready"]').getByRole('switch').click();
      await until(async () => /Drafts at the top of a chat, or by holding a chat/.test(await pick.innerText()));
      const ldr = tryBox.locator('[data-try-id="list-draft-ready"]');
      assert.equal(await ldr.getByRole('switch').getAttribute('aria-checked'), 'true');
      const fits = await pick.locator('.u-view-btn').evaluateAll(bs => bs.every(b => b.scrollWidth <= b.clientWidth));
      assert.ok(fits, 'Agent drafts choices are not cut off');
      await page.mouse.move(1, 1); await page.locator('body').evaluate(() => document.activeElement?.blur());
      await shot('settings', true);
      await sheet.evaluate(el => { for (let n = el; n; n = n.parentElement) n.scrollTop = 0; }); await page.waitForTimeout(200);
      await shot('settings-top');
      await tryBox.scrollIntoViewIfNeeded(); await shot('settings-try');
      // Inbox view and Suggested merges from the list's ⋯ menu.
      await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      if (await sheet.count()) { await page.getByRole('button', {name: 'Back'}).first().click().catch(() => {}); await page.waitForTimeout(400); }
      await inboxMore.click();
      await page.locator('.u-menu.u-inbox-menu').waitFor({timeout: 5000});
      const items = await page.locator('.u-menu .u-act').allInnerTexts();
      assert.deepEqual(items, ['Chats', 'Compact', 'Suggested merges (2)'], JSON.stringify(items));
      await shot('inbox-menu');
      await page.locator('.u-menu .u-act', {hasText: 'Compact'}).click();
      await page.waitForFunction(() => document.getElementById('messenger').classList.contains('u-compact'));
      assert.equal(await page.evaluate(() => localStorage.getItem('messenger.inboxView')), 'compact');
      await inboxMore.click(); await page.locator('.u-menu').waitFor();
      assert.equal(await page.locator('.u-menu .u-act.checked').innerText(), 'Compact');
      await page.locator('.u-menu .u-act', {hasText: 'Chats'}).click();
      await page.waitForFunction(() => !document.getElementById('messenger').classList.contains('u-compact'));
      }
    }
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${tag}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
