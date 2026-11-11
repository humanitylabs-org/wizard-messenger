const test = require('node:test');
const assert = require('node:assert/strict');
const {photoStages} = require('../static/unified.js');
// Issue 164: with "Photos open instantly" on, Messenger's own viewer opens a still photo from its thumbnail, then the
// box's view copy, and loads the original only on zoom. Off, and for GIFs, videos and photos still sending, the
// original as before.
const url = (id, kind) => 'api/unified/media/' + encodeURIComponent(id) + (kind ? '?kind=' + kind : '');
const photo = {id: '$a', msgtype: 'm.image', media: {mime: 'image/jpeg'}};

test('on: thumbnail first, then the view copy, original kept for zoom', () => {
  assert.deepEqual(photoStages(photo, true, url), {first: 'api/unified/media/%24a?kind=thumb', sharp: 'api/unified/media/%24a?kind=view', full: 'api/unified/media/%24a'});
  // A LINE photo carries no mimetype: still a photo.
  assert.equal(photoStages({id: '$b', msgtype: 'm.image', media: {}}, true, url).sharp, 'api/unified/media/%24b?kind=view');
});

test('off: the original, as before', () => {
  assert.deepEqual(photoStages(photo, false, url), {first: 'api/unified/media/%24a', sharp: null, full: 'api/unified/media/%24a'});
});

test('GIFs, videos, files and photos still sending open the original', () => {
  for (const m of [{id: '$g', msgtype: 'm.image', media: {mime: 'image/gif'}}, {id: '$v', msgtype: 'm.video', media: {mime: 'video/mp4'}},
    {id: '$f', msgtype: 'm.file', media: {mime: 'application/pdf'}}, {id: '$s', msgtype: 'm.sticker', media: {mime: 'image/webp'}}]) {
    assert.deepEqual(photoStages(m, true, url), {first: url(m.id), sharp: null, full: url(m.id)}, m.id);
  }
  assert.deepEqual(photoStages({...photo, local: 'blob:x', pending: true}, true, url), {first: 'blob:x', sharp: null, full: 'blob:x'});
});
