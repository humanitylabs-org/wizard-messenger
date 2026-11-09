const test = require('node:test');
const assert = require('node:assert/strict');
const {openMedia} = require('../static/unified.js');
// Issue 144: tapping a photo must always open it. Wizard's media viewer first; Messenger's own full-size view only
// when Wizard did not open it (view() answered false, threw, or WizardApp.media is missing).
const items = [{url: 'api/unified/media/%24a', kind: 'image', name: 'Ann'}, {url: 'api/unified/media/%24b', kind: 'image', name: 'Ann'}];
const spy = () => { const seen = []; const fn = item => seen.push(item); fn.seen = seen; return fn; };

test('Wizard viewer opens it: no Messenger view', () => {
  const calls = [], fallback = spy();
  const media = {view: (list, at) => { calls.push([list, at]); return true; }};
  assert.equal(openMedia(media, items, 1, fallback), 'wizard');
  assert.deepEqual(calls, [[items, 1]], 'Wizard gets every photo and the tapped index');
  assert.deepEqual(fallback.seen, []);
});

test('Wizard refuses (view answers false): Messenger shows the tapped photo', () => {
  const fallback = spy();
  assert.equal(openMedia({view: () => false}, items, 1, fallback), 'messenger');
  assert.deepEqual(fallback.seen, [items[1]]);
});

test('no WizardApp.media, or view throws: Messenger shows the tapped photo', () => {
  for (const media of [undefined, null, {}, {view: () => { throw new Error('host gone'); }}, {view: () => undefined}]) {
    const fallback = spy();
    assert.equal(openMedia(media, items, 0, fallback), 'messenger');
    assert.deepEqual(fallback.seen, [items[0]]);
  }
});

test('nothing to show: no view at all', () => {
  const fallback = spy();
  assert.equal(openMedia({view: () => false}, [], 0, fallback), 'none');
  assert.equal(openMedia({view: () => false}, [{kind: 'image'}], 0, fallback), 'none');
  assert.deepEqual(fallback.seen, []);
});
