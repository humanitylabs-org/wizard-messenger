/* Issue 262 (Miguel, Android, 17 Nov 2026): "On-device saving failed (timeout). Keep Wizard open; Send or Discard
 * still works." stayed under an idle composer after the voice note was gone. A warning about the take being recorded
 * ends with that take; notices about the finished take (too short, clipped) still show after it.
 * Exact production composer with synthetic dependencies, like voice_capture_guard_browser.
 * MESSENGER_SOURCE=<old unified.js> shows the stuck notice before the fix.
 * wizard-ux issue 1503 reopen (James, 18 Nov): the notice still sat there after the next text was sent (cases 5, 6). */
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(process.env.MESSENGER_SOURCE||path.join(__dirname,'../static/unified.js'),'utf8');
const composer=source.slice(source.indexOf('  function composer(id, p) {'),source.indexOf('  // WebM (Matroska)'));
const css=process.env.SHOT?fs.readFileSync(path.join(__dirname,'../static/unified.css'),'utf8'):'';
const WARN='On-device saving failed (timeout). Keep Wizard open; Send or Discard still works.';
const fixture=`
window.view={}; const s={drafts:{},person:'synthetic'},localAudio=new Map();
const voiceTapSession=Math.random().toString(36),voiceKept=new Map(),voiceQueued=new Set();let voiceRecoveryWork=null;
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e};
const iconButton=(icon,label,fn,cls)=>{const e=node('button',cls,label);e.type='button';e.setAttribute('aria-label',label);e.onclick=fn;return e;};
const button=(text,fn,cls)=>{const e=node('button',cls,text);e.type='button';e.onclick=fn;return e;};
const netLabel=n=>n,netBadge=()=>node('span'),bridged=n=>['telegram','whatsapp','signal'].includes(n),actionMenu=()=>{},serverDraft=()=>null,uid=()=>Math.random().toString(36).slice(2),preparePhoto=async f=>({blob:f}),editMsg=()=>{},reviewSend=()=>{};
const mentionComposer=()=>({close(){},paint(){},update(){},keydown(){return false;}}),composerMembers=()=>[],store={threads:{},lists:{}};
const switchState={on:{}};
const cap=x=>x,reviewedOf=()=>false,hold=()=>{},error=e=>{document.querySelector('#hidden-error').textContent=e.message;},toast=()=>{},fmtDur=ms=>'0:'+Math.floor(ms/1000),queueSend=(id,msg)=>{if(!msg.voice){window.texts=(window.texts||[]).concat(msg.text);return;}window.sent={id,take:msg.voice.take};WizardApp.capture.ack(msg.voice.take);},saveDrafts=()=>{},nameOf=()=>'',snippet=()=>'',call=async()=>({});
${composer}
window.rebuild=()=>{document.querySelector('#root').replaceChildren(composer('synthetic',{identities:[{id:'tg-fixture',network:'telegram',label:'Synthetic'}]}));}; rebuild();`;
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM});try{
const p=await browser.newPage({viewport:{width:390,height:844}});const errors=[];p.on('pageerror',e=>errors.push(e.message));
// An Android-like take (no plain-audio check): the shared recorder warns through onWarn, or via getInfo().warning
// when Messenger attaches to a take that already warned.
async function setup({durationMs=5000,infoWarning=null}={}){
 await p.setContent((process.env.SHOT?'<style>'+css+'</style><div class="u-app" style="position:fixed;left:0;right:0;bottom:0">':'')+'<div id="root"></div><p id="hidden-error" hidden></p>');
 await p.evaluate(([durationMs,infoWarning])=>{window.AudioEncoder=window.AudioEncoder||function(){};window.calls={ack:0,cancel:0};window.sent=null;window.active=null;window.warn=null;const t0=Date.now()-durationMs;
  window.session={id:'take-1',onLevel:()=>()=>{},onWarn:cb=>{window.warn=cb;return()=>{window.warn=null;};},getInfo:()=>({startedAt:t0,durationMs,warning:infoWarning}),cancel:async()=>{calls.cancel++;active=null;},
   stop:async()=>{active=null;return{id:'take-1',mime:'audio/webm',durationMs,meta:{purpose:'messenger-voice',person:'synthetic'},blob:new Blob([new Uint8Array(4000)],{type:'audio/webm'})};}};
  window.WizardApp={update:{hold:()=>({release(){}})},capture:{capabilities:()=>({}),current:()=>active?{id:active,appId:'messenger',active:true,recording:true,phase:'recording',meta:{}}:null,
   attach:async()=>null,ack:async()=>{calls.ack++;},pending:async()=>[],settle:async()=>[],start:async()=>{active='take-1';return session;}}};
 },[durationMs,infoWarning]);await p.evaluate(fixture);
}
const notice=()=>p.locator('.u-voice-notice');
async function recordAndWarn(){
 await p.getByRole('button',{name:'Record voice message'}).click();
 await p.getByRole('button',{name:'Send voice message'}).waitFor();
 await p.evaluate(w=>window.warn(w),WARN);
 await notice().waitFor();assert.equal(await notice().innerText(),WARN,'warning shows while recording');
}
if(process.env.SHOT){await setup();await recordAndWarn();await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>window.sent);await p.waitForTimeout(300);await p.screenshot({path:process.env.SHOT});console.log('SHOT',process.env.SHOT);return;}
// 1. Send: the note goes out and the storage warning goes with the recording panel.
await setup();await recordAndWarn();
await p.getByRole('button',{name:'Send voice message'}).click();
await p.waitForFunction(()=>window.sent);
await p.getByRole('button',{name:'Record voice message'}).waitFor();
assert.equal(await notice().isVisible(),false,'no storage warning under the idle composer after Send');
console.log('PASS warning cleared after Send');
// 2. Discard: same.
await setup();await recordAndWarn();
await p.getByRole('button',{name:'Discard recording'}).click();
await p.waitForFunction(()=>calls.cancel===1);
await p.getByRole('button',{name:'Record voice message'}).waitFor();
assert.equal(await notice().isVisible(),false,'no storage warning under the idle composer after Discard');
console.log('PASS warning cleared after Discard');
// 3. A warning carried by the take itself (getInfo) also ends with it.
await setup({infoWarning:WARN});await p.getByRole('button',{name:'Record voice message'}).click();
await p.getByRole('button',{name:'Send voice message'}).waitFor();
assert.equal(await notice().innerText(),WARN,'carried warning shows while recording');
await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>window.sent);
assert.equal(await notice().isVisible(),false,'carried warning cleared after Send');
console.log('PASS carried warning cleared');
// 4. A notice about the finished take still shows: a too-short take replaces the live warning.
await setup({durationMs:300});await recordAndWarn();
await p.getByRole('button',{name:'Send voice message'}).click();
await p.getByRole('button',{name:'Record voice message'}).waitFor();
assert.equal(await notice().innerText(),'Hold on a little longer to record','after-take notice still shown');
console.log('PASS after-take notice kept');
// 5. wizard-ux issue 1503 reopen: a notice still under the composer goes once the owner sends a text message.
await p.locator('textarea').fill('Thanks');await p.getByRole('button',{name:'Send',exact:true}).click();
await p.waitForFunction(()=>(window.texts||[]).includes('Thanks'));
assert.equal(await notice().isVisible(),false,'no voice notice after the next text is sent');
console.log('PASS notice cleared when a text is sent');
// 6. A storage warning that reaches Messenger after the take closed never paints under the idle composer.
await setup();await p.getByRole('button',{name:'Record voice message'}).click();
await p.getByRole('button',{name:'Send voice message'}).waitFor();
await p.evaluate(()=>{window.lateWarn=window.warn;});
await p.getByRole('button',{name:'Send voice message'}).click();await p.waitForFunction(()=>window.sent);
await p.evaluate(w=>window.lateWarn(w),WARN);await p.waitForTimeout(100);
assert.equal(await notice().isVisible(),false,'a late warning after the take closed is ignored');
console.log('PASS late warning ignored');
assert.deepEqual(errors,[]);console.log('ALL PASS voice_live_notice_browser');
}finally{await browser.close();}})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
