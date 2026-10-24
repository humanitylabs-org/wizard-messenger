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
async function fixture({deferPreview = false, connectors = false, connectorsUnavailable = false} = {}) {
  const root = new Element('main'), tabs = new Element('nav'); root.id = 'messenger'; tabs.id = 'inbox-tabs';
  const all = () => { const result = []; const walk = e => {result.push(e); e.children.forEach(walk);}; walk(root); return result; };
  const document = {activeElement: null, documentElement: {dataset:{}}, addEventListener(){},
    getElementById: id => id === 'inbox-tabs' ? tabs : all().find(e => e.id === id),
    createElement: tag => new Element(tag), createElementNS: (_,tag) => new Element(tag)};
  const calls = []; let releasePreview;
  let draft = {id:'d1',revision:1,state:'draft',person_id:'p1',identity_id:'i1',text:'Draft hello'};
  let policy = {mode:'no_access',enabled:false,log:[]};
  const api = async (path, opts = {}) => {
    calls.push({path, ...opts});
    if (path === 'api/unified/connectors') {
      if (connectorsUnavailable) { const e = new Error('Not enabled'); e.code = 'not_found'; throw e; }
      return {providers: []};
    }
    if (path === 'api/unified/telegram/status') return {state:'not_configured',message:'Not configured',logins:[]};
    if (path === 'api/view/agent-access') { if (opts.method === 'POST') policy = {...policy,...opts.body}; return policy; }
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
  const context = {document,console,Audio:class {},navigator:{},localStorage:{getItem(){return null;}},sessionStorage:{getItem(){return null;}},confirm:()=>true,
    setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),WizardApp:{update:{hold:()=>({release(){}})}}};
  context.window = context;
  if (connectors) vm.runInNewContext(fs.readFileSync('static/connectors.js','utf8'), context);
  vm.runInNewContext(fs.readFileSync('static/unified.js','utf8'), context);
  context.MessengerUnified.mount({api});
  const flush = async () => {for(let n=0;n<6;n++) await new Promise(r=>setImmediate(r));};
  const find = (tag, label) => all().find(e => e.tagName === tag && (e.attrs['aria-label'] === label || e.textContent === label));
  const click = async label => {const el = find('button',label); assert.ok(el,'button '+label); await el.onclick(); await flush();};
  await context.MessengerUnified.settings(); await flush();
  return {calls,find,click,flush,release:()=>releasePreview()};
}
test('connector settings retain agent controls; disabled connectors preserve Telegram', async () => {
  for (const connectorsUnavailable of [false, true]) {
    const f = await fixture({connectors:true, connectorsUnavailable});
    assert.ok(f.find('select','Agent access level'));
    assert.ok(f.find('button','Review agent drafts'));
    assert.equal(f.calls.some(c => c.path === 'api/unified/telegram/status'), connectorsUnavailable);
    assert.equal(f.calls.some(c => c.path.endsWith('/send')), false);
  }
});
test('owner chooses one of four policies; draft review never automatically sends',async()=>{
  const f = await fixture();
  const policy = f.find('select','Agent access level');
  assert.deepEqual(policy.children.map(e=>e.textContent),['No access','Read-only','Draft-only','Full access']);
  assert.equal(policy.value,'no_access');
  policy.value = 'draft_only'; await f.click('Save agent access');
  assert.equal(f.calls.find(c=>c.path==='api/view/agent-access'&&c.method==='POST').body.mode,'draft_only');
  await f.click('Review agent drafts'); await f.click('Review draft');
  assert.equal(f.calls.filter(c=>c.path.endsWith('/send')).length,0);
  await f.click('Save and review');
  assert.ok(f.find('button','Send')); assert.equal(f.calls.filter(c=>c.path.endsWith('/send')).length,0);
  const body = f.find('textarea','Draft message'); body.value = 'Owner edits'; body.oninput();
  assert.equal(f.find('button','Send'),undefined,'editing invalidates visible approval');
  await f.click('Save and review'); await f.click('Send');
  const send = f.calls.filter(c=>c.path.endsWith('/send'));
  assert.equal(send.length,1); assert.equal(send[0].body.revision,3);
});
test('an edit while preview is in flight cannot restore an old Send approval',async()=>{
  const f = await fixture({deferPreview:true});
  await f.click('Review agent drafts'); await f.click('Review draft');
  const review = f.click('Save and review'); await f.flush();
  const body = f.find('textarea','Draft message'); body.value = 'Newer text'; body.oninput();
  f.release(); await review;
  assert.equal(f.find('button','Send'),undefined);
  assert.equal(f.calls.filter(c=>c.path.endsWith('/send')).length,0);
});
