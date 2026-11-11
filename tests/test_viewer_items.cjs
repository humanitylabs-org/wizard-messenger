const test = require('node:test');
const assert = require('node:assert/strict');
const {viewerItems, timingSummary} = require('../static/unified.js');
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

test('Settings shows tap to Wizard\'s viewer next to the other timings', () => {
  const lines = timingSummary({photo_wizard: {n: 4, p50: 12, p90: 40}});
  assert.deepEqual(lines, ["Tap to Wizard's viewer 12 ms (p90 40 ms, 4 opened)"]);
});
