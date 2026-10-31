/* James (31 Oct 2026): after a mic start that never answers, the composer is back with a readable notice, on every
 * Wizard skin (hosted, Appearance v1 --wz-* tokens) and standalone dark. Exact production composer and CSS, synthetic
 * capture whose start never settles. Env: TOKENS_CSS (wizard-ux web/kit/wizard-tokens.css), EVIDENCE_DIR. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = path.join(__dirname, '../static');
const source = fs.readFileSync(path.join(dir, 'unified.js'), 'utf8');
const composer = source.slice(source.indexOf('  function composer(id, p) {'), source.indexOf('  // WebM (Matroska)'));
const css = [process.env.TOKENS_CSS ? fs.readFileSync(process.env.TOKENS_CSS, 'utf8') : '', fs.readFileSync(path.join(dir, 'app.css'), 'utf8'), fs.readFileSync(path.join(dir, 'unified.css'), 'utf8')].join('\n');
const out = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'evidence', 'voice-notice-skins'); fs.mkdirSync(out, {recursive: true});
const skins = process.env.TOKENS_CSS ? ['nebula', 'grove', 'tide', 'ember', 'signal'] : [];
const fixture = `
window.view={}; const s={drafts:{},person:'synthetic'},localAudio=new Map();
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
const iconButton=(icon,label,fn,cls)=>{const e=node('button',cls?'icon-button '+cls:'icon-button');e.type='button';e.title=label;e.setAttribute('aria-label',label);e.textContent=icon==='mic'?'🎤':icon==='photo'?'＋':'➤';e.onclick=fn;return e;};
const button=(text,fn,cls)=>{const e=node('button',cls,text);e.type='button';e.onclick=fn;return e;};
const netLabel=n=>n,netBadge=()=>node('span'),bridged=()=>true,actionMenu=()=>{},serverDraft=()=>null,uid=()=>'u',preparePhoto=async f=>({blob:f}),editMsg=()=>{},reviewSend=()=>{};
const cap=x=>x,reviewedOf=()=>false,hold=()=>{},error=()=>{},toast=()=>{},fmtDur=()=>'0:00',queueSend=()=>{},saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',call=async()=>({});
window.WizardApp={update:{hold:()=>({release(){}})},capture:{current:()=>null,attach:async()=>null,ack:async()=>{},start:()=>new Promise(()=>{})}};
${composer}
document.querySelector('#thread').append(composer('synthetic',{identities:[{id:'tg',network:'telegram',label:'Synthetic'}]}));`;
const html = (skin, hosted) => `<!doctype html><html ${skin ? `data-skin="${skin}"` : ''} class="${hosted ? 'wz-hosted' : ''}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><main id="messenger" style="height:100vh;display:flex;flex-direction:column"><section class="u-thread" id="thread" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end">
<div class="u-messages" style="flex:1;padding:16px"><p class="u-day">Today</p></div></section></main></body></html>`;
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM});
  const rows = [];
  try {
    for (const [skin, hosted] of [...skins.map(s => [s, true]), ['', false]]) {
      const page = await browser.newPage({viewport: {width: 390, height: 520}, deviceScaleFactor: 2, colorScheme: 'dark'});
      await page.setContent(html(skin, hosted)); await page.evaluate(fixture);
      await page.getByRole('button', {name: 'Record voice message'}).click();
      await page.locator('.u-voice-notice').waitFor({state: 'visible', timeout: 10000});
      await page.waitForFunction(() => !document.querySelector('.u-recording'));
      const notice = page.locator('.u-voice-notice');
      assert.match(await notice.innerText(), /didn.t start\. Tap the mic to try again/);
      assert.equal(await page.locator('.u-compose-row').isVisible(), true);
      assert.equal(await page.getByRole('button', {name: 'Record voice message'}).isEnabled(), true);
      const st = await notice.evaluate(e => { const c = getComputedStyle(e); return {color: c.color, bg: c.backgroundColor, size: c.fontSize}; });
      const shot = path.join(out, (skin || 'standalone-dark') + '.png'); await page.screenshot({path: shot});
      rows.push({skin: skin || 'standalone-dark', hosted, ...st, shot}); await page.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(rows, null, 1));
  console.log('PASS composer back with readable notice on ' + rows.length + ' looks');
})().catch(e => { console.error(e); process.exitCode = 1; });
