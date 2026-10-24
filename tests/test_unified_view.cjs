const test = require('node:test');
const assert = require('node:assert/strict');
const {backState} = require('../static/unified.js');
require('./share-receive-fixture.cjs');
test('Unified Back closes overlay, then thread, then delegates guarded root', () => {
  const initial = {tab:'people',person:'p1',overlay:'preview'};
  const first = backState(initial);
  assert.equal(first.person,'p1'); assert.equal(first.overlay,null); assert.equal(first.handled,true);
  const second = backState(first);
  assert.equal(second.person,null); assert.equal(second.handled,true);
  const root = backState(second);
  assert.equal(root.handled,false); assert.equal(root.tab,'people');
  assert.equal(initial.overlay,'preview');
});
test('Group nested view has the same Back contract', () => {
  assert.deepEqual(backState({tab:'groups',person:'g',overlay:null}),{tab:'groups',person:null,overlay:null,handled:true});
});
