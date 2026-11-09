// Issue 146 (Miguel, 10 Nov 2026): reacting to a message that is not at the bottom jumped the chat to the top.
// A long synthetic thread, scrolled up into the middle: an own reaction (picker), a reaction that arrives from the
// server (change feed) and an edit must all leave scrollTop where it was. Synthetic loopback only, no owner data.
// PLAYWRIGHT_MODULE=<playwright> [BROWSER=webkit] node tests/reaction_scroll_browser.cjs [outdir]
// WebKit (the Mac app and iPhone) is where the jump showed: it dropped the scroll position when the list was replaced.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), engine = pw[process.env.BROWSER || 'chromium'];
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'reaction-scroll-shots'); fs.mkdirSync(out, {recursive: true});
  const person = {id: 'fixture', display_name: 'Scroll preview', identities: [{id: 'fixture-telegram', network: 'telegram'}], last: {text: 'Synthetic preview only', timestamp: Date.now()}};
  const now = Date.now();
  const rows = Array.from({length: 80}, (_, i) => ({id: 'm' + i, network: 'telegram', identity_id: 'fixture-telegram', sender: i % 3 ? 'Preview' : undefined,
    outgoing: i % 3 === 0, timestamp: now - (80 - i) * 600000, msgtype: 'm.text', original: 'Synthetic message number ' + i + (i % 4 ? '' : ' with a longer line that wraps onto a second row in the bubble'), reactions: []}));
  let seq = 1, pushes = [], waiter = null; const errors = [];
  const push = r => { pushes.push(r); if (waiter) { const w = waiter; waiter = null; w(); } };
  const fixtureJS = `window.WizardApp={update:{hold:()=>({release(){}})},share:{targets:()=>Promise.resolve(),check:()=>Promise.resolve()}}; document.getElementById('gate').hidden=true; MessengerUnified.mount({api:async(p,o={})=>{const r=await fetch('/'+p,{...o,body:o.body===undefined?undefined:JSON.stringify(o.body),headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok)throw Error(d.error);return d.result;}}); MessengerUnified.authenticated();`;
  const browser = await engine.launch({headless: true, executablePath: process.env.BROWSER ? undefined : process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const parser = await browser.newPage();
  const fixtureHTML = await parser.evaluate(source => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    doc.querySelectorAll('script').forEach(el => el.remove());
    for (const src of ['/unified.js', '/fixture.js']) { const script = doc.createElement('script'); script.src = src; script.defer = true; doc.head.append(script); }
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }, fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  await parser.close();
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname, send = (body, type = 'application/json', status = 200) => { res.writeHead(status, {'Content-Type': type}); res.end(body); }, ok = result => send(JSON.stringify({ok: true, result}));
    if (pathname.includes('/updates')) {
      if (!pushes.length) await new Promise(r => { waiter = r; req.on('close', r); });
      const r = pushes.shift(); if (!r) return res.end(); seq++; return ok({seq, ...r});
    }
    if (pathname === '/api/unified/people') return ok({people: [person], seq});
    if (pathname === '/api/unified/groups') return ok({groups: [], seq});
    if (pathname === '/api/unified/people/fixture') return ok({person, messages: rows, seq, has_more: false});
    if (pathname.endsWith('/react')) {
      let body = ''; for await (const chunk of req) body += chunk; const key = JSON.parse(body).key, id = decodeURIComponent(pathname.split('/').at(-2));
      const m = rows.find(m => m.id === id); m.reactions = [{key, count: 1, mine: true}]; return ok({message: m});
    }
    if (pathname.startsWith('/api/')) return ok({});
    if (pathname === '/fixture.js') return send(fixtureJS, 'text/javascript');
    if (pathname === '/') return send(fixtureHTML, 'text/html');
    const name = pathname.slice(1); if (!['app.css', 'unified.css', 'unified.js', 'favicon.svg', 'icon-192.png'].includes(name)) { res.writeHead(404); return res.end(); }
    send(fs.readFileSync(path.join(root, name)), name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'image/svg+xml');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}/`;
  const summary = [];
  try {
    for (const [label, viewport, mobile] of [['phone', {width: 390, height: 844}, true], ['desktop', {width: 1280, height: 860}, false]]) {
      for (const r of rows) r.reactions = [];
      const context = await browser.newContext({viewport, ...(engine.name() === 'firefox' ? {} : {isMobile: mobile}), hasTouch: mobile, deviceScaleFactor: 1});
      await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(url); await page.locator('.u-person').click(); await page.locator('.u-message').first().waitFor(); await page.waitForTimeout(500);
      const sc = '.u-timeline';
      const top = () => page.$eval(sc, e => e.scrollTop);
      // Scroll up into the middle of the thread, well away from the bottom.
      await page.$eval(sc, e => { e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) * 0.45); });
      await page.waitForTimeout(300);
      const start = await top(); assert.ok(start > 400, 'scrolled into the middle: ' + start);
      // The jump the issue describes: replacing every child of the timeline drops the scroll position (scrollTop
      // clamps to 0 while the list is empty). Emulate that engine behaviour, so the test holds on every engine.
      await page.evaluate(sel => {
        const real = Element.prototype.replaceChildren; window.__replaced = 0;
        Element.prototype.replaceChildren = function (...a) { real.apply(this, a); if (this.matches(sel)) { window.__replaced++; this.scrollTop = 0; } };
        window.__mark = () => { window.__rows = [...document.querySelectorAll(sel + ' > .u-row')]; };
        window.__stillThere = () => window.__rows.filter(e => e.isConnected).length / window.__rows.length;
        window.__mark();
      }, sc);
      // An own reaction on a message in view, from the long-press/right-click menu.
      const target = await page.evaluate(sel => { const sc = document.querySelector(sel), box = sc.getBoundingClientRect(); const el = [...sc.querySelectorAll('.u-message')].find(e => { const r = e.getBoundingClientRect(); return r.top > box.top + 80 && r.bottom < box.bottom - 80; }); return el && el.querySelector('.u-text').textContent; }, sc);
      assert.ok(target, 'a message in the middle of the view');
      const msg = page.locator('.u-message .u-text', {hasText: target}).first();
      if (mobile) await msg.tap(); else await msg.click({button: 'right'});
      await page.getByRole('button', {name: 'More reactions', exact: true}).click(); await page.locator('.u-grid').waitFor();
      await page.getByRole('button', {name: '😁', exact: true}).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.u-react.mine')].some(e => e.textContent.includes('😁')), {}, {timeout: 2000});
      await page.waitForTimeout(600);
      const afterOwn = await top(); await page.screenshot({path: path.join(out, label + '-own-reaction.png')});
      assert.ok(Math.abs(afterOwn - start) <= 4, `own reaction keeps the place (${start} -> ${afterOwn})`);
      assert.ok(await page.evaluate(() => window.__stillThere()) > 0.95, 'a reaction swaps one bubble, the rest of the list stays in the DOM');
      assert.equal(await page.evaluate(() => window.__replaced), 0, 'a reaction never replaces the whole list');
      // A reaction from someone else arrives through the change feed.
      const other = rows.find(r => r.original === target) ? rows[rows.findIndex(r => r.original === target) - 1] : rows[30];
      push({messages: {fixture: [{...other, reactions: [{key: '👍', count: 1, mine: false}]}]}});
      await page.waitForFunction(() => document.querySelectorAll('.u-react').length >= 2, {}, {timeout: 5000}); await page.waitForTimeout(300);
      const afterFeed = await top();
      assert.ok(Math.abs(afterFeed - afterOwn) <= 4, `a reaction from the server keeps the place (${afterOwn} -> ${afterFeed})`);
      // An edit arriving from the server repaints in place too.
      const edited = rows[35]; push({messages: {fixture: [{...edited, original: edited.original + ' (edited)', edited: true}]}});
      await page.locator('.u-message .u-text', {hasText: '(edited)'}).first().waitFor({timeout: 5000}); await page.waitForTimeout(300);
      const afterEdit = await top();
      assert.ok(Math.abs(afterEdit - afterFeed) <= 4, `an edit from the server keeps the place (${afterFeed} -> ${afterEdit})`);
      // A new message at the bottom changes the list's shape (a whole-list replace): the place is put back.
      const fresh = {...rows[79], id: 'new-1', original: 'A brand new message at the bottom', timestamp: Date.now(), reactions: []};
      push({messages: {fixture: [fresh]}});
      await page.locator('.u-message .u-text', {hasText: 'A brand new message'}).waitFor({state: 'attached', timeout: 5000}); await page.waitForTimeout(300);
      const afterNew = await top();
      assert.ok(await page.evaluate(() => window.__replaced) >= 1, 'a new message replaced the list (the restore path ran)');
      assert.ok(Math.abs(afterNew - afterEdit) <= 4, `a new message while scrolled up keeps the place (${afterEdit} -> ${afterNew})`);
      summary.push(`${label}: ${start} -> ${afterOwn} -> ${afterFeed} -> ${afterEdit} -> ${afterNew}`);
      await context.close();
    }
    assert.deepEqual(errors.filter(e => !/ResizeObserver loop/.test(e)), [], 'no page errors');
    console.log(JSON.stringify({result: 'PASS', summary}));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.stack); process.exit(1); });
