const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(k,v) { this.attrs[k] = v; }
  getContext() { return {fillRect() {}}; }
}
const window = {qrcode: () => ({addData() {}, make() {}, getModuleCount: () => 1, isDark: () => true})};
vm.runInNewContext(fs.readFileSync('static/connectors.js','utf8'), {window, document: {createElement: tag => new Element(tag)}});
const nodes = root => [root, ...root.children.flatMap(nodes)];
(async () => {
  const root = new Element('main'), calls = [];
  const api = async (path, method, body) => {
    calls.push({path,method,body});
    if (method === 'GET') return {providers: [
      {network:'signal',label:'Signal',state:'disconnected',flows:[{id:'qr',name:'QR'}],logins:[]},
      {network:'kakaotalk',label:'KakaoTalk',state:'unsupported',message:'No compatible maintained bridge selected',flows:[],logins:[]}
    ]};
    if (path.endsWith('/start')) return {login_id:'synthetic',step_id:'fi.mau.signal.login.qr',type:'display_and_wait',display_and_wait:{type:'qr',data:'synthetic-only'}};
    if (path.endsWith('/step')) return {type:'complete'};
    return {};
  };
  const ui = window.MessengerConnectors(root,api); await ui.show();
  let buttons = nodes(root).filter(x => x.tag === 'button'); assert.equal(buttons.length,1); // no fake unsupported switch
  await buttons[0].onclick();
  assert.ok(nodes(root).some(x => x.tag === 'canvas'));
  buttons = nodes(root).filter(x => x.tag === 'button');
  await buttons.find(x => x.textContent.startsWith('I scanned')).onclick();
  assert.equal(calls.find(x => x.path.endsWith('/step')).body.type,'display_and_wait');
  assert.equal(calls.find(x => x.path.endsWith('/step')).body.login_id,'synthetic');
  await ui.close(); assert.equal(root.children.length,0);
  const privateRoot = new Element('main'), submitted = [];
  const privateApi = async (path, method, body) => {
    if (method === 'GET') return {providers:[{network:'line',label:'LINE',state:'disconnected',flows:[{id:'email',name:'Login'}],logins:[]}]};
    if (path.endsWith('/start')) return {login_id:'local',step_id:'credentials',type:'user_input',user_input:{fields:[{id:'email',type:'username'},{id:'password',type:'password'},{id:'code',type:'2fa_code'},{id:'workspace',type:'select',options:['Workspace A','Workspace B']}]}};
    if (path.endsWith('/step')) { submitted.push(body); return {login_id:'local',step_id:'phone',type:'display_and_wait',display_and_wait:{type:'nothing'},instructions:'Approve in official app'}; }
    return {};
  };
  const privateUI = window.MessengerConnectors(privateRoot,privateApi); await privateUI.show();
  await nodes(privateRoot).find(x => x.tag === 'button').onclick();
  const inputs = nodes(privateRoot).filter(x => x.tag === 'input'); assert.equal(inputs.length,3);
  for (const input of inputs) { assert.equal(input.type,'password'); input.value='synthetic-private-input'; }
  const select = nodes(privateRoot).find(x => x.tag === 'select'); assert.equal(select.children.length,2); select.value='Workspace B';
  await nodes(privateRoot).find(x => x.tag === 'form').onsubmit({preventDefault(){}});
  assert.ok(inputs.every(x => x.value === '')); assert.equal(submitted[0].fields.workspace,'Workspace B');
  assert.ok(nodes(privateRoot).some(x => x.tag === 'button' && x.textContent.startsWith('I scanned')));
  await privateUI.close(); assert.equal(privateRoot.children.length,0);
  console.log('connectors UI: QR, masked private input, select, phone approval, cancel and close passed');
})().catch(e => {console.error(e);process.exitCode=1;});
