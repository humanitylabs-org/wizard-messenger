'use strict';
// Current public Settings/hash routes; no source rewrites or private function hooks.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {browserContext,makeDocument}=require('./helpers/unified_browser_context.cjs');
const flush=async()=>{for(let n=0;n<16;n++)await new Promise(r=>setImmediate(r));};
async function fixture(level='no_access'){
  const document=makeDocument();
  for(const [id,tag] of [['messenger','main'],['inbox-tabs','nav'],['unified-inbox','section']]){
    const el=document.createElement(tag);el.id=id;document.body.append(el);
  }
  const f=browserContext({document}),calls=[],unexpected=[];
  const levels=[['no_access','No access'],['read_only','Read-only'],['draft_only','Draft-only'],['draft_and_send','Draft-and-send']].map(([id,label])=>({id,label,recommended:id==='draft_only'}));
  let current=level;
  const api=async(path,opts={})=>{
    calls.push({path,...opts});
    if(path==='api/view/agents/wizard/synthetic'&&opts.method==='POST'){current=opts.body.level;return {};}
    if(path==='api/view/agents')return {wizard_agents:[{id:'synthetic',label:'Synthetic Wizard',level:current}],wizard_levels:levels,
      agents:[{id:'older',name:'Synthetic older key',level:'read_only'}],levels,app_key:{level:'no_access'},log:[]};
    const responses={'api/unified/people':{people:[],seq:0},'api/unified/groups':{groups:[],seq:0},
      'api/unified/connectors':{providers:[]},'api/unified/telegram/status':{logins:[]},'api/view/authority':{required:true,ready:false},
      'api/unified/merge-suggestions':{suggestions:[]},'api/view/push':{enabled:false},'api/drafts':{drafts:[]},
      'api/unified/directory':{people:[],groups:[]},'api/unified/labels':{labels:[],rev:0},'api/unified/catch-up/settings':{},
      'api/unified/draft-watch':{on:true,watched:[],all_unread:false,stats:null}};
    if(path in responses)return responses[path];
    unexpected.push(path);throw Error('Unexpected current-permissions API '+path);
  };
  vm.runInNewContext(fs.readFileSync('static/unified.js','utf8'),f.context,{filename:'static/unified.js'});
  f.context.MessengerUnified.mount({api});f.context.MessengerUnified.authenticated();await flush();
  await f.context.MessengerUnified.settings();await flush();
  const all=()=>{const list=[];const walk=e=>{list.push(e);e.children.forEach(walk);};walk(document.body);return list;};
  const select=label=>all().find(e=>e.tagName==='select'&&e.getAttribute('aria-label')===label);
  return {...f,calls,unexpected,all,select};
}
test('current Settings exposes Wizard permissions, hides legacy controls, and saves only an explicit owner change',async()=>{
  const f=await fixture();
  try{
    const choice=f.select('What Synthetic Wizard may do');assert.ok(choice);
    assert.deepEqual(Array.from(choice.children,e=>e.textContent),['No access','Read-only','Draft-only (recommended)']);
    assert.equal(choice.value,'no_access');
    for(const text of ['Review agent drafts','Add an agent','Add agent'])assert(!f.all().some(e=>e.tagName==='button'&&e.textContent===text));
    assert.equal(f.select('What Synthetic older key may do'),undefined);
    assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
    choice.value='draft_only';await choice.onchange();await flush();
    assert.equal(f.select('What Synthetic Wizard may do').value,'draft_only');
    assert.deepEqual(f.calls.filter(c=>c.method==='POST').map(c=>({path:c.path,body:JSON.parse(JSON.stringify(c.body))})),
      [{path:'api/view/agents/wizard/synthetic',body:{level:'draft_only'}}]);
    f.navigateHash('#advanced');await flush();
    assert.equal(f.context.location.hash,'');assert.ok(f.select('What Synthetic older key may do'));
    assert.equal(f.select('What Wizard app key may do'),undefined);
    assert.deepEqual(f.unexpected,[]);assert.deepEqual(f.violations,[]);
  }finally{f.dispose();}
});
test('existing Draft-and-send is visible without granting or sending anything on settings entry',async()=>{
  const f=await fixture('draft_and_send');
  try{
    const choice=f.select('What Synthetic Wizard may do');assert.ok(choice);
    assert.equal(choice.value,'draft_and_send');assert.equal(choice.children.length,4);
    assert.equal(choice.children[3].textContent,'Draft-and-send');
    assert.equal(f.calls.filter(c=>c.method&&c.method!=='GET').length,0);
    assert.deepEqual(f.unexpected,[]);assert.deepEqual(f.violations,[]);
  }finally{f.dispose();}
});
