const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.value = ''; this.style = {}; this.dataset = {}; this.className = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k,v) { this.attrs[k] = v; }
  getContext() { return {fillRect() {}}; }
  querySelector() { return null; }
}
const window = {qrcode: () => ({addData() {}, make() {}, getModuleCount: () => 1, isDark: () => true})};
vm.runInNewContext(fs.readFileSync('static/connectors.js','utf8'), {window, document: {createElement: tag => new Element(tag)}});
assert.equal(typeof window.MessengerConnectors.qrCanvas, 'function', 'My QR codes and linking share the exported renderer');
const nodes = root => [root, ...root.children.flatMap(nodes)];
const texts = root => nodes(root).map(x => x.textContent).filter(Boolean);
const tick = () => new Promise(r => setTimeout(r, 0));
(async () => {
  // QR flow: QR first, scan steps visible, waits automatically, never stores QR data.
  const root = new Element('main'), calls = []; let release;
  const api = async (path, method, body) => {
    calls.push({path,method,body});
    if (method === 'GET') return {providers: [
      {network:'whatsapp',label:'WhatsApp',supported:true,state:'disconnected',flows:[{id:'phone',name:'Pairing code'},{id:'qr',name:'QR'}],logins:[]},
      {network:'kakaotalk',label:'KakaoTalk',supported:false,state:'unsupported',message:'No compatible maintained bridge selected',flows:[],logins:[]}
    ]};
    if (path.endsWith('/start')) return {login_id:'synthetic',step_id:'fi.mau.whatsapp.login.qr',type:'display_and_wait',display_and_wait:{type:'qr',data:'synthetic-only'}};
    if (path.endsWith('/step')) return new Promise(r => { release = () => r({type:'complete'}); });
    return {};
  };
  const ui = window.MessengerConnectors(root,api); await ui.show();
  const buttons = nodes(root).filter(x => x.tag === 'button');
  assert.equal(buttons[0].textContent, 'Show QR code', 'QR is the primary action, ahead of pairing code');
  // An unsupported network is the same tile as the others, disabled with "Soon": never a working connect button.
  const soon = buttons.filter(x => /c-soon/.test(x.className));
  assert.equal(buttons.length - soon.length, 2, 'no fake button for an unsupported network');
  assert.equal(soon.length, 1); assert.equal(soon[0].disabled, true, 'the Soon tile cannot be pressed');
  assert.ok(texts(soon[0]).includes('KakaoTalk') && texts(soon[0]).includes('Soon'), 'unsupported networks show as a dimmed Soon tile');
  const started = buttons[0].onclick(); await tick(); await tick(); await tick();
  assert.ok(nodes(root).some(x => x.tag === 'canvas'), 'QR rendered');
  assert.ok(texts(root).some(t => /Linked devices/.test(t)), 'phone scan steps shown');
  assert.ok(texts(root).some(t => /Waiting for your phone/.test(t)), 'waits automatically');
  const step = calls.find(x => x.path.endsWith('/step'));
  assert.equal(step.body.type,'display_and_wait'); assert.equal(step.body.login_id,'synthetic');
  release(); await started; await tick();
  assert.ok(texts(root).some(t => /WhatsApp connected/.test(t)), 'success screen');
  await ui.close(); assert.equal(root.children.length,0);

  // Credential flow: secrets masked, addresses readable, values cleared after submit, select preserved.
  const privateRoot = new Element('main'), submitted = [];
  const privateApi = async (path, method, body) => {
    if (method === 'GET') return {providers:[{network:'line',label:'LINE',supported:true,state:'disconnected',flows:[{id:'dev.highest.matrix.line.email_login',name:'Login'}],logins:[]}]};
    if (path.endsWith('/start')) return {login_id:'local',step_id:'credentials',type:'user_input',user_input:{fields:[{id:'email',type:'email'},{id:'password',type:'password'},{id:'code',type:'2fa_code'},{id:'workspace',type:'select',options:['Workspace A','Workspace B']}]}};
    if (path.endsWith('/step')) { submitted.push(body); return new Promise(() => {}); }
    return {};
  };
  const privateUI = window.MessengerConnectors(privateRoot,privateApi); await privateUI.show();
  await nodes(privateRoot).find(x => x.tag === 'button').onclick();
  const inputs = nodes(privateRoot).filter(x => x.tag === 'input'); assert.equal(inputs.length,3);
  assert.deepEqual(inputs.map(x => x.type), ['email','password','password']);
  for (const input of inputs) input.value='synthetic-private-input';
  const select = nodes(privateRoot).find(x => x.tag === 'select'); assert.equal(select.children.length,2); select.value='Workspace B';
  nodes(privateRoot).find(x => x.tag === 'form').onsubmit({preventDefault(){}}); await tick();
  assert.ok(inputs.every(x => x.value === ''), 'typed secrets cleared from the DOM');
  assert.equal(submitted[0].fields.workspace,'Workspace B');
  await privateUI.close(); assert.equal(privateRoot.children.length,0);
  console.log('connectors UI: QR-first, scan steps, auto-wait, masked secrets, readable address, select, cancel and close passed');
})().catch(e => {console.error(e);process.exitCode=1;});
