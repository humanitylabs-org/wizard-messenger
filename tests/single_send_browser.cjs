// Synthetic fixtures only. Run against a disposable loopback ViewServer, never an owner's Messenger.
// PREVIEW_URL=http://127.0.0.1:<port>/ PREVIEW_API_URL=http://127.0.0.1:<port>
// MESSENGER_API_TOKEN=<disposable token> STATIC_DIR=<checkout>/static EVIDENCE_DIR=<dir>
// Optional SHELL_DIR=<wizard shell>/web serves the real shared composer (Ctrl+Enter sends on touch).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const staticDir = process.env.STATIC_DIR || path.join(__dirname, '../static');
const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(staticDir, 'unified.js'))).digest('hex');

(async () => {
  const base = process.env.PREVIEW_URL, api = process.env.PREVIEW_API_URL, token = process.env.MESSENGER_API_TOKEN;
  assert.ok(base && api && token, 'set disposable PREVIEW_URL, PREVIEW_API_URL and MESSENGER_API_TOKEN');
  for (const url of [base, api]) assert.ok(['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'loopback fixture only');
  const evidence = process.env.EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, {recursive: true});
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const cases = [];
  try {
    for (const mode of ['double-tap', 'double-enter']) {
      const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
        colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: true, isMobile: true});
      try {
        await ctx.addInitScript(() => {
          let app;
          Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) {
            app = Object.freeze({...v, vault: {has: async () => ({available: false, saved: false})}, badge: {set: async () => true}});
          }});
        });
        const assets = [];
        // Mandatory: without this route a container may silently serve the old product code.
        await ctx.route(/\/(unified\.js|unified\.css)(\?|$)/, route => {
          const file = path.basename(new URL(route.request().url()).pathname); assets.push(file);
          return route.fulfill({status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css',
            body: fs.readFileSync(path.join(staticDir, file))});
        });
        await ctx.route('**/wizard-os-home/core/**', route => {
          const file = path.basename(new URL(route.request().url()).pathname);
          const local = process.env.SHELL_DIR && path.join(process.env.SHELL_DIR, 'core', file);
          return route.fulfill({status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: local && fs.existsSync(local) ? fs.readFileSync(local) : ''});
        });
        const person = {id: 'single-send-fixture', display_name: 'Single send fixture', unread: 0, labels: [],
          identities: [{id: 'fixture-telegram', kind: 'person', network: 'telegram', label: 'Synthetic Telegram'}],
          last: {text: 'Synthetic chat · no real account', timestamp: Date.now()}};
        const reply = (route, result) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
        const requests = [], delivered = [], draftRequests = [], errors = [];
        await ctx.route(/api\/unified\/(people|groups)(\?.*)?$/, route => reply(route, {people: [person], groups: [], seq: 1}));
        await ctx.route(/api\/unified\/people\/single-send-fixture\?limit=60$/, route => reply(route, {person, messages: [...delivered], has_more: false, seq: 1}));
        await ctx.route(/api\/unified\/people\/single-send-fixture\/(read|typing)$/, route => reply(route, {}));
        let draftRow = null, pendingDrafts = 0;
        await ctx.route('**/api/drafts**', async route => {
          const method = route.request().method(), body = method === 'POST' ? route.request().postDataJSON() : {};
          draftRequests.push({method, text: body.text}); pendingDrafts++;
          try {
            await delay(1500); // The exact pre-clear draft round-trip that exposed the phone double-send.
            if (method === 'POST') {
              draftRow = {id: 'd1', revision: (draftRow?.revision || 0) + 1, person_id: person.id,
                identity_id: body.identity_id || 'fixture-telegram', text: body.text || '', state: 'draft', attachments: []};
              return await reply(route, {draft: draftRow});
            }
            if (method === 'DELETE') { draftRow = null; return await reply(route, {}); }
            if (new URL(route.request().url()).pathname === '/api/drafts/d1') return await reply(route, {draft: draftRow});
            return await reply(route, {drafts: []});
          } finally { pendingDrafts--; }
        });
        await ctx.route(/api\/unified\/people\/single-send-fixture\/send$/, async route => {
          assert.equal(route.request().method(), 'POST');
          const body = route.request().postDataJSON(); requests.push(body);
          const message = {id: '$single-send-' + requests.length, client_id: body.client_id, outgoing: true, original: body.text,
            timestamp: Date.now(), network: 'telegram', msgtype: 'm.text', reactions: []};
          await delay(200); delivered.push(message); return reply(route, {message});
        });
        const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
        if (process.env.AGENT_STAGE_DIR) {
          const st = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_STAGE_DIR, 'state.json')));
          assert.equal(st.origin, new URL(base).origin, 'cookie must belong to this disposable fixture');
          await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: base}]);
          await page.goto(base);
        } else {
          const ticketResponse = await fetch(new URL('/api/view/ticket', api), {method: 'POST',
            headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify({bootstrap: true})});
          assert.equal(ticketResponse.status, 200);
          const ticket = (await ticketResponse.json()).result.ticket;
          await page.goto(base + '#ticket=' + ticket);
        }
        // Chats is the start screen; section tabs are hidden in current builds, so wait for the chat list itself.
    await page.locator('.u-person').first().waitFor({timeout: 60000});
        if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet');
        if (await page.locator('#inbox-tabs:not([hidden]) [data-tab="people"]').count()) await page.click('#inbox-tabs [data-tab="people"]');
        await page.locator('.u-person', {hasText: person.display_name}).click();
        const field = page.locator('.u-composer textarea'), send = page.locator('.u-compose-row > .u-send');
        await field.waitFor();
        // openPerson first paints cached data, then builds the actual server-backed composer.
        await page.waitForTimeout(1900);
        const text = mode === 'double-tap' ? 'One tap is one message.' : 'One Enter is one message.';
        await field.fill(text);
        const usesSharedComposer = await page.evaluate(() => !!window.WizComposerInput);
        const keyPath = mode === 'double-enter' ? (usesSharedComposer ? 'Control+Enter (touch Enter policy)' : 'form.requestSubmit (no shell composer)') : 'touchscreen.tap';
        let tap;
        if (mode === 'double-tap') {
          const box = await send.boundingBox(); assert.ok(box);
          tap = () => page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          tap = usesSharedComposer ? () => field.press('Control+Enter') : () => page.locator('.u-composer').evaluate(form => form.requestSubmit());
        }
        await tap(); await page.waitForTimeout(150);
        const settling = {disabled: await send.isDisabled(), busy: await send.getAttribute('aria-busy'),
          text: await field.inputValue(), sends: requests.length,
          draftPostStarted: draftRequests.some(r => r.method === 'POST')};
        // Do NOT locator.click a disabled button: Playwright would wait until it is enabled.
        // Coordinates send a real second touch now; the browser suppresses it on the fixed button.
        await tap();
        await page.waitForTimeout(8000); // Includes queued second save/send and slow draft deletion in the negative control.
        const bubbles = await page.locator('.u-message.outgoing').filter({hasText: text}).count();
        const empty = (await field.inputValue()) === '';
        if (evidence) await page.screenshot({path: path.join(evidence, mode === 'double-tap' ? 'messenger-single-send.png' : 'messenger-single-enter.png')});
        const checks = {
          checkoutAssets: ['unified.js', 'unified.css'].every(f => assets.includes(f)),
          // Two valid composer flows: the 15.9 flow settles the draft first (text still visible, Send must be locked),
          // and Miguel's send-at-once flow empties the box before any draft round-trip (nothing left to send twice).
          // Either way the second tap must find Send locked or the box empty.
          secondTapBlocked: (settling.draftPostStarted && settling.text === text && settling.sends === 0 && settling.disabled && settling.busy === 'true')
            || (settling.text === '' && settling.disabled),
          exactlyOneSend: requests.length === 1, exactlyOneOutgoingBubble: bubbles === 1,
          sentText: requests.every(r => r.text === text), empty, noPageErrors: errors.length === 0
        };
        cases.push({mode, keyPath, pass: Object.values(checks).every(Boolean), sends: requests.length, bubbles,
          uniqueClientIds: new Set(requests.map(r => r.client_id)).size, settling, checks, pageErrors: errors});
        // Drain delayed draft routes before closing the context (avoids abandoned fulfill promises).
        for (let i = 0; pendingDrafts && i < 30; i++) await page.waitForTimeout(100);
      } finally { await ctx.close(); }
    }
  } finally { await browser.close(); }
  const result = {pass: cases.length === 2 && cases.every(c => c.pass), sends: Math.max(...cases.map(c => c.sends)), sourceHash, cases};
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
