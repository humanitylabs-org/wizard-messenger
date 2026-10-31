// Settings → More (Miguel, 31 Oct 2026): one plain list under the accounts. Each Wizard agent has one level picker
// (No access / Read-only / Draft-only), then Saved drafts and Advanced (address, older keys, request log). Synthetic APIs only.
// node tests/agents_panel_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'agents-panel-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
// Miguel's palettes from the shell's core/skins.js, mapped the way the shell hosts an app (transparent canvas over glass).
const P = {
  dark: {scheme: 'dark', bg: '#000000', ink: '#f7f7f7', ink2: '#c4c4c4', ink3: '#8a8a8a', line2: 'rgba(255,255,255,.26)', accent: '#ffffff', on: '#000000', glass: '#141414'},
  light: {scheme: 'light', bg: '#ffffff', ink: '#000000', ink2: '#2e2e2e', ink3: '#6b6b6b', line2: 'rgba(0,0,0,.32)', accent: '#000000', on: '#ffffff', glass: '#f0f0f0'},
  'landscapes-light': {scheme: 'light', bg: '#EEF1F4', ink: '#111216', ink2: 'rgba(17,18,22,.76)', ink3: 'rgba(17,18,22,.54)', line2: 'rgba(0,0,0,.26)', accent: '#5B3FE6', on: '#ffffff', glass: 'linear-gradient(160deg,#cfd8e3,#eef1f4 55%,#e6dccf)'},
  landscapes: {scheme: 'dark', bg: '#0B0A10', ink: '#ffffff', ink2: 'rgba(255,255,255,.80)', ink3: 'rgba(255,255,255,.58)', line2: 'rgba(255,255,255,.28)', accent: '#7A5CFF', on: '#ffffff', glass: 'linear-gradient(160deg,#2b2340,#141a2e 55%,#3a2a2a)'},
};
const tokens = p => ({canvas: 'transparent', base: p.bg, surface: `color-mix(in srgb, ${p.ink} 6%, transparent)`, 'surface-raised': `color-mix(in srgb, ${p.ink} 10%, transparent)`,
  text: p.ink, 'text-secondary': p.ink2, 'text-muted': p.ink3, border: p.line2, accent: p.accent, 'accent-soft': `color-mix(in srgb, ${p.accent} 16%, transparent)`, 'on-accent': p.on});
(async () => {
  const browser = await chromium.launch();
  for (const [skin, p] of Object.entries(P)) for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    const state = {wizard_agents: [{id: 'hermes', label: 'Oscar', level: 'no_access', last_used: Date.now() - 6e4, main: true}],
      agents: [{id: 'c4196c9286fa', name: 'Old key', level: 'draft_only', label: 'Draft-only'}], app: 'draft_only'}; // like Miguel's box
    const posted = [];
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2, colorScheme: p.scheme});
    await ctx.addInitScript(([scheme, t, glass]) => {
      const noop = () => {};
      window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}};
      const mark = () => {
        const r = document.documentElement; if (!r) return false;
        r.dataset.wzHosted = ''; r.dataset.colorScheme = scheme; r.style.colorScheme = scheme;
        for (const [k, v] of Object.entries(t)) r.style.setProperty('--wz-' + k, v);
        r.style.background = glass; return true;
      };
      if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
    }, [p.scheme, tokens(p), p.glass]);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const LV = [['no_access', 'No access'], ['read_only', 'Read-only'], ['draft_only', 'Draft-only'], ['draft_and_send', 'Draft-and-send']];
    const listing = () => ({wizard_agents: state.wizard_agents.map(a => ({...a, level_label: LV.find(l => l[0] === a.level)[1]})),
      wizard_levels: LV.slice(0, 3).map(([id, l]) => ({id, label: l, recommended: id === 'draft_only'})), gateway_connected: true,
      agents: state.agents, app_key: {id: 'app-key', name: 'Wizard app key', level: state.app, label: 'No access'},
      levels: LV.map(([id, l]) => ({id, label: l, recommended: id === 'draft_only'})), log: [{t: Date.now() - 6e4, agent: 'Oscar', outcome: 'allowed', method: 'GET', route: 'chats'}]});
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), p2 = new URL(req.url()).pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      if (p2 === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p2 === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p2 === 'api/identity') return ok({identity: {account_id: '11'.repeat(32), npub: 'npub1x', display_name: 'Owner'}});
      if (['api/contacts', 'api/invites', 'api/dms'].includes(p2)) return ok({contacts: [], invites: [], dms: []});
      if (p2 === 'api/unified/people') return ok({people: [], seq: 1});
      if (p2 === 'api/unified/groups') return ok({groups: [], seq: 1});
      if (p2 === 'api/unified/connectors') return ok({providers: [{network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l'}]}]});
      if (p2.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 1}); }
      if (p2.startsWith('api/view/agents')) {
        if (req.method() !== 'GET') {
          const body = JSON.parse(req.postData() || '{}'); posted.push([req.method(), p2, body]);
          const w = /^api\/view\/agents\/wizard\/(.+)$/.exec(p2);
          if (w) state.wizard_agents.find(a => a.id === decodeURIComponent(w[1])).level = body.level;
          else if (req.method() === 'DELETE') state.agents = state.agents.filter(a => 'api/view/agents/' + a.id !== p2);
        }
        return ok(listing());
      }
      if (p2.startsWith('api/')) return ok({});
      const file = path.join(root, p2 || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    await page.goto('https://messenger.test/');
    await page.locator('#u-filters').waitFor({timeout: 15000});
    await page.locator('[aria-label="Settings"]').first().click();
    // More (Miguel, 31 Oct): one plain list under the accounts. No folds, no eyebrow inside, no boxes in boxes.
    const more = page.locator('.u-settings .u-more');
    await more.locator('.u-more-agent').first().waitFor();
    assert.equal(await page.locator('.u-sheet details').count() - await page.locator('.u-sheet details.c-later').count(), 0, 'no folds below the accounts');
    const rows = await more.evaluate(g => [...g.querySelectorAll(':scope > :not([hidden]), :scope > .u-more-agents > *')].filter(e => e.getClientRects().length && !e.classList.contains('u-more-agents')).map(e => e.innerText.split('\n')[0].trim()));
    assert.deepEqual(rows, ['Oscar', 'Saved drafts', 'Advanced'], 'agents, drafts, Advanced (merges/notifications only when they exist): ' + JSON.stringify(rows));
    assert.equal(await more.getByText('Older agent keys').count(), 0, 'older keys are not on the main view');
    assert.equal(await more.getByText('Recent agent requests').count(), 0, 'the request log is not on the main view');
    assert.equal(await more.getByText('Wizard Messenger address').count(), 0, 'the raw address moved to Advanced');
    assert.equal(await more.locator('.u-settings-group, .c-card, details').count(), 0, 'no nested boxes inside the More list');
    await page.mouse.move(1, 1); await page.waitForTimeout(400); // let any hover tint fade
    const nested = await more.evaluate(g => [...g.querySelectorAll('*')].filter(e => e.getClientRects().length && !['transparent', 'rgba(0, 0, 0, 0)'].includes(getComputedStyle(e).backgroundColor) && e.tagName !== 'OPTION').map(e => e.className));
    assert.deepEqual(nested, [], 'rows paint no background of their own');
    const pick = more.getByLabel('What Oscar may do');
    assert.deepEqual(await pick.locator('option').allTextContents(), ['No access', 'Read-only', 'Draft-only']);
    assert.equal(await more.getByText('Draft-and-send').count(), 0, 'no send level for Wizard agents');
    assert.equal(await more.locator('input').count(), 0, 'no key or name fields');
    // Thumb-sized rows; the picker is a full-height target and fits its label on a phone.
    for (const box of await more.evaluate(g => [...g.querySelectorAll('.u-more-row')].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height))) assert.ok(box >= 48, 'row height ' + box);
    const pb = await pick.boundingBox(); assert.ok(pb.height >= 44, 'picker height ' + pb.height);
    assert.ok(await pick.evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'picker label not clipped');
    const h3 = await page.locator('.u-sheet h3').allTextContents(); assert.ok(h3.includes('More'), 'More heading kept');
    await more.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    await page.screenshot({path: path.join(out, `more-${skin}-${label}.png`)});
    // Picking a level is the whole flow: no confirm, it saves and repaints.
    page.on('dialog', d => { throw new Error('unexpected dialog ' + d.message()); });
    await pick.selectOption('draft_only');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.u-overlay .u-sheet[aria-label="Settings"]').count(), 1, 'no confirm sheet');
    assert.deepEqual(posted.at(-1), ['POST', 'api/view/agents/wizard/hermes', {level: 'draft_only'}]);
    assert.equal(await more.getByLabel('What Oscar may do').inputValue(), 'draft_only', 'repainted with the saved level');
    assert.ok(await more.getByText('Only you send.').count(), 'the level explains itself');
    assert.match(await more.locator('.u-more-what').first().textContent(), /^Recommended\. /, 'Draft-only is marked recommended');
    assert.ok(await more.locator('.u-more-what').first().evaluate(e => e.getBoundingClientRect().height < 24), 'the description is one line');
    const ink = await more.locator('.u-agent-name').first().evaluate(e => getComputedStyle(e).color);
    assert.ok(!/rgba?\(0, 0, 0, 0\)/.test(ink), 'agent name is not transparent: ' + ink);
    // Advanced: the address, older keys (folded away from the main view) and the request log.
    await more.locator('.u-more-advanced').click();
    const adv = page.locator('.u-sheet.u-advanced');
    await adv.getByText('Recent agent requests').waitFor();
    assert.equal(await adv.locator('.u-more-address').count(), 1, 'address row in Advanced');
    assert.equal(await adv.getByText('Older agent keys').count(), 1, 'existing keys stay reachable');
    assert.equal(await adv.getByLabel('What Old key may do').inputValue(), 'draft_only');
    for (const h of await adv.locator('.u-agent-name').evaluateAll(els => els.map(e => e.getBoundingClientRect().height))) assert.ok(h < 30, 'key names stay on one line: ' + h);
    assert.equal(await adv.getByLabel('What Wizard app key may do').inputValue(), 'draft_only', 'shared app key keeps its level, in Advanced only');
    assert.ok(await adv.locator('.u-access-log li').count() >= 1, 'log listed');
    await page.waitForTimeout(2600); // sheet animation and toast settle
    await page.screenshot({path: path.join(out, `advanced-${skin}-${label}.png`)});
    // Back returns to Settings, not out of it.
    assert.equal(await page.evaluate(() => window.MessengerUnified.back()), true);
    await page.locator('.u-sheet[aria-label="Settings"] .u-more').waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('ok', skin, label);
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
