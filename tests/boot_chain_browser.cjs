// Issue 484: how many API round trips Messenger's first open waits on before the first chat row shows.
// Staged by tests/boot_chain_stage.py (real ViewServer + UnifiedInbox, made-up chats). Opens Messenger at phone size
// (412 px) in Chromium throttled like the issue (150 ms RTT, 1.6 Mbps down, 750 kbps up, 4x CPU), cold (empty cache)
// and then warm (same browser, second open), and prints for each: DOMContentLoaded, first chat row, and the API
// requests that the first row waited on, as a chain (a request that starts after another ended is one more round trip).
// AGENT_STAGE_DIR=<dir> python3 tests/boot_chain_stage.py <port> &  then  node tests/boot_chain_browser.cjs
// WIZARD_WEB_DIR=<wizard-ux>/web serves the shell's /wizard-os-home/ files. RUNS=<n> repeats (default 3).
// MAX_TRIPS=<n> fails when a run's chain is longer (default 1); MAX_COLD_MS / MAX_WARM_MS fail on the first-row time.
// UNTHROTTLED=1 skips the throttling. SHELL_RAW=1 / SHELL_ROUTE=1: see the gateway below. DEBUG=1 lists every API request.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), zlib = require('node:zlib');
const dir = process.env.AGENT_STAGE_DIR;
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const WEB = process.env.WIZARD_WEB_DIR, RUNS = +(process.env.RUNS || 3);
const MAX_TRIPS = +(process.env.MAX_TRIPS ?? 1), MAX_COLD = +(process.env.MAX_COLD_MS || 0), MAX_WARM = +(process.env.MAX_WARM_MS || 0);
let origin = st.origin;
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png'};

// Longest chain of API requests, each starting after the one before it ended, among those done before the first row.
function chain(reqs, before) {
  const done = reqs.filter(r => r.end != null && r.end <= before).sort((a, b) => a.start - b.start);
  const depth = new Map(), prev = new Map();
  for (const r of done) {
    let best = 0, from = null;
    for (const q of done) if (q !== r && q.end <= r.start + 1 && (depth.get(q) || 0) > best) { best = depth.get(q); from = q; }
    depth.set(r, best + 1); prev.set(r, from);
  }
  let last = null; for (const r of done) if (!last || depth.get(r) > depth.get(last)) last = r;
  const path = []; for (let r = last; r; r = prev.get(r)) path.unshift(r);
  return path;
}

async function open(ctx, label) {
  const page = await ctx.newPage(), cdp = await ctx.newCDPSession(page), reqs = new Map(), errors = [];
  if (!process.env.UNTHROTTLED) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8});
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
  }
  page.on('pageerror', e => errors.push(e.message));
  const t0 = Date.now();
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) reqs.set(r, {path: u.pathname, start: Date.now() - t0}); });
  page.on('requestfinished', r => { const x = reqs.get(r); if (x) x.end = Date.now() - t0; });
  page.on('requestfailed', r => { const x = reqs.get(r); if (x) x.end = Date.now() - t0; });
  await page.addInitScript(() => {
    window.__t = {};
    addEventListener('DOMContentLoaded', () => { window.__t.dcl = performance.now(); });
    const look = () => { if (!window.__t.row && document.querySelector('.u-person')) window.__t.row = performance.now(); };
    new MutationObserver(look).observe(document, {childList: true, subtree: true});
  });
  await page.goto(origin + '/');
  await page.locator('.u-person').first().waitFor({timeout: 30000});
  const t = await page.evaluate(() => window.__t);
  // performance.now() starts at navigation; the request clock starts just before goto. Close enough for ordering.
  const shift = await page.evaluate(() => performance.timeOrigin) - t0;
  const rows = [...reqs.values()].map(r => ({...r, start: r.start - shift, end: r.end == null ? null : r.end - shift}));
  const path = chain(rows, t.row);
  const afterDcl = path.filter(r => r.end > t.dcl);
  const result = {label, dcl: Math.round(t.dcl), row: Math.round(t.row), trips: path.length, tripsAfterDcl: afterDcl.length,
    chain: path.map(r => `${r.path} ${Math.round(r.start)}-${Math.round(r.end)}`), errors,
    all: rows.sort((a, b) => a.start - b.start).map(r => `${r.path} ${Math.round(r.start)}-${r.end == null ? '?' : Math.round(r.end)}`)};
  await cdp.detach().catch(() => {}); await page.close();
  return result;
}

(async () => {
  // A plain gateway in front of the stage, like Wizard's: Messenger under the same origin, the shell's /wizard-os-home/
  // files from WIZARD_WEB_DIR. A real server, not page.route, so the browser cache works as on a phone.
  const agent = new http.Agent({keepAlive: true});
  const gateway = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/wizard-os-home/')) {
      const f = WEB && path.join(WEB, u.pathname.replace(/^\/wizard-os-home\//, ''));
      if (!f || !f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      // Gzip-encoded when the browser accepts it, as any gateway that compresses would (Wizard's own serving of its
      // shell files is outside Messenger; SHELL_RAW=1 sends them as is).
      const body = fs.readFileSync(f), gz = !process.env.SHELL_RAW && /gzip/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, {'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000', ...(gz ? {'Content-Encoding': 'gzip'} : {})});
      return res.end(gz ? zlib.gzipSync(body, {level: 6}) : body);
    }
    const up = http.request({host: '127.0.0.1', port: st.port, path: req.url, method: req.method, headers: req.headers, agent}, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + gateway.address().port;
  const browser = await chromium.launch(), results = [];
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: origin}]);
    // SHELL_ROUTE=1: the shell's files come from outside the throttled network, as in the issue's own numbers (main:
    // DOMContentLoaded about 5.1 s, first row about 6.0 s). Playwright turns the HTTP cache off while it routes, so
    // the warm numbers then measure nothing; use it for cold opens only.
    if (process.env.SHELL_ROUTE) await ctx.route('**/wizard-os-home/**', r => {
      const f = WEB && path.join(WEB, new URL(r.request().url()).pathname.replace(/^\/wizard-os-home\//, ''));
      if (!f || !fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
      return r.fulfill({status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f)});
    });
    await ctx.addInitScript(() => { document.documentElement && (document.documentElement.dataset.wzHosted = ''); });
    results.push(await open(ctx, 'cold'), await open(ctx, 'warm'));
    await ctx.close();
  }
  await browser.close(); gateway.close(); agent.destroy();
  let bad = 0;
  for (const r of results) {
    console.log(`${r.label}: DOMContentLoaded ${r.dcl} ms, first row ${r.row} ms, API round trips before the row ${r.trips} (${r.tripsAfterDcl} after DOMContentLoaded)`);
    for (const c of r.chain) console.log('   ' + c);
    if (process.env.DEBUG) for (const c of r.all) console.log('     all: ' + c);
    if (r.errors.length) { console.log('   page errors: ' + r.errors.join(' | ')); bad++; }
    if (r.tripsAfterDcl > MAX_TRIPS) bad++;
    if (MAX_COLD && r.label === 'cold' && r.row > MAX_COLD) bad++;
    if (MAX_WARM && r.label === 'warm' && r.row > MAX_WARM) bad++;
  }
  const med = k => { const v = results.filter(r => r.label === k).map(r => r.row).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  console.log(`median first row: cold ${med('cold')} ms, warm ${med('warm')} ms (${os.cpus().length} CPUs)`);
  if (bad) { console.log('FAIL'); process.exit(1); }
  console.log('PASS');
})().catch(e => { console.error(e); process.exit(1); });
