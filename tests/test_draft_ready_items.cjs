const test = require('node:test');
const assert = require('node:assert/strict');
const {draftReadyItems} = require('../static/unified.js');
// Issue 201: the chat list's right-click / long-press menu offers the same "keeps a draft ready" item as the open
// chat's ⋯ menu (switch list-draft-ready); one helper builds it for both.

test('off: offers Agent keeps a draft ready and turns it on', () => {
  const calls = [], p = {id: 'james'};
  const items = draftReadyItems(p, false, (x, on) => calls.push([x.id, on]));
  assert.deepEqual(items.map(i => [i.label, i.icon]), [['Agent keeps a draft ready', 'sparkle']]);
  items[0].run();
  assert.deepEqual(calls, [['james', true]]);
});

test('on: offers Stop keeping a draft ready and turns it off', () => {
  const calls = [], p = {id: 'james'};
  const items = draftReadyItems(p, true, (x, on) => calls.push([x.id, on]));
  assert.deepEqual(items.map(i => i.label), ['Stop keeping a draft ready']);
  items[0].run();
  assert.deepEqual(calls, [['james', false]]);
});

test('groups get it too, native (shell) chats and missing chats never', () => {
  assert.equal(draftReadyItems({id: 'g1', is_group: true}, false, () => {}).length, 1);
  assert.deepEqual(draftReadyItems({id: 'n1', native: true}, false, () => {}), []);
  assert.deepEqual(draftReadyItems(null, false, () => {}), []);
});
