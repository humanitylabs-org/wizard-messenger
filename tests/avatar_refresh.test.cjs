'use strict';
// Browser-free state regression; rendered frame evidence lives in avatar_refresh_browser.cjs.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {makeDocument,Element}=require('./helpers/unified_browser_context.cjs');
test('browser harness parses without starting a browser',()=>{new vm.Script(fs.readFileSync(require('node:path').join(__dirname,'avatar_refresh_browser.cjs'),'utf8'));});
function fixture(){
 const document=makeDocument(),source=fs.readFileSync(require('node:path').join(__dirname,'../static/unified.js'),'utf8');
 Object.defineProperty(Element.prototype,'parentElement',{configurable:true,get(){return this.parent;}});
 const box={document,URLSearchParams,setTimeout(){},Math,ticketed:url=>url}; // same-origin window: addresses unchanged (wizard-os issue 133)
 vm.createContext(box);vm.runInContext(source.slice(source.indexOf('  // Real profile pictures'),source.indexOf('  const networksOf'))+';this.picture=withPicture;this.url=pictureURL;this.cache=avatarPictures',box);
 const paint=(url,slot='list:synthetic')=>{const el=document.createElement('span');document.body.append(el);box.picture(el,url,slot);return el;};
 const loaded=el=>{const img=el.children[0];img.complete=true;img.naturalWidth=64;img.onload();return img;};
 return {box,paint,loaded};
}
test('ten refreshes reuse decoded image with no renewed request or initials frame',()=>{
 const {paint,loaded}=fixture();let el=paint('avatar?v=stable'),img=loaded(el);const src=img.src;
 for(let i=0;i<10;i++){const old=el;el=paint('avatar?v=stable');old.remove();assert.equal(el.children[0],img);assert.equal(img.src,src);assert.equal(img.hidden,false);assert(el.classList.contains('has-img'));}
});
test('list/header slots do not steal, URL change replaces, absent photo keeps initials',()=>{
 const {paint,loaded}=fixture();const list=paint('avatar?v=1'),a=loaded(list),head=paint('avatar?v=1','thread-header'),b=loaded(head);
 assert.notEqual(a,b);assert.equal(a.parentElement,list);assert.equal(b.parentElement,head);
 const next=paint('avatar?v=2');assert.notEqual(next.children[0],a);assert.equal(next.children[0].hidden,true);
 assert.equal(paint('').children.length,0);
});
test('genuine errors keep fallback and never mark a failed photo loaded',()=>{
 const {paint}=fixture();const el=paint('broken?v=1'),img=el.children[0];img.onerror();img.onerror();
 const next=paint('broken?v=1');assert.equal(next.children[0],img);assert.equal(img.hidden,true);assert(!next.classList.contains('has-img'));
});
test('detached avatar cache is bounded and versioned URLs are stable',()=>{
 const {box,paint,loaded}=fixture();for(let i=0;i<530;i++){const el=paint('avatar?v='+i,'list:'+i);loaded(el);el.remove();}
 assert(box.cache.size<=512);assert.equal(box.url('synthetic','v1'),box.url('synthetic','v1'));assert.equal(box.url('private:synthetic','v1'),'');
});
test('lazy loading watches the visible avatar circle, not the hidden picture (16.27-16.29 showed no photos)',()=>{
 const document=makeDocument(),source=fs.readFileSync(require('node:path').join(__dirname,'../static/unified.js'),'utf8');
 Object.defineProperty(Element.prototype,'parentElement',{configurable:true,get(){return this.parent;}});
 const watched=new Set();
 // Like a real browser: an element with the hidden attribute (display:none) never intersects.
 class IntersectionObserver{constructor(cb){this.cb=cb;IntersectionObserver.last=this;}observe(el){watched.add(el);}unobserve(el){watched.delete(el);}
  flush(){this.cb([...watched].map(target=>({target,isIntersecting:!target.hidden})));}}
 const box={document,URLSearchParams,setTimeout(){},Math,IntersectionObserver};
 vm.createContext(box);vm.runInContext(source.slice(source.indexOf('  // Real profile pictures'),source.indexOf('  const networksOf'))+';this.picture=withPicture',box);
 const paint=()=>{const el=document.createElement('span');document.body.append(el);box.picture(el,'avatar?v=1','list:lazy');return el;};
 const first=paint(),img=first.children[0];assert.equal(img.hidden,true);
 const second=paint();first.remove();assert.equal(second.children[0],img); // repaint before it scrolled into view
 IntersectionObserver.last.flush();
 assert.equal(img.src,'avatar?v=1','an on-screen avatar must request its picture');
});
