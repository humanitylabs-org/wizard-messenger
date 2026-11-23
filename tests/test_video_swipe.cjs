const test = require('node:test');
const assert = require('node:assert/strict');
const {videoSwipe} = require('../static/unified.js');
// Issue 379 (switch video-fullscreen): a clear drag down closes the full-screen video; short or sideways drags stay.

test('a drag down of 90 px or more closes', () => {
  assert.equal(videoSwipe(0, 90), 'close');
  assert.equal(videoSwipe(-40, 200), 'close');
});

test('short, upward and sideways drags spring back', () => {
  assert.equal(videoSwipe(0, 89), 'stay');
  assert.equal(videoSwipe(0, -200), 'stay');
  assert.equal(videoSwipe(150, 120), 'stay');
  assert.equal(videoSwipe(0, NaN), 'stay');
  assert.equal(videoSwipe(undefined, undefined), 'stay');
});
