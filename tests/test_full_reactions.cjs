const test = require('node:test');
const assert = require('node:assert/strict');
const {reactionBare, reactionFilter, reactionQuick, emojiUsage, emojiRanked} = require('../static/unified.js');
// Issue 471 (switch full-reactions): the quick row and the allowed-set filter.

const SIX = ['❤️', '👍', '👎', '😂', '😮', '😢'];

test('no history: the usual six', () => {
  assert.deepEqual(reactionQuick([], SIX, null), SIX);
});

test('most-used reactions first, then the usual six, six in all, no repeats', () => {
  const t0 = 1_800_000_000_000;
  let u = {};
  for (let i = 0; i < 3; i++) u = emojiUsage(u, '⚡', t0 + i);
  u = emojiUsage(u, '👍', t0 + 5);
  assert.deepEqual(reactionQuick(emojiRanked(u, t0 + 10), SIX, null), ['⚡', '👍', '❤️', '👎', '😂', '😮']);
});

test('a chat that allows only some reactions: only those, its own list fills the row', () => {
  const allowed = ['❤️', '👍', '🔥'];
  assert.deepEqual(reactionQuick(['⚡', '🔥'], SIX, allowed), ['🔥', '❤️', '👍']);
  // ❤ without U+FE0F (a picker) counts as the listed ❤️.
  assert.deepEqual(reactionQuick(['❤'], SIX, allowed), ['❤', '👍', '🔥']);
});

test('the allowed-set filter ignores variation selectors; no list means any', () => {
  assert.equal(reactionFilter(null), null);
  const ok = reactionFilter(['❤️', '👍']);
  assert.ok(ok('❤')); assert.ok(ok('👍️')); assert.ok(!ok('⚡'));
  assert.equal(reactionBare('❤️'), '❤');
});
