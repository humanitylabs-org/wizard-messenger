'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
// Execute the actual receiver and the shared composer staging function without browser/network dependencies.
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../static/unified.js'), 'utf8');
function shareFixture({locked=false, telegram=true, count=0}={}) {
  const s={ready:!locked,person:null,tab:'people',search:null,epoch:0,drafts:{}}, calls=[], urls=[], nodes=[];
  const view={id:null,attach:null,draft:{isConnected:true,focus(){},value:''},grow(){}};
  let finish;
  const prepared = new Promise(resolve=>{finish=resolve;});
  const context={s,view,store:{threads:{p1:{}}},Blob,File,console,URL:{revokeObjectURL:u=>urls.push(u)},
    closeOverlay(){},switchTab(){},inChat(){},renderList(){},saveDrafts(){},hold(){},toast:t=>calls.push(['toast',t]),error:e=>calls.push(['error',e.message]),
    newChat:(_text,place)=>{context.pick=place; return Promise.resolve(false);},
    openPerson:async id=>{s.person=id;view.id=id;view.stagePhotos=context.stage;},
    preparePhoto:async file=>{context.preparing=true;await prepared;return {blob:file,url:'blob:photo',w:1,h:1};},
    paintBar:()=>{nodes.splice(0,nodes.length,...(view.attach||[]));}, grow(){},
    bar:{querySelectorAll:()=>nodes},draft:view.draft,telegramOnly:telegram,id:'p1'};
  view.attach=Array.from({length:count},(_,i)=>({url:'blob:'+i}));
  vm.createContext(context);
  const start=source.indexOf('    async function stagePhotos(picked) {'), end=source.indexOf('    file.onchange',start);
  vm.runInContext(source.slice(start,end)+'\nthis.stage=stagePhotos;',context);
  const a=source.indexOf('  function sharedText(item)'),b=source.indexOf('  function listenForShares()',a);
  vm.runInContext(source.slice(a,b)+'\nthis.receive=receiveShare;',context);
  view.stagePhotos=context.stage;
  return {context,s,view,calls,nodes,finish};
}
const photo=()=>({id:'share-1',kind:'image',file:new File(['photo'],'one.png',{type:'image/png'}),target:'p1'});
test('image receive waits for visible multi-photo staging, opens target, and never sends',async()=>{
  const f=shareFixture(); let settled=false;
  const result=f.context.receive(photo()).then(ok=>{settled=true;return ok;});
  await Promise.resolve(); assert.equal(settled,false); assert.equal(f.s.person,'p1'); assert.equal(f.nodes.length,0);
  f.finish(); assert.equal(await result,true); assert.equal(f.nodes.length,1);
  assert.equal(f.view.attach[0].blob.type,'image/png'); assert.equal(f.calls.length,0);
});
test('locked image stays pending; after unlock the same item stages once',async()=>{
  const f=shareFixture({locked:true}),item=photo();
  assert.equal(await f.context.receive(item),false); assert.equal(f.s.person,null);
  f.s.ready=true;f.finish();assert.equal(await f.context.receive(item),true);assert.equal(f.nodes.length,1);
});
test('shared image extends existing photo tray and keeps the caption in the composer',async()=>{
  const f=shareFixture({count:2}); f.s.person=f.view.id='p1';f.s.drafts.p1='old draft';f.finish();
  assert.equal(await f.context.receive({...photo(),text:'caption'}),true);assert.equal(f.nodes.length,3);assert.equal(f.view.draft.value,'old draft\n\ncaption');
});
test('unsupported network, full tray, generic file and navigation during decode never ack',async()=>{
  for(const opts of [{telegram:false},{count:10}]){const f=shareFixture(opts);f.finish();assert.equal(await f.context.receive(photo()),false);}
  const f=shareFixture();assert.equal(await f.context.receive({...photo(),kind:'file'}),false);
  const pending=f.context.receive(photo());await new Promise(setImmediate);assert.equal(f.context.preparing,true);f.s.epoch++;f.finish();assert.equal(await pending,false);assert.equal(f.nodes.length,0);
});
test('image without target uses existing recipient picker; only a staged selection acknowledges',async()=>{
  const f=shareFixture();f.finish();assert.equal(await f.context.receive({...photo(),target:null}),false);
  assert.equal(f.nodes.length,0);assert.equal(await f.context.pick('p1'),true);assert.equal(f.nodes.length,1);
});
