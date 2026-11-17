// Issue 277 (switch agent-chat-name): the pinned Agent chat carries the owner's agent's own name and sigil (the Wizard's
// hat mark in the agent's colour), picked as the agent with Draft-only access in Settings > Agents. Off: "Agent" and the
// Agent Service is never asked. On with no agent known: "Agent" stays.
// Synthetic API (agent_chat.py's owner routes, api/view/agents, the Agent Service's /wizard/v1/agents), no container:
//   PLAYWRIGHT_MODULE=... [SHELL_DIR=<wizard-ux>/web] node tests/agent_chat_name_browser.cjs [outdir]
// SHELL_DIR serves the shell's hat mark (/wizard-os-home/brand/...) for the screenshots; without it the tile has no mark.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-chat-name-shots');
const shell = process.env.SHELL_DIR ? path.resolve(process.env.SHELL_DIR) : '';
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const now = Date.now(), min = 60e3;
const base = (id, name) => ({id, display_name: name, avatar: null, identities: [{id: id + '-i', network: 'line', kind: 'person', label: name}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Hi', timestamp: now - min, outgoing: false}, language: '', peer_read_ts: 0});
const PEOPLE = [base('anna', 'Anna Lee'), base('ben', 'Ben Ito')];
const SERVICE = [{id: 'hermes', label: 'Hermes', is_default: true, privacy: 'standard', appearance: {glyph: 'hat', hue: 265}},
  {id: 'oscar', label: 'Oscar', is_default: false, privacy: 'standard', appearance: {glyph: 'hat', hue: 30}}];
const LEVELS = [{id: 'hermes', label: 'Your Wizard agent', level: 'read_only', main: true, last_used: now - min},
  {id: 'oscar', label: 'Oscar', level: 'draft_only', main: false, last_used: now - 2 * min}];

async function run(browser, label, {on, service = SERVICE, levels = LEVELS}, viewport) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, colorScheme: 'dark', hasTouch: viewport.width < 600});
  await ctx.addInitScript(() => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  });
  const page = await ctx.newPage(), errors = [], hits = {service: 0};
  page.on('pageerror', e => errors.push(e.message));
  const entries = [{id: 'n1', kind: 'note', by: 'owner', text: 'Buy dog food', at: now - 20 * min, seen: {at: now - 19 * min, by: 'Oscar'}}];
  const state = () => ({entries, unread: 0, urgent: false, sweep_open: false, read_at: 0, agent: {woken: true, checked: true}, reports_unread: 0, reports_read_at: 0});
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const switches = [
    {id: 'agent-chat', name: 'Agent chat', description: 'x', on: true, default: false, tried: false, vote: null, issues: []},
    {id: 'agent-chat-name', name: 'Agent chat with your agent\'s name', description: 'x', on, default: false, tried: false, vote: null, issues: ['humanitylabs-org/wizard-messenger#277']}];
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'wizard/v1/agents') {
      hits.service++;
      return service ? route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({agents: service})}) : route.fulfill({status: 404, body: ''});
    }
    if (p.startsWith('wizard-os-home/')) {
      const file = shell && path.join(shell, p.slice('wizard-os-home/'.length));
      if (!file || !file.startsWith(shell) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    }
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches})});
    if (p === 'api/view/agents') return ok({wizard_agents: levels, wizard_levels: [], gateway_connected: true, agents: [], levels: [], log: []});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p.startsWith('api/unified/agent-chat')) return ok(state());
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
  const row = page.locator('.u-list > .u-agent-row[data-mode="chat"]');
  await row.waitFor({timeout: 10000});
  await page.waitForTimeout(1500);
  const shot = name => page.screenshot({path: path.join(out, `${label}-${name}.png`)});
  const expect = on && service ? 'Oscar' : 'Agent';
  assert.equal(await row.locator('strong').textContent(), expect, label + ': the pinned row\'s name');
  assert.equal(await row.locator('.u-agent-own').count(), expect === 'Oscar' ? 1 : 0, label + ': the agent\'s own sigil');
  if (expect === 'Oscar') {
    assert.equal(await row.getAttribute('aria-label'), 'Chat with Oscar', label + ': read out with the name');
    const ink = await row.locator('.u-agent-own').evaluate(el => [el.style.getPropertyValue('--ag-h'), el.dataset.agent, getComputedStyle(el).color]);
    assert.equal(ink[1], 'oscar', label + ': Oscar\'s sigil');
    assert.ok(Math.abs(Number(ink[0]) - 61) < 15, label + ': Oscar\'s orange hue ' + ink[0]);
  }
  // The Reports row keeps its own name and face.
  assert.equal(await page.locator('.u-agent-row[data-mode="reports"] strong').textContent(), 'Reports', label + ': Reports keeps its name');
  await shot('1-list');
  await row.click();
  const head = page.locator('#unified-inbox .u-agent-head');
  await head.waitFor({timeout: 5000});
  await page.waitForTimeout(800);
  assert.equal(await head.locator('.u-who-text strong').textContent(), expect, label + ': the chat\'s title');
  assert.equal(await head.locator('.u-agent-own').count(), expect === 'Oscar' ? 1 : 0, label + ': the header sigil');
  assert.equal(await page.locator('#unified-inbox .u-ac-field').count(), 1, label + ': still the note composer');
  await shot('2-chat');
  if (!on) assert.equal(hits.service, 0, label + ': the Agent Service is never asked with the switch off');
  assert.deepEqual(errors, [], label + ' page errors');
  await ctx.close();
  return {label, name: expect, asked: hits.service};
}

(async () => {
  const browser = await chromium.launch();
  try {
    const results = [];
    results.push(await run(browser, 'phone-on', {on: true}, {width: 390, height: 780}));
    results.push(await run(browser, 'desktop-on', {on: true}, {width: 1280, height: 800}));
    results.push(await run(browser, 'phone-off', {on: false}, {width: 390, height: 780}));
    results.push(await run(browser, 'phone-unknown', {on: true, service: null, levels: [LEVELS[0]]}, {width: 390, height: 780}));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
