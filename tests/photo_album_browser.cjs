// Loopback disposable preview; album rendering, viewer, selection, two skins.
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  assert.match(new URL(base).hostname, /^(localhost|127\.0\.0\.1)$/);
  const out = process.env.OUT || 'voicefix/albums'; fs.mkdirSync(out, {recursive: true});
  const b = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await b.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true, ignoreHTTPSErrors: true});
  const person = {id: 'album-fixture', display_name: 'Album preview', identities: [{id: 'album-id', network: 'telegram'}], last: {text: 'Photos', timestamp: 1000}, unread: 0};
  let rows = [], uploads = [], sends = []; const shares = [], reactions = [];
  await ctx.exposeBinding('__albumShare', (_, data) => {shares.push(data); return 'sent';});
  await ctx.addInitScript(() => {let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) {app = Object.freeze({...v, share: {...v.share, wizard: async data => window.__albumShare({files: data.files.length, text: data.text})}});}});});
  const ok = result => ({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
  await ctx.route(/api\/unified\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^.*api\/unified\//, '');
    if (path === 'people') return route.fulfill(ok({people: [person], seq: 1}));
    if (path === 'groups') return route.fulfill(ok({groups: [], seq: 1}));
    if (path === 'people/album-fixture') return route.fulfill(ok({person, messages: rows, has_more: false, seq: 1}));
    if (path.endsWith('/react')) { const id = decodeURIComponent(path.split('/')[1]); reactions.push(id); const m = rows.find(r => r.id === id); m.reactions = []; return route.fulfill(ok({message: m})); }
    if (path.includes('updates')) return new Promise(() => {});
    if (path.endsWith('/upload')) { uploads.push(route.request().postDataBuffer().length); return route.fulfill(ok({upload_id: 'u' + uploads.length})); }
    if (path.endsWith('/send')) { sends.push(JSON.parse(route.request().postData())); return route.fulfill(ok({state: 'sent'})); }
    if (path.includes('media/')) {
      const n = Number(decodeURIComponent(path).match(/photo-(\d+)/)?.[1] || 0);
      const colors = ['#608a96','#ddb586','#ad7698','#6d8a68'];
      return route.fulfill({status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${colors[n % 4]}"/><circle cx="420" cy="140" r="65" fill="#f9e7bc"/><path d="M0 480L240 160L410 480L500 280L640 480" fill="#263f50"/></svg>`});
    }
    if (/(read|typing)$/.test(path)) return route.fulfill(ok({}));
    return route.continue();
  });
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const ticket = JSON.parse(execFileSync('curl', ['-sf','-X','POST','-H','Authorization: Bearer ' + process.env.MESSENGER_API_TOKEN,'-H','Content-Type: application/json','-d','{"bootstrap":true}','http://127.0.0.1:19252/api/view/ticket'])).result.ticket;
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(1000);
  if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.locator('#confirm-passphrase').waitFor({state: 'visible'});
  const pw = 'disposable-album-fixture-' + Date.now(); await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet');
  await page.click('#inbox-tabs [data-tab="people"]');
  async function show(n, incoming = false) {
    rows = Array.from({length: n}, (_, i) => ({id: '$photo-' + i, album: incoming ? 'telegram:1234567890123456789' : 'matrix:$album', identity_id: 'album-id', network: 'telegram', sender: incoming ? 'Album preview' : 'You', outgoing: !incoming,
      original: i === 0 ? 'A few photos, one post.' : '', timestamp: Date.now() - 10000, msgtype: 'm.image', media: {w: 640, h: 480, mime: 'image/jpeg'}, reactions: []}));
    if (incoming) rows[1].reactions = [{key: '👍', count: 1, mine: true}];
    await page.evaluate(() => {sessionStorage.clear(); localStorage.clear();}); await page.reload();
    await page.locator('.u-person', {hasText: 'Album preview'}).click();
    await page.locator('.u-album .u-media').nth(n - 1).waitFor();
    assert.equal(await page.locator('.u-message').count(), 1, n + ' photos = one post');
    assert.equal(await page.locator('.u-message footer').count(), 1, 'one timestamp/receipt');
    assert.equal(await page.locator('.u-message .u-text').count(), 1, 'one caption');
    const rects = await page.locator('.u-album .u-media').evaluateAll(els => els.map(el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
    assert(rects.every(r => r.w > 100 && r.x >= 0 && r.x + r.w <= 390), 'tiles stay on phone');
    if (n === 2) assert.equal(rects[0].y, rects[1].y);
    if (n === 3) assert(rects[0].h > rects[1].h * 1.9, '3 photos = one tall plus two');
    if (n === 4) assert.equal(rects[2].y, rects[3].y);
    await page.waitForTimeout(300);
    await page.screenshot({path: out + '/album-' + n + (incoming ? '-incoming' : '') + '-dark.png'});
  }
  for (const n of [2,3,4,10]) {
    await show(n);
    if (n === 3) {
      await page.locator('.u-album .u-media').nth(1).click();
      await page.locator('.u-viewer').waitFor();
      assert.match(await page.locator('.u-viewer img').getAttribute('src'), /photo-1/);
      await page.locator('.u-viewer [aria-label="Close"]').click();
      const tile = page.locator('.u-album .u-media').nth(2), box = await tile.boundingBox();
      const touch = await ctx.newCDPSession(page);
      await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: box.x+20, y: box.y+20}]});
      await page.waitForTimeout(600);
      await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      await page.locator('.u-selection strong').waitFor();
      assert.equal(await page.locator('.u-selection strong').innerText(), '1 selected', 'long hold selects the album once');
      assert.equal(await page.locator('.u-row.u-selected').count(), 1);
      assert.equal(await page.locator('.u-viewer').count(), 0, 'hold does not open viewer');
      await page.screenshot({path: out + '/album-selected-dark.png'});
      await page.getByRole('button', {name: 'Forward to Wizard', exact: true}).click();
      for (let i=0; i<50 && shares.length===0; i++) await page.waitForTimeout(50);
      assert.equal(shares.length, 1, 'one album forward'); assert.equal(shares[0].files, 3, 'all photos forwarded');
      assert.equal((shares[0].text.match(/A few photos, one post\./g) || []).length, 1, 'caption appears once, with existing sender/date attribution');
      await page.evaluate(() => {document.documentElement.style.setProperty('--bubble-in','#f0e9dc'); document.documentElement.style.setProperty('--ink','#18252c'); document.documentElement.style.setProperty('--bg','#faf7f0'); document.documentElement.style.setProperty('--surface','#f2ebdf');});
      await page.screenshot({path: out + '/album-3-warm.png'});
      await page.evaluate(() => { for (const token of ['--bubble-in','--ink','--bg','--surface']) document.documentElement.style.removeProperty(token); });
    }
    await page.locator('.u-thread-head [aria-label="Back"]').click();
  }
  await show(3, true);
  await page.locator('.u-reactions .u-react').click();
  for (let i=0; i<50 && reactions.length===0; i++) await page.waitForTimeout(50);
  assert.deepEqual(reactions, ['$photo-1'], 'received reaction on extra part targets that part');
  await page.locator('.u-thread-head [aria-label="Back"]').click();
  // Same id from a different sender must never merge; ordinary single photo unchanged.
  rows = rows.slice(0,2); rows[1] = {...rows[1], sender: 'Someone else'};
  await page.evaluate(() => {sessionStorage.clear(); localStorage.clear();}); await page.reload();
  await page.locator('.u-person', {hasText: 'Album preview'}).click();
  assert.equal(await page.locator('.u-message').count(), 2);
  assert.equal(await page.locator('.u-album').count(), 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(out + '/receipt.json', JSON.stringify({tests: ['2/3/4/10 one bubble','one caption/footer','viewer exact photo','long hold one selection','received grouped_id','different sender isolation','single photo intact','two skins'], errors}, null, 2));
  console.log('PASS photo_album_browser'); await b.close();
})().catch(e => {console.error(e.stack); process.exit(1);});
