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
      {network:'line',label:'LINE',state:'unsupported',message:'No compatible maintained bridge selected',flows:[],logins:[]}
    ]};
    if (path.endsWith('/start')) return {login_id:'synthetic',step_id:'fi.mau.signal.login.qr',type:'display_and_wait',display_and_wait:{type:'qr',data:'synthetic-only'}};
    if (path.endsWith('/step')) return {type:'complete'};
    return {};
  };
  const ui = window.MessengerConnectors(root,api); await ui.show();
  let buttons = nodes(root).filter(x => x.tag === 'button'); assert.equal(buttons.length,1); // no fake LINE switch
  await buttons[0].onclick();
  assert.ok(nodes(root).some(x => x.tag === 'canvas'));
  buttons = nodes(root).filter(x => x.tag === 'button');
  await buttons.find(x => x.textContent.startsWith('I scanned')).onclick();
  assert.equal(calls.find(x => x.path.endsWith('/step')).body.type,'display_and_wait');
  assert.equal(calls.find(x => x.path.endsWith('/step')).body.login_id,'synthetic');
  await ui.close(); assert.equal(root.children.length,0);
  console.log('connectors UI: unsupported hidden; QR rendering; explicit continuation; completion; close passed');
})().catch(e => {console.error(e);process.exitCode=1;});
