// James, 28 Oct 2026: an overlay that carries text is never see-through. Nothing behind a sheet, menu,
// toast or sticky label may show through it, in any skin, hosted in Wizard (transparent canvas) or standalone.
// Proof: paint each overlay twice, once over loud text and once over nothing, and require identical pixels.
// Env: STATIC_DIR (Messenger static/), TOKENS_CSS (wizard-ux web/kit/wizard-tokens.css),
//      optional UNIFIED_CSS to test an older unified.css (the live image's) under the new app.css.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const dir = process.env.STATIC_DIR || path.join(__dirname, '..', 'static');
const css = [
  process.env.TOKENS_CSS ? fs.readFileSync(process.env.TOKENS_CSS, 'utf8') : '',
  fs.readFileSync(path.join(dir, 'app.css'), 'utf8'),
  fs.readFileSync(process.env.UNIFIED_CSS || path.join(dir, 'unified.css'), 'utf8'),
].join('\n');
const skins = process.env.TOKENS_CSS ? ['nebula', 'grove', 'tide', 'ember', 'signal'] : ['standalone'];
const loud = Array.from({length: 60}, (_, i) => `<p style="margin:0;font:700 28px sans-serif;color:${i % 2 ? '#fff' : '#ff0'}">BEHIND TEXT ${i} WWWWWWWWWWWWWW</p>`).join('');
const html = (skin, hosted) => `<!doctype html><html ${skin !== 'standalone' ? `data-skin="${skin}"` : ''} class="${hosted ? 'wz-hosted' : ''}"><head><style>${css}</style></head>
<body style="background:#000"><main id="messenger" style="position:relative;height:640px;overflow:hidden">
<div id="behind" style="position:absolute;inset:0">${loud}</div>
<div class="u-overlay" style="animation:none"><section class="u-sheet" style="animation:none;height:420px"><h2>Settings</h2><p class="helper">Connect an account</p></section></div>
<p class="u-toast" style="bottom:20px">Saved</p>
<div style="position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column"><span class="u-day">Today</span></div>
<div class="sheet-layer" style="animation:none;inset:auto 0 0 0;height:120px;background:none"><section class="sheet" style="animation:none;height:100px">Marmot sheet</section></div>
</main></body></html>`;
const regions = {'.u-overlay > .u-sheet': null, '.u-toast': null, '.u-day': null, '.sheet-layer > .sheet': null};

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 360, height: 640}, deviceScaleFactor: 1});
  const results = [];
  for (const skin of skins) for (const hosted of [true, false]) {
    await page.setContent(html(skin, hosted));
    for (const sel of Object.keys(regions)) {
      const el = page.locator(sel);
      // Clip inside the rounded corners so only the panel fill is compared.
      const b = await el.boundingBox(); assert(b && b.width > 20 && b.height > 10, `${sel} rendered`);
      const clip = {x: b.x + 12, y: b.y + 4, width: b.width - 24, height: b.height - 8};
      await page.evaluate(() => { document.getElementById('behind').style.visibility = 'visible'; });
      const over = await page.screenshot({clip});
      await page.evaluate(() => { document.getElementById('behind').style.visibility = 'hidden'; });
      const bare = await page.screenshot({clip});
      const ok = over.equals(bare);
      results.push({skin, hosted, sel, opaque: ok, bg: await el.evaluate(e => getComputedStyle(e).backgroundColor)});
    }
  }
  await browser.close();
  const bad = results.filter(r => !r.opaque);
  console.log(JSON.stringify({checked: results.length, see_through: bad}, null, 1));
  assert.equal(bad.length, 0, 'text overlays must be fully opaque');
  console.log('PASS opaque overlays');
})().catch(e => { console.error(e); process.exit(1); });
