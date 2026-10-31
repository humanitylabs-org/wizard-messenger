/* A chat opening is NOT a mic tap. Synthetic composer dependencies; exact production composer.
 * MESSENGER_SOURCE=<15.11 unified.js> is the fail-before proof. No owner content or network. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(process.env.MESSENGER_SOURCE||path.join(__dirname,'../static/unified.js'),'utf8');
const composer=source.slice(source.indexOf('  function composer(id, p) {'),source.indexOf('  // WebM (Matroska)'));
const fixture=`
window.view={}; const s={drafts:{},person:'synthetic'},localAudio=new Map();
const voiceTapSession=Math.random().toString(36),voiceKept=new Map(),voiceQueued=new Set();let voiceRecoveryWork=null;
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
const iconButton=(icon,label,fn,cls)=>{const e=node('button',cls,label);e.type='button';e.setAttribute('aria-label',label);e.onclick=fn;return e;};
const button=(text,fn,cls)=>{const e=node('button',cls,text);e.type='button';e.onclick=fn;return e;};
const netLabel=n=>n,netBadge=()=>node('span'),bridged=n=>['telegram','whatsapp','signal'].includes(n),actionMenu=()=>{},serverDraft=()=>null,uid=()=>Math.random().toString(36).slice(2),preparePhoto=async f=>({blob:f}),editMsg=()=>{},reviewSend=()=>{};
const cap=x=>x,reviewedOf=()=>false,hold=()=>{},error=e=>{throw e;},toast=()=>{},fmtDur=ms=>'0:'+Math.floor(ms/1000),queueSend=(id,msg)=>{window.sent={id,take:msg.voice.take};WizardApp.capture.ack(msg.voice.take);},saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',call=async()=>({});
${composer}
window.rebuild=(id='synthetic')=>{document.querySelector('#root').replaceChildren(composer(id,{identities:[{id:'tg-fixture',network:'telegram',label:'Synthetic'}]}));}; rebuild();`;
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});try{
 const p=await b.newPage({viewport:{width:390,height:844}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 async function setup(mode='none'){
  await p.setContent('<main id="root"></main>');
  await p.evaluate(mode=>{
   window.calls={start:0,attach:0,settle:0,stop:0,cancel:0,ack:0};window.sent=null;window.active=null;
   const meta={purpose:'messenger-voice',person:'synthetic',identity:'tg-fixture'};
   window.kept=mode==='none'?[]:[{id:'old-take',durationMs:mode==='tiny'?400:5000,blob:new Blob([mode==='empty'?'':'synthetic audio']),meta}];
   if(mode==='native')active={id:'old-take',appId:'messenger',active:true,recording:true,phase:'recording',meta};
   const make=id=>({id,onLevel:()=>()=>{},getInfo:()=>({startedAt:Date.now()-1500}),cancel:async()=>{calls.cancel++;active=null;},stop:async()=>{calls.stop++;active=null;return{id,durationMs:1500,blob:new Blob(['synthetic-audio'],{type:'audio/ogg'})};}});
   window.WizardApp={capture:{
    current:()=>active,
    attach:()=>{calls.attach++;return new Promise(()=>{});}, // the old auto-probe hangs; must NEVER be called
    settle:async keep=>{calls.settle++;if(active?.id!==keep&&active){calls.stop++;active=null;}return kept;},
    pending:async()=>kept,ack:async id=>{calls.ack++;kept=kept.filter(t=>t.id!==id);},
    start:async opts=>{calls.start++;active={id:'tap-take',appId:'messenger',active:true,recording:true,phase:'recording',meta:opts.meta};return make(active.id);}
   }};
   window.badFrames=0;window.badMutations=0;window.watchOpen=true;
   new MutationObserver(()=>{if(watchOpen&&document.querySelector('.u-recording'))badMutations++;}).observe(document.body,{childList:true,subtree:true});
   function frame(){if(watchOpen&&(document.querySelector('.u-recording')||document.querySelector('.u-compose-row')?.hidden))badFrames++;requestAnimationFrame(frame);}requestAnimationFrame(frame);
  },mode);
  await p.evaluate(fixture);
 }
 async function silent(label){await p.waitForTimeout(2100);assert.equal(await p.locator('.u-recording').count(),0,label);assert.ok(await p.locator('.u-compose-row').isVisible(),label);assert.deepEqual(await p.evaluate(()=>[badFrames,badMutations,calls.attach,calls.start]),[0,0,0,0],label+' zero flash/probe/start');}
 await setup();await silent('empty open with attach hanging');console.log('PASS (a) no take: zero recording panels in every frame for 2s; composer visible; attach never called');
 for(const mode of ['empty','tiny']){await setup(mode);await silent(mode);assert.equal(await p.evaluate(()=>calls.ack),1);assert.equal(await p.locator('.u-unsent-voice').count(),0);await p.evaluate(()=>rebuild());await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>kept.length),0);}console.log('PASS (b) stale empty/tiny takes acknowledged silently and stay gone');
 await setup('real');await silent('five second leftover');assert.ok(await p.locator('.u-unsent-voice').isVisible());await p.getByRole('button',{name:'Send',exact:true}).click();await p.waitForFunction(()=>sent);assert.deepEqual(await p.evaluate(()=>sent),{id:'synthetic',take:'old-take'});assert.equal(await p.evaluate(()=>calls.ack),1);
 await setup('real');await p.locator('.u-unsent-voice').waitFor();await p.getByRole('button',{name:'Discard',exact:true}).click();await p.waitForFunction(()=>!kept.length);console.log('PASS (c) real 5s take: quiet chip, Send/Discard, no live panel');
 await setup('native');await silent('orphan running native');assert.equal(await p.evaluate(()=>calls.stop),1);assert.ok(await p.locator('.u-unsent-voice').isVisible());console.log('PASS native orphan stopped/kept, never displayed as recording');
 await setup();await p.evaluate(()=>watchOpen=false);await p.getByRole('button',{name:'Record voice message'}).click();await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.doesNotMatch(await p.locator('.u-recording').innerText(),/Starting/);assert.equal(await p.evaluate(()=>calls.start),1);
 await p.evaluate(()=>rebuild('another-person'));assert.equal(await p.locator('.u-recording').count(),0);assert.ok(await p.locator('.u-compose-row').isVisible());
 await p.evaluate(()=>rebuild());await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.equal(await p.evaluate(()=>calls.start),1);assert.equal(await p.evaluate(()=>calls.attach),0);await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>sent);assert.equal(await p.evaluate(()=>calls.stop),1);
 await setup();await p.evaluate(()=>watchOpen=false);await p.getByRole('button',{name:'Record voice message'}).click();await p.getByRole('button',{name:'Discard recording'}).click();await p.waitForFunction(()=>calls.cancel===1);assert.equal(await p.locator('.u-recording').count(),0);console.log('PASS (d,e) tap records immediately; Send/Discard; leave and return restores only this session\'s live take');
 assert.deepEqual(errors,[]);console.log('ALL PASS voice_open_browser');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
