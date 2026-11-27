// Issue 480: an album still sending (queueSend's pending message, which already holds its photos with this phone's
// previews) is shown as that album, never wrapped as one broken photo, and its Retry state stays on the post.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const src = fs.readFileSync(__dirname + '/../static/unified.js', 'utf8');
const a = src.indexOf('  function albumPosts('), z = src.indexOf('  function nearBottom(', a);
assert(a >= 0 && z > a);
const albumPosts = new Function(src.slice(a, z) + '; return albumPosts;')();

function sending(n, extra = {}) {
  const m = {id: 'pending:w1', client_id: 'w1', outgoing: true, pending: true, original: 'Trip', timestamp: 2, network: 'telegram', msgtype: 'm.image', reactions: [], album: 'pending:w1', ...extra};
  m.photos = Array.from({length: n}, (_, i) => ({...m, photos: undefined, id: m.id + ':' + i, original: i ? '' : m.original, local: 'blob:p' + i, media: {w: 4, h: 3, mime: 'image/jpeg'}}));
  m.media = m.photos[0].media;
  return m;
}

test('a sending album is shown with its own photos and previews', () => {
  const m = sending(4), posts = albumPosts([{id: '$t', msgtype: 'm.text', original: 'Hi', timestamp: 1}, m]);
  assert.equal(posts.length, 2);
  assert.strictEqual(posts[1], m, 'the pending message itself, so later state (failed, retry) shows');
  assert.deepEqual(posts[1].photos.map(p => p.local), ['blob:p0', 'blob:p1', 'blob:p2', 'blob:p3']);
  assert.equal(posts[1].id, 'pending:w1'); assert.equal(posts[1].pending, true);
});

test('a failed sending album keeps its Retry on the post', () => {
  const retry = () => {}, m = sending(3, {pending: false, failed: 'Upload failed. Tap to retry.', retry});
  const post = albumPosts([m])[0];
  assert.equal(post.failed, 'Upload failed. Tap to retry.'); assert.strictEqual(post.retry, retry);
  assert.equal(post.photos.length, 3);
});

test('two sending albums in a row stay two posts and are never changed', () => {
  const one = sending(2), two = sending(2, {id: 'pending:w2', client_id: 'w2', album: 'pending:w2'});
  const before = one.photos.length;
  const posts = albumPosts([one, two]);
  assert.equal(posts.length, 2); assert.equal(one.photos.length, before); assert.equal(two.photos.length, 2);
});

test('delivered album rows are still grouped as before', () => {
  const row = (i) => ({id: '$p' + i, album: 'tg:1', identity_id: 'tg', network: 'telegram', sender: 'Me', outgoing: true, timestamp: 3, msgtype: 'm.image', original: i ? '' : 'Trip', media: {w: 4, h: 3}, reactions: []});
  const posts = albumPosts([row(0), row(1), row(2)]);
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].photos.map(p => p.id), ['$p0', '$p1', '$p2']);
});
