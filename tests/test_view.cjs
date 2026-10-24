'use strict';
// Lightweight Node fixture/source tests ONLY. These are not browser, relay,
// container, layout, physical-Back or two-human-account acceptance evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'static/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/app.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const L = require('../static/app.js');
const ownHex = '11'.repeat(32), peerHex = '22'.repeat(32), group = 'ab'.repeat(32);
const own = {account_id: ownHex, npub: L.encodePublic(ownHex), display_name: 'Fixture owner'};
const peer = {member_id: peerHex, npub: L.encodePublic(peerHex), display_name: 'Fixture peer'};
const dm = {group_id: group, name: 'Direct message', pending_confirmation: false, members: [peer, {member_id: ownHex}]};
const msg = (id, created_at = 10, direction = 'received', text = 'Fixture text') => ({message_id: id.repeat(64), group_id: group, author: direction === 'received' ? peerHex : ownHex, direction, text, created_at});

// Independent test-only bech32 builder, for nprofile TLV/corruption fixtures.
function profile(bytes) {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let acc = 0, bits = 0; const words = [];
  for (const byte of bytes) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); } }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const hrp = 'nprofile', expanded = [...hrp].map(c => c.charCodeAt(0) >> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31));
  let chk = 1;
  for (const w of expanded.concat(words, [0,0,0,0,0,0])) {
    const high = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ w;
    [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3].forEach((g,i) => { if ((high >>> i) & 1) chk ^= g; });
  }
  chk ^= 1;
  return hrp + '1' + words.concat(Array.from({length: 6}, (_,i) => (chk >>> (5 * (5-i))) & 31)).map(n => alphabet[n]).join('');
}

test('public npub encoding/decoding round trips exact 32-byte keys', () => {
  for (const key of [ownHex, peerHex, '00'.repeat(32), 'ff'.repeat(32)]) {
    const npub = L.encodePublic(key); assert.equal(npub.length, 63);
    assert.equal(L.keyHex(npub), key); assert.equal(L.decodeAddress(npub).npub, npub);
  }
});
test('address input preserves valid tokens and rejects repaired/malformed tokens', () => {
  assert.equal(L.decodeAddress(peerHex).pubkey, peerHex);
  for (const address of [peerHex.toUpperCase().replace(/2/g, 'A'), ' ' + peerHex, peerHex + ' ', 'npub1invalid', 'nsec1secret', 'name@example.com', L.encodePublic(peerHex).toUpperCase(), L.encodePublic(peerHex).slice(0,-1) + 'x']) assert.throws(() => L.decodeAddress(address));
});
test('nprofile decodes public-key TLV; rejects duplicate/missing/truncated key', () => {
  const key = [...Buffer.from(peerHex, 'hex')];
  assert.equal(L.decodeAddress(profile([0,32,...key,1,3,97,98,99])).pubkey, peerHex);
  for (const bytes of [[0,31,...key.slice(0,31)], [1,1,1], [0,32,...key,0,32,...key], [0,32,...key,1,4,1], [0]]) assert.throws(() => L.decodeAddress(profile(bytes)));
});
test('peer is selected from member public identity, never arbitrary members[0]', () => {
  assert.deepEqual(L.peerOf(dm, own), peer);
  assert.deepEqual(L.peerOf({...dm, members: [{npub: own.npub},peer]}, own), peer);
  assert.equal(L.peerOf({...dm,members:[peer,{member_id:'33'.repeat(32)}]},own), null);
});
test('copy renders npub, not raw public hex; invalid identity has no invented address', () => {
  assert.equal(L.publicAddress({member_id: peerHex}), peer.npub);
  assert.equal(L.publicAddress({member_id: 'not-a-key'}), '');
});
test('history merges by exact ID, retains older events and sorts equal timestamps by ID', () => {
  const old = [msg('b',10),msg('a',10)], incoming = [msg('b',10,'received','Updated'),msg('c',11)];
  const merged = L.mergeMessages(old,incoming);
  assert.deepEqual(merged.map(m=>m.message_id), ['a','b','c'].map(c=>c.repeat(64)));
  assert.equal(merged[1].text,'Updated'); assert.equal(old[0].text,'Fixture text');
});
test('message timestamp accepts epoch seconds/ISO and rejects nonfinite data', () => {
  assert.equal(L.stamp(10),10000); assert.equal(L.stamp('10'),10000);
  assert.equal(L.stamp('1970-01-01T00:00:10Z'),10000);
  assert.equal(L.stamp(Infinity),0); assert.equal(L.stamp('invalid'),0);
});
test('scroll follows only within the 48px threshold', () => {
  assert.equal(L.nearBottom(452,1000,500),true); assert.equal(L.nearBottom(451,1000,500),false);
});
test('Back closes exactly one layer; root returns false for actual Wizard hook', () => {
  const sheet = L.backLayer({group,sheet:'address'}); assert.equal(sheet.group,group); assert.equal(sheet.sheet,null); assert.equal(sheet.handled,true);
  const list = L.backLayer(sheet); assert.equal(list.group,null); assert.equal(list.handled,true);
  assert.equal(L.backLayer(list).handled,false);
});
test('Sent requires positive publication; Queued requires durable event IDs', () => {
  assert.equal(L.receiptState({published:1,message_ids:['f'.repeat(64)]}),'sent');
  assert.equal(L.receiptState({published:0,message_ids:['f'.repeat(64)]}),'queued');
  assert.equal(L.receiptState({published:1,message_ids:[]}),'checking');
});
test('ambiguous engine/network/abort failures never permit fresh-send Retry', () => {
  for (const code of ['send_outcome_unknown','engine_unavailable','marmot_operation_failed',undefined]) assert.equal(L.failedSendState({code}), 'checking');
  for (const code of ['invalid_input','vault_locked','unauthorized']) assert.equal(L.failedSendState({code}),'failed');
});
test('passphrase minimum counts Unicode characters rather than UTF-16 units', () => {
  assert.equal(L.passphraseLength('😀'.repeat(8)),8); assert.equal(L.passphraseLength('😀'.repeat(16)),16);
});
test('source/markup use local assets, selectable Wizard tokens, no demo/token/import sink', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  for (const [,id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id),'missing HTML id: '+id);
  assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|Authorization:|Bearer |console\./);
  assert.doesNotMatch(html,/<script[^>]+https?:|<link[^>]+https?:|API token|nsec|Import/);
  assert.match(css,/user-select: text/); assert.match(css,/min-width: 720px/); assert.match(css,/grid-template-columns: 300px/);
  assert.match(css,/prefers-reduced-motion: reduce/); assert.match(source,/window\.__wizardCloseOverlay = backStep/);
  assert.doesNotMatch(source,/wizardBackStep|__wosBack|\.postMessage\(/);
});

// Minimal DOM API fixture. It deliberately has no browser layout engine:
// source/lifecycle tests below cannot prove geometry, selection or physical Back.
class FixtureElement {
  constructor(tag, doc) {
    this.tagName=tag.toUpperCase(); this.doc=doc; this.children=[]; this.parentNode=null;
    this.listeners={}; this.attributes={}; this.style={setProperty(){}}; this.dataset={};
    this.value=''; this.hidden=false; this.disabled=false; this.className=''; this.type='';
    this.scrollTop=0; this.scrollHeight=200; this.clientHeight=500; this._text='';
    this.classList={add:(...v)=>this.className=[...new Set(this.className.split(/\s+/).filter(Boolean).concat(v))].join(' '), remove:(...v)=>this.className=this.className.split(/\s+/).filter(x=>!v.includes(x)).join(' '), toggle:(v,on)=>{ const present=this.className.split(/\s+/).includes(v); const add=on===undefined?!present:on; this.classList[add?'add':'remove'](v); return add; },contains:v=>this.className.split(/\s+/).includes(v)};
  }
  set textContent(value) { this._text=String(value??''); this.replaceChildren(); }
  get textContent() { return this._text+this.children.map(c=>c.textContent).join(''); }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node==='string') { const text=new FixtureElement('span',this.doc); text.textContent=node; node=text; }
      if (node.tagName==='#FRAGMENT') { this.append(...[...node.children]); continue; }
      node.remove(); node.parentNode=this; this.children.push(node);
    }
  }
  replaceChildren(...nodes) { for(const child of this.children) child.parentNode=null; this.children=[]; this.append(...nodes); }
  remove() { if(this.parentNode) { const list=this.parentNode.children; const i=list.indexOf(this); if(i>=0) list.splice(i,1); this.parentNode=null; } }
  get isConnected() { return !!this.parentNode || !!this.id; }
  setAttribute(name,value) { this.attributes[name]=String(value); }
  getAttribute(name) { return this.attributes[name]??null; }
  addEventListener(type,fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type,event={}) { event={target:this,preventDefault(){},stopPropagation(){},...event}; for(const fn of this.listeners[type]||[]) fn(event); return this['on'+type]?.(event); }
  focus() { this.doc.activeElement=this; }
  getBoundingClientRect() { return {top:0,bottom:40}; }
  getClientRects() { return this.hidden?[]:[this.getBoundingClientRect()]; }
  querySelectorAll() { return this.children.flatMap(c=>[c,...c.querySelectorAll()]).filter(c=>['BUTTON','INPUT'].includes(c.tagName)); }
  scrollTo({top}) { this.scrollTop=top; }
  requestSubmit() { this.fire('submit'); }
  reset() { this.value=''; }
}
async function fixture({respond, saved=new Map(), hash='', standalone=false, hidden=false, storageBlocked=false}={}) {
  const elements=new Map(), document={hidden, activeElement:null,listeners:{},getElementById:id=>elements.get(id),createElement:tag=>new FixtureElement(tag,document),createDocumentFragment:()=>new FixtureElement('#fragment',document),addEventListener(type,fn){(this.listeners[type] ||= []).push(fn);}};
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const el=new FixtureElement(match[1],document); el.id=match[3]; el.hidden=/\bhidden\b/.test(match[2]); el.className=/class="([^"]+)"/.exec(match[2])?.[1]||''; elements.set(el.id,el);
  }
  const calls=[], timers=new Map(), windowEvents={}; let timerId=0, pushes=0;
  const location={hash,pathname:'/apps/messenger/',search:''};
  const history={state:null,replaceState(state,_title,url){this.state=state; location.hash=''; location.url=url;},pushState(state){this.state=state;pushes++;},back(){this.state=null;}};
  const localStorage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>{if(storageBlocked)throw new Error('Fixture storage unavailable');saved.set(key,value);}};
  const defaultRespond = (url,opts) => {
    if(url==='api/view/session') return {authenticated:true,csrf_token:'fixture-csrf'};
    if(url==='api/status') return {state:'ready'};
    if(url==='api/identity') return {identity:own};
    if(url==='api/contacts') return {contacts:[]};
    if(url==='api/resolve-contact') return {pubkey:peerHex,npub:peer.npub,relays:[]};
    if(url==='api/invites') return {invites:[]};
    if(url==='api/dms') return {dms:[dm]};
    if(url.includes('/messages') && opts.method==='GET') return {messages:[],next_cursor:null};
    throw new Error('Unexpected fixture route '+url+' '+opts.method);
  };
  const context={document,history,location,localStorage,AbortController,TextEncoder,URLSearchParams,crypto:webcrypto,Date,Map,Set,console,
    navigator:{userActivation:{isActive:true},clipboard:{async writeText(text){context.copied=text;}}},innerHeight:640,
    matchMedia:()=>({matches:false}),setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    addEventListener(type,fn){(windowEvents[type] ||= []).push(fn);},
    async fetch(url,opts){
      calls.push({url,opts,body:opts.body?JSON.parse(opts.body):undefined});
      const value=await (respond?.(url,opts,defaultRespond)??defaultRespond(url,opts));
      if(value?.httpError) return {status:value.httpError,ok:false,json:async()=>({ok:false,error:{code:value.code,message:'Raw operator diagnostic that must not render'}})};
      return {status:200,ok:true,json:async()=>({ok:true,result:value})};
    }};
  context.window=context;context.top=standalone?context:{};
  // Domain fixtures only; real shared-client/host acceptance runs on the build host.
  context.sharedHolds=new Set();
  context.WizardApp={ready:()=>Promise.resolve({hosted:!standalone}),back:{register:handler=>{context.sharedBack=handler;return ()=>{};}},update:{hold:reason=>{const token={reason};context.sharedHolds.add(token);return {release:()=>context.sharedHolds.delete(token)};}}};
  vm.runInNewContext(source,context,{filename:'static/app.js'});
  const flush=async()=>{for(let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve));};
  await flush();
  return {context,document,elements,calls,timers,saved,history,windowEvents,flush,get pushes(){return pushes;},e:id=>elements.get(id),async poll(){const timer=[...timers.values()].find(t=>t.ms===3000);assert.ok(timer,'poll scheduled');timer.fn();await flush();}};
}

test('DOM fixture: last-message preview never masquerades as loaded thread history',async()=>{
  let release;const history=new Promise(r=>release=r);
  const incoming={message_id:'b'.repeat(64),text:'Earlier QA message',direction:'received',author:peerHex,created_at:1700000000};
  const outgoing={message_id:'c'.repeat(64),text:'pong',direction:'sent',author:ownHex,created_at:1700000010};
  const f=await fixture({respond:(url,opts,base)=>{
    if(url.includes('/messages?limit=1')&&!url.includes('limit=100'))return {messages:[outgoing],next_cursor:null};
    if(url.includes('/messages?limit=100'))return history;return base(url,opts);
  }});
  assert.match(f.e('conversation-list').textContent,/pong/);
  f.e('conversation-list').children[0].fire('click');await f.flush();
  assert.equal(f.e('history-loading').hidden,false);
  assert.equal(f.e('messages').textContent,'','a one-message list preview is not a complete history window');
  assert.equal(f.e('history-empty').hidden,true);
  release({messages:[incoming,outgoing],next_cursor:null});await f.flush();
  assert.match(f.e('messages').textContent,/Earlier QA message/);assert.match(f.e('messages').textContent,/pong/);assert.equal(f.e('history-loading').hidden,true);
});
test('DOM fixture: reopening known history labels its explicit refresh without blanking saved rows',async()=>{
  let release,hold=false;const history=new Promise(r=>release=r);
  const msg={message_id:'b'.repeat(64),text:'Known full history',direction:'received',author:peerHex,created_at:1700000000};
  const f=await fixture({respond:(url,opts,base)=>url.includes('/messages?limit=100')?(hold?history:{messages:[msg],next_cursor:null}):base(url,opts)});
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('chat-back').fire('click');await f.flush();hold=true;
  f.e('conversation-list').children[0].fire('click');await f.flush();
  assert.match(f.e('messages').textContent,/Known full history/);assert.equal(f.e('history-loading').hidden,false);assert.match(f.e('history-loading-text').textContent,/Refreshing/);
  release({messages:[msg],next_cursor:null});await f.flush();assert.equal(f.e('history-loading').hidden,true);
});
test('DOM fixture: opening and initial list fetch show honest activity; polling stays quiet',async()=>{
  let releaseSession,releaseList;const session=new Promise(r=>releaseSession=r),list=new Promise(r=>releaseList=r);
  const f=await fixture({respond:(url,opts,base)=>url==='api/view/session'?session:url==='api/dms'?list:base(url,opts)});
  assert.equal(f.e('gate-progress').hidden,false);assert.match(f.e('activity-announcement').textContent,/Opening/);
  releaseSession({authenticated:true,csrf_token:'fixture-csrf'});await f.flush();
  assert.equal(f.e('list-loading').hidden,false);assert.equal(f.e('conversation-list').getAttribute('aria-busy'),'true');assert.doesNotMatch(f.e('conversation-list').textContent,/No conversations/);
  releaseList({dms:[]});await f.flush();assert.equal(f.e('list-loading').hidden,true);assert.match(f.e('conversation-list').textContent,/No conversations/);
  await f.poll();assert.equal(f.e('list-loading').hidden,true);
});
test('DOM fixture: accepting an invite is immediate, single-flight, and clears both affordances',async()=>{
  let accepted=false,release;const hold=new Promise(r=>release=r);
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/invites')return {invites:accepted?[]:[{...dm,pending_confirmation:true}]};
    if(url==='api/dms')return {dms:accepted?[dm]:[]};
    if(url.endsWith('/accept'))return hold.then(()=>{accepted=true;return {completed:true};});return base(url,opts);
  }});
  f.e('conversation-list').children.find(x=>x.className==='invite-row').children[0].fire('click');await f.flush();
  f.e('accept-invite').fire('click');f.e('accept-invite').fire('click');await f.flush();
  assert.equal(f.e('accept-invite').textContent,'Accepting…');assert.equal(f.e('accept-invite').disabled,true);assert.equal(f.e('decline-invite').disabled,true);assert.match(f.e('activity-announcement').textContent,/Accepting/);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/accept')).length,1);assert.match(f.e('conversation-list').textContent,/Accepting/);
  release();await f.flush();assert.equal(f.e('invite-actions').hidden,true);assert.equal(f.e('accept-invite').textContent,'Accept');assert.equal(f.e('accept-invite').disabled,false);
});
test('DOM fixture: failed invitation clears spinner, restores controls and preserves its error',async()=>{
  let release;const hold=new Promise(r=>release=r);
  const f=await fixture({respond:(url,opts,base)=>url==='api/invites'?{invites:[{...dm,pending_confirmation:true}]}:url.endsWith('/accept')?hold:base(url,opts)});
  f.e('conversation-list').children.find(x=>x.className==='invite-row').children[0].fire('click');await f.flush();f.e('accept-invite').fire('click');await f.flush();
  release({httpError:502,code:'request_failed'});await f.flush();assert.equal(f.e('accept-invite').textContent,'Accept');assert.equal(f.e('accept-invite').disabled,false);assert.ok(f.e('chat-error').textContent);assert.doesNotMatch(f.e('activity-announcement').textContent,/Accepting/);
});
test('DOM fixture: loading a first chat shows history activity, then disappears on settlement',async()=>{
  let release;const hold=new Promise(r=>release=r);
  const f=await fixture({respond:(url,opts,base)=>url.includes('/messages?limit=100')?hold:base(url,opts)});
  f.e('conversation-list').children[0].fire('click');await f.flush();assert.equal(f.e('history-loading').hidden,false);assert.match(f.e('history-loading-text').textContent,/Loading messages/);assert.equal(f.e('messages').getAttribute('aria-busy'),'true');
  release({messages:[],next_cursor:null});await f.flush();assert.equal(f.e('history-loading').hidden,true);assert.equal(f.e('messages').getAttribute('aria-busy'),'false');
});
test('DOM fixture: silent cookie session uses only relative API and same-origin credentials',async()=>{
  const f=await fixture(); assert.equal(f.e('workspace').hidden,false);
  for(const call of f.calls) {assert.match(call.url,/^api\//);assert.equal(call.opts.credentials,'same-origin');assert.equal(call.opts.headers.Authorization,undefined);}
  assert.equal(f.pushes,0,'framed boot must not push joint history');
});
test('DOM fixture: parking during bootstrap never strands Opening or repeats the one-use exchange',async()=>{
  let release; const session = new Promise(resolve=>{ release=resolve; });
  const f=await fixture({hash:'#ticket=fixture-parked-ticket',respond:(url,opts,base)=>{
    if(url==='api/view/session' && opts.method==='POST') return session;
    if(url==='api/status')return {state:'setup_required'}; return base(url,opts);
  }});
  f.document.hidden=true; for(const fn of f.document.listeners.visibilitychange||[])fn();
  release({authenticated:true,csrf_token:'fixture-parked-csrf'}); await f.flush();
  f.document.hidden=false; for(const fn of f.document.listeners.visibilitychange||[])fn(); await f.flush();
  assert.equal(f.e('setup-form').hidden,false);assert.equal(f.e('setup-submit').textContent,'Create address');
  assert.equal(f.calls.filter(c=>c.url==='api/view/session'&&c.opts.method==='POST').length,1);
});
test('DOM fixture: waking while bootstrap is pending keeps the one-use request alive',async()=>{
  let release; const session = new Promise(resolve=>{ release=resolve; });
  const f=await fixture({hash:'#ticket=fixture-pending-ticket',respond:(url,opts,base)=>{
    if(url==='api/view/session' && opts.method==='POST') return session;
    if(url==='api/status')return {state:'setup_required'}; return base(url,opts);
  }});
  for(const hidden of [true,false]){f.document.hidden=hidden;for(const fn of f.document.listeners.visibilitychange||[])fn();}
  release({authenticated:true,csrf_token:'fixture-pending-csrf'});await f.flush();
  assert.equal(f.e('setup-form').hidden,false);assert.equal(f.calls[0].opts.signal.aborted,false);
  assert.equal(f.calls.filter(c=>c.url==='api/view/session').length,1);
});
test('DOM fixture: a consumed setup link recovers only via an existing cookie session',async()=>{
  const f=await fixture({hash:'#ticket=fixture-consumed-ticket',respond:(url,opts,base)=>{
    if(url==='api/view/session'&&opts.method==='POST')return {httpError:401,code:'invalid_view_ticket'};
    if(url==='api/status')return {state:'setup_required'};return base(url,opts);
  }});
  assert.equal(f.e('setup-form').hidden,false);
  assert.deepEqual(f.calls.filter(c=>c.url==='api/view/session').map(c=>c.opts.method),['POST','GET']);
});
test('DOM fixture: a consumed setup link without a cookie grants no account setup',async()=>{
  const f=await fixture({hash:'#ticket=fixture-consumed-ticket',respond:(url,opts,base)=>{
    if(url==='api/view/session')return {httpError:401,code:opts.method==='POST'?'invalid_view_ticket':'setup_link_required'};
    return base(url,opts);
  }});
  assert.equal(f.e('setup-form').hidden,true);assert.match(f.e('gate-description').textContent,/setup link/);
  assert.equal(f.calls.some(c=>c.url==='api/setup'),false);
});
test('DOM fixture: setup link in an existing authenticated window strips its fragment without exchanging again',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/status'?{state:'setup_required'}:base(url,opts)});
  f.context.location.hash='#ticket=fixture-fragment-link'; for(const fn of f.windowEvents.hashchange||[])fn(); await f.flush();
  assert.equal(f.context.location.hash,'');assert.equal(f.e('setup-form').hidden,false);
  assert.equal(f.calls.filter(c=>c.url==='api/view/session'&&c.opts.method==='POST').length,0);
});
test('DOM fixture: fresh fragment link recovers a mounted first-open gate',async()=>{
  let exchanged=false;
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/view/session'){if(opts.method==='POST'){exchanged=true;return base(url,opts);}if(!exchanged)return {httpError:401,code:'setup_link_required'};}
    if(url==='api/status')return {state:'setup_required'}; return base(url,opts);
  }});
  assert.equal(f.e('setup-form').hidden,true);
  f.context.location.hash='#ticket=fixture-fresh-fragment';for(const fn of f.windowEvents.hashchange||[])fn();await f.flush();
  assert.equal(f.context.location.hash,'');assert.equal(f.e('setup-form').hidden,false);
  assert.equal(f.calls.filter(c=>c.url==='api/view/session'&&c.opts.method==='POST').length,1);
});
test('DOM fixture: one-use ticket is removed and exchanged without token persistence',async()=>{
  const f=await fixture({hash:'#ticket=fixture-opaque-ticket'});
  assert.equal(f.context.location.hash,'');assert.equal(f.calls[0].opts.method,'POST');assert.deepEqual(f.calls[0].body,{ticket:'fixture-opaque-ticket'});
  assert.equal(f.calls[0].opts.headers['X-Messenger-CSRF'],undefined);
  assert.ok(![...f.saved.values()].join('').includes('fixture-opaque-ticket'));
});
test('DOM fixture: HTTP 401 presents Wizard reconnect, never a capability field',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/view/session'?{httpError:401,code:'unauthorized'}:base(url,opts)});
  assert.equal(f.e('gate-description').textContent,'Open Messenger from Wizard to reconnect.');assert.equal(f.e('workspace').hidden,true);assert.equal(f.e('setup-form').hidden,true);
});
test('DOM fixture: setup match/minimum, CSRF body-only secret and first address sheet',async()=>{
  let created=false;
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/status') return {state:created?'ready':'setup_required'};
    if(url==='api/setup'){created=true;return {state:'ready',identity:own};}
    if(url==='api/view/unlock')return {authenticated:true,csrf_token:'fixture-csrf',status:{state:'ready'}};return base(url,opts);
  }});
  assert.equal(f.e('setup-submit').disabled,true);
  f.e('display-name').value='Fixture owner';f.e('display-name').fire('input');assert.equal(f.context.sharedHolds.size,1);
  f.e('passphrase').value='fixture-passphrase-123';f.e('confirm-passphrase').value='wrong';f.e('confirm-passphrase').fire('input');assert.equal(f.e('setup-submit').disabled,true);
  f.e('confirm-passphrase').value=f.e('passphrase').value;f.e('confirm-passphrase').fire('input');assert.equal(f.e('setup-submit').disabled,false);
  f.e('setup-form').fire('submit');await f.flush();
  const post=f.calls.find(c=>c.url==='api/setup');assert.equal(post.body.action,'create');assert.equal(post.opts.headers['X-Messenger-CSRF'],'fixture-csrf');
  assert.equal(f.e('passphrase').value,'');assert.equal(f.e('confirm-passphrase').value,'');assert.equal(f.e('sheet-title').textContent,'My address');
  assert.ok(![...f.saved.values()].join('').includes('fixture-passphrase-123'));
  assert.equal(f.context.sharedHolds.size,0,'saved setup name is not unsaved work');
});
test('DOM fixture: wrong unlock passphrase stays locked, clears field and keeps focus',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/status'?{state:'locked'}:url==='api/setup'?{httpError:423,code:'vault_unlock_failed'}:base(url,opts)});
  f.e('passphrase').value='fixture-wrong-passphrase';f.e('passphrase').fire('input');f.e('setup-form').fire('submit');await f.flush();
  assert.equal(f.e('setup-error').textContent,"That passphrase isn't right.");assert.equal(f.e('passphrase').value,'');assert.equal(f.document.activeElement,f.e('passphrase'));assert.equal(f.e('workspace').hidden,true);
});
test('DOM fixture: HTTP401 wrong passphrase on a live cookie session keeps the unlock form (no reconnect)',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/status'?{state:'locked'}:url==='api/setup'?{httpError:401,code:'vault_unlock_failed'}:base(url,opts)});
  f.e('passphrase').value='fixture-wrong-passphrase';f.e('passphrase').fire('input');f.e('setup-form').fire('submit');await f.flush();
  assert.equal(f.e('setup-error').textContent,"That passphrase isn't right.");assert.equal(f.e('setup-form').hidden,false);assert.equal(f.e('reconnect').hidden,true);
});
test('DOM fixture: incoming pending composer is disabled; accept is explicit',async()=>{
  let accepted=false;const incoming={...dm,pending_confirmation:true};
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/invites')return {invites:accepted?[]:[incoming]};
    if(url==='api/dms'&&opts.method==='GET')return {dms:accepted?[dm]:[]};
    if(url.endsWith('/accept')){accepted=true;return {completed:true,group_id:group};}return base(url,opts);
  }});
  f.e('conversation-list').children[1].children[0].fire('click');await f.flush();
  assert.equal(f.e('draft').disabled,true);assert.equal(f.e('chat-subline').textContent,'Invite pending');
  f.e('accept-invite').fire('click');await f.flush();assert.equal(f.e('draft').disabled,false);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/accept')).length,1);
});
test('DOM fixture: nested Back closes sheet then chat then returns false; still mounted',async()=>{
  const f=await fixture();f.e('conversation-list').children[0].fire('click');await f.flush();
  f.e('my-address').fire('click');assert.equal(f.context.__wizardCloseOverlay(),true);assert.equal(f.e('sheet-layer').hidden,true);assert.equal(f.e('chat').hidden,false);
  assert.equal(f.context.__wizardCloseOverlay(),true);assert.equal(f.e('chat').hidden,true);assert.equal(f.e('workspace').hidden,false);
  assert.equal(f.context.__wizardCloseOverlay(),false);assert.equal(f.pushes,0);
});
test('shared domain Back is honest and holds drafts beyond nested close',async()=>{
  const f=await fixture();assert.equal(f.context.sharedBack.canGoBack(),false);
  f.e('conversation-list').children[0].fire('click');await f.flush();assert.equal(f.context.sharedBack.canGoBack(),true);
  f.e('draft').value='Fixture held draft';f.e('draft').fire('input');assert.equal(f.context.sharedHolds.size,1);
  assert.equal(f.context.sharedBack.back(),true);assert.equal(f.context.sharedBack.canGoBack(),false);assert.equal(f.context.sharedHolds.size,1);
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('draft').value='';f.e('draft').fire('input');assert.equal(f.context.sharedHolds.size,0);
  f.e('add-contact').fire('click');f.e('contact-address').value=peer.npub;f.e('contact-address').fire('input');
  f.context.sharedBack.back();assert.equal(f.context.sharedHolds.size,1,'closing a contact sheet is not discarding its draft');
});
test('DOM fixture: outgoing invite stays Invite sent despite relay-published text',async()=>{
  let messages=[];
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/dms'&&opts.method==='POST')return {dm,invite_sent:true};
    if(url.includes('/messages')&&opts.method==='POST'){const body=JSON.parse(opts.body);messages=[msg('f',20,'sent',body.text)];return {message_ids:['f'.repeat(64)],published:1,request_id:body.request_id};}
    if(url.includes('/messages')&&opts.method==='GET')return {messages,next_cursor:null};return base(url,opts);
  }});
  f.e('add-contact').fire('click');f.e('contact-address').value=peer.npub;f.e('contact-form').fire('submit');await f.flush();
  assert.equal(f.e('chat-subline').textContent,'Invite sent');f.e('draft').value='Fixture outbound';f.e('draft').fire('input');f.e('composer').fire('submit');await f.flush();
  assert.equal(f.e('chat-subline').textContent,'Invite sent');assert.match(f.e('messages').textContent,/Sent ✓/);assert.doesNotMatch(f.e('messages').textContent,/Delivered|Read|Accepted/);
  assert.equal(f.e('messages').children.filter(n=>n.dataset.messageId==='f'.repeat(64)).length,1);
});
test('DOM fixture: request/draft persisted BEFORE send; checking outcome has no Retry and never resends',async()=>{
  const saved=new Map();let durableRequest;
  const f=await fixture({saved,respond:(url,opts,base)=>{
    if(url.includes('/messages')&&opts.method==='POST'){
      const body=JSON.parse(opts.body);const record=JSON.parse(saved.get('wizard-messenger:v1:'+ownHex+':'+group));
      durableRequest=record.attempts[0].request_id;assert.equal(durableRequest,body.request_id);assert.equal(record.attempts[0].text,body.text);assert.equal(record.draft,'');
      return {httpError:409,code:'send_outcome_unknown'};
    }return base(url,opts);
  }});
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('draft').value='Fixture ambiguous text';f.e('draft').fire('input');f.e('composer').fire('submit');await f.flush();
  assert.match(f.e('messages').textContent,/Checking delivery/);assert.doesNotMatch(f.e('messages').textContent,/Retry|Sent ✓/);
  await f.poll();assert.equal(f.calls.filter(c=>c.url.includes('/messages')&&c.opts.method==='POST').length,1);
  const record=JSON.parse(saved.get('wizard-messenger:v1:'+ownHex+':'+group));assert.equal(record.attempts[0].state,'checking');assert.equal(record.attempts[0].request_id,durableRequest);
});
test('DOM fixture: definite rejection Retry preserves exact request and message text',async()=>{
  let attempts=0;
  const f=await fixture({respond:(url,opts,base)=>{
    if(url.includes('/messages')&&opts.method==='POST'){attempts++;const body=JSON.parse(opts.body);return attempts===1?{httpError:423,code:'vault_locked'}:{published:1,message_ids:['e'.repeat(64)],request_id:body.request_id};}return base(url,opts);
  }});
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('draft').value='Fixture retry text';f.e('draft').fire('input');f.e('composer').fire('submit');await f.flush();
  assert.match(f.e('messages').textContent,/Not sent ·Retry/);
  const bubble=f.e('messages').children.find(n=>n.tagName==='ARTICLE');bubble.children[2].children[1].fire('click');await f.flush();
  const sends=f.calls.filter(c=>c.url.includes('/messages')&&c.opts.method==='POST');assert.equal(sends.length,2);assert.deepEqual(sends[0].body,sends[1].body);
});
test('DOM fixture: hidden polling cancels one inflight signal; visible resumes snapshot',async()=>{
  let block=false, release;
  const f=await fixture({respond:(url,opts,base)=>block&&url==='api/status'?new Promise(resolve=>{release=()=>resolve({state:'ready'});}):base(url,opts)});
  block=true;await f.poll();const inflight=f.calls.at(-1).opts.signal;
  f.document.hidden=true;for(const listener of f.document.listeners.visibilitychange)listener();assert.equal(f.timers.size,0);assert.equal(inflight.aborted,true);
  release();await f.flush();block=false;
  f.document.hidden=false;for(const listener of f.document.listeners.visibilitychange)listener();await f.flush();assert.ok(f.calls.length>6);
});
test('DOM fixture: lock clears visible messages and identity, without ending cookie session',async()=>{
  let locked=false;
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/status')return {state:locked?'locked':'ready'};
    if(url==='api/setup'){locked=true;return {state:'locked'};}
    if(url.includes('/messages'))return {messages:[msg('a')],next_cursor:null};return base(url,opts);
  }});
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('my-address').fire('click');f.e('lock').fire('click');await f.flush();
  assert.equal(f.e('workspace').hidden,true);assert.equal(f.e('gate-title').textContent,'Unlock Messenger');assert.equal(f.e('messages').textContent,'');assert.equal(f.e('public-address').textContent,'');
  await f.poll();assert.equal(f.calls.filter(c=>c.url==='api/view/session').length,1);
});

test('DOM fixture: normal later opening uses passphrase session bootstrap, not an API-token form',async()=>{
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/view/session')return {httpError:401,code:'session_unlock_required'};
    if(url==='api/view/unlock')return {csrf_token:'fixture-bootstrap-csrf',status:{state:'ready'}};
    return base(url,opts);
  }});
  assert.equal(f.e('gate-title').textContent,'Unlock Messenger');assert.equal(f.e('name-label').hidden,true);assert.equal(f.e('confirm-label').hidden,true);
  f.e('passphrase').value='fixture-bootstrap-passphrase';f.e('passphrase').fire('input');f.e('setup-form').fire('submit');await f.flush();
  const unlock=f.calls.find(c=>c.url==='api/view/unlock');assert.deepEqual(unlock.body,{vault_password:'fixture-bootstrap-passphrase'});assert.equal(unlock.opts.headers['X-Messenger-CSRF'],undefined);
  assert.equal(f.e('workspace').hidden,false);assert.equal(f.e('passphrase').value,'');assert.ok(![...f.saved.values()].join('').includes('fixture-bootstrap-passphrase'));
});
test('DOM fixture: a new account with no chats shows the empty state and Add contact',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/dms'?{dms:[]}:url==='api/invites'?{invites:[]}:base(url,opts)});
  assert.equal(f.e('workspace').hidden,false);assert.match(f.e('conversation-list').textContent,/No conversations yet/);assert.match(f.e('conversation-list').textContent,/Add contact/);
});
test('DOM fixture: first open from the launcher without a setup link explains the next step',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/view/session'?{httpError:401,code:'setup_link_required'}:base(url,opts)});
  assert.equal(f.e('gate-title').textContent,'Messenger');assert.match(f.e('gate-description').textContent,/setup link/);
  assert.equal(f.e('setup-form').hidden,true);assert.equal(f.e('reconnect').hidden,false);assert.equal(f.e('workspace').hidden,true);
});
test('DOM fixture: failed passphrase bootstrap remains Unlock, including HTTP401 failure',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/view/session'?{httpError:401,code:'session_unlock_required'}:url==='api/view/unlock'?{httpError:401,code:'vault_unlock_failed'}:base(url,opts)});
  f.e('passphrase').value='fixture-bootstrap-wrong';f.e('passphrase').fire('input');f.e('setup-form').fire('submit');await f.flush();
  assert.equal(f.e('gate-title').textContent,'Unlock Messenger');assert.equal(f.e('setup-error').textContent,"That passphrase isn't right.");assert.equal(f.e('passphrase').value,'');
});
test('DOM fixture: NIP-05 resolver runs before contact save/invite, using exact returned public key',async()=>{
  const f=await fixture({respond:(url,opts,base)=>{
    if(url==='api/resolve-contact')return {pubkey:peerHex,npub:peer.npub,relays:[],nip05:'friend@example.com',nip05_verified:true};
    if(url==='api/contacts'&&opts.method==='POST')return {contact:{pubkey:peerHex,label:'Fixture label'}};
    if(url==='api/dms'&&opts.method==='POST')return {dm,invite_sent:true};return base(url,opts);
  }});
  f.e('add-contact').fire('click');f.e('contact-address').value='friend@example.com';f.e('contact-name').value='Fixture label';f.e('contact-form').fire('submit');await f.flush();
  const writes=f.calls.filter(c=>c.opts.method==='POST');assert.deepEqual(writes.map(c=>c.url),['api/resolve-contact','api/contacts','api/dms']);
  assert.deepEqual(writes[0].body,{address:'friend@example.com'});assert.equal(writes[1].body.pubkey,peerHex);assert.equal(writes[2].body.pubkey,peerHex);
  for(const write of writes)assert.equal(write.opts.headers['X-Messenger-CSRF'],'fixture-csrf');
});
test('DOM fixture: unverified NIP-05 never creates a contact or conversation',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url==='api/resolve-contact'?{pubkey:peerHex,nip05_verified:false}:base(url,opts)});
  f.e('add-contact').fire('click');f.e('contact-address').value='friend@example.com';f.e('contact-form').fire('submit');await f.flush();
  assert.match(f.e('contact-error').textContent,/could not be verified/);assert.equal(f.calls.filter(c=>c.opts.method==='POST').length,1);
});
test('DOM fixture: draft and interrupted send restore without automatic new send',async()=>{
  const saved=new Map([['wizard-messenger:v1:'+ownHex+':'+group,JSON.stringify({draft:'Fixture restored draft',attempts:[{request_id:'fixture_request_12345',text:'Fixture interrupted send',state:'sending',created_at:20}]})]]);
  const f=await fixture({saved});f.e('conversation-list').children[0].fire('click');await f.flush();
  assert.equal(f.e('draft').value,'Fixture restored draft');assert.match(f.e('messages').textContent,/Checking delivery/);assert.equal(f.calls.filter(c=>c.opts.method==='POST').length,0);
});
test('DOM fixture: older pagination sends BOTH cursors and keeps exact existing message node',async()=>{
  const f=await fixture({respond:(url,opts,base)=>url.includes('/messages')?url.includes('before=')?{messages:[msg('a',5)],next_cursor:null}:{messages:[msg('b',10)],next_cursor:{before:10,before_message_id:'b'.repeat(64)}}:base(url,opts)});
  f.e('conversation-list').children[0].fire('click');await f.flush();const original=f.e('messages').children.find(n=>n.dataset.messageId==='b'.repeat(64));
  f.e('load-older').fire('click');await f.flush();const request=f.calls.find(c=>c.url.includes('before='));
  assert.match(request.url,/before=10&before_message_id=b{64}/);assert.equal(f.e('messages').children.find(n=>n.dataset.messageId==='b'.repeat(64)),original);
  assert.equal(f.e('messages').children.filter(n=>n.tagName==='ARTICLE').length,2);assert.equal(f.e('new-messages').hidden,true);
});
test('DOM fixture: queued retry uses existing event ID and unrelated group publication is not Sent',async()=>{
  let sent=false;
  const f=await fixture({respond:(url,opts,base)=>{
    if(url.includes('/messages')&&opts.method==='POST'){sent=true;return {published:0,message_ids:['c'.repeat(64)],request_id:JSON.parse(opts.body).request_id};}
    if(url.includes('/messages')&&opts.method==='GET')return {messages:sent?[msg('c',20,'sent','Fixture queued')]:[],next_cursor:null};
    if(url.endsWith('/retry'))return {published:1,message_ids:['d'.repeat(64)],target_event_id:'c'.repeat(64),retry_scope:'group_convergence'};
    return base(url,opts);
  }});
  f.e('conversation-list').children[0].fire('click');await f.flush();f.e('draft').value='Fixture queued';f.e('draft').fire('input');f.e('composer').fire('submit');await f.flush();
  assert.match(f.e('messages').textContent,/QueuedRetry/);const bubble=f.e('messages').children.find(n=>n.tagName==='ARTICLE');bubble.children[2].children[1].fire('click');await f.flush();
  const retry=f.calls.find(c=>c.url.endsWith('/retry'));assert.deepEqual(retry.body,{message_id:'c'.repeat(64)});assert.match(f.e('messages').textContent,/Queued/);assert.doesNotMatch(f.e('messages').textContent,/Sent ✓/);
  assert.equal(f.calls.filter(c=>c.url.includes('/messages')&&c.opts.method==='POST').length,1);
});
test('DOM fixture: unavailable persistent storage refuses untracked send and retains text',async()=>{
  const f=await fixture({storageBlocked:true});f.e('conversation-list').children[0].fire('click');await f.flush();f.e('draft').value='Fixture unsaved';f.e('draft').fire('input');f.e('composer').fire('submit');await f.flush();
  assert.equal(f.e('draft').value,'Fixture unsaved');assert.match(f.e('composer-error').textContent,/storage is unavailable/);assert.equal(f.calls.filter(c=>c.opts.method==='POST').length,0);
});
