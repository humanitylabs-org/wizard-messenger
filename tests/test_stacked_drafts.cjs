// Issue 353: which drafts wait as stacked bubbles above the box (switch stacked-drafts).
const test = require('node:test');
const assert = require('node:assert/strict');
const {draftStack} = require('../static/unified.js');

const d = (id, person = 'ann', state = 'draft') => ({id, person_id: person, state});

test('one draft alone belongs in the box, never in the stack', () => {
  assert.deepEqual(draftStack([d('a')], 'ann', null), []);
  assert.deepEqual(draftStack([], 'ann', null), []);
  assert.deepEqual(draftStack(null, 'ann', null), []);
});

test('two or more wait in creation order, other chats and closed drafts left out', () => {
  const rows = [d('a'), d('x', 'bob'), d('b'), d('s', 'ann', 'sent'), d('c')];
  assert.deepEqual(draftStack(rows, 'ann', null).map(r => r.id), ['a', 'b', 'c']);
});

test('the draft in the box is never also a bubble', () => {
  assert.deepEqual(draftStack([d('a'), d('b'), d('c')], 'ann', 'b').map(r => r.id), ['a', 'c']);
  assert.deepEqual(draftStack([d('a'), d('b')], 'ann', 'a').map(r => r.id), ['b']);
  assert.deepEqual(draftStack([d('a')], 'ann', 'a'), []);
});
