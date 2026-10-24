const test = require('node:test');
const assert = require('node:assert/strict');
const {fetchOlder} = require('../static/unified.js');

test('history consumes opaque server cursor, preserves ties, dedupes replay and stops', async () => {
  const t = {messages:[{id:'b',timestamp:100},{id:'c',timestamp:100},{id:'pending',pending:true,timestamp:0}],has_more:true,next_cursor:'opaque+/='};
  const calls=[];
  const call = async path => { calls.push(path); return {messages:[{id:'a',timestamp:100},{id:'b',timestamp:100}],has_more:false,next_cursor:null}; };
  await fetchOlder(t,'person',call);
  assert.deepEqual(calls,['people/person?limit=60&cursor=opaque%2B%2F%3D']);
  assert.deepEqual(t.messages.map(m=>m.id),['a','b','c','pending']);
  assert.equal(t.has_more,false); assert.equal(t.next_cursor,null);
  assert.equal(await fetchOlder(t,'person',call),false); assert.equal(calls.length,1);
});
test('failed history request does not consume cursor or drop rows',async()=>{
  const t={messages:[{id:'a'}],has_more:true,next_cursor:'retry'};
  await assert.rejects(fetchOlder(t,'person',async()=>{throw Error('outage');}));
  assert.equal(t.next_cursor,'retry'); assert.equal(t.has_more,true); assert.deepEqual(t.messages,[{id:'a'}]);
});

// Run the actual shipping UI with an in-memory DOM and explicitly synthetic API.
const vm=require('node:vm'), fs=require('node:fs');
class Element {
  constructor(tag) {this.tagName=tag;this.children=[];this.attrs={};this.dataset={};this.value='';this._text='';this.classList={remove(){},add(){},toggle(){}};}
  set textContent(v){this._text=v;this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...els){for(const el of els){el.parent=this;this.children.push(el);}}
  replaceChildren(...els){this.children=[];this._text='';this.append(...els);}
  setAttribute(k,v){this.attrs[k]=v;}
  getAttribute(k){return this.attrs[k];}
  addEventListener(){}
  focus(){}
  querySelector(selector){return this.querySelectorAll(selector)[0];}
  querySelectorAll(selector){const out=[];const walk=e=>{for(const c of e.children){if(selector.startsWith('.')&&c.className?.split(' ').includes(selector.slice(1)))out.push(c);walk(c);}};walk(this);return out;}
}
test('message search calls authenticated API, pages text results and ignores stale queries',async()=>{
  const root=new Element('main');root.id='messenger';const inbox=new Element('section');inbox.id='unified-inbox';root.append(inbox);
  const tabs=new Element('nav');tabs.id='inbox-tabs';
  const all=()=>{const out=[];const walk=e=>{out.push(e);e.children.forEach(walk);};walk(root);return out;};
  const document={querySelector(){return null;},hidden:true,activeElement:null,documentElement:{dataset:{}},addEventListener(){},getElementById:id=>id==='inbox-tabs'?tabs:all().find(e=>e.id===id),createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
  const calls=[], pending=[];
  const api=async path=>{
    calls.push(path);
    if(path==='api/unified/people')return {people:[],seq:0};
    if(path==='api/unified/telegram/status')return {};
    if(path.startsWith('api/unified/search?'))return new Promise(resolve=>pending.push({path,resolve}));
    throw Error('Unexpected '+path);
  };
  const timers=[];
  const ctx={addEventListener(){},document,AbortController,Audio:class{},navigator:{},URLSearchParams,console,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},requestAnimationFrame:fn=>fn(),localStorage:{getItem(){return null;}},sessionStorage:{getItem(){return null;}}};ctx.window=ctx;
  vm.runInNewContext(fs.readFileSync('static/unified.js','utf8'),ctx);
  ctx.MessengerUnified.mount({api});ctx.MessengerUnified.authenticated();
  const flush=async()=>{for(let n=0;n<5;n++)await new Promise(r=>setImmediate(r));};await flush();
  all().find(e=>e.attrs['aria-label']==='Search').onclick();await flush();
  const field=all().find(e=>e.tagName==='input');
  field.value='old';field.oninput();timers.pop()();await flush();
  field.value='needle';field.oninput();timers.pop()();await flush();
  assert.equal(pending.length,2);
  const message={message_id:'a',person_id:'p',display_name:'Alice',network:'telegram',original:'<script>needle</script>',translated:'translated needle',timestamp:100};
  pending[1].resolve({messages:[message],next_cursor:'page+/='});await flush();
  pending[0].resolve({messages:[{...message,original:'STALE'}],next_cursor:null});await flush();
  assert.ok(inbox.textContent.includes('<script>needle</script>'));assert.ok(inbox.textContent.includes('translated needle'));assert.ok(!inbox.textContent.includes('STALE'));
  const more=all().find(e=>e.tagName==='button'&&e.textContent==='More results');more.onclick();await flush();
  assert.ok(calls.at(-1).includes('cursor=page%2B%2F%3D'));
  pending[2].resolve({messages:[{...message,message_id:'b',original:'Older hit'}],next_cursor:null});await flush();
  assert.ok(inbox.textContent.includes('Older hit'));assert.ok(!all().some(e=>e.textContent==='More results'));
  field.value='private';field.oninput();timers.pop()();await flush();
  ctx.MessengerUnified.signout();
  pending[3].resolve({messages:[{...message,original:'AFTER SIGNOUT'}],next_cursor:null});await flush();
  assert.equal(inbox.textContent,'');
});
