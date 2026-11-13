// Agent keeps drafts ready (issue 178, on for everyone, no switch): the chat header ⋯ picks a chat for the agent, Settings
// has "Draft for every unread chat" and the sent/edited/discarded line, and closing an agent's draft tells the box
// why (sent with its text, or discarded). Synthetic API only; phone + desktop; nothing is sent to a network here
// except the owner's own composer send, which the fixture answers.
// PLAYWRIGHT_MODULE=... node tests/agent_drafts_ready_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-drafts-ready-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const ident = (id, net, label) => [{id: id + '-i', network: net, kind: 'person', label}];
const person = (id, name, net, text, ago, extra = {}) => ({id, display_name: name, identities: ident(id, net, name), labels: [], unread: 0, muted: false, low_priority: false, last: {text, timestamp: now - ago * min, outgoing: false}, language: '', peer_read_ts: 0, last_read_ts: 0, ...extra});
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
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
      if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: []})});
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
    await page.locator('.u-person', {hasText: 'James Carter'}).waitFor({timeout: 15000});
    await page.waitForTimeout(600); // switches sync
    // Settings: no switch row; Draft for every unread chat plus the agent's sent/edited/discarded line, always.
    await page.locator('[aria-label="Settings"]').first().click();
    await page.locator('.u-settings .u-more-agent-drafts-all').waitFor({timeout: 5000});
    assert.equal(await page.locator('.u-settings .u-more-agent-drafts').count(), 0, 'no Agent keeps drafts ready switch row');
    await page.locator('.u-settings .u-more-agent').first().waitFor({timeout: 5000});
    await page.waitForTimeout(400);
    const all = page.locator('.u-settings .u-more-agent-drafts-all'), stats = page.locator('.u-settings .u-agent-draft-stats');
    assert.ok(await all.isVisible(), 'every-unread row is always there');
    assert.ok(await stats.isVisible(), 'stats line is always there');
    {
      assert.equal(await stats.innerText(), 'Agent drafts: 2 sent as drafted · 1 edited · 0 discarded');
      await stats.scrollIntoViewIfNeeded(); await shot('settings-stats');
      await all.getByRole('radio', {name: 'On'}).click();
      await page.waitForFunction(() => document.querySelector('.u-more-agent-drafts-all [data-on="1"]')?.getAttribute('aria-checked') === 'true');
      assert.deepEqual(box.watch, [{all_unread: true}]);
      await page.mouse.move(0, 0); await page.waitForTimeout(500);
    }
    await shot('settings');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    if (await page.locator('.u-settings').count()) await page.getByRole('button', {name: /Back|Close/}).first().click();
    // The chat header ⋯ always has the per-chat choice.
    await page.locator('.u-person', {hasText: 'James Carter'}).click();
    await page.locator('.u-composer textarea').waitFor({timeout: 10000});
    await page.waitForFunction(() => /Drafted by Oscar/.test(document.querySelector('.u-draft-note')?.textContent || ''), null, {timeout: 10000});
    const menu = async () => { await page.locator('[aria-label="Chat options"]').last().click(); await page.locator('.u-menu').waitFor(); return page.locator('.u-menu .u-act').allInnerTexts(); };
    let items = await menu();
    assert.ok(items.includes('Agent keeps a draft ready'), JSON.stringify(items));
    {
      await page.locator('.u-menu .u-act', {hasText: 'Agent keeps a draft ready'}).click();
      await page.waitForFunction(() => !document.querySelector('.u-menu'));
      assert.deepEqual(box.watch.at(-1), {person_id: 'james', on: true});
      items = await menu();
      assert.ok(items.includes('Stop keeping a draft ready'), JSON.stringify(items));
      await shot('chat-menu');
    }
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.u-menu'));
    // The owner edits the agent's words and sends: the box hears it was sent, with the text that went out.
    const ta = page.locator('.u-composer textarea');
    assert.equal(await ta.inputValue(), 'Tuesday at 3 works for me.');
    await ta.fill('Tuesday at 3 works, see you there!');
    await page.locator('.u-composer [aria-label="Send"]').click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && !box.deletes.length; i++) await page.waitForTimeout(100);
    assert.deepEqual(box.deletes.map(([id, b]) => [id, b.outcome, b.sent_text]), [['d1', 'sent', 'Tuesday at 3 works, see you there!']]);
    assert.equal(box.sends.length, 1, 'the owner\'s own send');
    await shot('sent');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(`${tag}: ok`);
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
