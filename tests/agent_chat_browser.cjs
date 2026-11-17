// Issue 265 (switch agent-chat): a pinned Agent chat on top of Chats. A note gets a tick once the agent picks it up
// (never a reply), Sweep brings one list with one-tap answers that collapse to the agent's result, an urgent ping
// makes the chat unread and counts on Messenger's badge, and Reports holds the longer write-ups. Switch off: no row.
// Synthetic API (a small fake of agent_chat.py's owner routes), no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/agent_chat_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-chat-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee'), base('ben', 'Ben Ito')];

// The box side, as agent_chat.py keeps it.
function fakeBox() {
  const box = {seq: 0, read_at: 0, reports_read_at: 0, entries: []};
  const state = () => {
    const unread = box.entries.filter(e => e.by === 'agent' && e.kind !== 'report' && e.at > box.read_at);
    return {entries: box.entries, unread: unread.length, urgent: unread.some(e => e.kind === 'ping'),
      reports_unread: box.entries.filter(e => e.kind === 'report' && e.at > box.reports_read_at).length,
      sweep_open: box.entries.some(e => e.kind === 'ask' && !e.done), read_at: box.read_at};
  };
  const at = () => Date.now() + box.seq;
  return {box, state,
    owner(p, body) {
      if (p === '' && body) box.entries.push({id: 'n' + ++box.seq, kind: 'note', by: 'owner', text: body.text, at: at(), seen: null});
      if (p === '/sweep' && !box.entries.some(e => e.kind === 'ask' && !e.done)) box.entries.push({id: 's' + ++box.seq, kind: 'ask', ask: 'sweep', by: 'owner', at: at(), seen: null, done: null});
      if (p === '/answer') { const i = box.entries.find(e => e.id === body.post_id).items.find(x => x.n === body.item); const b = i.buttons.find(x => x.value === body.value); i.answer = {label: b.label, value: b.value, at: at(), seen: null}; }
      if (p === '/read') box[body?.reports ? 'reports_read_at' : 'read_at'] = Math.max(0, ...box.entries.map(e => e.at));
      return state();
    },
    ack(text) { const e = box.entries.find(x => x.text === text); e.seen = {at: at(), by: 'Oscar'}; },
    post(kind, text, items = [], link = null) {
      const e = {id: 'p' + ++box.seq, kind, by: 'agent', agent: 'Oscar', text, link, at: Date.now() + 20000 + box.seq, items: items.map((x, i) => ({n: i + 1, recommendation: null, answer: null, result: null, ...x}))};
      if (kind === 'sweep') { const ask = box.entries.find(x => x.kind === 'ask' && !x.done); ask.done = e.id; ask.seen = {at: at()}; }
      box.entries.push(e); return e;
    },
    done(post, n, result) { const i = post.items.find(x => x.n === n); i.result = result; i.answer.seen = at(); },
  };
}

async function run(browser, label, switchOn, viewport) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.__badge = [];
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: n => { window.__badge.push(n); }}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], fake = fakeBox();
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = [{id: 'agent-chat', name: 'Agent chat', description: 'x', on: switchOn, default: false, tried: false, vote: null, issues: ['humanitylabs-org/wizard-messenger#265']}];
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) {
      if (!switchOn) return route.fulfill({status: 409, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'feature_off', message: 'off'}})});
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
      return ok(req.method() === 'POST' ? fake.owner(p.slice('api/unified/agent-chat'.length), body) : fake.state());
    }
    if (p === 'api/unified/people') return ok({people: PEOPLE, seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Anna Lee'}).first().waitFor({timeout: 20000});
  await page.waitForTimeout(1200);
  const shot = name => page.screenshot({path: path.join(out, `${label}-${name}.png`)});
  const result = {label};
  if (!switchOn) {
    result.row = await page.locator('.u-agent-row').count();
    assert.equal(result.row, 0, label + ': switch off, no Agent row');
    await shot('list');
    assert.deepEqual(errors, [], label + ' page errors');
    await ctx.close(); return result;
  }
  const rows = await page.locator('.u-list > .u-person').evaluateAll(els => els.map(e => e.querySelector('strong')?.textContent));
  assert.equal(rows[0], 'Agent', label + ': the Agent chat is pinned on top');
  await shot('1-list');
  await page.locator('.u-agent-row').click();
  const sheet = page.locator('.u-sheet.u-agent-chat');
  await sheet.waitFor({timeout: 5000});
  await sheet.locator('.u-ac-field').fill('Buy dog food https://shop.example/food');
  await sheet.locator('.u-ac-field').press('Enter');
  await sheet.locator('.u-ac-row.out', {hasText: 'Buy dog food'}).waitFor({timeout: 5000});
  assert.equal(await sheet.locator('.u-ac-row.out .u-ac-tick').count(), 0, label + ': no tick before the agent picks it up');
  assert.equal(await sheet.locator('.u-ac-row.out a[href="https://shop.example/food"]').count(), 1, label + ': the link in a note is tappable');
  fake.ack('Buy dog food https://shop.example/food');
  await sheet.locator('.u-ac-row.out .u-ac-tick').waitFor({timeout: 9000});
  result.tick = true;
  assert.equal(await sheet.locator('.u-ac-row.in').count(), 0, label + ': the note got no reply');
  await shot('2-note-ticked');
  await sheet.getByRole('button', {name: 'Sweep', exact: true}).click();
  await sheet.getByRole('button', {name: 'Sweep asked'}).waitFor({timeout: 5000});
  assert.ok(await sheet.getByRole('button', {name: 'Sweep asked'}).isDisabled(), label + ': one Sweep at a time');
  const sweep = fake.post('sweep', '', [
    {text: "Buddy's comment on your post needs a reply", recommendation: 'Thank him and ask about Friday', buttons: [{label: 'Yes', value: 'yes'}, {label: 'Skip', value: 'skip'}, {label: 'Later', value: 'later'}]},
    {text: 'Dentist asks for a new date', recommendation: 'Tuesday 10:00', buttons: [{label: 'Tue', value: 'Tue'}, {label: 'Wed', value: 'Wed'}]}]);
  await sheet.locator('.u-ac-items .u-ac-item').first().waitFor({timeout: 9000});
  await shot('3-sweep');
  const yes = sheet.locator('.u-ac-item').first().getByRole('button', {name: 'Yes'});
  await yes.click();
  await page.waitForFunction(() => document.querySelector('.u-ac-item .u-ac-choice[aria-pressed="true"]')?.textContent === 'Yes', null, {timeout: 5000});
  fake.done(sweep, 1, 'Replied to Buddy');
  await sheet.locator('.u-ac-item.done', {hasText: '✓ Replied to Buddy'}).waitFor({timeout: 9000});
  assert.equal(await sheet.locator('.u-ac-item.done .u-ac-choice').count(), 0, label + ': a done item collapses to its result');
  await shot('4-answered');
  fake.post('report', 'Weekly social stats\nFollowers +12, best post Tuesday.');
  await sheet.getByRole('button', {name: 'Reports (1)'}).waitFor({timeout: 9000});
  assert.equal(await sheet.locator('.u-ac-row.report').count(), 0, label + ': reports stay out of the chat');
  await sheet.getByRole('button', {name: 'Reports (1)'}).click();
  await sheet.locator('.u-ac-row.report h3', {hasText: 'Weekly social stats'}).waitFor({timeout: 5000});
  assert.ok(await sheet.locator('.u-ac-compose').isHidden(), label + ': Reports has no composer');
  await shot('5-reports');
  await sheet.getByRole('button', {name: 'Back to chat'}).click();
  await page.getByRole('button', {name: 'Close'}).first().click();
  await sheet.waitFor({state: 'detached', timeout: 5000});
  fake.post('ping', "Buddy's comment needs a reply", [], 'https://social.example/p/1');
  await page.locator('.u-agent-row.urgent').waitFor({timeout: 9000});
  assert.equal(await page.locator('.u-agent-row .u-badge').textContent(), '1', label + ': the ping makes the chat unread');
  result.badge = await page.evaluate(() => window.__badge.at(-1));
  assert.equal(result.badge, 1, label + ': an urgent ping counts on Messenger\'s badge');
  await shot('6-urgent-row');
  await page.locator('.u-agent-row').click();
  await sheet.locator('.u-ac-row.in.urgent a[href="https://social.example/p/1"]').waitFor({timeout: 5000});
  await shot('7-urgent-open');
  await page.getByRole('button', {name: 'Close'}).first().click();
  await page.waitForFunction(() => !document.querySelector('.u-agent-row.urgent'), null, {timeout: 9000});
  result.badgeAfterRead = await page.evaluate(() => window.__badge.at(-1));
  assert.equal(result.badgeAfterRead, 0, label + ': reading it clears the badge');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [await run(browser, 'phone', true, {width: 390, height: 844}), await run(browser, 'desktop', true, {width: 1280, height: 860}),
      await run(browser, 'switch-off', false, {width: 390, height: 844})];
    console.log(JSON.stringify({ok: true, results}, null, 1));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
