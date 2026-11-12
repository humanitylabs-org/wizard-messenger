const test = require('node:test');
const assert = require('node:assert/strict');
const {openMedia, hostViewer} = require('../static/unified.js');
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

// Issue 180: in the installed Android app (Messenger on its own, no Wizard around it) the shared client's media.view
// only tries window.open and still answers true, so the tap did nothing. Messenger's own view opens there instead.
test('on its own (not framed, no Wizard host): Messenger shows the photo, the shared client is never asked', () => {
  const calls = [], app = {hosted: false, media: {view: () => { calls.push('view'); return true; }}};
  const fallback = spy();
  assert.equal(hostViewer(app, false), null);
  assert.equal(openMedia(hostViewer(app, false), items, 1, fallback), 'messenger');
  assert.deepEqual(calls, [], 'no window.open attempt');
  assert.deepEqual(fallback.seen, [items[1]]);
  assert.equal(hostViewer(undefined, false), null);
});

test('inside Wizard (framed, or connected to a Wizard host): Wizard viewer as before', () => {
  const app = {hosted: false, media: {view: () => true}};
  assert.equal(hostViewer(app, true), app.media);
  const hosted = {hosted: true, media: {view: () => true}};
  assert.equal(hostViewer(hosted, false), hosted.media);
  const fallback = spy();
  assert.equal(openMedia(hostViewer(hosted, false), items, 0, fallback), 'wizard');
  assert.deepEqual(fallback.seen, []);
});
