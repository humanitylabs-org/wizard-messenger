import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const src = readFileSync(new URL('../static/unified.js', import.meta.url), 'utf8');
const helper = src.slice(src.indexOf('  function recentSharePeople('), src.indexOf('  async function newChat('));
const person = (id, timestamp) => ({id, display_name: 'Test Person ' + id.toUpperCase(), ...(timestamp ? {last: {timestamp}} : {})});
test('Send to sorts newest chat first, uses cached list activity, then alphabetical tail', () => {
  const store = {lists: {people: [person('c', 300), person('b', 200)], groups: [person('g', 400)]}};
  const ctx = {store}; vm.runInNewContext(helper + '\nthis.sort = recentSharePeople;', ctx);
  const rows = [person('a'), person('b'), person('c'), person('g'), person('d')];
  assert.deepEqual(Array.from(ctx.sort(rows), p => p.id), ['g','c','b','a','d']);
  assert.deepEqual(rows.map(p => p.id), ['a','b','c','g','d']);
  assert.deepEqual(Array.from(ctx.sort([person('b', 500), person('g')]), p => p.id), ['b','g']);
});
test('Send to has no alphabet dividers; normal New chat remains A-Z; published targets carry recency', () => {
  assert.match(src, /const all = shareText \? recentSharePeople\(directory\) : directory.sort/);
  assert.match(src, /if \(!shareText && !q && first !== letter\)/);
  assert.match(src, /lastActivity: p.last\?\.timestamp \|\| 0/);
});
test('published targets include group activity, deterministic ties and a twelve-row cap', () => {
  const targets = src.slice(src.indexOf('  function shareTargetRows()'), src.indexOf('  function shareTargets()'));
  const store = {lists: {people: Array.from({length: 15}, (_, i) => person(String(i).padStart(2, '0'), 100)), groups: [person('group', 500)]}};
  const ctx = {store, SHARE_TARGETS: 12, listKey: () => 'people', networksOf: () => ['telegram'], cap: s => s[0].toUpperCase() + s.slice(1)};
  vm.runInNewContext(helper + targets + '\nthis.rows = shareTargetRows();', ctx);
  assert.equal(ctx.rows.length, 12);
  assert.equal(ctx.rows[0].id, 'group');
  assert.equal(ctx.rows[0].detail, 'Group');
  assert.equal(ctx.rows[0].lastActivity, 500);
  assert.deepEqual(Array.from(ctx.rows.slice(1), r => r.id), Array.from({length: 11}, (_, i) => String(i).padStart(2, '0')));
  assert.ok(ctx.rows.slice(1).every(r => r.lastActivity === 100));
});
test('missing cached lists and equal timestamps keep alphabetical tail without mutating rows', () => {
  const ctx = {store: {lists: {}}}; vm.runInNewContext(helper + '\nthis.sort = recentSharePeople;', ctx);
  const rows = [person('z'), person('b', 42), person('a', 42), person('x')];
  assert.deepEqual(Array.from(ctx.sort(rows), p => p.id), ['a', 'b', 'x', 'z']);
  assert.deepEqual(rows.map(p => p.id), ['z', 'b', 'a', 'x']);
});
