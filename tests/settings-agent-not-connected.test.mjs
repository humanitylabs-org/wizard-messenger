import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
// wizard-ux issue 1335: Agent access shows "Not connected" instead of the chosen level while Messenger holds no gateway
// row (the agent is then an unknown caller and has no Messenger tools). Runs the real renderer code from unified.js.
const source=readFileSync(new URL('../static/unified.js',import.meta.url),'utf8');
const settings=source.indexOf('  function moreSettings(sheet)');
const paintBody=source.slice(source.indexOf('    const sync = () => {',settings),source.indexOf("    api('api/view/agents').then",settings));
const rowBody=source.slice(source.indexOf('  const LEVEL_TEXT ='),source.indexOf('  // Inbox view (James, 6 Nov 2026)'));
const el=(tag,className='',text='')=>({tag,className,textContent:text,children:[],hidden:false,title:'',value:'',attrs:{},
  setAttribute(k,v){this.attrs[k]=v;},replaceChildren(){this.children=[];},append(...c){this.children.push(...c);}});
const LEVELS=[{id:'no_access',label:'No access'},{id:'read_only',label:'Read-only'},{id:'draft_only',label:'Draft-only',recommended:true}];
function paint(state){
  const agents=el('div'),head=el('h3'),group=el('div'),rows=[];
  const context=vm.createContext({agents,head,group,node:el,api:()=>Promise.resolve(state),
    levelRow:(agent,label,levels,save,options)=>{rows.push(options);return el('div');}});
  vm.runInContext(paintBody+'\nglobalThis.paint=paintAgents;',context);context.paint(state);return rows;
}
function row(agent,options){
  const context=vm.createContext({node:el,action:fn=>fn(),toast:()=>{}});
  vm.runInContext(rowBody+'\nglobalThis.levelRow=levelRow;',context);
  return context.levelRow(agent,agent.label,LEVELS,async()=>{},options);
}
const all=n=>[n,...n.children.flatMap(all)];
const agent={id:'hermes',label:'Oscar',level:'draft_only'};
test('a missing gateway row reaches each agent row as not connected',()=>{
  assert.deepEqual(paint({gateway_connected:false,wizard_agents:[agent],wizard_levels:LEVELS}).map(o=>o.connected),[false]);
  assert.deepEqual(paint({gateway_connected:true,wizard_agents:[agent],wizard_levels:LEVELS}).map(o=>o.connected),[true]);
  // An older Messenger answer without the field keeps the picker.
  assert.deepEqual(paint({wizard_agents:[agent],wizard_levels:LEVELS}).map(o=>o.connected),[true]);
});
test('not connected: the row says so and offers no level picker',()=>{
  const r=row(agent,{recommend:true,connected:false}),nodes=all(r);
  assert.equal(nodes.some(n=>n.tag==='select'),false,'no level picker while not connected');
  const off=nodes.find(n=>/u-agent-off/.test(n.className));
  assert.equal(off.textContent,'Not connected');
  assert.doesNotMatch(nodes.map(n=>n.textContent).join(' '),/Draft-only \(recommended\)|Read-only|No access/);
  assert.match(off.title,/Draft-only is saved/);
  assert.equal(agent.level,'draft_only','the owner choice is kept, never rewritten');
});
test('connected: the level picker shows the chosen level as before',()=>{
  const nodes=all(row(agent,{recommend:true,connected:true}));
  const pick=nodes.find(n=>n.tag==='select');
  assert.ok(pick);assert.equal(pick.value,'draft_only');
  assert.equal(nodes.some(n=>/u-agent-off/.test(n.className)),false);
});
