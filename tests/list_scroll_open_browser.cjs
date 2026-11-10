// Issue 152: the chat list jumped back to the top a second after a chat opened. It should stay where it was scrolled.
// A long synthetic chat list, scrolled down: open a chat, then the change feed brings the read mark (and a new
// message in another chat) about a second later. On desktop the list beside the chat must keep its scrollTop; on a
// phone, Back must put the list back where it was. Synthetic loopback only, no owner data.
// PLAYWRIGHT_MODULE=<playwright> [BROWSER=webkit] node tests/list_scroll_open_browser.cjs [outdir]
// Some engines (WebKit: the Mac app and iPhone) drop the scroll position when every child of a scroller is
// replaced, so the test emulates that engine for `.u-list` and holds on every engine.
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), engine = pw[process.env.BROWSER || 'chromium'];
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'list-scroll-shots'); fs.mkdirSync(out, {recursive: true});
  const now = Date.now();
  const people = Array.from({length: 60}, (_, i) => ({id: 'p' + i, display_name: 'Preview chat ' + i, identities: [{id: 'p' + i + '-telegram', network: 'telegram'}],
    unread: i % 5 === 0 ? 2 : 0, last: {text: 'Synthetic preview ' + i, timestamp: now - i * 600000}}));
  const thread = id => Array.from({length: 6}, (_, i) => ({id: id + '-m' + i, network: 'telegram', identity_id: id + '-telegram', sender: 'Preview',
    outgoing: false, timestamp: now - (6 - i) * 60000, msgtype: 'm.text', original: 'Synthetic message ' + i, reactions: []}));
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
    if (pathname === '/api/unified/people') return ok({people, seq});
    if (pathname === '/api/unified/groups') return ok({groups: [], seq});
    const m = pathname.match(/^\/api\/unified\/people\/(p\d+)$/);
    if (m) { const person = people.find(p => p.id === m[1]); return ok({person, messages: thread(person.id), seq, has_more: false}); }
    if (pathname.startsWith('/api/')) return ok({});
    if (pathname === '/fixture.js') return send(fixtureJS, 'text/javascript');
    if (pathname === '/') return send(fixtureHTML, 'text/html');
    const name = pathname.slice(1); if (!['app.css', 'unified.css', 'unified.js', 'favicon.svg', 'icon-192.png'].includes(name)) { res.writeHead(404); return res.end(); }
    send(fs.readFileSync(path.join(root, name)), name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'image/svg+xml');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${server.address().port}/`;
  const summary = [];
  try {
    for (const [label, viewport, mobile] of [['desktop', {width: 1280, height: 860}, false], ['phone', {width: 390, height: 844}, true]]) {
      const context = await browser.newContext({viewport, ...(engine.name() === 'firefox' ? {} : {isMobile: mobile}), hasTouch: mobile, deviceScaleFactor: 1});
      await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => { if (!/ResizeObserver loop/.test(e.message)) errors.push(e.message); });
      await page.goto(url); await page.locator('.u-person').nth(40).waitFor(); await page.waitForTimeout(400);
      const sc = '.u-list';
      await page.evaluate(sel => {
        const real = Element.prototype.replaceChildren; window.__replaced = 0;
        Element.prototype.replaceChildren = function (...a) { real.apply(this, a); if (this.matches(sel)) { window.__replaced++; if (!window.__real) this.scrollTop = 0; } };
      }, sc);
      const top = () => page.$eval(sc, e => e.scrollTop);
      if (process.env.NO_EMULATE) await page.evaluate(() => { window.__real = true; });
      await page.waitForFunction(sel => { const e = document.querySelector(sel); return e && e.scrollHeight > e.clientHeight + 800; }, sc);
      await page.$eval(sc, e => { e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) * 0.6); }); await page.waitForTimeout(250);

      const start = await top(); assert.ok(start > 400, 'list scrolled down: ' + start);
      const pick = await page.evaluate(sel => { const sc = document.querySelector(sel), box = sc.getBoundingClientRect(); const el = [...sc.querySelectorAll('.u-person')].find(e => { const r = e.getBoundingClientRect(); return r.top > box.top + 60 && r.bottom < box.bottom - 60; }); return el.dataset.pid; }, sc);
      const row = page.locator(`.u-person[data-pid="${pick}"]`);
      if (mobile) await row.tap(); else await row.click();
      await page.locator('.u-message').first().waitFor(); await page.waitForTimeout(300);
      // About a second later: the read mark for the opened chat and a new message in another chat arrive.
      const opened = people.find(p => p.id === pick), other = people[7];
      push({people: [{...opened, unread: 0, last_read_ts: now}, {...other, last: {text: 'Synthetic new message', timestamp: Date.now()}}]});
      await page.waitForTimeout(1200);
      if (!mobile) {
        const after = await top(); await page.screenshot({path: path.join(out, label + '-after-open.png')});
        assert.ok(await page.evaluate(() => window.__replaced) > 0, 'the change feed repainted the list');
        assert.ok(Math.abs(after - start) <= 4, `desktop: the list beside the open chat keeps its place (${start} -> ${after})`);
        // A feed reset (server restart) rebuilds the list beside the open chat: it keeps its place too.
        push({reset: true}); await page.waitForTimeout(1500);
        const afterReset = await top(); await page.screenshot({path: path.join(out, label + '-after-reset.png')});
        assert.ok(Math.abs(afterReset - start) <= 4, `desktop: a feed reset keeps the list's place (${start} -> ${afterReset})`);
        summary.push({label, start, after, afterReset});
      } else {
        await page.getByRole('button', {name: 'Back', exact: true}).first().click();
        await page.locator(sc).waitFor(); await page.waitForTimeout(400);
        const after = await top(); await page.screenshot({path: path.join(out, label + '-after-back.png')});
        assert.ok(Math.abs(after - start) <= 4, `phone: Back puts the list where it was (${start} -> ${after})`);
        summary.push({label, start, after});
      }
      await context.close();
    }
    assert.deepEqual(errors, [], 'no page errors');
    console.log(JSON.stringify({ok: true, engine: engine.name(), summary}));
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exit(1); });
