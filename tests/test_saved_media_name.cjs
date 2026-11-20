// Issue 337: with "Saved photos keep their file name" on, Save in a photo viewer names the file after the photo
// (its own real name, else a dated name), never after its sender.
const test = require('node:test');
const assert = require('node:assert/strict');
const {savedMediaName, viewerItems} = require('../static/unified.js');

const at = new Date(2026, 10, 20, 14, 3);
const photo = (media, extra = {}) => ({id: '$p', msgtype: 'm.image', outgoing: true, timestamp: at.getTime(), media, ...extra});

test('a real file name from the sender is kept', () => {
  assert.equal(savedMediaName(photo({mime: 'image/jpeg', source_name: 'IMG_1234.JPG'})), 'IMG_1234.JPG');
  assert.equal(savedMediaName(photo({mime: 'image/png', source_name: 'Beach day.png'})), 'Beach day.png');
  assert.equal(savedMediaName(photo({mime: 'image/jpeg', filename: 'signal-2026-11-20-140312.jpg'})), 'signal-2026-11-20-140312.jpg');
});

test('no, generic or random names get a dated name with the right extension', () => {
  assert.equal(savedMediaName(photo({mime: 'image/jpeg'}), at), 'Messenger photo 2026-11-20 14.03.jpg');
  assert.equal(savedMediaName(photo({mime: 'image/webp', source_name: 'image.jpg'}), at), 'Messenger photo 2026-11-20 14.03.webp');
  assert.equal(savedMediaName(photo({mime: 'image/jpeg', source_name: '3f9a1c0e8b7d4a2f9e6c.jpg'}), at), 'Messenger photo 2026-11-20 14.03.jpg');
  assert.equal(savedMediaName(photo({mime: 'image/jpeg', source_name: 'aB3dE5fG7hJ9kL1mN3pQ5r.jpg'}), at), 'Messenger photo 2026-11-20 14.03.jpg');
  assert.equal(savedMediaName({msgtype: 'm.video', timestamp: at.getTime(), media: {mime: 'video/mp4', source_name: 'video.mp4'}}), 'Messenger video 2026-11-20 14.03.mp4');
  assert.equal(savedMediaName(photo({}), at), 'Messenger photo 2026-11-20 14.03.jpg');
});

test('the name never carries a path or the sender', () => {
  assert.equal(savedMediaName(photo({mime: 'image/jpeg', source_name: 'a/b:c.jpg'})), 'a_b_c.jpg');
  assert.ok(!/You/.test(savedMediaName(photo({mime: 'image/jpeg'}))));
});

test('viewer items take the name from who(), so the switch only swaps that function', () => {
  const list = [photo({mime: 'image/jpeg'})];
  const [item] = viewerItems(list, {url: id => '/m/' + id, who: x => savedMediaName(x, at)});
  assert.equal(item.name, 'Messenger photo 2026-11-20 14.03.jpg');
});
