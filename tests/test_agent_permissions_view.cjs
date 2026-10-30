const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
// Execute the shipping view with a small DOM, not source-string permission assertions.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.value = ''; this._text = ''; this.classList = {remove(){}}; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  append(...els) { for (const el of els) { el.parent = this; this.children.push(el); } }
  replaceChildren(...els) { this.children = []; this._text = ''; this.append(...els); }
  setAttribute(k,v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  focus() {}
  querySelectorAll() { return []; }
}
async function fixture({deferPreview = false, connectors = false, connectorsUnavailable = false, remoteRequired = false} = {}) {
  const root = new Element('main'), tabs = new Element('nav'); root.id = 'messenger'; tabs.id = 'inbox-tabs';
  const all = () => { const result = []; const walk = e => {result.push(e); e.children.forEach(walk);}; walk(root); return result; };
  const document = {activeElement: null, documentElement: {dataset:{}}, addEventListener(){},
    getElementById: id => id === 'inbox-tabs' ? tabs : all().find(e => e.id === id),
    createElement: tag => new Element(tag), createElementNS: (_,tag) => new Element(tag)};
  const calls = []; let releasePreview;
  let draft = {id:'d1',revision:1,state:'draft',person_id:'p1',identity_id:'i1',text:'Draft hello'};
  let policy = {mode:'no_access',enabled:false,log:[]}; const agents = [{id:'a0',name:'Oscar',level:'no_access',label:'No access'}];
  const api = async (path, opts = {}) => {
    calls.push({path, ...opts});
    if (path === 'api/unified/connectors') {
      if (connectorsUnavailable) { const e = new Error('Not enabled'); e.code = 'not_found'; throw e; }
      return {providers: []};
    }
    if (path === 'api/unified/telegram/status') return {state:'not_configured',message:'Not configured',logins:[]};
    if (path === 'api/view/authority') return {ready:false, required:remoteRequired, reason:'Independent review has not been configured.'};
    if (path === 'api/view/push') return {enabled:false};
    if (path === 'api/view/agent-access') { if (opts.method === 'POST') policy = {...policy,...opts.body}; return policy; }
    if (path.startsWith('api/view/agents')) {
      const LV = [['no_access','No access'],['read_only','Read-only'],['draft_only','Draft-only'],['draft_and_send','Draft-and-send']];
      if (path === 'api/view/agents' && opts.method === 'POST') { agents.push({id:'a'+agents.length,name:opts.body.name,level:'no_access',label:'No access'}); return {agent:agents.at(-1),key:'wzak_000000000000_secret'}; }
      if (path === 'api/view/agents/app-key' && opts.method === 'POST') policy = {...policy, mode: opts.body.level};
      else if (opts.method === 'POST') agents.find(a => 'api/view/agents/' + a.id === path).level = opts.body.level;
      return {agents:agents.map(a=>({...a})), app_key:{id:'app-key',name:'Wizard app key',level:policy.mode,label:'x'},
        levels:LV.map(([id,label])=>({id,label,recommended:id==='draft_only'})), log:[]};
    }
    if (path === 'api/drafts') return {drafts:[{...draft}]};
    if (path === 'api/unified/directory') return {people:[{id:'p1',display_name:'Alice',identities:[{id:'i1',network:'telegram',label:'Alice'}]}],groups:[]};
    if (path === 'api/drafts/d1') { draft = {...draft,...opts.body,revision:draft.revision+1}; return {draft:{...draft}}; }
    if (path === 'api/drafts/d1/preview') {
      const result = {draft:{...draft,preview:{id:'preview1',original:draft.text,translated:draft.text}}};
      if (deferPreview) return new Promise(resolve => {releasePreview = () => resolve(result);});
      return result;
    }
    if (path === 'api/drafts/d1/send') {draft.state = 'sent'; return {draft};}
    throw new Error('Unexpected API: '+path);
  };
  const context = {addEventListener(){},document,console,Audio:class {},navigator:{},localStorage:{getItem(){return null;}},sessionStorage:{getItem(){return null;}},confirm:()=>true,
    setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),WizardApp:{update:{hold:()=>({release(){}})}}};
  context.window = context;
  if (connectors) vm.runInNewContext(fs.readFileSync('static/connectors.js','utf8'), context);
  vm.runInNewContext(fs.readFileSync('static/unified.js','utf8'), context);
  context.MessengerUnified.mount({api});
  const flush = async () => {for(let n=0;n<6;n++) await new Promise(r=>setImmediate(r));};
  const find = (tag, label) => all().find(e => e.tagName === tag && (e.attrs['aria-label'] === label || e.textContent === label));
  const click = async label => {const el = find('button',label); assert.ok(el,'button '+label); await el.onclick(); await flush();};
  await context.MessengerUnified.settings(); await flush();
  return {calls,find,click,flush,release:()=>releasePreview(),agents,context,all};
}
test('connector settings retain agent controls; disabled connectors preserve Telegram', async () => {
  for (const connectorsUnavailable of [false, true]) {
    const f = await fixture({connectors:true, connectorsUnavailable});
    assert.ok(f.find('select','Level for Oscar')); assert.ok(f.find('select','Level for Wizard app key'));
    assert.ok(f.find('button','Review agent drafts'));
    assert.equal(f.calls.some(c => c.path === 'api/unified/telegram/status'), connectorsUnavailable);
    assert.equal(f.calls.some(c => c.path.endsWith('/send')), false);
  }
});
test('owner chooses four policies; required remote review has no local Send fallback',async()=>{
  const f = await fixture({remoteRequired:true});
  const policy = f.find('select','Level for Oscar');
  assert.deepEqual(policy.children.map(e=>e.textContent),['No access','Read-only','Draft-only (Recommended)','Draft-and-send']);
  assert.equal(policy.value,'no_access');
  policy.value = 'draft_only'; await policy.onchange(); await f.flush();
  assert.equal(f.calls.find(c=>c.path==='api/view/agents/a0'&&c.method==='POST').body.level,'draft_only');
  assert.equal(f.agents[0].level,'draft_only');
  assert.equal(f.calls.some(c=>c.path==='api/view/agent-access'),false);
  await f.click('Review agent drafts'); await f.click('Review draft');
  assert.ok(f.find('button','Review securely').disabled);
  assert.equal(f.find('button','Send'),undefined);
  const body = f.find('textarea','Draft message'); body.value = 'Owner edits'; body.oninput();
  assert.ok(f.find('button','Review securely').disabled);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/send') || c.path.endsWith('/preview') || c.path.endsWith('/export')).length,0);
});
test('normal mode edits, reviews and requires a separate explicit Send click', async () => {
  const f = await fixture();
  await f.click('Review agent drafts'); await f.click('Review draft');
  assert.equal(f.find('button','Send'), undefined);
  const body = f.find('textarea','Draft message');
  body.value = 'Exact owner edit'; body.oninput();
  await f.click('Review message');
  const saved = f.calls.find(c => c.path === 'api/drafts/d1' && c.method === 'POST');
  assert.equal(saved.body.text, 'Exact owner edit');
  assert.equal(saved.body.person_id, 'p1'); assert.equal(saved.body.identity_id, 'i1');
  assert.equal(f.calls.some(c=>c.path.endsWith('/send')), false);
  assert.ok(f.find('button','Send'));
  body.value = 'Changed after review'; body.oninput();
  assert.equal(f.find('button','Send'), undefined);
  await f.click('Review message');
  await f.click('Send');
  const sends = f.calls.filter(c=>c.path.endsWith('/send'));
  assert.equal(sends.length,1); assert.equal(sends[0].body.revision,3);
  assert.equal(sends[0].body.send_original,false);
  assert.equal(f.calls.some(c=>c.path.endsWith('/export')),false);
});
test('normal preview pending cannot expose Send or editable controls', async () => {
  const f = await fixture({deferPreview:true});
  await f.click('Review agent drafts'); await f.click('Review draft');
  const pending = f.click('Review message'); await f.flush();
  assert.ok(f.find('textarea','Draft message').disabled);
  assert.ok(f.find('select','Draft recipient and channel').disabled);
  assert.equal(f.find('button','Send'),undefined);
  f.release(); await pending;
  assert.ok(f.find('button','Send')); assert.equal(f.calls.some(c=>c.path.endsWith('/send')),false);
});
test('secure-review export and edit races execute the shipping UI contract',()=>{
  const {spawnSync} = require('node:child_process');
  const result = spawnSync(process.execPath,['tests/remote_authority_ui.cjs'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('owner adds an agent: new key shown once, starts at No access, Draft-and-send needs a confirmation', async () => {
  const f = await f_fixture();
  const name = f.find('input','New agent name'); name.value = 'Helper';
  await f.click('Add agent');
  assert.equal(f.calls.find(c=>c.path==='api/view/agents'&&c.method==='POST').body.name,'Helper');
  assert.equal(f.find('input','New agent key').value,'wzak_000000000000_secret');
  const helper = f.find('select','Level for Helper'); assert.equal(helper.value,'no_access');
  f.context.confirm = () => false; helper.value = 'draft_and_send'; await helper.onchange(); await f.flush();
  assert.equal(f.agents[1].level,'no_access'); assert.equal(helper.value,'no_access');
  f.context.confirm = () => true; helper.value = 'draft_and_send'; await helper.onchange(); await f.flush();
  assert.equal(f.agents[1].level,'draft_and_send');
});
async function f_fixture() { return fixture(); }
