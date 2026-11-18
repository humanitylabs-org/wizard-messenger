'use strict';
// Synthetic DOM/VM support, not layout, media, shell or installed-app evidence.
// Keep this explicit: never invent unknown properties or hide callback errors.
const {webcrypto} = require('node:crypto');
const {performance} = require('node:perf_hooks');

function events(target) {
  const listeners = new Map();
  target.addEventListener = (type, fn, options) => {
    const list = listeners.get(type) || [];
    if (!list.some(entry => entry.fn === fn)) list.push({fn, once: !!options?.once});
    listeners.set(type, list);
  };
  target.removeEventListener = (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(entry => entry.fn !== fn));
  target.dispatchEvent = event => {
    for (const entry of [...(listeners.get(event.type) || [])]) {
      if (entry.once) target.removeEventListener(event.type, entry.fn);
      entry.fn.call(target, event); // Deliberately propagates exceptions to the test.
    }
    return !event.defaultPrevented;
  };
  return target;
}
function storage() {
  const values = new Map();
  return {get length() {return values.size;}, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)), clear: () => values.clear()};
}
function matches(el, selector) {
  // Supported subset is explicit; unsupported selectors must fail, not match null.
  if (!/^(?:[a-zA-Z][\w-]*)?(?:#[\w-]+)?(?:\.[\w-]+)*(?:\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[\w-]+))?\])*$/.test(selector) || !selector)
    throw new Error('Unsupported fixture selector: ' + selector);
  const tag = /^[a-zA-Z][\w-]*/.exec(selector)?.[0];
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  const id = /#([\w-]+)/.exec(selector)?.[1];
  if (id && el.id !== id) return false;
  if ([...selector.matchAll(/\.([\w-]+)/g)].some(m => !el.classList.contains(m[1]))) return false;
  for (const m of selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/g)) {
    const actual = el.getAttribute(m[1]), expected = m[2] ?? m[3] ?? m[4];
    if (actual === null || (expected !== undefined && actual !== expected)) return false;
  }
  return true;
}
class Element {
  constructor(tag, doc) {
    // Existing domain fixtures use lowercase tagName; this is not a browser DOM.
    this.tagName = tag.toLowerCase(); this.ownerDocument = doc; this.parent = null;
    this.children = []; this.attrs = {}; this.dataset = {}; this.value = ''; this._text = '';
    this.className = ''; this.hidden = false; this.disabled = false; this.clientWidth = 0;
    this.scrollHeight = 0; this.clientHeight = 0; this.scrollTop = 0;
    const props = new Map();
    this.style = {setProperty: (k,v) => props.set(k,String(v)), removeProperty: k => {const v=props.get(k)||'';props.delete(k);return v;}, getPropertyValue:k=>props.get(k)||''};
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {contains: c => classes().includes(c), add: (...cs) => {this.className=[...new Set([...classes(),...cs])].join(' ');},
      remove: (...cs) => {this.className=classes().filter(c=>!cs.includes(c)).join(' ');},
      toggle: (c,force) => {const on=force===undefined?!classes().includes(c):!!force;this.classList[on?'add':'remove'](c);return on;}};
    events(this);
  }
  get parentNode() {return this.parent;}
  get isConnected() {return !!this.ownerDocument && (this === this.ownerDocument.documentElement || !!this.parent?.isConnected);}
  set textContent(v) {this.replaceChildren();this._text=String(v??'');}
  get textContent() {return this._text+this.children.map(c=>c.textContent).join('');}
  append(...nodes) {
    for (let child of nodes) {
      if (typeof child === 'string') {const text=new Element('#text',this.ownerDocument);text._text=child;child=text;}
      if (child.tagName === '#fragment') {this.append(...[...child.children]);continue;}
      child.remove();child.parent=this;child.ownerDocument=this.ownerDocument;this.children.push(child);
    }
  }
  prepend(...nodes) {const old=this.children;this.children=[];this.append(...nodes);for(const c of old)if(c.parent===this)this.children.push(c);}
  replaceChildren(...nodes) {for(const child of this.children)child.parent=null;this.children=[];this._text='';this.append(...nodes);}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
  setAttribute(k,v) {
    v=String(v);this.attrs[k]=v;
    if(k==='id')this.id=v;if(k==='class')this.className=v;
    if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
  }
  getAttribute(k) {
    if(k==='id')return this.id??null;if(k==='class')return this.className||null;
    if(k.startsWith('data-'))return this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]??null;
    return this.attrs[k]??null;
  }
  removeAttribute(k) {delete this.attrs[k];if(k.startsWith('data-'))delete this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];}
  toggleAttribute(k,force) {const on=force===undefined?this.getAttribute(k)===null:!!force;if(on)this.setAttribute(k,'');else this.removeAttribute(k);return on;}
  focus() {if(this.ownerDocument)this.ownerDocument.activeElement=this;}
  closest(selector) {let el=this;const alternatives=selector.split(',').map(s=>s.trim());while(el){if(alternatives.some(s=>matches(el,s)))return el;el=el.parent;}return null;}
  getClientRects() {return this.hidden || !this.isConnected ? [] : [this.getBoundingClientRect()];}
  checkVisibility() {let el=this;while(el){if(el.hidden)return false;el=el.parent;}return this.isConnected;}
  // Synthetic zero/default geometry, NEVER layout acceptance evidence.
  getBoundingClientRect() {return {x:0,y:0,top:0,left:0,right:this.clientWidth,bottom:this.clientHeight,width:this.clientWidth,height:this.clientHeight};}
  contains(child) {return child===this||this.children.some(c=>c.contains(child));}
  querySelectorAll(selector) {
    const alternatives=selector.split(',').map(s=>s.trim().split(/\s+/));
    // Validate even an empty tree: unsupported selectors must never silently pass.
    for(const parts of alternatives)for(const part of parts)matches(this,part);
    const out=[];
    const test = el => alternatives.some(parts=>{
      if(!matches(el,parts.at(-1)))return false;
      let parent=el.parent;
      for(let i=parts.length-2;i>=0;i--){while(parent&&!matches(parent,parts[i]))parent=parent.parent;if(!parent)return false;parent=parent.parent;}
      return true;
    });
    const walk=el=>{for(const c of el.children){if(test(c))out.push(c);walk(c);}};walk(this);return out;
  }
  querySelector(selector) {return this.querySelectorAll(selector)[0]??null;}
}
function browserContext({document, url='https://synthetic.invalid/apps/messenger/?fixture=1', overrides={}}={}) {
  let current=new URL(url);
  const location={};
  for(const field of ['href','origin','protocol','host','hostname','port','pathname','search','hash'])
    Object.defineProperty(location,field,{enumerable:true,get:()=>current[field],...(field==='origin'?{}:{set:v=>{current[field]=v;}})});
  const historyCalls=[];
  const history={state:null,replaceState(state,_title,url){
    const next=url==null?current:new URL(url,current);
    if(next.origin!==current.origin)throw new DOMException('Cross-origin history URL','SecurityError');
    this.state=structuredClone(state);current=new URL(next);historyCalls.push({state:this.state,url:current.href});
    // replaceState never dispatches hashchange/popstate.
  }};
  const timers=new Map(), violations=[];let timerId=0;
  const schedule=(kind,fn,ms=0,...args)=>{const id=++timerId;timers.set(id,{kind,fn,ms,args});return id;};
  const context=events({document,location,history,crypto:webcrypto,URL,URLSearchParams,AbortController,
    TextEncoder,TextDecoder,performance,console,DOMException,Event,Blob,atob,btoa,structuredClone,
    innerWidth:390,innerHeight:844,navigator:{},localStorage:storage(),sessionStorage:storage(),
    matchMedia:query=>({media:query,matches:false,addEventListener(){},removeEventListener(){}}),
    // Explicit lifecycle surface; synthetic tests deliver records with trigger().
    MutationObserver:class {constructor(callback){this.callback=callback;} observe(target,options){this.target=target;this.options=options;} disconnect(){this.target=null;} trigger(records=[]){this.callback(records,this);}},
    setTimeout:(...args)=>schedule('timeout',...args),setInterval:(...args)=>schedule('interval',...args),
    clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),
    requestAnimationFrame:fn=>schedule('animation',fn,16),cancelAnimationFrame:id=>timers.delete(id),
    // Never contact a network or pretend to implement media playback.
    fetch:async path=>{
      // Contacts is an optional separately installed app, absent in this fixture.
      if(path==='/contacts/api/contacts')return {ok:false,status:404,json:async()=>({error:'Synthetic Contacts app absent'})};
      const error=new Error('Unexpected fixture fetch '+path);violations.push(error);throw error;
    },
    Audio:class extends EventTarget {play(){const error=new Error('Media playback is outside this fixture');violations.push(error);throw error;}},
    ...overrides});
  context.window=context;context.self=context;
  if(document)events(document);
  return {context,historyCalls,timers,violations,
    runTimer(id){const timer=timers.get(id);if(!timer)throw new Error('Unknown fixture timer '+id);if(timer.kind!=='interval')timers.delete(id);return timer.fn(...timer.args);},
    navigateHash(hash){location.hash=hash;context.dispatchEvent({type:'hashchange'});},
    dispose(){timers.clear();}};
}
function makeDocument() {
  const doc=events({hidden:true,activeElement:null});
  doc.documentElement=new Element('html',doc);doc.body=new Element('body',doc);doc.documentElement.append(doc.body);
  doc.createElement=tag=>new Element(tag,doc);doc.createElementNS=(_,tag)=>new Element(tag,doc);
  doc.createDocumentFragment=()=>new Element('#fragment',doc);
  doc.querySelectorAll=selector=>doc.documentElement.querySelectorAll(selector);
  doc.querySelector=selector=>doc.querySelectorAll(selector)[0]??null;
  doc.getElementById=id=>doc.querySelector('#'+id);
  return doc;
}
module.exports={Element,browserContext,makeDocument};
