const test = require('node:test');
const assert = require('node:assert/strict');
const {PREFETCH, hasThumb, prefetchPlan, prefetchAllowed, photoPrefetcher} = require('../static/unified.js');
// Issue 166: with "Background photo download" on, the phone quietly fetches thumbnails of the last messages of the
// newest chats, then view copies of the newest photos in each, on Wi-Fi only unless the owner picks Always.
const url = (id, kind) => 'api/unified/media/' + encodeURIComponent(id) + (kind ? '?kind=' + kind : '');
const photo = id => ({id, msgtype: 'm.image', media: {mime: 'image/jpeg'}});

test('sizes match the plan in issue 162', () => {
  assert.deepEqual(PREFETCH, {chats: 15, messages: 40, views: 10, cap: 300 * 1024 * 1024, concurrency: 2});
});

test('only messages whose bubble shows a thumbnail', () => {
  assert.ok(hasThumb(photo('$p')));
  assert.ok(hasThumb({id: '$s', msgtype: 'm.sticker', media: {}}));
  assert.ok(hasThumb({id: '$v', msgtype: 'm.video', media: {thumb: 'mxc://x/y'}}));
  assert.ok(hasThumb({id: '$i', msgtype: 'm.file', media: {mime: 'image/png'}}));
  for (const m of [{id: '$t', msgtype: 'm.text'}, {id: '$v', msgtype: 'm.video', media: {}}, {id: '$f', msgtype: 'm.file', media: {mime: 'application/pdf'}},
    {...photo('$l'), local: 'blob:x'}, {...photo('$q'), pending: true}, {...photo('$d'), deleted: true}, {...photo('$u'), unavailable: 'photo'}]) assert.ok(!hasThumb(m), m.id);
});

test('plan: every thumbnail first, newest chat and message first, then up to 10 view copies per chat', () => {
  const threads = {a: [photo('a1'), {id: 'a2', msgtype: 'm.text'}, photo('a3'), {id: 'ag', msgtype: 'm.image', media: {mime: 'image/gif'}}], b: [photo('b1')]};
  const plan = prefetchPlan([{id: 'a'}, {id: 'b'}], id => threads[id], url);
  assert.deepEqual(plan.map(x => x.kind + ':' + x.id), ['thumb:ag', 'thumb:a3', 'thumb:a1', 'thumb:b1', 'view:a3', 'view:a1', 'view:b1']);
  assert.equal(plan[4].url, 'api/unified/media/a3?kind=view');
  // 15 chats, the last 40 messages, 10 view copies each.
  const many = Array.from({length: 60}, (_, i) => photo('m' + i));
  const chats = Array.from({length: 20}, (_, i) => ({id: 'c' + i}));
  const big = prefetchPlan(chats, () => many, url);
  assert.equal(big.filter(x => x.kind === 'thumb').length, 15 * 40);
  assert.equal(big.filter(x => x.kind === 'view').length, 15 * 10);
  assert.equal(big[0].id, 'm59');
  assert.deepEqual(prefetchPlan(null, () => [], url), []);
});

test('Wi-Fi only never uses cellular, and a phone that cannot tell downloads nothing', () => {
  assert.equal(prefetchAllowed('off', {type: 'wifi'}, false), false);
  assert.equal(prefetchAllowed('always', {type: 'cellular'}, true), true);
  assert.equal(prefetchAllowed('wifi', {type: 'wifi'}, true), true);
  assert.equal(prefetchAllowed('wifi', {type: 'ethernet'}, false), true);
  assert.equal(prefetchAllowed('wifi', {type: 'cellular'}, true), false);
  assert.equal(prefetchAllowed('wifi', {type: 'cellular'}, false), false);
  assert.equal(prefetchAllowed('wifi', {type: 'wifi', saveData: true}, true), false);
  assert.equal(prefetchAllowed('wifi', undefined, true), false);
  assert.equal(prefetchAllowed('wifi', {}, true), false);
  assert.equal(prefetchAllowed('wifi', undefined, false), true);
});

function rig(over = {}) {
  const calls = [], cache = new Map(), saved = [], timers = [];
  let busy = false, allowed = true, t = 0;
  const pending = new Map();
  const get = u => { calls.push(u); return new Promise(resolve => pending.set(u, resolve)); };
  const answer = (u, size = 10, ok = true) => pending.get(u)({ok, blob: async () => new Blob([new Uint8Array(size)], {type: 'image/jpeg'}), headers: {get: () => 'image/jpeg'}});
  const c = {put: async (u, r) => cache.set(u, r), delete: async u => cache.delete(u), match: async u => cache.get(u)};
  const q = photoPrefetcher({get, open: async () => c, index: {load: () => over.index || {}, save: e => saved.push(JSON.parse(JSON.stringify(e)))},
    allowed: () => allowed, busy: () => busy, later: (fn, ms) => timers.push(fn), now: () => ++t, cap: over.cap ?? 1000, concurrency: 2});
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return {q, calls, cache, saved, timers, answer, flush, set: o => { if ('busy' in o) busy = o.busy; if ('allowed' in o) allowed = o.allowed; }};
}
const items = (...ids) => ids.map(id => ({url: url(id, 'thumb'), kind: 'thumb', id}));

test('two at a time, each kept in Cache Storage once', async () => {
  const r = rig();
  assert.equal(r.q.add(items('a', 'b', 'c')), 3); await r.flush();
  assert.deepEqual(r.calls, [url('a', 'thumb'), url('b', 'thumb')]);
  r.answer(url('a', 'thumb')); await r.flush();
  assert.deepEqual(r.calls.length, 3);
  r.answer(url('b', 'thumb')); r.answer(url('c', 'thumb')); await r.flush();
  assert.equal(r.cache.size, 3);
  assert.deepEqual(r.q.stats(), {files: 3, bytes: 30, queued: 0, running: 0});
  assert.equal(r.q.add(items('a', 'b')), 0, 'already kept: never fetched again');
  assert.ok(r.q.has(url('a', 'thumb')));
  const hit = await r.q.match(url('a', 'thumb'));
  assert.match(hit, /^blob:/); URL.revokeObjectURL(hit);
  assert.equal(await r.q.match(url('zz', 'thumb')), null);
});

test('paused while the owner loads something or the network is not allowed', async () => {
  const r = rig();
  r.set({busy: true});
  r.q.add(items('a')); await r.flush();
  assert.equal(r.calls.length, 0); assert.equal(r.timers.length, 1);
  r.set({busy: false}); r.timers.shift()(); await r.flush();
  assert.equal(r.calls.length, 1);
  r.answer(url('a', 'thumb')); await r.flush();
  r.set({allowed: false});
  r.q.add(items('b')); await r.flush();
  assert.equal(r.calls.length, 1, 'cellular with Wi-Fi only: nothing downloads');
  r.set({allowed: true}); r.q.pump(); await r.flush();
  assert.equal(r.calls.length, 2);
});

test('live messages jump the queue; a missing file is not retried', async () => {
  const r = rig();
  r.q.add(items('a', 'b', 'c', 'd'));
  r.q.add(items('new'), true); await r.flush();
  r.answer(url('a', 'thumb'), 10, false); await r.flush();
  assert.equal(r.calls[2], url('new', 'thumb'));
  assert.equal(r.q.add(items('a')), 0);
});

test('a later thumbnail still goes before every view copy waiting', async () => {
  const r = rig();
  const view = id => ({url: url(id, 'view'), kind: 'view', id});
  r.q.add([...items('a', 'b'), view('a'), view('b')]); await r.flush();
  r.q.add([...items('c'), view('c')]); await r.flush();
  for (const u of [url('a', 'thumb'), url('b', 'thumb')]) r.answer(u); await r.flush();
  assert.deepEqual(r.calls.slice(2, 4), [url('c', 'thumb'), url('a', 'view')]);
});

test('over the cap view copies go first, oldest first, and thumbnails survive', async () => {
  const r = rig({cap: 100});
  const view = id => ({url: url(id, 'view'), kind: 'view', id});
  r.q.add([...items('t1'), view('v1')]); await r.flush();
  r.answer(url('t1', 'thumb'), 30); r.answer(url('v1', 'view'), 40); await r.flush();
  r.q.add([view('v2')]); await r.flush();
  r.answer(url('v2', 'view'), 40); await r.flush();
  assert.equal(r.q.stats().bytes, 70);
  assert.ok(r.q.has(url('t1', 'thumb'))); assert.ok(!r.q.has(url('v1', 'view'))); assert.ok(r.q.has(url('v2', 'view')));
  assert.ok(!r.cache.has(url('v1', 'view')));
  r.q.add([view('v3')]); await r.flush(); r.answer(url('v3', 'view'), 90); await r.flush();
  assert.ok(r.q.has(url('t1', 'thumb')), 'every view copy goes before a thumbnail does');
  assert.equal(r.q.stats().bytes, 30);
  r.q.add(items('t2')); await r.flush(); r.answer(url('t2', 'thumb'), 80); await r.flush();
  assert.ok(!r.q.has(url('t1', 'thumb')) && r.q.has(url('t2', 'thumb')), 'then the oldest thumbnail');
});

test('the index survives a reload, and Lock forgets everything', async () => {
  const r = rig({index: {[url('k', 'thumb')]: {kind: 'thumb', size: 5, at: 1}}});
  assert.equal(r.q.add(items('k')), 0);
  r.q.add(items('x')); await r.flush(); const inflight = url('x', 'thumb');
  await r.q.clear();
  r.answer(inflight); await r.flush();
  assert.deepEqual(r.q.stats(), {files: 0, bytes: 0, queued: 0, running: 0});
  assert.equal(r.cache.size, 0, 'a download that finishes after Lock is not kept');
  assert.deepEqual(r.saved.at(-1), {});
});
