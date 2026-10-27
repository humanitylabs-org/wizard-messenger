// Self-contained (no server, no owner data). The phone fingerprint prompt must wait until Messenger is actually on
// screen and Wizard says it is in front: Wizard loads apps in the background after a reload, and James got a fingerprint prompt for Messenger on his
// chat screen before he had opened it (James, 27 Oct 2026). Opening Messenger then asks once, by itself.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const shell = process.env.SHELL_DIR || path.join(process.env.HOME, 'apps/wizard-os-home');
  const dir = process.env.STATIC_DIR || path.join(__dirname, '..', 'static');
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}});
  await ctx.addInitScript(() => {
    if (window === window.top) return;
    window.__opens = 0; addEventListener('error', e => console.log('frame-error', e.message));
    const vault = {has: async () => ({available: true, saved: true}), open: async () => { window.__opens++; parent.postMessage('vault-open', '*'); throw Object.assign(new Error('cancelled'), {code: 'cancelled'}); }};
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v, vault, view: {isVisible: () => !!parent.front}}); }});
  });
  await ctx.route('http://wizard.test/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({contentType: 'text/html', body: `<!doctype html><body style="margin:0">
      <div id="chats" style="height:100vh">Chats</div>
      <div id="desk" style="position:fixed;inset:0;transform:translateX(100%)"><iframe id="m" src="/messenger/" style="width:100%;height:100%;border:0"></iframe></div>
      <script>window.opens=0;window.front=false;addEventListener('message',e=>{if(e.data==='vault-open')window.opens++;});</script></body>`});
    if (u.pathname.startsWith('/wizard-os-home/core/')) { const c = path.join(shell, 'web/core', path.basename(u.pathname)); return route.fulfill({contentType: 'text/javascript', body: fs.existsSync(c) ? fs.readFileSync(c) : ''}); }
    if (u.pathname === '/messenger/api/view/session') return route.fulfill({status: 401, contentType: 'application/json', body: JSON.stringify({error: {code: 'session_unlock_required'}})});
    if (u.pathname.startsWith('/messenger/api/')) return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result: {enabled: false}, enabled: false})});
    const f = u.pathname === '/messenger/' ? 'index.html' : u.pathname.replace('/messenger/', '');
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({contentType: f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(p)});
  });
  const page = await ctx.newPage(), errors = [];
  if (process.env.DEBUG) page.on('request', r => console.log('req', r.url()));
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (/frame-error/.test(m.text())) errors.push(m.text()); });
  await page.goto('http://wizard.test/');
  const frame = page.frameLocator('#m');
  await frame.locator('#gate-title', {hasText: 'Unlock Messenger'}).waitFor({state: 'attached', timeout: 10000}).catch(async e => { console.log('gate', await frame.locator('#gate').innerText().catch(x => x.message)); throw e; });
  await page.waitForTimeout(2500);
  assert.equal(await page.evaluate(() => opens), 0, 'no fingerprint prompt while Messenger sits off screen');
  // A parked desk (loaded, not rendered: the shell's content-visibility) in place still does not ask.
  await page.evaluate(() => { const d = document.getElementById('desk'); d.style.contentVisibility = 'hidden'; d.style.transform = 'none'; });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => opens), 0, 'no prompt while parked');
  await page.evaluate(() => { const d = document.getElementById('desk'); d.style.contentVisibility = ''; d.style.transform = 'translateX(100%)'; });
  await page.waitForTimeout(300);
  // The real phone case: Messenger's window is laid out on screen, but Wizard has Chats in front of it.
  await page.evaluate(() => { document.getElementById('desk').style.transform = 'none'; });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => opens), 0, 'no prompt while Wizard has another window in front');
  // James opens Messenger: Wizard puts it in front.
  await page.evaluate(() => { window.front = true; });
  for (let i = 0; i < 40 && !(await page.evaluate(() => opens)); i++) await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => opens), 1, 'opening Messenger asks for the fingerprint once, by itself');
  // Sliding away and back does not ask again (the passphrase or the button remain).
  await page.evaluate(() => { window.front = false; document.getElementById('desk').style.transform = 'translateX(100%)'; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.front = true; document.getElementById('desk').style.transform = 'none'; });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => opens), 1, 'no repeat prompt');
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('pass fingerprint_on_open_browser');
})().catch(e => { console.error(e); process.exit(1); });
