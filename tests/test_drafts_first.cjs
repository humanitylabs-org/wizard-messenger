const test = require('node:test');
const assert = require('node:assert/strict');
const {chatOrder} = require('../static/unified.js');
// #133: "Drafts at top" (Settings, off by default) floats chats with a waiting draft above the rest.
const now = Date.UTC(2026, 10, 7);
const chat = (id, daysAgo, extra = {}) => ({id, display_name: id, last: {timestamp: now - daysAgo * 864e5}, ...extra});
const rows = [chat('jay', 30), chat('ann', 0), chat('bob', 2, {pinned: true}), chat('cy', 1)];
const drafts = {jay: {updated: now}, cy: {updated: now - 5e3}};
const draftOf = p => drafts[p.id] || null;
test('off by default: pinned first, then newest last message (unchanged order)', () => {
  assert.deepEqual(chatOrder(rows).map(p => p.id), ['bob', 'ann', 'cy', 'jay']);
  assert.deepEqual(chatOrder(rows, {draftOf}).map(p => p.id), ['bob', 'ann', 'cy', 'jay'], 'drafts alone never reorder');
});
test('on: chats with a draft lead, newest draft first, even an old chat', () => {
  assert.deepEqual(chatOrder(rows, {draftsFirst: true, draftOf}).map(p => p.id), ['jay', 'cy', 'bob', 'ann']);
});
test('on with no drafts keeps the usual order; the input is not changed', () => {
  const before = rows.map(p => p.id);
  assert.deepEqual(chatOrder(rows, {draftsFirst: true}).map(p => p.id), ['bob', 'ann', 'cy', 'jay']);
  assert.deepEqual(rows.map(p => p.id), before);
});
test('on: drafts without a time (this device only) still lead, in last-message order', () => {
  const local = {ann: {updated: 0}, jay: {updated: 0}};
  assert.deepEqual(chatOrder(rows, {draftsFirst: true, draftOf: p => local[p.id] || null}).map(p => p.id), ['ann', 'jay', 'bob', 'cy']);
});
