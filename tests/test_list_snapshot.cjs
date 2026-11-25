// Issue 336: a full list reload must never roll a chat back to an older copy than the change feed (or this device)
// already showed, and must never bring back a chat the feed removed. Every other chat takes the reload's copy.
const test = require('node:test'), assert = require('node:assert/strict');
const {listSnapshot} = require('../static/unified.js');

const row = (id, n, unread, at = n * 1000) => ({id, unread, last: {text: 'msg ' + n, timestamp: at}});

test('a reload older than the feed keeps the feed’s copy of the chats it moved on', () => {
  const current = [row('a', 5, 3), row('b', 2, 1)];
  const reload = [row('a', 4, 2), row('b', 2, 1)];            // read at seq 20, before a's msg 5 (seq 21)
  const marks = new Map([['a', {seq: 21}], ['b', {seq: 12}]]);
  assert.deepEqual(listSnapshot(current, reload, 20, 1e12, marks), [row('a', 5, 3), row('b', 2, 1)]);
});

test('a reload newer than the feed wins', () => {
  const current = [row('a', 4, 2)];
  const reload = [row('a', 6, 4)];
  assert.deepEqual(listSnapshot(current, reload, 30, 1e12, new Map([['a', {seq: 21}]])), [row('a', 6, 4)]);
});

test('a chat the feed removed after the reload was read stays removed; one it added stays', () => {
  const current = [row('new', 9, 1)];
  const reload = [row('gone', 3, 1)];
  const marks = new Map([['gone', {seq: 25}], ['new', {seq: 26}]]);
  assert.deepEqual(listSnapshot(current, reload, 20, 1e12, marks), [row('new', 9, 1)]);
});

test('a chat read on this device after the reload was asked stays read', () => {
  const current = [{...row('a', 4, 0)}];
  const reload = [row('a', 4, 2)];
  const marks = new Map([['a', {seq: 10, local: 5000}]]);
  assert.deepEqual(listSnapshot(current, reload, 20, 4000, marks), [row('a', 4, 0)]);
  // A reload asked after the read carries the box's own answer.
  assert.deepEqual(listSnapshot(current, reload, 20, 6000, marks), [row('a', 4, 2)]);
});

test('chats with no mark take the reload, newest first; a chat new to the reload is listed', () => {
  const current = [row('a', 1, 0, 1000)];
  const reload = [row('a', 2, 1, 2000), row('b', 3, 1, 3000)];
  assert.deepEqual(listSnapshot(current, reload, 5, 1e12, new Map()).map(p => p.id), ['b', 'a']);
  assert.deepEqual(listSnapshot(null, reload, 5, 1e12, new Map()).map(p => p.id), ['b', 'a']);
});
