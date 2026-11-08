'use strict';
// Shared photos from another Wizard app are staged in a chat's photo tray and never sent.
// Runs the real receiveShare / stageFiles / newChat source against synthetic stand-ins (no browser, no account).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../static/unified.js'), 'utf8');

function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'source marker missing: ' + from);
  return source.slice(a, b);
}

function fixture({locked = false, canAttach = true, count = 0} = {}) {
  const s = {ready: !locked, person: null, tab: 'people', search: null, epoch: 0, drafts: {}, overlay: null};
  const calls = [], tray = [];
  const view = {id: null, attach: Array.from({length: count}, (_, i) => ({url: 'blob:' + i})), edit: null,
    draft: {value: '', focus() {}}, grow() {}};
  const context = {s, view, store: {threads: {p1: {}}}, calls, tray, File, Blob, console,
    form: {isConnected: true}, canAttach, id: 'p1',
    toast: t => calls.push(['toast', t]), error: e => calls.push(['error', e.message]),
    closeOverlay() {}, switchTab() {}, inChat() {}, renderList() {}, saveDrafts() {}, hold() {}, newChat: null,
    openPerson: async id => { s.person = id; view.id = id; },
  };
  // addFiles stand-in: the real one prepares photos and fills view.attach; the staging contract is "tray grew".
  context.addFiles = async picked => { await context.gate; for (const f of picked) view.attach.push({blob: f, name: f.name}); tray.push(...picked); };
  context.gate = Promise.resolve();
  vm.createContext(context);
  vm.runInContext(slice('    const stageFiles = async picked => {', '    // Ctrl|Cmd+Enter') + '\nthis.stageFiles = stageFiles;', context);
  view.stageFiles = context.stageFiles;
  vm.runInContext(slice('  function sharedText(item)', '  function listenForShares()') + '\nthis.receive = receiveShare;', context);
  return {context, s, view, calls, tray};
}
const photo = extra => ({id: 'share-1', kind: 'image', file: new File(['photo'], 'one.png', {type: 'image/png'}), target: 'p1', ...extra});

test('an image share opens the target chat, stages it in the tray and never sends', async () => {
  const f = fixture();
  assert.equal(await f.context.receive(photo()), true);
  assert.equal(f.s.person, 'p1'); assert.equal(f.tray.length, 1); assert.equal(f.view.attach[0].blob.type, 'image/png');
  assert.equal(f.calls.length, 0);
});

test('a locked Messenger leaves the image pending, then stages it once after unlock', async () => {
  const f = fixture({locked: true}), item = photo();
  assert.equal(await f.context.receive(item), false); assert.equal(f.s.person, null); assert.equal(f.tray.length, 0);
  f.s.ready = true;
  assert.equal(await f.context.receive(item), true); assert.equal(f.tray.length, 1);
});

test('the caption goes into the composer after the photo, appended to an existing draft', async () => {
  const f = fixture({count: 2}); f.s.person = f.view.id = 'p1'; f.s.drafts.p1 = 'old draft';
  assert.equal(await f.context.receive(photo({text: 'caption'})), true);
  assert.equal(f.view.attach.length, 3); assert.equal(f.view.draft.value, 'old draft\n\ncaption');
});

test('chats that cannot take photos, a full tray, plain files and a mid-stage chat change are never acknowledged', async () => {
  for (const opts of [{canAttach: false}, {count: 10}]) {
    const f = fixture(opts); assert.equal(await f.context.receive(photo()), false); assert.equal(f.tray.length, 0);
  }
  const g = fixture(); assert.equal(await g.context.receive(photo({kind: 'file'})), false); assert.equal(g.tray.length, 0);
  const h = fixture(); let release; h.context.gate = new Promise(r => { release = r; });
  const pending = h.context.receive(photo());
  await new Promise(setImmediate); h.s.person = 'p2'; release();
  assert.equal(await pending, false);
});

test('an image without a target uses the existing recipient picker; only a staged choice acknowledges', async () => {
  const f = fixture(); let pick;
  f.context.newChat = (text, place) => { pick = place; return Promise.resolve(false); };
  assert.equal(await f.context.receive(photo({target: null})), false);
  assert.equal(f.tray.length, 0); assert.equal(await pick('p1'), true); assert.equal(f.tray.length, 1);
});

test('Messenger registers images with the share sheet and newChat settles only on a staged photo', () => {
  assert.match(source, /accepts: \['text', 'url', 'image'\], receive: receiveShare/);
  assert.match(source, /s\.answer = result => resolve\(placeShare \? result === true : true\)/);
  assert.match(source, /Object\.assign\(view, \{draft, grow, paintBar, paintRecording, paintRecordingTick, stageFiles\}\)/);
});
