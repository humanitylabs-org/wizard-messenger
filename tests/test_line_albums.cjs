// LINE photo groups (issue 187) reuse the one album projection, in LINE's order.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const src = fs.readFileSync(__dirname + '/../static/unified.js', 'utf8');
const a = src.indexOf('  function albumPosts('), z = src.indexOf('  function nearBottom(', a);
assert(a >= 0 && z > a);
const albumPosts = new Function(src.slice(a, z) + '; return albumPosts;')();
const part = (i, extra = {}) => ({id: '$p' + i, album: 'line:612345', identity_id: 'line-1', network: 'line', sender: 'Friend',
  outgoing: false, timestamp: i, msgtype: 'm.image', original: '', media: {album_index: i, album_count: 3}, reactions: [], ...extra});

test('a LINE multi-photo send is one album message in LINE order', () => {
  const posts = albumPosts([part(2), part(0), part(1)]);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].photos.map(p => p.id), ['$p0', '$p1', '$p2']);
});
test('LINE photos without a group, or from two sends, stay separate', () => {
  assert.equal(albumPosts([part(0, {album: null}), part(1, {album: null})]).length, 2);
  assert.equal(albumPosts([part(0), part(1, {album: 'line:other'})]).length, 2);
  assert.equal(albumPosts([part(0), {id: 't', msgtype: 'm.text', original: 'hi'}, part(1)]).length, 3);
});
