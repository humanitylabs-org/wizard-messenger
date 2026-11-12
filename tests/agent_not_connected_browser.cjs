// wizard-ux issue 1335: with no gateway row (gateway_connected false) Agent access says "Not connected" for each
// Wizard agent instead of its chosen level, and offers no level picker until the agent is connected.
// Synthetic APIs only. STATIC_DIR=<old static> with BEFORE=1 shows the old picker for a before shot.
// node tests/agent_not_connected_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE)
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'agent-not-connected-shots');
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
  for (const [skin, p] of Object.entries(P).filter(([k]) => ['dark', 'light'].includes(k))) for (const [label, viewport] of [['390', {width: 390, height: 844}]]) {
    const state = {wizard_agents: [{id: 'hermes', label: 'Oscar', level: 'draft_only', last_used: Date.now() - 6e4, main: true}],
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
      wizard_levels: LV.slice(0, 3).map(([id, l]) => ({id, label: l, recommended: id === 'draft_only'})), gateway_connected: false,
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
      if (p2 === 'api/unified/connectors') return ok({providers: [{network: 'whatsapp', label: 'WhatsApp', supported: true, state: 'connected', flows: [], logins: [{id: 'l', name: '+15550100199'}]},
        {network: 'signal', label: 'Signal', supported: true, state: 'not_configured', flows: []}, {network: 'kakaotalk', label: 'KakaoTalk', supported: false, state: 'unsupported', flows: [], message: 'Coming later'}]});
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
    const more = page.locator('.u-settings .u-more-agents');
    await more.locator('.u-more-agent').first().waitFor();
    const text = await more.innerText();
    if (process.env.BEFORE) assert.equal(await more.getByLabel('What Oscar may do').inputValue(), 'draft_only', 'before: the picker shows the chosen level');
    else {
      assert.match(text, /Oscar\s+Not connected/, 'the agent row says Not connected: ' + text);
      assert.equal(await more.locator('select').count(), 0, 'no level picker while not connected');
      assert.doesNotMatch(text, /Draft-only|Read-only|No access/, 'no chosen level shown');
      assert.ok((await more.locator('.u-more-agent').boundingBox()).height < 64, 'the agent row is one line');
    }
    assert.deepEqual(errors, []);
    await more.scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
    await page.screenshot({path: path.join(out, `${process.env.BEFORE ? 'before' : 'after'}-${skin}-${label}.png`)});
    await ctx.close();
  }
  await browser.close();
  console.log('agent not connected browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
