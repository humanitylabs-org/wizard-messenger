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
