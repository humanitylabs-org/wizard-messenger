/* James: mic must show its take immediately and never hide a running recorder.
 * James (31 Oct 2026, Samsung SM-S938B): a start that never answers must hand the composer back, not sit on
 * "Stopping…" forever with the mic disabled.
 * Exact production composer, isolated synthetic dependencies; no contacts/network.
 * MESSENGER_SOURCE=<old unified.js> proves the hung-start cases fail before the fix. */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(process.env.MESSENGER_SOURCE||path.join(__dirname,'../static/unified.js'),'utf8');
const composer=source.slice(source.indexOf('  function composer(id, p) {'),source.indexOf('  // WebM (Matroska)'));
const fixture=`
window.view={}; const s={drafts:{},person:'synthetic'},localAudio=new Map();
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
const iconButton=(icon,label,fn,cls)=>{const e=node('button',cls,label);e.type='button';e.setAttribute('aria-label',label);e.onclick=fn;return e;};
const button=(text,fn,cls)=>{const e=node('button',cls,text);e.type='button';e.onclick=fn;return e;};
const netLabel=n=>n,netBadge=()=>node('span'),bridged=n=>['telegram','whatsapp','signal'].includes(n),actionMenu=()=>{},serverDraft=()=>null,uid=()=>Math.random().toString(36).slice(2),preparePhoto=async f=>({blob:f}),editMsg=()=>{},reviewSend=()=>{};
const cap=x=>x,reviewedOf=()=>false,hold=()=>{},error=e=>{document.querySelector('#hidden-error').textContent=e.message;},toast=()=>{},fmtDur=ms=>'0:'+Math.floor(ms/1000),queueSend=(id,msg)=>{window.sent={id,take:msg.voice.take};WizardApp.capture.ack(msg.voice.take);},saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',call=async()=>({});
${composer}
window.rebuild=()=>{document.querySelector('#root').replaceChildren(composer('synthetic',{identities:[{id:'tg-fixture',network:'telegram',label:'Synthetic'}]}));}; rebuild();`;
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});try{
const p=await browser.newPage({viewport:{width:390,height:844}}); const errors=[];p.on('pageerror',e=>errors.push(e.message));
async function setup(mode='pending'){
 await p.setContent('<div id="root"></div><p id="hidden-error" hidden></p>');
 await p.evaluate(mode=>{window.calls={start:0,cancel:0,stop:0,attach:0,ack:0,cancelled:[]};window.active=null;window.sent=null;window.starts=[];
 const make=id=>({id,onLevel:()=>()=>{},getInfo:()=>({startedAt:Date.now()-1500}),cancel:async()=>{calls.cancel++;calls.cancelled.push(id);if(active===id)active=null;},stop:async()=>{calls.stop++;if(active===id)active=null;return{id,durationMs:1500,blob:new Blob(['synthetic-audio'],{type:'audio/ogg'})};}});
 window.session=make('take-fixture');
 window.resolveStart=(i=0)=>starts[i].resolve();
 window.WizardApp={update:{hold:()=>({release(){}})},capture:{current:()=>active?{id:active,meta:{person:'synthetic'}}:null,attach:async()=>{if(!active)return null;calls.attach++;return session;},ack:async()=>{calls.ack++;},start:()=>{calls.start++;if(mode==='fail')return Promise.reject(new Error('Microphone held by Recorder'));
   const n=starts.length,sess=n?make('take-'+n):session;return new Promise(resolve=>{starts.push({session:sess,resolve:()=>{active=sess.id;resolve(sess);}});});}}};
 },mode); await p.evaluate(fixture);
}
const visible=()=>p.locator('.u-recording').isVisible();
// The composer is back: the text row shows, the mic is enabled, no panel and no "Stopping…" anywhere.
async function composerBack(label){
 assert.equal(await p.locator('.u-recording').count(),0,label+': recording panel closed');
 assert.equal(await p.locator('.u-compose-row').isVisible(),true,label+': composer row visible');
 assert.equal(await p.locator('.u-mic').isEnabled(),true,label+': mic enabled');
 assert.doesNotMatch(await p.locator('#root').innerText(),/Stopping/,label+': no Stopping…');
}
if(process.env.PROVE_OLD_REBUILD){await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.evaluate(()=>{rebuild();resolveStart();});await p.waitForFunction(()=>active);await p.waitForTimeout(100);assert.equal(await p.locator('.u-recording').count(),0);assert.ok(await p.evaluate(()=>active));console.log('CONFIRMED old composer rebuild: physical take active, recording panel detached and invisible');return;}
// Hung start first: these are the cases that fail before the 15.8 fix.
await setup();await p.getByRole('button',{name:'Record voice message'}).click();
assert.match(await p.locator('.u-recording').innerText(),/Starting/);
const t0=Date.now();await p.locator('.u-voice-notice').waitFor({state:'visible',timeout:10000});
await p.waitForFunction(()=>!document.querySelector('.u-recording'),null,{timeout:1000}).catch(()=>{});
await composerBack('start never answers');
assert.ok(Date.now()-t0<9500,'composer back within 1 s of the 8 s deadline');
assert.match(await p.locator('.u-voice-notice').innerText(),/didn.t start\. Tap the mic to try again/);
// A newer recording begins; then the abandoned start answers late. Only the late session is cancelled.
await p.getByRole('button',{name:'Record voice message'}).click();
await p.waitForFunction(()=>starts.length===2,null,{timeout:5000});await p.evaluate(()=>resolveStart(1));
await p.getByRole('button',{name:'Send voice message'}).waitFor();
await p.evaluate(()=>resolveStart(0));await p.waitForFunction(()=>calls.cancel===1);
assert.deepEqual(await p.evaluate(()=>calls.cancelled),['take-fixture'],'late session cancelled, newer take untouched');
assert.ok(await p.getByRole('button',{name:'Send voice message'}).isVisible(),'newer recording keeps Send/Discard');
assert.equal(await p.locator('.u-voice-notice').isVisible(),false,'late start paints no notice over the newer recording');
console.log('PASS hung start: composer back after deadline, mic enabled, no Stopping…, late session cancelled without touching the newer recording');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.getByRole('button',{name:'Discard recording'}).click();
await composerBack('Discard while Starting');
await p.evaluate(()=>resolveStart());await p.waitForFunction(()=>calls.cancel===1);assert.equal(await p.evaluate(()=>active),null);
console.log('PASS Discard while Starting gives the composer back at once and cancels the late take');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();
assert.ok(await visible(),'James: recording panel visible immediately while start is pending');
assert.match(await p.locator('.u-recording').innerText(),/Starting/);
await p.evaluate(()=>{document.querySelector('.u-mic').click();rebuild();});
assert.equal(await p.evaluate(()=>calls.start),1,'double mic tap starts once');assert.ok(await visible());
await p.evaluate(()=>resolveStart());await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.ok(await visible(),'late start after composer rebuild stays visible');
await p.evaluate(()=>rebuild());assert.ok(await visible(),'live composer rebuild keeps Send/Discard');
await p.getByRole('button',{name:/Discard recording|Cancel recording/}).click();await p.waitForFunction(()=>!active);
console.log('PASS immediate panel, pending/live composer rebuild, double tap, discard');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.evaluate(()=>resolveStart());
await p.getByRole('button',{name:'Send voice message'}).waitFor();
// Re-run the document-scoped production composer with fresh view, preserving the host-owned take.
await p.evaluate(()=>{view.recording.off?.();clearInterval(view.recording.tick);});await p.evaluate(fixture);
await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.equal(await p.evaluate(()=>calls.attach),1);assert.equal(await p.evaluate(()=>calls.start),1);
await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>!!sent);assert.deepEqual(await p.evaluate(()=>sent),{id:'synthetic',take:'take-fixture'});assert.equal(await p.evaluate(()=>calls.ack),1);assert.equal(await p.evaluate(()=>active),null);
console.log('PASS app-document reload reattaches own take, sends original target and acknowledges');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.evaluate(()=>resolveStart());await p.getByRole('button',{name:'Send voice message'}).waitFor();await p.evaluate(()=>{clearInterval(view.recording.tick);view.recording.off?.();});await p.evaluate(fixture);await p.getByRole('button',{name:'Discard recording'}).click();await p.waitForFunction(()=>!active);console.log('PASS app-document reload can discard own take');
await setup('fail');await p.getByRole('button',{name:'Record voice message'}).click();await p.waitForFunction(()=>document.querySelector('.u-voice-notice')?.textContent);assert.ok(await p.locator('.u-voice-notice').isVisible());assert.match(await p.locator('.u-voice-notice').innerText(),/Recorder/);assert.equal(await p.evaluate(()=>active),null);await composerBack('busy start');console.log('PASS failed/busy start names holder in visible thread notice');
assert.deepEqual(errors,[]);
// Leave the composer + notice on screen for the screenshot.
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.locator('.u-voice-notice').waitFor({state:'visible',timeout:10000});
await p.screenshot({path:process.env.VOICE_SCREENSHOT||'voice-note-recording.png'});
console.log('ALL PASS voice_note_record_browser');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
