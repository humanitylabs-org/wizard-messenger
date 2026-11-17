// Issue 204 (on for everyone, the switch device-auto-translate is gone): an auto-translate chat (Thai)
// shows incoming messages in English translated by the browser's built-in translator (stubbed here as Chrome's
// Translator/LanguageDetector), the box is asked with ?translate=device so it queues nothing for Tinfoil, and the
// reply's send preview carries this browser's Thai translation (on_device). A message the device can't read falls back
// to the box's one-message translate route. A stale stored `device-auto-translate: off` changes nothing. With no
// built-in translator the box (Tinfoil) translates. Synthetic API only, no container and no shell:
// PLAYWRIGHT_MODULE=... node tests/device_auto_translate_browser.cjs [outdir]
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'device-auto-translate-shots');
const L = require(path.join(root, 'app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'line', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'สวัสดี', timestamp: now - min, outgoing: false}, language: 'th', peer_read_ts: 0};
const msg = (id, original, t) => ({id, identity_id: 'ann-i', network: 'line', sender: 'Ann Lee', outgoing: false, original, translated: null, translation_error: null, msgtype: 'm.text', timestamp: now - t * min, timeline_order: 10 - t, reactions: []});
const MESSAGES = [msg('$thai', 'สวัสดีครับ เจอกันพรุ่งนี้', 3), msg('$odd', '¿¿??', 2), msg('$en', 'ok see you', 1)];
const DEVICE = {'สวัสดีครับ เจอกันพรุ่งนี้': ['th', 'Hello, see you tomorrow'], '¿¿??': ['und', null], 'ok see you': ['en', null], 'See you at noon': ['en', 'เจอกันตอนเที่ยง']};

async function run(browser, {stale, builtIn, tag}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark'});
  await ctx.addInitScript(([builtIn, DEVICE]) => {
    const noop = () => {};
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
    const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
    if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    window.deviceCalls = [];
    // Headless Chromium on an https origin has the APIs with no language packs: remove them for "no built-in translator".
    if (!builtIn) for (const k of ['Translator', 'LanguageDetector']) { try { delete window[k]; } catch {} try { Object.defineProperty(window, k, {value: undefined, configurable: true}); } catch {} }
    if (builtIn) {
      window.LanguageDetector = {create: async () => ({detect: async t => { deviceCalls.push(['detect', t]); return [{detectedLanguage: (DEVICE[t] || ['und'])[0], confidence: 0.9}]; }})};
      window.Translator = {availability: async () => 'available', create: async pair => { deviceCalls.push(['create', pair.sourceLanguage + '>' + pair.targetLanguage]); return {translate: async t => DEVICE[t][1]}; }};
    }
  }, [builtIn, DEVICE]);
  const page = await ctx.newPage(), errors = [], box = {timeline: [], translate: [], previews: []};
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contract: 'wizard.app-switches/1', switches: stale ? [{id: 'device-auto-translate', on: false}] : []})});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') {
      box.timeline.push(url.searchParams.get('translate'));
      // The box's own queue (Tinfoil) translates for a view that did not say ?translate=device.
      const tinfoil = url.searchParams.get('translate') !== 'device';
      return ok({person, messages: MESSAGES.map(m => ({...m, translated: tinfoil ? m.original + ' (Tinfoil)' : null})), has_more: false, next_cursor: null, seq: 5, typing: []});
    }
    if (p === 'api/unified/people/ann/preview') {
      const body = req.postDataJSON(); box.previews.push(body);
      return ok({id: 'pv1', original: body.text, translated: body.on_device ? body.translated : body.text + ' (Tinfoil)', error: null, identity_id: 'ann-i', language: 'th'});
    }
    if (p.endsWith('/translate')) { box.translate.push(p); return ok({id: '$odd', translated: '?? (Tinfoil)', error: null}); }
    if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const row = id => page.locator(`.u-row[data-id="${id}"]`);
  await row('$thai').waitFor({timeout: 15000});
  await page.waitForTimeout(1500); // the device queue has run
  const read = async id => ({text: (await row(id).locator('.u-text').textContent()).trim(), note: await row(id).locator('.u-on-device').count()});
  const shown = {thai: await read('$thai'), odd: await read('$odd'), en: await read('$en')};
  await page.screenshot({path: path.join(out, tag + '-thread.png')});
  await page.locator('.u-composer textarea').fill('See you at noon');
  await page.locator('.u-composer .u-send').first().click();
  await page.locator('.u-preview').first().waitFor({timeout: 10000});
  const preview = (await page.locator('.u-preview').first().textContent()).trim();
  await page.screenshot({path: path.join(out, tag + '-preview.png')});
  const deviceCalls = await page.evaluate(() => window.deviceCalls);
  await ctx.close();
  assert.deepEqual(errors, []);
  return {shown, preview, box, deviceCalls};
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const stale of [false, true]) {
    const local = await run(browser, {stale, builtIn: true, tag: stale ? 'stale-off-builtin' : 'builtin'});
    assert.deepEqual(local.box.timeline, ['device'], 'the box is told this view translates on the device');
    assert.deepEqual(local.shown.thai, {text: 'Hello, see you tomorrow', note: 1}, 'incoming Thai shows in English, translated here');
    assert.deepEqual(local.shown.en, {text: 'ok see you', note: 0}, 'English stays as is, with no model call');
    assert.deepEqual(local.box.translate, ['api/unified/messages/%24odd/translate'], 'only what the device cannot read goes to the box');
    assert.equal(local.shown.odd.text, '?? (Tinfoil)');
    assert.deepEqual(local.box.previews, [{text: 'See you at noon', identity_id: 'ann-i', translated: 'เจอกันตอนเที่ยง', on_device: true}]);
    assert.equal(local.preview, 'เจอกันตอนเที่ยง', 'the send preview is this browser\'s translation');
    assert.ok(local.deviceCalls.some(c => c[1] === 'en>th'));
    if (!stale) console.log(JSON.stringify(local));
    }
    for (const [name, opts] of [['none', {stale: false, builtIn: false}]]) {
      const r = await run(browser, {...opts, tag: name});
      assert.deepEqual(r.box.timeline, [null], name + ': the box queue translates as before');
      assert.deepEqual(r.shown.thai, {text: 'สวัสดีครับ เจอกันพรุ่งนี้ (Tinfoil)', note: 0}, name);
      assert.deepEqual(r.box.translate, [], name);
      assert.deepEqual(r.box.previews, [{text: 'See you at noon', identity_id: 'ann-i'}], name + ': the preview goes to Tinfoil');
      assert.deepEqual(r.deviceCalls, [], name + ': the built-in translator is not touched');
    }
    console.log('device auto-translate browser: ok');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
