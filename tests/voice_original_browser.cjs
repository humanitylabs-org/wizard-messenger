/* Real shared capture + SDK; real disposable archive HTTP boundary. No installed owner data.
 * CORE_DIR must contain the downloaded live app-capture.js and app-client.js.
 * RECORD_MS defaults to the required real-time 120-second take. */
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('assert/strict'),{spawn}=require('child_process');
const {chromium}=require('playwright');
const core=process.env.CORE_DIR;if(!core)throw Error('CORE_DIR required');
const source=fs.readFileSync(path.join(__dirname,'../static/unified.js'),'utf8');
const helpers=source.slice(source.indexOf('  async function saveVoiceRecording('),source.indexOf('  async function upload('));
const queue=source.slice(source.indexOf('  const queues = {};'),source.indexOf('  // A send Messenger refused'));
const deadline=source.slice(source.indexOf('  const VOICE_STEP_MIN_MS'),source.indexOf("  if (typeof module !== 'undefined')")); // issue 273
let backend,fixture,browser,stage;
const server=http.createServer((q,r)=>{
 if(q.url.startsWith('/api/')){const up=http.request({hostname:'127.0.0.1',port:backend,path:q.url,method:q.method,headers:q.headers},res=>{r.writeHead(res.statusCode,res.headers);res.pipe(r);});up.on('error',e=>{r.writeHead(502);r.end(e.message);});q.pipe(up);return;}
 if(q.url.endsWith('.js')){const name=path.basename(q.url);if(!['app-client.js','app-capture.js'].includes(name)){r.writeHead(404);return r.end();}r.setHeader('Content-Type','application/javascript');return r.end(fs.readFileSync(path.join(core,name)));}
 r.setHeader('Content-Type','text/html');r.end('<!doctype html><div id="root"></div><script src="/core/app-capture.js"></script><script src="/core/app-client.js"></script>');
});
(async()=>{await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;
 stage=spawn('python3',[path.join(__dirname,'voice_archive_stage.py'),origin],{cwd:path.join(__dirname,'..'),env:{...process.env,PYTHONPATH:'.:tests'}});stage.stderr.pipe(process.stderr);
 fixture=await new Promise((ok,no)=>{let text='';stage.stdout.on('data',d=>{text+=d;try{ok(JSON.parse(text.split('\n')[0]));}catch{}});stage.on('exit',c=>no(Error('stage exit '+c)));});backend=fixture.port;
 browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const ctx=await browser.newContext({permissions:['microphone']});await ctx.addCookies([{name:'wizard_messenger_session',value:fixture.cookie,url:origin}]);const p=await ctx.newPage();await p.goto(origin);await p.evaluate(()=>WizardApp.ready({name:'Messenger fixture',version:'test'}));
 // Standalone SDK uses its scoped app identity derived from ready(). Capture metadata is real.
 await p.evaluate(async()=>{window.session=await WizardApp.capture.start({kind:'audio',meta:{purpose:'messenger-voice',person:'synthetic'}});});
 await p.waitForTimeout(Number(process.env.RECORD_MS||120000));
 const first=await p.evaluate(async()=>{window.take=await session.stop();return {id:take.id,size:take.blob.size,duration:take.durationMs,sha:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await take.blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')};});
 assert(first.duration>=Number(process.env.RECORD_MS||120000)-1000);assert(first.size>0);
 await p.reload();await p.evaluate(()=>WizardApp.ready({name:'Messenger fixture',version:'test'}));
 const restored=await p.evaluate(async()=>{window.take=(await WizardApp.capture.pending())[0];return {id:take?.id,size:take?.blob.size,sha:take?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await take.blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join(''):null};});assert.equal(restored.id,first.id);assert.equal(restored.sha,first.sha);
 await p.evaluate(({helpers,queue,csrf:token})=>{window.csrf=()=>token;window.toasts=[];window.toast=x=>toasts.push(x);window.store={threads:{synthetic:{person:{identities:[{network:'telegram'}]},messages:[]}},pending:0};window.s={person:'synthetic'};window.uid=()=>Math.random().toString(36).slice(2);window.hold=()=>{};window.paintThread=()=>{};window.mergeMessages=()=>{};window.calls={upload:0,send:0,ack:0};window.upload=async()=>{calls.upload++;throw Error('Unsupported raw bytes fixture');};window.call=async()=>{calls.send++;};WizardApp.capture.ack=async()=>{calls.ack++;};window.csrf=()=>token;eval(helpers+queue+';window.archiveTest=archiveVoiceOriginal;window.saveTest=saveVoiceRecording;window.queueTest=queueSend;');}, {helpers:deadline+helpers,queue,csrf:fixture.csrf});
 const receipt=await p.evaluate(()=>archiveTest({blob:take.blob,take:take.id,duration:take.durationMs}));assert.equal(receipt.sha256,first.sha);assert.equal(receipt.size,first.size);
 await p.evaluate(()=>{window.raw=new Blob([new Uint8Array([0,255,128,1,0,1,2,3,4])],{type:'audio/unknown'});queueTest('synthetic',{voice:{blob:raw,take:'existing-unsupported',duration:120000,waveform:[],url:'blob:fixture'}});});
 await p.waitForFunction(()=>store.threads.synthetic.messages[0]?.failed);assert.deepEqual(await p.evaluate(()=>calls),{upload:1,send:0,ack:0});assert.equal(await p.evaluate(()=>store.threads.synthetic.messages.length),1);
 const rawReceipt=await p.evaluate(()=>archiveTest({blob:raw,take:'existing-unsupported',duration:120000}));assert.equal(rawReceipt.head_hex,'00ff80010001020304');
 // Sharing really traverses the SDK, with native cancellation/unsupported injected at its platform boundary.
 for(const outcome of ['cancelled','unsupported','shared']){
 await p.evaluate(outcome=>{window.sharedFile=null;Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>outcome!=='unsupported'});Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.sharedFile=data.files?.[0];if(outcome==='cancelled')throw new DOMException('Cancelled','AbortError');}});},outcome);
 await p.evaluate(()=>{const b=document.createElement('button');b.id='save';b.onclick=()=>store.threads.synthetic.messages[0].saveRecording();document.querySelector('#root').replaceChildren(b);});await p.locator('#save').click();await p.waitForTimeout(300);
 const text=await p.evaluate(()=>toasts.at(-1));assert.match(text,outcome==='cancelled'?/cancelled/:outcome==='unsupported'?/unavailable/:/shared/);assert.equal(await p.evaluate(()=>calls.ack),0);if(outcome!=='unsupported')assert.equal(await p.evaluate(async()=>Array.from(new Uint8Array(await sharedFile.arrayBuffer())).join(',')),'0,255,128,1,0,1,2,3,4');
 }
 assert.equal(await p.evaluate(()=>sharedFile.type),'audio/unknown');
 // Archive failures and mismatching readback must stop before conversion/provider writes.
 for (const mode of ['put-failure','readback-mismatch']) {
   await p.evaluate(()=>{store.threads.synthetic.messages=[];calls.upload=calls.send=calls.ack=0;});
   const pattern=mode==='put-failure'?'**/api/view/voice-original?*':'**/api/view/voice-original/*';
   await p.route(pattern,route=>route.fulfill({status:mode==='put-failure'?503:200,contentType:mode==='put-failure'?'application/json':'application/octet-stream',body:mode==='put-failure'?JSON.stringify({ok:false,error:{message:'fixture archive unavailable'}}):'mismatch'}));
   await p.evaluate(()=>queueTest('synthetic',{voice:{blob:raw,take:'archive-failure',duration:120000,waveform:[],url:'blob:fixture'}}));
   await p.waitForFunction(()=>store.threads.synthetic.messages[0]?.failed);
   assert.deepEqual(await p.evaluate(()=>calls),{upload:0,send:0,ack:0});assert.equal(await p.evaluate(()=>typeof store.threads.synthetic.messages[0].saveRecording),'function');
   await p.unroute(pattern);
 }
 const composer=source.slice(source.indexOf('  function composer(id, p) {'),source.indexOf('  // WebM (Matroska)'));
 await p.evaluate(({composer,helpers})=>{eval(`
 const view={},s={drafts:{},person:'synthetic'},localAudio=new Map(),voiceKept=new Map(),voiceQueued=new Set(),voiceTapSession='fixture';let voiceRecoveryWork=null;
 const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
 const button=(text,fn,cls)=>{const e=node('button',cls,text);e.type='button';e.onclick=fn;return e;};
 const iconButton=(icon,label,fn,cls)=>{const e=button(label,fn,cls);e.setAttribute('aria-label',label);return e;};
 const netLabel=n=>n,netBadge=()=>node('span'),bridged=()=>true,actionMenu=()=>{},serverDraft=()=>null,cap=x=>x,reviewedOf=()=>false,error=()=>{},fmtDur=ms=>String(ms),saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',queueSend=()=>{throw Error('Recovery must not auto-send');};
 ${helpers}\n${composer}\ndocument.querySelector('#root').replaceChildren(composer('synthetic',{identities:[{id:'fixture',network:'telegram'}]}));`);},{composer,helpers});
 await p.locator('.u-unsent-voice').waitFor();assert.equal(await p.getByRole('button',{name:'Save recording',exact:true}).count(),1);assert.equal(await p.evaluate(()=>calls.ack),0);
 console.log(JSON.stringify({pass:true,recording:first,recovered:restored,archive:receipt,unsupportedArchive:rawReceipt,sharedCore:Object.fromEntries(['app-capture.js','app-client.js'].map(n=>[n,require('crypto').createHash('sha256').update(fs.readFileSync(path.join(core,n))).digest('hex')]))}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(stage)stage.kill();server.close();});
