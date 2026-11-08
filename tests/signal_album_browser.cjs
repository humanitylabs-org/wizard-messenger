// Synthetic hosted-proxy QA. Real app + pinned shared Appearance host/client;
// no owner account, database, credentials, external requests or native sends.
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(process.env.SIGNAL_APP_ROOT || path.join(__dirname, '..')), shell = path.resolve(process.env.SIGNAL_SHELL_WEB || ''), out = process.env.OUT;
assert(out && process.env.SIGNAL_INGRESS_PROOF && process.env.SIGNAL_SHELL_WEB);
fs.mkdirSync(out, {recursive:true});
const proof = JSON.parse(fs.readFileSync(process.env.SIGNAL_INGRESS_PROOF)), rows = proof.candidate;
const identities = [{id:rows[0].identity_id, network:'signal', address:'!synthetic:test', label:'Signal fixture'}];
const person = {id:'signal-fixture', display_name:'Synthetic Signal album', identities, unread:0, last:{timestamp:1700000000123}, preferred_identity:identities[0].id};
let apiCalls = [], shares = [], httpCalls = [];
// openPerson fetches ?limit=60. Match method + pathname, but validate (never
// discard) query semantics. The old exact-string route silently returned an
// empty fallback with no person for the real production URL.
function threadReply(p, method='GET') {
  const u = new URL(p, 'http://fixture/');
  if (u.pathname !== '/api/unified/people/signal-fixture') return null;
  assert.equal(method, 'GET', 'unexpected synthetic thread method');
  assert.deepEqual([...u.searchParams.keys()], ['limit'], 'unimplemented thread query');
  assert.equal(u.searchParams.get('limit'), '60');
  return {person, messages:rows, seq:1, has_more:false, next_cursor:null};
}
const proxy = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wizard-os-home/core/skins.css"><style>html,body{margin:0;width:100%;height:100%;color:var(--ink);background:var(--bg)}.win{height:100%;display:flex;flex-direction:column;background:var(--sk-win,var(--bg))}header{flex:0 0 38px;display:flex;gap:8px;align-items:center;padding:0 8px}iframe{border:0;width:100%;flex:1;min-height:0}</style><script>window.WizCore={apps:()=>({APPS:[{id:'fixture',url:'/app/'}]})};addEventListener('message',e=>{if(e.origin!==location.origin)return;let d=e.data;if(d?.type==='wizard:app:request')e.source.postMessage({type:'wizard:app:reply',version:1,id:d.id,value:d.op==='ready'?{version:1,hosted:true}:null},location.origin)});</script><script src="/wizard-os-home/core/skin-frame.js"></script><script src="/wizard-os-home/core/skins.js"></script><script src="/wizard-os-home/core/appearance-host.js"></script></head><body><div class="win"><header>Synthetic · Messenger <button onclick="WosSkin.set('nebula');WizAppearance.sync()">Nebula</button><button onclick="WosSkin.set('signal');WizAppearance.sync()">Signal</button></header><iframe src="/app/"></iframe></div></body></html>`;
const bootstrap = `document.getElementById('gate').hidden=true; document.getElementById('inbox-tabs').hidden=false; window.MessengerUnified.mount({api:(p,o)=>window.__fixtureAPI(p,o||{}),csrf:'synthetic-only'}); window.MessengerUnified.authenticated();`;
const contentTypes = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server = http.createServer((req,res)=>{
  // Fixed synthetic origin only; never retain cookies, auth or arbitrary headers.
  res.on('finish',()=>httpCalls.push({method:req.method,path:req.url,status:res.statusCode,headers:{'content-type':res.getHeader('content-type')||null,'cache-control':res.getHeader('cache-control')||null,'content-security-policy':res.getHeader('content-security-policy')||null,'x-frame-options':res.getHeader('x-frame-options')||null}}));
  const u = new URL(req.url,'http://fixture'); let body, type;
  if(u.pathname==='/proxy.html'){body=proxy;type='text/html; charset=utf-8';}
  else if(u.pathname==='/app/app.js'){body=bootstrap;type='text/javascript';}
  else if(u.pathname.startsWith('/app/api/unified/media/')){
    const id=decodeURIComponent(u.pathname.split('/').at(-1)), color=id.includes('red')?'#df3232':id.includes('green')?'#239e50':'#2463d9';
    body=`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${color}"/><text x="40" y="240" fill="white" font-size="42">Synthetic ${id.replace(/[^a-z-]/g,'')}</text></svg>`;type='image/svg+xml';
  } else {
    let base, suffix;
    if(u.pathname.startsWith('/wizard-os-home/')){base=shell;suffix=u.pathname.slice('/wizard-os-home/'.length);}
    else if(u.pathname.startsWith('/app/')){base=path.join(root,'static');suffix=u.pathname.slice('/app/'.length)||'index.html';}
    else {res.writeHead(404);res.end('{}');return;}
    const file=path.resolve(base,suffix);
    if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('{}');return;}
    body=fs.readFileSync(file);type=contentTypes[path.extname(file)]||'application/octet-stream';
  }
  res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(body);
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
  const errors=[], receipts=[];
  try {
    for(const size of [{name:'phone',width:412,height:860,touch:true},{name:'wide',width:1365,height:900,touch:false}]){
      const context=await browser.newContext({viewport:{width:size.width,height:size.height},isMobile:size.touch,hasTouch:size.touch,colorScheme:'dark'});
      let draft = null;
      await context.exposeBinding('__fixtureAPI',async(source,p,o)=>{
        const request={profile:size.name,path:p,method:o.method||'GET'};apiCalls.push(request);
        const reply=threadReply(p,request.method);
        Object.assign(request,{thread:!!reply,message_count:reply?.messages.length??null});
        if(reply)return reply;
        if(p==='api/drafts' && o.method==='POST') { draft={id:'synthetic-draft',revision:1,state:'draft',attachments:[],...o.body}; return {draft}; }
        if(p==='api/drafts/synthetic-draft' && o.method==='POST') { draft={...draft,...o.body,revision:(draft?.revision||0)+1}; return {draft}; }
        if(p==='api/drafts/synthetic-draft' && o.method==='DELETE') { draft=null; return {}; }
        if(p==='api/unified/people')return {people:[person],groups:[],seq:1};
        if(p==='api/unified/groups')return {people:[],groups:[],seq:1};

        if(p.startsWith('api/unified/updates'))return new Promise(()=>{});
        if(p==='api/unified/status')return {telegram:'ready',signal:'ready',people:1,groups:0};
        if(p==='api/drafts')return {drafts:draft?[draft]:[]};
        return {people:[],groups:[],drafts:[],accounts:[],logins:[],codes:[],messages:[],contacts:[]};
      });
      await context.addInitScript(()=>{
        let actual;
        Object.defineProperty(window,'WizardApp',{configurable:true,get:()=>actual,set:v=>{
          actual={...v,media:{...v.media,view:(items,index)=>{window.__viewer={items,index};return true;}},share:{...v.share,wizard:async payload=>{window.__shared={text:payload.text,files:payload.files.map(f=>({name:f.name,size:f.size,type:f.type}))};return 'sent';}}};
        }});
        window.__documentID=crypto.randomUUID();
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(size.name+': '+e.message));
      await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort('blockedbyclient'));
      await page.goto(origin+'/proxy.html');
      const frame=page.frameLocator('iframe');
      await frame.getByText('Synthetic Signal album',{exact:true}).first().click();
      const bubble=frame.locator('.u-message.has-album');await bubble.waitFor();
      assert.equal(await bubble.count(),1);assert.equal(await bubble.locator('.u-album .u-media').count(),3);
      assert.equal(await bubble.locator('.u-text').innerText(),'Three photos');assert.equal(await bubble.locator('footer').count(),1);
      const tileIDs=await bubble.locator('.u-album img').evaluateAll(imgs=>imgs.map(i=>decodeURIComponent(i.getAttribute('src')||i.dataset.src||'')));
      assert(tileIDs[0].includes('$z-red')&&tileIDs[1].includes('$a-green')&&tileIDs[2].includes('$m-blue'),JSON.stringify(tileIDs));
      const id=await page.frames()[1].evaluate(()=>window.__documentID);
      // Preserve an unsent form and the same document across live skin changes.
      await frame.locator('textarea').first().fill('Unsent synthetic draft');
      for(const skin of ['nebula','signal']){
        await page.getByRole('button',{name:skin==='nebula'?'Nebula':'Signal',exact:true}).click();
        await page.waitForFunction(()=>WizAppearance.inspect().some(s=>s.acked&&s.themed));
        await frame.locator('html[data-skin="'+skin+'"] .u-album').waitFor();
        assert.equal(await page.frames()[1].evaluate(()=>window.__documentID),id);
        assert.equal(await frame.locator('textarea').first().inputValue(),'Unsent synthetic draft');
        await page.frames()[1].evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));});
        await page.screenshot({path:path.join(out,size.name+'-'+skin+'.png'),fullPage:true});
        receipts.push({profile:size.name,skin,appearance:await page.evaluate(()=>WizAppearance.inspect()),width:await page.frames()[1].evaluate(()=>innerWidth)});
      }
      for(let i=0;i<3;i++){
        await bubble.locator('.u-album .u-media').nth(i).click();
        const viewer=await page.frames()[1].evaluate(()=>window.__viewer);
        assert(viewer&&Array.isArray(viewer.items)&&decodeURIComponent(viewer.items[viewer.index].url).includes(['$z-red','$a-green','$m-blue'][i]));
      }
      if(size.touch){
        const box=await bubble.locator('.u-album .u-media').first().boundingBox(),cdp=await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
        await page.waitForTimeout(680);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        assert.equal(await frame.locator('.u-selection strong').innerText(),'1 selected');
        await frame.getByRole('button',{name:'Forward to Wizard',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.__shared?.files.length===3);
        const share=await page.frames()[1].evaluate(()=>window.__shared);
        assert.equal((share.text.match(/Three photos/g)||[]).length,1);shares.push(share);
      }
      await context.close();
    }
    const standalone=await browser.newPage({viewport:{width:412,height:860},colorScheme:'dark'});
    await standalone.exposeBinding('__fixtureAPI',async(source,p,o={})=>{
      const request={profile:'standalone',path:p,method:o.method||'GET'};apiCalls.push(request);const reply=threadReply(p,request.method);Object.assign(request,{thread:!!reply,message_count:reply?.messages.length??null});
      return reply || (p==='api/unified/people'?{people:[person],seq:1}:p.startsWith('api/unified/updates')?new Promise(()=>{}):{people:[],groups:[],drafts:[],codes:[]});
    });
    standalone.on('pageerror',e=>errors.push('standalone: '+e.message));
    await standalone.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
    await standalone.goto(origin+'/app/');await standalone.getByText('Synthetic Signal album',{exact:true}).first().click();
    await standalone.locator('.u-album').waitFor();
    assert.equal(await standalone.locator('html[data-wz-hosted]').count(),0);
    const bg=await standalone.evaluate(()=>getComputedStyle(document.body).backgroundColor);
    assert(!['rgb(255, 255, 255)','rgba(0, 0, 0, 0)'].includes(bg),bg);
    await standalone.screenshot({path:path.join(out,'standalone-dark.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    assert.deepEqual([...new Set(apiCalls.filter(c=>c.thread&&c.message_count===rows.length).map(c=>c.profile))].sort(),['phone','standalone','wide'],'all profiles must consume the real converter rows; legitimate wake refetches are allowed');
    fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify({scope:'synthetic hosted proxy, not installed shell/device/account ingress',receipts,shares,apiCalls,httpCalls,errors},null,2));
  } catch(error) {
    const dom=[];
    for(const [ci,context] of browser.contexts().entries())for(const [pi,page] of context.pages().entries()){
      await page.screenshot({path:path.join(out,`failure-${ci}-${pi}.png`),fullPage:true}).catch(()=>{});
      for(const f of page.frames())if(f.url().startsWith(origin))dom.push(await f.evaluate(()=>({path:location.pathname,ready:document.readyState,hosted:document.documentElement.hasAttribute('data-wz-hosted'),skin:document.documentElement.dataset.skin||null,albums:document.querySelectorAll('.u-album').length,messages:document.querySelectorAll('.u-message').length,notices:[...document.querySelectorAll('.u-notice,.u-empty,.u-error,[role="alert"]')].map(n=>n.textContent).slice(0,12),capabilities:{appearance:!!window.WizardApp?.appearance,attachChip:!!window.WizardApp?.attachChip,mediaView:!!window.WizardApp?.media?.view,share:!!window.WizardApp?.share?.wizard}})).catch(e=>({diagnostic_error:e.message})));
    }
    fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:error.message,apiCalls,httpCalls,errors,dom},null,2));throw error;
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
