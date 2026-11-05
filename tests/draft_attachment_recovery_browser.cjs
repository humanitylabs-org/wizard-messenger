// Disposable synthetic ViewServer only; all provider I/O in agent_drafts_stage.py is mocked.
// Uses the actual shared Appearance host/client in an explicitly labelled hosted proxy, not owner data.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
// skins.css supplies shape, not palette variables: evaluate only the pinned palette table.
const skinSource = fs.readFileSync(path.join(process.env.SHELL_DIR, 'core/skins.js'), 'utf8');
const paletteTable = skinSource.slice(skinSource.indexOf('  const SKINS = ['), skinSource.indexOf('  // Each skin'));
const palettes = vm.runInNewContext('const T=o=>o;' + paletteTable + ';SKINS').filter(s => ['nebula', 'signal'].includes(s.id)).map(s => ({id:s.id,t:s.t}));
const st = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_STAGE_DIR, 'state.json')));
assert.equal(new URL(st.origin).hostname, '127.0.0.1');
const evidence = process.env.EVIDENCE_DIR; fs.mkdirSync(evidence, {recursive: true});
const pause = ms => new Promise(r => setTimeout(r, ms));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar};
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts;
const until = async (fn, label) => { for (let i = 0; i < 120; i++) { if (await fn()) return; await pause(100); } throw Error(label); };
(async () => {
  for (const d of await drafts()) await fetch(st.origin + '/api/drafts/' + d.id, {method: 'DELETE', headers: {...auth, 'Content-Type': 'application/json'}, body: JSON.stringify({revision: d.revision})});
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'dark', hasTouch: true, isMobile: true});
  const errors = [], sends = [], checks = []; let failNames = new Set(), failId = null, hold = true, held = false, release;
  const gate = new Promise(r => { release = r; });
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', route => {
    const rel = new URL(route.request().url()).pathname.replace('/wizard-os-home/', '');
    const p = path.resolve(process.env.SHELL_DIR, rel);
    assert.ok(p.startsWith(path.resolve(process.env.SHELL_DIR) + path.sep));
    return route.fulfill({status: fs.existsSync(p) ? 200 : 404, contentType: p.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.existsSync(p) ? fs.readFileSync(p) : ''});
  });
  await ctx.route('**/hosted-draft-qa', r => r.fulfill({contentType: 'text/html', body: `<!doctype html><html data-skin="nebula"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wizard-os-home/core/skins.css"><script>window.setFixtureSkin=id=>{const s=${JSON.stringify(palettes)}.find(s=>s.id===id);if(!s)throw Error('Unknown palette');for(const [k,v] of Object.entries(s.t))document.documentElement.style.setProperty('--'+k,v);document.documentElement.dataset.skin=id;window.WizAppearance?.sync()};setFixtureSkin('nebula')</script><script src="/wizard-os-home/core/appearance-host.js" defer></script><style>html,body{margin:0;width:100%;height:100%;background:var(--bg,#05030c)}.st-embed,iframe{display:block;width:100%;height:100%;border:0}</style></head><body><div class="st-embed"><iframe title="Synthetic Messenger" src="/"></iframe></div></body></html>`}));
  await ctx.route(/\/api\/drafts\/[^/]+\/attachments(?:\/[^/?]+)?(?:\?.*)?$/, async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'PUT') {
      if (hold) { hold = false; held = true; await gate; }
      if (failNames.has(u.searchParams.get('name'))) return route.fulfill({status: 507, contentType: 'application/json', body: JSON.stringify({ok: false, error: {code: 'storage_failed', message: 'Synthetic storage failure'}})});
    }
    if (req.method() === 'GET' && failId && u.pathname.endsWith('/' + failId)) return route.fulfill({status: 502, body: 'Synthetic open failure'});
    return route.continue();
  });
  await ctx.route(/\/api\/unified\/people\/[^/]+\/send$/, async route => { sends.push(route.request().postDataJSON()); await pause(200); return route.continue(); });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(st.origin + '/hosted-draft-qa');
    const frame = page.frameLocator('iframe');
    await frame.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const field = frame.locator('textarea[aria-label="Message"]'), input = frame.locator('.u-compose-row input[type=file]');
    await field.waitFor(); await page.waitForTimeout(1200); await field.fill('Synthetic three-photo caption');
    const bytes = await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 80; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#4875a8'; x.fillRect(0,0,80,60); return Array.from(new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer())); });
    const photo = n => ({name: 'synthetic-' + n + '.png', mimeType: 'image/png', buffer: Buffer.from(bytes)});
    await input.setInputFiles(photo(1)); await until(() => held, 'first PUT held');
    await input.setInputFiles([photo(2), photo(3)]); release();
    await until(async () => (await drafts()).some(d => d.attachments.length === 3), 'all three saved through strict revisions');
    assert.equal(await frame.locator('.u-draft-note.conflict').count(), 0); checks.push('overlapping selections saved');
    // Live re-dress of the same unsent composer with the real shared host and client (synthetic hosted proxy).
    const doc = await page.frames()[1].evaluate(() => window.__draftIdentity = Math.random());
    const skinProof = [];
    for (const skin of ['nebula', 'signal']) {
      await page.evaluate(s => window.setFixtureSkin(s), skin);
      await page.waitForFunction(s => { const i = document.querySelector('iframe'); return i.contentDocument.documentElement.dataset.skin === s && window.WizAppearance.inspect().some(f => f.acked); }, skin);
      const expected = palettes.find(s => s.id === skin).t['violet-2'];
      await page.frames()[1].waitForFunction(a => getComputedStyle(document.documentElement).getPropertyValue('--wz-accent').trim() === a, expected);
      const proof = await page.frames()[1].evaluate(() => ({skin:document.documentElement.dataset.skin, accent:getComputedStyle(document.documentElement).getPropertyValue('--wz-accent').trim(), base:getComputedStyle(document.documentElement).getPropertyValue('--wz-base').trim(), width:innerWidth}));
      proof.host = await page.evaluate(() => ({applied:WizAppearance.get(document.querySelector('iframe')),frames:WizAppearance.inspect()}));
      assert.equal(proof.accent, expected); assert.equal(proof.width, 390); assert.equal(proof.host.applied.skin, skin);
      skinProof.push(proof);
      assert.equal(await field.inputValue(), 'Synthetic three-photo caption');
      assert.equal(await page.frames()[1].evaluate(() => window.__draftIdentity), doc);
      await page.waitForTimeout(500); await page.screenshot({path: path.join(evidence, 'hosted-proxy-draft-' + skin + '.png')});
    }
    assert.notEqual(skinProof[0].accent, skinProof[1].accent);
    fs.writeFileSync(path.join(evidence, 'hosted-skin-proof.json'), JSON.stringify(skinProof, null, 2));
    checks.push('two live skins retained same draft');
    // Real failed opens remain visible as removable chips, alongside healthy files, and block send.
    const d = (await drafts())[0]; failId = d.attachments[1].id;
    await page.frames()[1].goto(st.origin + '/');
    await frame.locator('textarea[aria-label="Message"]').waitFor(); await frame.locator('.u-draft-note.conflict').waitFor();
    assert.equal(await frame.locator('.u-attach-strip .ch-att').count(), 3);
    await frame.locator('.u-compose-row > .u-send').click(); await page.waitForTimeout(400); assert.equal(sends.length, 0);
    failId = null; await frame.locator('.u-compose-row > .u-send').click();
    await until(() => sends.length === 1, 'retry sends restored photos');
    assert.equal(sends[0].upload_ids.length, 3); assert.equal(sends[0].text, 'Synthetic three-photo caption');
    await until(async () => (await drafts()).length === 0, 'sent draft deleted');
    checks.push('reload, failed open, retry and exactly one three-photo synthetic send');
    // Permanent storage failures: removing one cannot authorize another failed file.
    await field.fill('Keep this text');
    failNames = new Set(['broken-one.pdf', 'broken-two.pdf']);
    await input.setInputFiles([...failNames].map(name => ({name, mimeType: 'application/pdf', buffer: Buffer.from('synthetic PDF fixture')})));
    await frame.locator('.u-draft-note.conflict').waitFor();
    await frame.locator('.u-compose-row > .u-send').click(); await page.waitForTimeout(400); assert.equal(sends.length, 1);
    await frame.locator('.u-attach-strip .ch-att').first().getByRole('button', {name: 'Remove'}).click();
    assert.equal(await frame.locator('.u-draft-note.conflict').count(), 1);
    await frame.locator('.u-compose-row > .u-send').click(); await page.waitForTimeout(300); assert.equal(sends.length, 1);
    await frame.locator('.u-attach-strip .ch-att').first().getByRole('button', {name: 'Remove'}).click();
    await until(async () => await frame.locator('.u-draft-note.conflict').count() === 0, 'error clears after last failed attachment removed');
    assert.equal(await field.inputValue(), 'Keep this text'); checks.push('permanent failure blocked, all failed chips removable, text retained');
    // Standalone fallback, no owner login or shell transport.
    await page.goto(st.origin + '/'); await page.locator('.u-composer textarea').waitFor();
    assert.equal(await page.locator('html').evaluate(e => e.classList.contains('wz-hosted')), false);
    await page.screenshot({path: path.join(evidence, 'standalone-draft-dark.png')});
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'browser-receipt.json'), JSON.stringify({pass: true, syntheticOnly: true, hostedProxy: true, checks, sends, pageErrors: errors}, null, 2));
    console.log(JSON.stringify({pass: true, checks: checks.length, syntheticSends: sends.length, pageErrors: errors}));
  } catch (e) { await page.screenshot({path: path.join(evidence, 'failure.png')}).catch(() => {}); throw e; }
  finally { release(); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
