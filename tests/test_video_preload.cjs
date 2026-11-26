const test = require('node:test');
const assert = require('node:assert/strict');
const {videoPreload, videoPrefetchWanted} = require('../static/unified.js');
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

// Issue 443 (James is on mobile data a lot): videos follow photos. A device that never chose downloads and buffers
// videos on any network; Wi-Fi only waits for Wi-Fi; Data Saver waits unless the device chose Always.
test('a device that never chose: any network, but not with Data Saver', () => {
  assert.equal(videoPrefetchWanted('', {type: 'cellular'}, true), true);
  assert.equal(videoPrefetchWanted('', undefined, true), true);
  assert.equal(videoPrefetchWanted('', {type: 'wifi'}, true), true);
  assert.equal(videoPrefetchWanted('', {type: 'cellular', saveData: true}, true), false);
  assert.equal(videoPreload({type: 'cellular'}, true, ''), 'auto');
  assert.equal(videoPreload({type: 'cellular', saveData: true}, true, ''), 'metadata');
});

test('Wi-Fi only, Always and Off are kept', () => {
  assert.equal(videoPrefetchWanted('wifi', {type: 'cellular'}, true), false);
  assert.equal(videoPrefetchWanted('wifi', {type: 'wifi'}, true), true);
  assert.equal(videoPrefetchWanted('always', {type: 'cellular', saveData: true}, true), true);
  assert.equal(videoPrefetchWanted('off', {type: 'wifi'}, false), false);
  assert.equal(videoPreload({type: 'cellular'}, true, 'wifi'), 'metadata');
});
