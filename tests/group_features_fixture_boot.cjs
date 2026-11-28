// Mechanical contract replay, not browser/feature acceptance. Safe on coordinator.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {origin,createFixture}=require('./helpers/group_features_fixture.cjs');
const fixture=createFixture(),app=fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8'),unified=fs.readFileSync(path.join(__dirname,'../static/unified.js'),'utf8');
const replayed=[];
// Execute the production API decoder, rather than accepting an invented JSON shape.
const decoder=app.slice(app.indexOf('  async function apiOnce('),app.indexOf('  function friendly('));
const context=vm.createContext({state:{csrf:'synthetic'},APIError:class extends Error{},trustedWizard:false,bootAnswer:()=>null,fetch:async(p,options)=>{
  const body=fixture.reply(origin+'/app/'+p,options.method,options.body&&JSON.parse(options.body));assert(body,p);
  replayed.push(p);return {status:200,ok:true,json:async()=>body};
}});
vm.runInContext(decoder+';this.api=apiOnce',context);
(async()=>{
  // app.js refreshPasskey + boot: trusted-owner -> session -> snapshot -> identity.
  for(const p of ['api/view/passkey','api/view/trusted-owner','api/view/session','api/status','api/identity','api/contacts','api/invites','api/dms']) {
    assert(app.includes("'"+p+"'"),p+' production request changed');const r=await context.api(p);
    if(p.endsWith('/session')){assert.equal(r.authenticated,true);assert.equal(typeof r.csrf_token,'string');assert(r.csrf_token);}
    if(p==='api/status')assert.equal(r.state,'ready');
    if(p==='api/identity')assert(r.identity.account_id&&r.identity.npub&&r.identity.display_name);
  }
  // unified.js authenticated -> loadContacts/qr-codes + loadLists -> feed; drafts timer.
  assert(unified.includes("const CONTACTS = '/contacts/'"));assert.deepEqual(fixture.reply(origin+'/contacts/api/contacts'),{contacts:[]});
  assert(unified.includes("const keys = ['people', 'groups']"));
  const lists=await Promise.all(['people','groups'].map(k=>context.api('api/unified/'+k)));
  const rows=lists.flatMap((r,i)=>r[['people','groups'][i]]);assert.equal(rows.length,1);assert.equal(rows[0].id,'synthetic-group');assert(rows[0].labels);assert(rows[0].last.text);
  for(const p of ['api/unified/qr-codes','api/unified/updates?since=1&hold=20.0','api/drafts','api/unified/people/synthetic-group?limit=60']) {
    const r=await context.api(p);if(p.includes('updates')){assert(!Array.isArray(r.messages));assert(!Array.isArray(r.typing));}
    if(p.includes('limit=60')){assert.equal(r.person.kind,'group');assert.equal(r.person.members.length,2);assert.equal(r.messages[0].msgtype,'m.text');assert(r.messages[0].mentioned);}
  }
  assert.equal(fixture.reply(origin+'/app/api/unified/listen'),null,'no unused EventSource/WebSocket listener concealed by catch-all');
  assert(!/new (?:EventSource|WebSocket)\(/.test(app+unified));
  const sent=await context.api('api/unified/people/synthetic-group/send',{method:'POST',body:{text:'@Bob Example ',client_id:'synthetic-client'}});
  assert.equal(sent.message.mentions[0].name,'Bob Example');assert(sent.message.outgoing);
  const html=fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
  const assets=[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(m=>new URL(m[1],origin+'/app/').pathname);
  for(const p of assets.filter(p=>p.startsWith('/app/'))){const name=p.slice(5);assert(fs.existsSync(path.join(__dirname,'../static',name))||['favicon.svg','icon-192.png'].includes(name),p);}
  console.log(JSON.stringify({pass:true,scope:'browser-free contract replay; not rendered-browser proof',replayed,assets},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
