/* James: mic must show its take immediately and never hide a running recorder.
 * Exact production composer, isolated synthetic dependencies; no contacts/network. */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(process.env.MESSENGER_SOURCE||path.join(__dirname,'../static/unified.js'),'utf8');
const composer=source.slice(source.indexOf('  function composer(id, p) {'),source.indexOf('  // WebM (Matroska)'));
const fixture=`
window.view={}; const s={drafts:{},person:'synthetic'},localAudio=new Map();
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
const iconButton=(icon,label,fn,cls)=>{const e=node('button',cls,label);e.type='button';e.setAttribute('aria-label',label);e.onclick=fn;return e;};
const cap=x=>x,reviewedOf=()=>false,hold=()=>{},error=e=>{document.querySelector('#hidden-error').textContent=e.message;},toast=()=>{},fmtDur=ms=>'0:'+Math.floor(ms/1000),queueSend=(id,msg)=>{window.sent={id,take:msg.voice.take};WizardApp.capture.ack(msg.voice.take);},saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',call=async()=>({});
${composer}
window.rebuild=()=>{document.querySelector('#root').replaceChildren(composer('synthetic',{identities:[{id:'tg-fixture',network:'telegram',label:'Synthetic'}]}));}; rebuild();`;
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});try{
const p=await browser.newPage({viewport:{width:390,height:844}}); const errors=[];p.on('pageerror',e=>errors.push(e.message));
async function setup(mode='pending'){
 await p.setContent('<div id="root"></div><p id="hidden-error" hidden></p>');
 await p.evaluate(mode=>{window.calls={start:0,cancel:0,stop:0,attach:0,ack:0};window.active=false;window.sent=null;
 const session={id:'take-fixture',onLevel:()=>()=>{},getInfo:()=>({startedAt:Date.now()-1500}),cancel:async()=>{calls.cancel++;active=false;},stop:async()=>{calls.stop++;active=false;return{id:'take-fixture',durationMs:1500,blob:new Blob(['synthetic-audio'],{type:'audio/ogg'})};}};
 window.WizardApp={update:{hold:()=>({release(){}})},capture:{current:()=>active?{id:session.id,meta:{person:'synthetic'}}:null,attach:async()=>{if(!active)return null;calls.attach++;return session;},ack:async()=>{calls.ack++;},start:()=>{calls.start++;if(mode==='fail')return Promise.reject(new Error('Microphone held by Recorder'));return new Promise(resolve=>{window.resolveStart=()=>{active=true;resolve(session);};});}}};
 },mode); await p.evaluate(fixture);
}
const visible=()=>p.locator('.u-recording').isVisible();
await setup();await p.getByRole('button',{name:'Record voice message'}).click();
assert.ok(await visible(),'James: recording panel visible immediately while start is pending');
assert.match(await p.locator('.u-recording').innerText(),/Starting/);
await p.evaluate(()=>{document.querySelector('.u-mic').click();rebuild();});
assert.equal(await p.evaluate(()=>calls.start),1,'double mic tap starts once');assert.ok(await visible());
await p.evaluate(()=>resolveStart());await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.ok(await visible(),'late start after composer rebuild stays visible');
await p.evaluate(()=>rebuild());assert.ok(await visible(),'live composer rebuild keeps Send/Discard');
await p.getByRole('button',{name:/Discard recording|Cancel recording/}).click();assert.equal(await p.evaluate(()=>active),false);
console.log('PASS immediate panel, pending/live composer rebuild, double tap, discard');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.evaluate(()=>resolveStart());
// Re-run the document-scoped production composer with fresh view, preserving the host-owned take.
await p.evaluate(()=>{view.recording.off?.();clearInterval(view.recording.tick);});await p.evaluate(fixture);
await p.getByRole('button',{name:'Send voice message'}).waitFor();assert.equal(await p.evaluate(()=>calls.attach),1);assert.equal(await p.evaluate(()=>calls.start),1);
await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>!!sent);assert.deepEqual(await p.evaluate(()=>sent),{id:'synthetic',take:'take-fixture'});assert.equal(await p.evaluate(()=>calls.ack),1);assert.equal(await p.evaluate(()=>active),false);
console.log('PASS app-document reload reattaches own take, sends original target and acknowledges');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.evaluate(()=>resolveStart());await p.evaluate(()=>{clearInterval(view.recording.tick);view.recording.off?.();});await p.evaluate(fixture);await p.getByRole('button',{name:'Discard recording'}).click();assert.equal(await p.evaluate(()=>active),false);console.log('PASS app-document reload can discard own take');
await setup('fail');await p.getByRole('button',{name:'Record voice message'}).click();await p.waitForFunction(()=>document.querySelector('.u-voice-notice')?.textContent);assert.ok(await p.locator('.u-voice-notice').isVisible());assert.match(await p.locator('.u-voice-notice').innerText(),/Recorder/);assert.equal(await p.evaluate(()=>active),false);console.log('PASS failed/busy start names holder in visible thread notice');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.locator('.u-voice-notice').waitFor({state:'visible',timeout:10000});assert.match(await p.locator('.u-voice-notice').innerText(),/too long/);await p.evaluate(()=>resolveStart());await p.waitForFunction(()=>calls.cancel===1);assert.equal(await p.evaluate(()=>active),false);assert.equal(await p.locator('.u-recording').count(),0);console.log('PASS 8-second timeout cancels late start with no orphan');
await setup();await p.getByRole('button',{name:'Record voice message'}).click();await p.getByRole('button',{name:'Discard recording'}).click();await p.evaluate(()=>resolveStart());await p.waitForFunction(()=>calls.cancel===1);assert.equal(await p.evaluate(()=>active),false);console.log('PASS Cancel while starting cancels late take');
assert.deepEqual(errors,[]);await p.screenshot({path:process.env.VOICE_SCREENSHOT||'voice-note-recording.png'});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
