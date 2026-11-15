const test = require('node:test');
const assert = require('node:assert/strict');
const {photoTimings} = require('../static/unified.js');
// Issue 168: with "Photo timings" on, the view times each photo stage and sends only names and milliseconds.

function clock(on = true) {
  const sent = [], timers = [];
  const t = photoTimings({post: s => sent.push(s), later: (fn, ms) => timers.push({fn, ms}), on: () => on});
  return {t, sent, timers, fire: async () => { for (const x of timers.splice(0)) x.fn(); await Promise.resolve(); await Promise.resolve(); }};
}

test('off: nothing is kept or sent', async () => {
  const c = clock(false);
  c.t.add('photo_thumb', 10); c.t.tap(0).shown(50);
  assert.equal(c.t.pending(), 0); assert.equal(c.timers.length, 0);
});

test('on: one batch a few seconds later, rounded, bad numbers dropped', async () => {
  const c = clock();
  c.t.add('photo_thumb', 120.4); c.t.add('photo_thumb', NaN); c.t.add('photo_thumb', -3); c.t.add('photo_thumb', '9');
  c.t.add('photo_thumb', 80.6);
  assert.equal(c.timers.length, 1); assert.equal(c.timers[0].ms, 3000);
  await c.fire();
  assert.deepEqual(c.sent, [[{name: 'photo_thumb', ms: 120}, {name: 'photo_thumb', ms: 81}]]);
  assert.equal(c.t.pending(), 0);
});

test('a full batch goes at once', async () => {
  const c = clock();
  for (let i = 0; i < 50; i++) c.t.add('photo_thumb', i);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0].length, 50);
});

test('an opened photo counts each stage once, from the tap', async () => {
  const c = clock();
  const tap = c.t.tap(1000);
  tap.firstFrame(true); tap.firstFrame(false); tap.shown(1012); tap.shown(1400); tap.sharp(1300); tap.sharp(1900);
  const black = c.t.tap(2000); black.firstFrame(false); black.shown(2250);
  await c.fire();
  assert.deepEqual(c.sent[0], [{name: 'photo_black', ms: 0}, {name: 'photo_tap', ms: 12}, {name: 'photo_sharp', ms: 300},
    {name: 'photo_black', ms: 1}, {name: 'photo_tap', ms: 250}]);
});

test('a failed post is quiet', async () => {
  const t = photoTimings({post: () => { throw new Error('offline'); }, later: fn => fn, on: () => true});
  t.add('photo_tap', 1); t.flush(); await Promise.resolve(); await Promise.resolve();
  assert.equal(t.pending(), 0);
});
