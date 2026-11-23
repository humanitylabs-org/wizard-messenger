const test = require('node:test');
const assert = require('node:assert/strict');
const {videoPreload} = require('../static/unified.js');
// Issue 343: a video bubble near the screen buffers its first seconds on Wi-Fi, so one tap plays at once. On mobile
// data, with Data Saver, or on a phone whose network is unknown, it only reads the header.

test('Wi-Fi and wired buffer ahead', () => {
  assert.equal(videoPreload({type: 'wifi'}, true), 'auto');
  assert.equal(videoPreload({type: 'ethernet'}, false), 'auto');
  assert.equal(videoPreload(undefined, false), 'auto');
});

test('mobile data, Data Saver and unknown phone networks only read the header', () => {
  assert.equal(videoPreload({type: 'cellular'}, true), 'metadata');
  assert.equal(videoPreload({type: 'wifi', saveData: true}, true), 'metadata');
  assert.equal(videoPreload(undefined, true), 'metadata');
  assert.equal(videoPreload({type: 'none'}, false), 'metadata');
});
