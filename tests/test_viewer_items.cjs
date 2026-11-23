const test = require('node:test');
const assert = require('node:assert/strict');
const {viewerItems} = require('../static/unified.js');
// Issue 170: with "Photos ready in Wizard's viewer" on, each still photo handed to Wizard's shared viewer carries a
// placeholder (the view copy this phone already has, else the thumbnail), while url stays the original.
const url = (id, kind) => 'api/unified/media/' + encodeURIComponent(id) + (kind ? '?kind=' + kind : '');
const who = x => x.outgoing ? 'You' : 'Ann';
const list = [
  {id: '$a', msgtype: 'm.image', media: {mime: 'image/jpeg'}},
  {id: '$b', msgtype: 'm.image', media: {mime: 'image/jpeg'}, outgoing: true},
  {id: '$g', msgtype: 'm.image', media: {mime: 'image/gif'}},
  {id: '$v', msgtype: 'm.video', media: {mime: 'video/mp4'}},
  {id: '$l', msgtype: 'm.image', local: 'blob:http://x/1', media: {mime: 'image/png'}},
];

test('off: the items are exactly as before, no placeholder', () => {
  assert.deepEqual(viewerItems(list, {url, who}), [
    {url: url('$a'), kind: 'image', name: 'Ann'}, {url: url('$b'), kind: 'image', name: 'You'},
    {url: url('$g'), kind: 'image', name: 'Ann'}, {url: url('$v'), kind: 'video', name: 'Ann'}, {url: url('$l'), kind: 'image', name: 'Ann'}]);
});

test('on: still photos get the thumbnail as placeholder; GIFs, videos and unsent photos get none', () => {
  const items = viewerItems(list, {placeholder: true, url, who});
  assert.deepEqual(items.map(x => x.placeholder), [url('$a', 'thumb'), url('$b', 'thumb'), undefined, undefined, undefined]);
  assert.deepEqual(items.map(x => x.url), list.map(x => url(x.id)), 'Save and Share keep the original');
});

test('on: a view copy this phone already downloaded wins over the thumbnail', () => {
  const items = viewerItems(list, {placeholder: true, url, who, blobs: {[url('$b', 'view')]: 'blob:http://x/view-b'}});
  assert.equal(items[0].placeholder, url('$a', 'thumb'));
  assert.equal(items[1].placeholder, 'blob:http://x/view-b');
  assert.equal(items[1].url, url('$b'));
});

// Issue 348: the tapped photo starts from the thumbnail its bubble already shows (it draws in the tap's frame) and
// carries its screen copy as `preview`, which Wizard's viewer shows next; the others keep the screen copy as before.
test('on: the tapped photo opens from its thumbnail with the screen copy as preview', () => {
  const blobs = {[url('$a', 'view')]: 'blob:http://x/view-a', [url('$b', 'view')]: 'blob:http://x/view-b'};
  const items = viewerItems(list, {placeholder: true, url, who, blobs, at: 1});
  assert.equal(items[1].placeholder, url('$b', 'thumb'));
  assert.equal(items[1].preview, 'blob:http://x/view-b');
  assert.equal(items[1].url, url('$b'), 'Save and Share keep the original');
  assert.equal(items[0].placeholder, 'blob:http://x/view-a');
  assert.equal('preview' in items[0], false);
});

test('on: a tapped photo whose screen copy is not read yet opens from its thumbnail, with no preview', () => {
  const items = viewerItems(list, {placeholder: true, url, who, at: 0});
  assert.equal(items[0].placeholder, url('$a', 'thumb'));
  assert.equal('preview' in items[0], false);
});

test('a tapped GIF, video or unsent photo gets neither', () => {
  for (const at of [2, 3, 4]) {
    const item = viewerItems(list, {placeholder: true, url, who, at})[at];
    assert.equal('placeholder' in item || 'preview' in item, false, list[at].id);
  }
});
