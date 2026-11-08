// Forum only. Real hosted client + source view; ALL accounts/messages/identities are SYNTHETIC.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
if(!process.cwd().startsWith('/srv/work/')) throw Error('Forum /srv/work only');
const out=path.resolve(process.argv[2]),shell=process.env.SHELL_DIR,staticDir=path.resolve(__dirname,'../static');fs.mkdirSync(out,{recursive:true});
// Reuse LINE's hosted Appearance fixture, not hand-built colour tokens.
assert(fs.existsSync(path.join(shell,'core/skins.js')), 'Pinned real skin source required');
// Same palette extraction/real appearance host as the passing LINE fixture.
const vm=require('node:vm'),src=fs.readFileSync(path.join(shell,'core/skins.js'),'utf8');
const table=src.slice(src.indexOf('  const SKINS = ['),src.indexOf('  // Each skin'));
const palettes=vm.runInNewContext('const T=o=>o;'+table+';SKINS').filter(s=>['nebula','signal'].includes(s.id)).map(s=>({id:s.id,t:s.t}));
assert.equal(palettes.length,2);
const host=`<!doctype html><html data-skin="nebula"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wizard-os-home/core/skins.css"><script>window.WizCore={apps:()=>({APPS:[{url:'/app/'}]})};window.setFixtureSkin=id=>{const s=JSON.parse(atob('${Buffer.from(JSON.stringify(palettes)).toString('base64')}')).find(s=>s.id===id);for(const[k,v]of Object.entries(s.t))document.documentElement.style.setProperty('--'+k,v);document.documentElement.dataset.skin=id;window.WizAppearance?.sync()};setFixtureSkin('nebula')</script><script src="/wizard-os-home/core/appearance-host.js" defer></script><style>html,body{margin:0;height:100%;background:var(--bg)}.win,iframe{width:100%;height:100%;border:0}</style></head><body><div class="st-embed win"><iframe src="/app/" title="Synthetic group"></iframe></div></body></html>`;
const {origin,createFixture}=require('./helpers/group_features_fixture.cjs');
const types={'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'};
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});const results=[];
try { for(const profile of [{name:'desktop',viewport:{width:1280,height:860}},{name:'phone',viewport:{width:390,height:844},isMobile:true,hasTouch:true}]) {
 const ctx=await browser.newContext({...profile,deviceScaleFactor:1,reducedMotion:'reduce'}),page=await ctx.newPage(),errors=[],consoleErrors=[],forbidden=[],unmatched=[],requests=[];
 page.on('pageerror',e=>errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
 const fixture=createFixture();
 try {
 await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname;
  requests.push({method:req.method(),path:p+u.search});
  if(u.origin!==origin){forbidden.push(u.origin);return route.abort();}
  const json=data=>route.fulfill({json:data});
  if(p==='/')return route.fulfill({body:host,contentType:'text/html'});
  if(p.startsWith('/wizard-os-home/')){const file=path.join(shell,p.slice('/wizard-os-home/'.length));if(fs.existsSync(file))return route.fulfill({path:file,contentType:types[path.extname(file)]||'text/plain'});unmatched.push(p);return route.fulfill({status:404,body:''});}
  if(p==='/app/')return route.fulfill({path:path.join(staticDir,'index.html'),contentType:'text/html'});
  if(!p.includes('/api/')){const name=p.replace(/^\/app\//,'');const file=path.join(staticDir,!fs.existsSync(path.join(staticDir,name))&&['favicon.svg','icon-192.png'].includes(name)?'../'+name:name);if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file,contentType:types[path.extname(file)]||'application/octet-stream'});unmatched.push(p);return route.fulfill({status:404,body:''});}
  if(p.includes('/login')||p.includes('/enable')||p.includes('/unlock')){forbidden.push(p);return route.abort();}
  const answer=fixture.reply(req.url(),req.method(),req.postData()?req.postDataJSON():undefined);
  if(answer===null){unmatched.push(req.method()+' '+p);return route.fulfill({status:501,json:{ok:false,error:{code:'fixture_route_missing'}}});}
  if(p.endsWith('/api/unified/updates'))await new Promise(resolve=>setTimeout(resolve,1500));
  return json(answer);
 });
 await page.goto(origin+'/');const f=page.frameLocator('iframe');await f.locator('.u-person').first().waitFor();await f.locator('.u-person').first().click();await f.locator('.u-composer textarea').waitFor();
 const docMarker=await f.locator('html').evaluate(el=>el.dataset.qaDocument=String(Math.random()));let previousAccent;
 for(const skin of ['nebula','signal']) {
  await page.evaluate(skin=>setFixtureSkin(skin),skin);
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('iframe').contentDocument.documentElement).getPropertyValue('--wz-accent').trim()!=='');
  if(previousAccent)await page.waitForFunction(old=>getComputedStyle(document.querySelector('iframe').contentDocument.documentElement).getPropertyValue('--wz-accent').trim()!==old,previousAccent);
  previousAccent=await f.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--wz-accent').trim());assert(previousAccent);
  const draft=f.locator('.u-composer textarea');await draft.fill('@');await f.locator('.u-mention-picker:not([hidden])').waitFor();
  await page.screenshot({path:path.join(out,`${profile.name}-${skin}-mention-picker.png`)});
  const panel=await f.locator('.u-mention-picker').evaluate(el=>getComputedStyle(el).backgroundColor);assert.match(panel,/^rgb\(/,'opaque picker floor');
  await draft.press('ArrowDown');await draft.press('Tab');assert.equal(await draft.inputValue(),'@Bob Example ');assert.equal(await f.locator('.u-mention-mirror mark').textContent(),'@Bob Example');
  await f.locator('.u-send').click();await f.locator('.u-message.outgoing .u-mention').last().waitFor();await page.screenshot({path:path.join(out,`${profile.name}-${skin}-sent-mention.png`)});
  assert.equal(await f.locator('html').getAttribute('data-qa-document'),docMarker,'live skin never reloads document');
  assert(await f.locator('.u-mentioned').count(),'incoming owner mention highlight');
  const chip=f.locator('.u-react').first();
  if(profile.hasTouch)await chip.focus();else await chip.hover();
  await chip.locator('.u-reactor-tooltip:not([hidden])').waitFor();assert.match(await chip.locator('.u-reactor-tooltip').textContent(),/Alice Example.*Bob Example/s);
  await page.screenshot({path:path.join(out,`${profile.name}-${skin}-reactor-tooltip${profile.hasTouch?'-keyboard-focus':''}.png`)});
  if(profile.hasTouch){const box=await chip.boundingBox(),cdp=await ctx.newCDPSession(page),points=[{x:box.x+box.width/2,y:box.y+box.height/2}];await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});await page.waitForTimeout(520);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
  else await chip.click({button:'right'});
  await f.locator('.u-reactor-list').waitFor();await page.waitForTimeout(100);assert(await f.locator('.u-reactor-list').isVisible(),'long-press release keeps sheet open');
  await f.getByRole('tab',{name:'All',exact:true}).click();assert.equal(await f.locator('.u-reactor-list .u-reactor-row').filter({hasText:'Alice Example'}).count(),1);
  await f.getByRole('tab',{name:'❤️ 1',exact:true}).click();assert.equal(await f.locator('.u-reactor-list .u-reactor-row').count(),1);await f.getByRole('tab',{name:'All',exact:true}).click();
  await page.screenshot({path:path.join(out,`${profile.name}-${skin}-reactor-sheet.png`)});
  await f.locator('.u-overlay').click({position:{x:8,y:8}});await f.locator('.u-overlay').waitFor({state:'detached'});assert(await f.locator('.u-timeline').isVisible());
  await chip.click(profile.hasTouch?{}:{button:'right'});await f.locator('.u-reactor-list').waitFor();await page.goBack();await f.locator('.u-overlay').waitFor({state:'detached'});assert(await f.locator('.u-timeline').isVisible(),'Back closes sheet, not app');
  results.push({profile:profile.name,skin,picker:true,sentMention:true,ownerHighlight:true,tooltip:profile.hasTouch?'keyboard focus (phone has no hover)':'hover',reactorSheet:true,liveSkin:true,opaquePanel:panel});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(forbidden,[]);assert.deepEqual(unmatched,[]);assert.deepEqual(consoleErrors,[]);assert(await f.locator('html').evaluate(el=>el.scrollWidth<=innerWidth));
 } catch(e) {
  const diagnostic={profile:profile.name,error:e.stack||String(e),pageErrors:errors,consoleErrors,unmatched,forbidden,requests};
  fs.writeFileSync(path.join(out,`${profile.name}-failure.json`),JSON.stringify(diagnostic,null,2));console.error(JSON.stringify(diagnostic,null,2));
  await page.screenshot({path:path.join(out,`${profile.name}-failure.png`)}).catch(error=>console.error('failure screenshot:',error.message));throw e;
 } finally {await ctx.close();}
 }
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({pass:true,syntheticOnly:true,realSharedAppearance:true,providerMessagingProven:false,results},null,2));
} finally {await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
