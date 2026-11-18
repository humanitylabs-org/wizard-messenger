const test = require('node:test');
const assert = require('node:assert/strict');
const {attachChoices, aimPicker} = require('../static/unified.js');
// Issue 285: + opens Camera (touch screens only), Photo or video, and File, each with its own picker settings,
// because one bare file input made an Android WebView jump straight to the photo gallery.

test('a chat offers camera, photo or video, and any file on a touch screen', () => {
  assert.deepEqual(attachChoices(false, true).map(c => [c.id, c.label, c.accept, c.capture || '', c.multiple]), [
    ['camera', 'Camera', 'image/*', 'environment', false],
    ['photo', 'Photo or video', 'image/*,video/*', '', true],
    ['file', 'File', '*/*', '', true],
  ]);
});

test('no camera item without a touch screen', () => {
  assert.deepEqual(attachChoices(false, false).map(c => c.id), ['photo', 'file']);
});

test('the Agent chat takes photos and voice notes only', () => {
  assert.deepEqual(attachChoices(true, true).map(c => [c.id, c.accept]), [['camera', 'image/*'], ['photo', 'image/*'], ['file', 'audio/*']]);
});

test('aimPicker sets the one input for the choice and clears a stale capture', () => {
  const attrs = {}, input = {clicks: 0, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; }, click() { this.clicks++; }};
  const [camera, photo] = attachChoices(false, true);
  aimPicker(input, camera);
  assert.equal(input.accept, 'image/*'); assert.equal(input.multiple, false); assert.equal(attrs.capture, 'environment'); assert.equal(input.clicks, 1);
  aimPicker(input, photo);
  assert.equal(input.accept, 'image/*,video/*'); assert.equal(input.multiple, true); assert.equal('capture' in attrs, false); assert.equal(input.clicks, 2);
});
