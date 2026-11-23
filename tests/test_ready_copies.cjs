// Issue 348: the view copies this phone downloaded are kept ready as blob: URLs, so a tapped photo is handed to
// Wizard's viewer in the tap itself (get answers at once), read ahead once per URL, decoded ahead on request, and
// bounded (the oldest blob is revoked).
const test = require('node:test');
const assert = require('node:assert/strict');
const {readyCopies} = require('../static/unified.js');

function fixture(opts = {}) {
  const cached = new Set(opts.cached || ['a', 'b', 'c', 'd']), reads = [], decoded = [], revoked = [];
  let n = 0;
  const r = readyCopies({
    has: url => cached.has(url),
    match: url => { reads.push(url); return opts.match ? opts.match(url) : Promise.resolve('blob:' + url + ':' + (++n)); },
    decode: blob => { decoded.push(blob); return Promise.resolve(); },
    revoke: blob => revoked.push(blob),
    keep: opts.keep, hot: opts.hot,
  });
  return {r, reads, decoded, revoked};
}

test('get answers at once: nothing before a read, the blob after it', async () => {
  const {r, reads} = fixture();
  assert.equal(r.get('a'), undefined);
  const job = r.prime(['a', 'b']);
  assert.equal(r.get('a'), undefined, 'a read in flight is not waited for');
  await job;
  assert.equal(r.get('a'), 'blob:a:1');
  assert.equal(r.get('b'), 'blob:b:2');
  assert.deepEqual(reads, ['a', 'b']);
});

test('each URL is read once, even when primed again while reading', async () => {
  const {r, reads} = fixture();
  const one = r.prime(['a']), two = r.prime(['a']);
  await Promise.all([one, two]);
  await r.prime(['a']);
  assert.deepEqual(reads, ['a']);
});

test('photos this phone has not downloaded are never read', async () => {
  const {r, reads} = fixture({cached: ['a']});
  await r.prime(['a', 'x', null, '']);
  assert.deepEqual(reads, ['a']);
  assert.equal(r.get('x'), undefined);
});

test('decoded on request only, also for a copy already read', async () => {
  const {r, decoded} = fixture();
  await r.prime(['a', 'b']);
  assert.deepEqual(decoded, []);
  await r.prime(['a'], {decoded: true});
  assert.deepEqual(decoded, ['blob:a:1']);
  await r.prime(['c'], {decoded: true});
  assert.deepEqual(decoded, ['blob:a:1', 'blob:c:3']);
});

test('the oldest blob is revoked past the bound, and a used one counts as new', async () => {
  const {r, revoked} = fixture({keep: 2});
  await r.prime(['a', 'b']);
  await r.prime(['a']); // used again: b is now the oldest
  await r.prime(['c']);
  assert.deepEqual(revoked, ['blob:b:2']);
  assert.equal(r.get('a'), 'blob:a:1');
  assert.equal(r.get('b'), undefined);
  assert.equal(r.size(), 2);
});

test('a failed read keeps nothing and can be tried again', async () => {
  let fail = true;
  const {r, reads} = fixture({match: url => fail ? Promise.reject(new Error('gone')) : Promise.resolve('blob:' + url)});
  await r.prime(['a']);
  assert.equal(r.get('a'), undefined);
  fail = false;
  await r.prime(['a']);
  assert.equal(r.get('a'), 'blob:a');
  assert.deepEqual(reads, ['a', 'a']);
});

test('clear revokes every kept blob', async () => {
  const {r, revoked} = fixture();
  await r.prime(['a', 'b']);
  r.clear();
  assert.deepEqual(revoked.sort(), ['blob:a:1', 'blob:b:2']);
  assert.equal(r.get('a'), undefined);
});
