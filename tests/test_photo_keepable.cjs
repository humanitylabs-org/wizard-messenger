const test = require('node:test');
const assert = require('node:assert/strict');
const {keepable, photoPrefetcher} = require('../static/unified.js');
// Issue 404: the phone keeps a photo's thumbnail or view copy only when it is a picture a phone can draw. Before the
// box turned HEIC photos into JPEGs it answered their view copy with the HEIC bytes (labelled video/mp4), and the
// phone kept that; such a copy is let go the next time it is asked for, so the box's picture is used instead.

test('keepable: pictures phones draw, for thumbnails and view copies only', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/JPEG']) assert.ok(keepable('thumb', type), type);
  for (const type of ['video/mp4', 'image/heic', 'application/octet-stream', '', undefined]) {
    assert.equal(keepable('thumb', type), false, String(type));
    assert.equal(keepable('view', type), false, String(type));
  }
  assert.ok(keepable('video', 'video/mp4'), 'videos keep their own type');
});

function rig(index = {}) {
  const cache = new Map(), pending = new Map();
  const get = u => new Promise(resolve => pending.set(u, resolve));
  const answer = (u, type) => pending.get(u)({ok: true, blob: async () => new Blob([new Uint8Array(10)], {type}), headers: {get: () => type}});
  const c = {put: async (u, r) => cache.set(u, r), delete: async u => cache.delete(u), match: async u => cache.get(u)};
  const q = photoPrefetcher({get, open: async () => c, index: {load: () => index, save: () => {}}, allowed: () => true, busy: () => false, later: () => {}, cap: 1000, concurrency: 2});
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  return {q, cache, answer, flush};
}

test('a view copy that is not a picture is never kept', async () => {
  const r = rig();
  r.q.add([{url: 'v1', kind: 'view'}, {url: 'v2', kind: 'view'}]);
  await r.flush();
  r.answer('v1', 'video/mp4'); r.answer('v2', 'image/jpeg');
  await r.flush();
  assert.equal(r.q.has('v1'), false);
  assert.equal(r.cache.has('v1'), false);
  assert.equal(r.q.has('v2'), true);
});

test('a bad copy kept before is dropped when asked for, a good one is served', async () => {
  const r = rig({bad: {kind: 'view', size: 10, at: 1}, good: {kind: 'thumb', size: 10, at: 2}});
  r.cache.set('bad', new Response(new Blob([new Uint8Array(10)], {type: 'video/mp4'})));
  r.cache.set('good', new Response(new Blob([new Uint8Array(10)], {type: 'image/jpeg'})));
  assert.equal(await r.q.match('bad'), null);
  assert.equal(r.q.has('bad'), false);
  assert.equal(r.cache.has('bad'), false);
  const blob = await r.q.match('good');
  assert.match(blob, /^blob:/);
  URL.revokeObjectURL(blob);
});
