// Messenger share receiver proof on a disposable loopback preview (never the owner's Messenger).
// Candidate unified.js is routed in; chat rows are injected; every send is intercepted and must stay zero.
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const BASE = process.env.PREVIEW_URL || 'https://localhost:19253/';
const MSG = process.env.MSG_DIR, OUT = process.env.OUT;
const miguel = { id: 'p1', display_name: 'Miguel', identities: [{ id: 'i1', network: 'telegram', label: '@miguel' }], last: { text: 'hey', timestamp: 2000 }, unread: 0 };
const novaire = { id: 'p2', display_name: 'Novaire', identities: [{ id: 'i2', network: 'whatsapp', label: '+66' }], last: { text: 'yo', timestamp: 1000 }, unread: 0 };
const team = { id: 'g1', display_name: 'AI Wizards team', identities: [{ id: 'i3', network: 'telegram', label: 'group', kind: 'group' }], last: { text: 'ok', timestamp: 3000 }, unread: 0 };
const ok = result => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
(async () => {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, colorScheme: 'dark' });
  await ctx.route('**/unified.js*', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(MSG + '/static/unified.js', 'utf8') }));
  const sends = [];
  await ctx.route(/api\/unified\//, async route => {
    const req = route.request(), u = new URL(req.url()), path = u.pathname.replace(/^.*api\/unified\//, '');
    if (/\/(send|preview|upload)$/.test(path)) { sends.push(path); return route.fulfill(ok({ id: 'x' })); }
    if (path === 'people' && req.method() === 'GET') return route.fulfill(ok({ people: [miguel, novaire], seq: 0 }));
    if (path === 'groups' && req.method() === 'GET') return route.fulfill(ok({ groups: [team], seq: 0 }));
    if (path === 'directory') return route.fulfill(ok({ people: [miguel, novaire], groups: [team] }));
    const m = path.match(/^people\/(p1|p2|g1)$/);
    if (m && req.method() === 'GET') { const person = { p1: miguel, p2: novaire, g1: team }[m[1]]; return route.fulfill(ok({ person, messages: [], has_more: false, seq: 0 })); }
    if (/^people\/\w+\/(read|typing)$/.test(path)) return route.fulfill(ok({}));
    if (path.startsWith('updates')) return new Promise(() => {}); // hold the change feed open
    return route.continue();
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE); await p.locator('.u-person').first().waitFor({ state: 'visible', timeout: 30000 });
  await p.evaluate(() => sessionStorage.removeItem('messenger-unified-drafts'));
  const results = [];
  const step = (n, c, x = '') => { results.push(c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' · ' + x : '')); };

  const rows = await p.evaluate(() => window.MessengerUnified.shareTargetRows());
  step('direct targets = recent chats, most recent first, groups labelled', rows.map(r => r.name + ':' + r.detail).join() === 'AI Wizards team:Group,Miguel:Telegram,Novaire:Whatsapp', JSON.stringify(rows));

  // With a person: opens Miguel's chat, text sits in his composer, nothing sent.
  let r = await p.evaluate(() => window.MessengerUnified.receiveShare({ id: 'sh1', text: 'Look at this', url: 'https://example.com/x', target: 'p1' }));
  await p.locator('.u-composer textarea').waitFor({ state: 'visible' }); await p.waitForTimeout(600);
  let v = await p.locator('.u-composer textarea').inputValue();
  let head = await p.evaluate(() => document.querySelector('.u-thread-head, .u-head, header')?.textContent || document.body.innerText.slice(0, 80));
  await p.screenshot({ path: OUT + '/msg-miguel-composer.png' });
  step('share to Miguel → his chat open with text in composer', r === true && v === 'Look at this\nhttps://example.com/x' && /Miguel/.test(head), JSON.stringify({ r, v }));
  step('nothing sent', sends.length === 0);

  // Second share to the same person appends, never overwrites the draft.
  await p.evaluate(() => window.MessengerUnified.receiveShare({ id: 'sh2', text: 'and this', target: 'p1' })); await p.waitForTimeout(600);
  v = await p.locator('.u-composer textarea').inputValue();
  step('second share appends to the existing draft', v === 'Look at this\nhttps://example.com/x\n\nand this', JSON.stringify(v));

  // No person: Send to… picker, pick Novaire → her composer has it.
  await p.evaluate(() => { window.__settled = 'open'; Promise.resolve(window.MessengerUnified.receiveShare({ id: 'sh3', text: 'pick me', target: null })).then(v => { window.__settled = v; }); });
  r = true;
  await p.locator('.u-directory-row').first().waitFor({ state: 'visible' });
  const title = await p.evaluate(() => document.querySelector('.u-overlay')?.innerText.split('\n')[0]);
  await p.screenshot({ path: OUT + '/msg-send-to.png' });
  step('no person → "Send to…" picker', r === true && /Send to/.test(title || ''), title);
  await p.locator('.u-directory-row', { hasText: 'Novaire' }).click(); await p.waitForTimeout(800);
  v = await p.locator('.u-composer textarea').inputValue();
  step('pick Novaire → text in her composer, receive settles true only now', v === 'pick me' && (await p.evaluate(() => window.__settled)) === true, JSON.stringify(v));
  // Picker closed without choosing: settles (owner declined), nothing placed or sent.
  await p.evaluate(() => { window.__settled = 'open'; Promise.resolve(window.MessengerUnified.receiveShare({ id: 'sh4', text: 'never mind', target: null })).then(v => { window.__settled = v; }); });
  await p.locator('.u-directory-row').first().waitFor({ state: 'visible' });
  const before = await p.evaluate(() => window.__settled);
  await p.locator('.u-overlay header button').click(); await p.waitForTimeout(300);
  step('picker open = still pending; closing it settles', before === 'open' && (await p.evaluate(() => window.__settled)) === true, String(before));

  // Back unwinds: thread → list; root stays in the app.
  await p.goBack(); await p.waitForTimeout(500);
  step('Back leaves the thread to the list (app stays)', (await p.locator('.u-timeline').count()) === 0 && p.url().startsWith(BASE));
  step('still nothing sent; zero page errors', sends.length === 0 && errs.length === 0, errs.join(' | '));
  await b.close();
  const fail = results.filter(x => !x).length; console.log(JSON.stringify({ pass: results.length - fail, fail })); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
