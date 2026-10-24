// Run only against a fresh disposable preview, never an owner's Messenger.
// PREVIEW_URL=https://localhost:<tls-port>/ PREVIEW_API_URL=http://127.0.0.1:<api-port>
// MESSENGER_API_TOKEN=<disposable capability> node tests/send_restart_browser.cjs
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// Exercise the actual queue function's full retry budget without waiting two minutes.
async function exhaustedBudget() {
  const source = fs.readFileSync(path.join(__dirname, '../static/unified.js'), 'utf8');
  const queue = source.slice(source.indexOf('  const queues = {};'), source.indexOf('  async function editMsg('));
  const thread = {person: {identities: [{network: 'telegram'}]}, messages: []};
  const store = {threads: {p1: thread}, pending: 0};
  const requests = [], delays = [];
  let paintCount = 0;
  const sandbox = {store, s: {person: 'p1'}, uid: () => 'budget-test', hold() {},
    paintThread() { paintCount++; },
    call: async (_route, body) => { requests.push(body); throw Object.assign(new Error('gateway'), {code: 'server_restarting'}); },
    setTimeout(fn, delay) { delays.push(delay); queueMicrotask(fn); }};
  vm.createContext(sandbox);
  vm.runInContext(queue + '\nqueueSend("p1", {text: "budget fixture"}); globalThis.done = queues.p1;', sandbox);
  await sandbox.done;
  assert.equal(requests.length, 25, 'initial attempt plus 24 retries');
  assert.equal(delays.length, 24);
  assert.ok(delays.every(ms => ms === 5000));
  assert.equal(new Set(requests.map(r => r.client_id)).size, 1);
  assert.equal(thread.messages[0].pending, false);
  assert.equal(thread.messages[0].failed, 'Messenger was restarting');
  assert.equal(typeof thread.messages[0].retry, 'function');
  assert.equal(store.pending, 1, 'failed message still protects unsent work');
  assert.ok(paintCount > 0);
  assert.ok(source.includes("'Not sent · ' + m.failed + ' · Retry'"), 'friendly retry label uses failure reason');
  return {attempts: requests.length, waits: delays.length, friendlyText: 'Not sent · ' + thread.messages[0].failed + ' · Retry'};
}

(async () => {
  const budget = await exhaustedBudget();
  const base = process.env.PREVIEW_URL;
  const api = process.env.PREVIEW_API_URL;
  const token = process.env.MESSENGER_API_TOKEN;
  assert.ok(base && api && token, 'set disposable PREVIEW_URL, PREVIEW_API_URL and MESSENGER_API_TOKEN');
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'preview must be loopback');
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(api).hostname), 'ticket API must be loopback');
  const evidence = process.env.EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, {recursive: true});
  const browser = await chromium.launch({headless: true});
  try {
    const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
      colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: true, isMobile: true});
    await ctx.addInitScript(() => {
      let app;
      Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) {
        app = Object.freeze({...v, vault: {has: async () => ({available: false, saved: false})}, badge: {set: async () => true}});
      }});
      window.__sendFailures = [];
      const inspect = () => {
        const text = document.body?.textContent || '';
        if (/Failed to execute|Unexpected end of JSON|Not sent/.test(text)) window.__sendFailures.push(text);
      };
      new MutationObserver(records => {
        inspect();
        for (const r of records) for (const n of r.addedNodes) {
          if (/Failed to execute|Unexpected end of JSON|Not sent/.test(n.textContent || '')) window.__sendFailures.push(n.textContent);
        }
      }).observe(document, {subtree: true, childList: true, characterData: true});
    });
    const person = {id: 'restart-fixture', display_name: 'Restart fixture', unread: 0, labels: [],
      identities: [{id: 'fixture-telegram', kind: 'person', network: 'telegram'}], last: {text: 'fixture', timestamp: Date.now()}};
    const reply = (route, result) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    await ctx.route(/api\/unified\/(people|groups)(\?.*)?$/, route => reply(route, {people: [person], groups: [], seq: 1}));
    await ctx.route(/api\/unified\/people\/restart-fixture\?limit=60$/, route => reply(route, {person, messages: [], has_more: false, seq: 1}));
    await ctx.route(/api\/unified\/people\/restart-fixture\/read$/, route => reply(route, {}));
    const requests = [], sent = [];
    await ctx.route(/api\/unified\/people\/restart-fixture\/send$/, async route => {
      assert.equal(route.request().method(), 'POST');
      const body = route.request().postDataJSON(); requests.push(body);
      if (requests.length <= 2) return route.fulfill({status: 502, body: ''});
      const message = {id: '$restart-fixture', client_id: body.client_id, outgoing: true, original: body.text,
        timestamp: Date.now(), network: 'telegram', msgtype: 'm.text', reactions: []};
      sent.push(message); return reply(route, {message});
    });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ticketResponse = await fetch(new URL('/api/view/ticket', api), {method: 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify({bootstrap: true})});
    assert.equal(ticketResponse.status, 200);
    const ticket = (await ticketResponse.json()).result.ticket;
    await page.goto(base + '#ticket=' + ticket);
    await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
    // A fresh unified preview is usable without creating a Marmot account or a real login.
    if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet');
    await page.click('#inbox-tabs [data-tab="people"]');
    await page.locator('.u-person', {hasText: 'Restart fixture'}).click();
    await page.locator('.u-composer textarea').fill('send survives two empty gateway replies');
    await page.locator('.u-composer').evaluate(form => form.requestSubmit());
    const message = page.locator('.u-message', {hasText: 'send survives two empty gateway replies'});
    await message.waitFor({timeout: 10000});
    await page.waitForFunction(() => {
      const m = [...document.querySelectorAll('.u-message')].find(n => n.textContent.includes('send survives two empty gateway replies'));
      return m && !m.classList.contains('pending') && !m.classList.contains('failed');
    }, null, {timeout: 30000});
    assert.equal(requests.length, 3, 'two empty-body 502s then success');
    assert.equal(sent.length, 1);
    assert.ok(requests[0].client_id);
    assert.equal(new Set(requests.map(r => r.client_id)).size, 1, 'every retry retains the idempotency key');
    assert.ok(requests.every(r => r.text === requests[0].text));
    assert.equal(await message.count(), 1, 'echo replaces optimistic message');
    assert.equal(await page.locator('.u-message.failed, .u-retry').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__sendFailures), [], 'no transient failed/JSON-parse error text');
    assert.deepEqual(errors, []);
    if (evidence) await page.screenshot({path: path.join(evidence, 'send-recovered.png')});
    console.log(JSON.stringify({pass: true, browser: {attempts: requests.length, uniqueClientIds: new Set(requests.map(r => r.client_id)).size,
      deliveredMessages: sent.length, failedStates: 0, pageErrors: errors}, exhaustedBudget: budget}));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
