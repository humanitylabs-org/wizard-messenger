// Synthetic-only loopback harness: real index/CSS/unified handler, no engine, vault or owner data.
const {chromium} = require('playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '../static'), out = process.env.OUT || 'reaction-proof'; fs.mkdirSync(out, {recursive: true});
  const skinSource = fs.readFileSync(process.env.SKIN_SOURCE, 'utf8');
  const skins = new Function('const T = o => o;' + skinSource.slice(skinSource.indexOf('  const SKINS ='), skinSource.indexOf('  // Each skin')) + '; return SKINS;')();
  const person = {id:'fixture', display_name:'Reaction preview', identities:[{id:'fixture-telegram',network:'telegram'}], last:{text:'Synthetic preview only',timestamp:Date.now()}};
  let rows, pending = 0, fail = false; const requests = [], measurements = [], errors = [];
  function reset(album) { const base = {network:'telegram', identity_id:'fixture-telegram', sender:'Preview', outgoing:false, timestamp:Date.now()-60000, msgtype:album?'m.image':'m.text', media:album?{w:640,h:480,mime:'image/svg+xml'}:undefined, original:'Synthetic reaction preview', reactions:[]}; rows = album ? [{...base,id:'part-1',album:'fixture-album'}, {...base,id:'part-2',original:'',album:'fixture-album', reactions:[{key:'👍',count:3,mine:true},{key:'😁',count:2,mine:false}]}] : [{...base,id:'text-1',reactions:[{key:'👍',count:3,mine:true},{key:'😁',count:2,mine:false}]}]; }
  const fixtureJS = `window.WizardApp={update:{hold:()=>({release(){}})},share:{targets:()=>Promise.resolve(),check:()=>Promise.resolve()}}; document.getElementById('gate').hidden=true; MessengerUnified.mount({api:async(p,o={})=>{const r=await fetch('/'+p,{...o,body:o.body===undefined?undefined:JSON.stringify(o.body),headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok)throw Error(d.error);return d.result;}}); MessengerUnified.authenticated();`;
  const server = http.createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname, send = (body,type='application/json',status=200) => {res.writeHead(status,{'Content-Type':type});res.end(body);}, ok = result => send(JSON.stringify({ok:true,result}));
    if (pathname.includes('/updates')) return; // long poll remains pending until browser closes
    if (pathname.includes('/media/')) return send('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#608a96"/><circle cx="420" cy="140" r="65" fill="#f9e7bc"/></svg>','image/svg+xml');
    if (pathname === '/api/unified/people') return ok({people:[person],seq:1});
    if (pathname === '/api/unified/groups') return ok({groups:[],seq:1});
    if (pathname === '/api/unified/people/fixture') return ok({person,messages:rows,seq:1,has_more:false});
    if (pathname.endsWith('/react')) {
      let body='';for await (const chunk of req) body+=chunk; const key=JSON.parse(body).key, id=decodeURIComponent(pathname.split('/').at(-2)); requests.push({id,key}); pending++;
      await new Promise(r=>setTimeout(r,2500)); pending--;
      if(fail) {fail=false;return send(JSON.stringify({error:'Synthetic bridge offline'}),'application/json',503);}
      const m=rows.find(m=>m.id===id), had=m.reactions.some(r=>r.mine&&r.key===key); m.reactions=m.reactions.map(r=>({...r,count:r.count-(r.mine?1:0),mine:false})).filter(r=>r.count>0);
      if(!had){const r=m.reactions.find(r=>r.key===key);if(r){r.count++;r.mine=true;}else m.reactions.push({key,count:1,mine:true});} return ok({message:m});
    }
    if (pathname.startsWith('/api/')) return ok({});
    if (pathname === '/fixture.js') return send(fixtureJS,'text/javascript');
    if (pathname === '/') { const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<script src="/unified.js" defer></script><script src="/fixture.js" defer></script></head>'); return send(html,'text/html'); }
    const name=pathname.slice(1); if(!['app.css','unified.css','unified.js','favicon.svg','icon-192.png'].includes(name)){res.writeHead(404);return res.end();}
    send(fs.readFileSync(path.join(root,name)),name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'image/svg+xml');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const url=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  try {
    for(const skin of ['nebula','sepia']) for(const album of [false,true]) {
      reset(album); const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
      // Block all non-loopback traffic, including any unintended external delivery.
      await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():route.abort());
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.locator('.u-person').click();await page.locator('.u-message').first().waitFor();
      const t=skins.find(s=>s.id===skin).t;await page.evaluate(({skin,t})=>{document.documentElement.dataset.skin=skin; const map={base:'bg',canvas:'bg',text:'ink','text-secondary':'ink-2','text-muted':'ink-3',surface:'glass','surface-raised':'glass-2',accent:'violet',border:'line'};for(const [role,key] of Object.entries(map))document.documentElement.style.setProperty('--wz-'+role,t[key]);}, {skin,t});
      const open=async()=>{await page.locator('.u-message .u-text').first().click();await page.getByRole('button',{name:'More reactions',exact:true}).click();await page.locator('.u-grid').waitFor();};
      await open();const rect=await page.locator('.u-grid').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=390&&rect.y+rect.height<=844);assert.equal(await page.locator('.u-grid button').count(),72);
      const label=`${skin}-${album?'album':'text'}`; await page.screenshot({path:path.join(out,label+'-picker.png')});
      // Outside and shared Back entry both close, without leaving the thread.
      await page.mouse.click(385,15);assert.equal(await page.locator('#u-overlay').count(),0);await open();assert.equal(await page.evaluate(()=>MessengerUnified.back()),true);assert.equal(await page.locator('.u-message').count(),1);
      await open();const before=requests.length, start=Date.now();await page.getByRole('button',{name:'😁',exact:true}).click();
      await page.waitForFunction(()=>[...document.querySelectorAll('.u-react.mine')].some(e=>e.textContent.includes('😁')),{},{timeout:700});const elapsed=Date.now()-start; assert(pending>0,'HTTP is still delayed when DOM shows selected reaction');assert(elapsed<700);assert.deepEqual(requests[before],{id:album?'part-2':'text-1',key:'😁'});
      await page.screenshot({path:path.join(out,label+'-pending.png')});measurements.push({skin,album,paintMs:elapsed,httpDelayMs:2500});
      await page.waitForFunction(()=>!document.querySelector('#u-overlay'));await page.waitForTimeout(2600);
      const mine=page.locator('.u-react.mine');assert.match(await mine.innerText(),/😁/);
      // Same exact key toggles off before its delayed response, preserving the other two users.
      await mine.click();assert.equal(await page.locator('.u-react.mine').count(),0);assert.match(await page.locator('.u-reactions').innerText(),/😁.*2/);await page.waitForTimeout(2600);
      fail=true;await open();await page.getByRole('button',{name:'😁',exact:true}).click();assert.equal(await page.locator('.u-react.mine').count(),1);await page.getByRole('status').filter({hasText:'Synthetic bridge offline'}).waitFor({timeout:5000});assert.equal(await page.locator('.u-react.mine').count(),0);
      await context.close();
    }
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({measurements,requests,errors,scope:'synthetic loopback with real index, CSS and unified handler; skin token adapter; not installed-app/auth proof'},null,2));console.log(JSON.stringify({result:'PASS',measurements}));
  } finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.stack);process.exit(1);});
