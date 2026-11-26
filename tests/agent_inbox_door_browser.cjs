// Issue 325: in door mode the Agent chat's Sweep shows the box's agent inbox card: Waiting
// items with their recommendation and up to 4 one-tap answers, "Open to confirm" for a confirm item, Done, the counts,
// "And N more" to Wizard's inbox view and Yes to all when the card allows it. A tap answers that record on the box.
// Synthetic API (a small fake of agent_chat.py's door routes), no container and no shell:
//   PLAYWRIGHT_MODULE=... node tests/agent_inbox_door_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-inbox-door-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee')];

function item(id, title, ask, options, extra = {}) {
  return {id, agent: 'hermes', thread_id: 't-' + id, title, ask, recommendation: '', options: options.map(token => ({token})), default_option: options[0] || null,
    confirm: false, seen: 1, link: '/wizard-os-home/?session=t-' + id, state: 'surfaced', ...extra};
}
// The box side, as agent_chat.py keeps it in door mode.
function fakeBox() {
  const box = {seq: 0, read_at: 0, entries: [], answers: []};
  const card = () => ({schema: 'wizard.agent-sweep/1', id: 'sweep_' + 'c'.repeat(24), at: Date.now(), day: '', thread_id: '', agent: 'hermes',
    waiting: {items: [
      item('inbox_1', 'Electricity bill', 'Pay the €84 bill due Friday?', ['pay', 'wait', 'ask-landlord', 'skip', 'fifth'], {recommendation: 'Pay it now: it is due Friday'}),
      item('inbox_2', 'Lease renewal', 'Sign and send the new lease?', ['send'], {confirm: true, seen: 2}),
      item('inbox_3', 'Dentist', 'Move the check-up to Tuesday 10:00?', ['yes', 'no'], {recommendation: 'Yes, Tuesday works'})],
    more: 2, link: '/wizard-os-home/?inbox=waiting'},
    done: {items: [{id: 'inbox_7', title: 'Booked the car service', link: '/wizard-os-home/?session=d7'}, {id: 'inbox_8', title: 'Sent the invoice to Ana', link: '/wizard-os-home/?session=d8'}], more: 0, link: '/wizard-os-home/?inbox=done'},
    running: {count: 3, stale: 0, link: '/wizard-os-home/?inbox=running'}, later: {count: 1, link: '/wizard-os-home/?inbox=later'}, parked: {count: 0, link: '/wizard-os-home/?inbox=parked'},
    yes_to_all: {count: 2, skipped: 1}});
  const state = () => ({entries: box.entries, unread: 0, urgent: false, reports_unread: 0, reports_read_at: 0, sweep_open: false, read_at: box.read_at,
    agent: {woken: false, checked: true}, door: {on: true}});
  const at = () => Date.now() + box.seq;
  const post = () => box.entries.findLast(e => e.card);
  const yesCount = c => c.waiting.items.filter(i => !i.confirm && i.state === 'surfaced').length;
  return {box, state,
    owner(p, body) {
      if (p === '' && body) box.entries.push({id: 'n' + ++box.seq, kind: 'note', by: 'owner', text: body.text, at: at(), seen: null, door: 'pending'});
      if (p === '/sweep') {
        const a = {id: 's' + ++box.seq, kind: 'ask', ask: 'sweep', by: 'owner', at: at(), seen: {at: at(), by: 'agent inbox'}, done: null};
        const e = {id: 'p' + ++box.seq, kind: 'sweep', by: 'agent', agent: null, text: '', link: null, items: [], card: card(), at: at(), reply_to: a.id};
        a.done = e.id; box.entries.push(a, e);
      }
      if (p === '/door/answer') {
        box.answers.push(body);
        const i = post().card.waiting.items.find(x => x.id === body.record); i.state = 'answered'; i.answer = body.option;
        post().card.yes_to_all.count = yesCount(post().card);
      }
      if (p === '/door/yes-to-all') {
        box.answers.push({yes_to_all: body.post_id});
        for (const i of post().card.waiting.items) if (!i.confirm && i.state === 'surfaced') { i.state = 'answered'; i.answer = i.default_option; }
        post().card.yes_to_all.count = 0;
      }
      if (p === '/read') box.read_at = Math.max(0, ...box.entries.map(e => e.at));
      return state();
    },
    tick(text) { const e = box.entries.find(x => x.text === text); e.seen = {at: at(), by: 'agent inbox'}; e.door = {record: 'inbox_n', at: at()}; },
    answeredInDaily(id) { const i = post().card.waiting.items.find(x => x.id === id); i.state = 'answered'; i.answer = 'no'; post().card.yes_to_all.count = yesCount(post().card); },
  };
}

async function run(browser, label, viewport, scheme) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: scheme, hasTouch: viewport.width < 600});
  // The Wizard shell marks the skin on html[data-color-scheme]; Messenger's light skin keys on it, not on the media query.
  await ctx.addInitScript(s => { window.__scheme = s; }, scheme);
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; r.dataset.colorScheme = window.__scheme; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], fake = fakeBox();
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: [] /* no Messenger switch since the switch removal: the door is always on */})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) {
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
  await page.waitForTimeout(800);
  const shot = name => page.screenshot({path: path.join(out, `${label}-${name}.png`)});
  await page.locator('.u-agent-row[data-mode="chat"]').click();
  const chat = page.locator('#unified-inbox');
  await chat.locator('.u-thread-head.u-agent-head').waitFor({timeout: 5000});
  // A note gets its tick once the box has the record.
  await chat.locator('.u-ac-field').fill('Renew the passport before March');
  await chat.getByRole('button', {name: 'Save note'}).click();
  const note = chat.locator('.u-row.outgoing', {hasText: 'Renew the passport'});
  await note.waitFor({timeout: 5000});
  assert.equal(await note.locator('.u-ac-tick').count(), 0, label + ': no tick before the box has the record');
  fake.tick('Renew the passport before March');
  await note.locator('.u-reactions .u-ac-tick').waitFor({timeout: 9000});
  // Sweep draws the box's card.
  await chat.getByRole('button', {name: 'Sweep', exact: true}).click();
  const bubble = chat.locator('.u-row.incoming .u-ac-card');
  await bubble.waitFor({timeout: 5000});
  assert.equal(await chat.getByRole('button', {name: 'Sweep', exact: true}).isDisabled(), false, label + ': no agent-written list to wait for');
  const items = bubble.locator('.u-ac-items > .u-ac-item');
  assert.equal(await items.count(), 3);
  assert.deepEqual(await items.nth(0).locator('.u-ac-choice').allTextContents(), ['Pay', 'Wait', 'Ask landlord', 'Skip'], label + ': up to 4 buttons');
  assert.ok((await items.nth(0).textContent()).includes('Recommended: Pay it now'), label + ': the recommendation shows');
  assert.equal(await items.nth(1).locator('.u-ac-choice').count(), 0, label + ': a confirm item has no buttons');
  assert.equal(await items.nth(1).locator('a.u-ac-confirm', {hasText: 'Open to confirm'}).getAttribute('href'), '/wizard-os-home/?session=t-inbox_2');
  assert.equal(await bubble.locator('a.u-ac-more', {hasText: 'And 2 more'}).getAttribute('href'), '/wizard-os-home/?inbox=waiting');
  assert.equal(await bubble.locator('.u-ac-done li').count(), 2);
  assert.ok((await bubble.locator('.u-ac-counts').textContent()).includes('Running: 3'), label + ': the counts show');
  await bubble.getByRole('button', {name: 'Yes to all (2)'}).waitFor();
  await page.waitForTimeout(300);
  await shot('1-sweep-card');
  // A tap answers that record on the box and the item collapses to the answer.
  await items.nth(0).getByRole('button', {name: 'Wait'}).click();
  await items.nth(0).locator('.u-ac-answer', {hasText: 'You: Wait'}).waitFor({timeout: 5000});
  assert.deepEqual(fake.box.answers[0], {post_id: fake.box.entries.at(-1).id, record: 'inbox_1', option: 'wait'});
  await bubble.getByRole('button', {name: 'Yes to all (1)'}).waitFor({timeout: 5000});
  // An answer given in Daily shows here once the box's card is read again.
  fake.answeredInDaily('inbox_3');
  await items.nth(2).locator('.u-ac-answer', {hasText: 'You: No'}).waitFor({timeout: 9000});
  assert.equal(await bubble.getByRole('button', {name: /Yes to all/}).count(), 0, label + ': Yes to all goes once nothing is left for it');
  await page.waitForTimeout(300);
  await shot('2-answered');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.colorScheme), scheme, label + ': skin marked');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return {label, ok: true};
}

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    const results = [];
    for (const scheme of ['dark', 'light']) {
      results.push(await run(browser, 'phone-' + scheme, {width: 390, height: 844}, scheme));
      results.push(await run(browser, 'desktop-' + scheme, {width: 1280, height: 860}, scheme));
    }
    // Light and dark shots must really differ (issue 325 review: they were byte-identical).
    const digest = f => require('crypto').createHash('md5').update(fs.readFileSync(path.join(out, f))).digest('hex');
    for (const size of ['phone', 'desktop']) for (const name of ['1-sweep-card', '2-answered']) {
      assert.notEqual(digest(`${size}-dark-${name}.png`), digest(`${size}-light-${name}.png`), `${size} ${name}: light differs from dark`);
    }
    console.log(JSON.stringify({ok: true, results}));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
