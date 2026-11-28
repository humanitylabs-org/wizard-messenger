// Executes the production serverDraft controller against an isolated strict-revision synthetic endpoint.
// No Messenger server, credentials, provider, private draft, or message store is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(process.env.STATIC_JS || path.join(__dirname, '../static/unified.js'), 'utf8');
const controller = source.slice(source.indexOf('  function serverDraft('), source.indexOf('  function composer('));
const tick = () => new Promise(r => setImmediate(r));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const copy = v => structuredClone(v);
async function fixture(saved = []) {
  let slow = false;
  let row = saved === null ? null : {id: 'synthetic-draft', person_id: 'alice', identity_id: 'signal-alice', revision: 1, text: 'Keep this caption', state: 'draft', attachments: saved};
  let next = 0, writes = 0, failPut = new Set(), lost = 0, flaky = 0, failGet = new Set(), holdPut = null, holdGet = null, failDelete = false;
  const counts = {puts: 0, deletes: 0, draftDeletes: 0, sends: 0}, errors = [], requests = [];
  const s = {person: 'alice', drafts: {}, draftIndex: {}, bindDraft: null};
  const view = {id: 'alice', attach: null}, ui = {form: {isConnected: true}, draft: {value: '', focus() {}}, channel: {value: 'signal-alice', options: [{value: 'signal-alice'}]}, grow() {}, paintBar() {}, paintVia() {}};
  const bad = (code) => Object.assign(new Error(code), {code});
  async function api(url, options = {}) {
    const body = options.body || {}, method = options.method || 'GET';
    requests.push({url, method, body: copy(body)});
    if (url.endsWith('/attachments/' + (url.split('/').pop())) && url.includes('/attachments/') && method === 'DELETE') {
      if (failDelete) throw bad('storage_failed');
      if (body.revision !== row.revision) throw bad('draft_changed');
      row.attachments = row.attachments.filter(a => a.id !== url.split('/').pop()); row.revision++; counts.deletes++;
    } else if (method === 'POST' && url === 'api/drafts') {
      if (row) throw bad('draft_exists');
      row = {...body, id: 'synthetic-draft', revision: 1, state: 'draft', attachments: []}; counts.creates = (counts.creates || 0) + 1;
    } else if (method === 'POST') {
      if (body.revision !== row.revision) throw bad('draft_changed');
      row = {...row, text: body.text, identity_id: body.identity_id, revision: row.revision + 1};
    } else if (method === 'DELETE') {
      if (body.revision !== row.revision) throw bad('draft_changed');
      row = null; counts.draftDeletes++;
    }
    return {draft: copy(row)};
  }
  async function draftRaw(url, method, blob, q) {
    counts.puts++;
    // Issue 481: slow() keeps each PUT open for a moment, so uploads running side by side are counted.
    if (slow) { counts.live = (counts.live || 0) + 1; counts.peak = Math.max(counts.peak || 0, counts.live); await tick(); await tick(); counts.live--; }
    if (holdPut) { const gate = holdPut; holdPut = null; gate.entered.resolve(); await gate.promise; }
    if (failPut.has(q.name)) throw bad('storage_failed');
    // Issue 463: passing trouble (no answer / gateway 502) is transient; the box answers a known upload key as is.
    if (flaky > 0) { flaky--; throw Object.assign(new Error('Could not attach that file'), {transient: true}); }
    if (q.key && row.attachments.some(a => a.key === q.key)) return {draft: copy(row)};
    // Issue 481: the composer's keyed appends (append=1) run side by side and are not fenced to the revision.
    if (q.revision !== row.revision && !(q.append === 1 && q.key)) throw bad('draft_changed');
    row.attachments.push({id: 'file-' + (++next), name: q.name, mime: blob.type, bytes: blob.size, ...(q.key ? {key: q.key} : {})}); row.revision++;
    if (lost > 0) { lost--; throw Object.assign(new Error('Could not attach that file'), {transient: true}); }
    return {draft: copy(row)};
  }
  const context = vm.createContext({view, ui, s, saveDrafts() {}, draftsFor: (rows, id) => rows.filter(d => d.person_id === id), Blob, File: class extends Blob { constructor(b, name, o) { super(b, o); this.name = name; } },
    URL: {createObjectURL: () => 'blob:synthetic', revokeObjectURL() {}},
    uid: () => String(++next), api, draftRaw, csrf: () => 'synthetic', error: e => errors.push(e.message),
    fetch: async url => { const id = url.split('/').pop(); if (holdGet) { const gate = holdGet; holdGet = null; await gate.promise; }
      return {ok: !failGet.has(id), blob: async () => new Blob(['synthetic'], {type: 'image/png'})}; },
    preparePhoto: async f => ({blob: f, albumBlob: f, url: 'blob:synthetic', w: 1, h: 1}),
    // Issue 402: restored attachments are sorted photo / video / file by the view's own rule.
    attachKind: require(path.join(__dirname, '../static/unified.js')).attachKind,
    // Issue 353: several drafts per chat are on for everyone, so the controller always works out the stack.
    draftStack: require(path.join(__dirname, '../static/unified.js')).draftStack, prepareVideo: async f => ({video: true, blob: f, local: 'blob:synthetic', url: ''}),
    draftWrites: writes, draftWrote() { context.draftWrites++; }, refreshDraftIndex() {},
    fetchDrafts: async () => row ? [copy(row)] : [], closedDrafts: new Set(), agentName: () => 'Owner',
    SD_SAVE_MS: 500000, SD_POLL_MS: 500000, SD_UPLOAD_WAIT_MS: [1, 1, 1], SD_UPLOAD_PARALLEL: 3, SD_SEND_HOLD_MS: 1000, setTimeout: (fn, ms) => ms <= 1 ? setTimeout(fn, 0) : 0,
    clearTimeout, setInterval: () => 0, clearInterval() {}, document: {hidden: false},
    node: (tag, cls, text) => ({tag, cls, text, append() {}}), button: () => ({}),
  });
  vm.runInContext(controller + '\nthis.sd = serverDraft("alice", ui);', context);
  view.sd = context.sd;
  await new Promise(r => setTimeout(r, 10));
  const item = name => ({key: name, name, bytes: 3, file: true, blob: new Blob(['abc'], {type: 'application/pdf'})});
  return {sd: context.sd, ui, view, item, counts, errors, requests, row: () => copy(row), failPut, failGet,
    loseAnswers(n) { lost = n; }, flaky(n) { flaky = n; }, slow() { slow = true; },
    holdPut() { return holdPut = {...defer(), entered: defer()}; }, holdGet() { return holdGet = defer(); },
    failDelete(v) { failDelete = v; }, remoteAttachments(a) { row.attachments = a; row.revision++; },
    replaceView(empty = false) { s.person = 'bob'; ui.form.isConnected = false; view.id = 'bob'; view.sd = {}; view.attach = empty ? null : [item('bob-only')]; },
    async select(...items) { view.attach = [...(view.attach || []), ...items]; await context.sd.attach(items); },
    async remove(it) { view.attach = (view.attach || []).filter(a => a !== it); await context.sd.detach(it); },
  };
}

test('two overlapping selections use successive revisions, not a sticky false error', async () => {
  const f = await fixture(), first = f.item('one.pdf'), second = f.item('two.pdf'), gate = f.holdPut();
  const a = f.select(first); await tick(); const b = f.select(second); await tick(); gate.resolve();
  await Promise.all([a, b]);
  assert.equal(f.row().attachments.length, 2, 'REGRESSION_OVERLAPPING_ATTACHMENT_BATCH_LOST'); assert.equal(f.sd.uploadError, false); assert.deepEqual(f.errors, []);
});
test('overlapping selections in an empty composer create only one draft', async () => {
  const f = await fixture(null), gate = f.holdPut(), a = f.select(f.item('one.pdf')); await tick();
  const b = f.select(f.item('two.pdf')); gate.resolve(); await Promise.all([a, b]);
  assert.equal(f.row().attachments.length, 2); assert.equal(f.sd.uploadError, false); assert.equal(f.sd.conflict, null);
});
test('autosave waits for attachment revision, preserving caption and both files', async () => {
  const f = await fixture(), gate = f.holdPut(), a = f.select(f.item('one.pdf')); await tick();
  f.ui.draft.value = 'New caption'; const save = f.sd.save(); await tick(); gate.resolve(); await Promise.all([a, save]);
  assert.equal(f.row().text, 'New caption'); assert.equal(f.row().attachments.length, 1); assert.equal(f.sd.conflict, null);
});
test('transient PUT failure retries from retained bytes and clears its own error', async () => {
  const f = await fixture(), it = f.item('one.pdf'); f.failPut.add(it.name); await f.select(it);
  assert.equal(f.sd.uploadError, true); assert.equal(f.view.attach[0], it);
  assert.equal(f.sd.note().text, 'An attachment did not upload. Tap Retry on it, or remove it, before sending.');
  f.failPut.clear(); await f.sd.retry();
  assert.equal(f.sd.uploadError, false); assert.equal(f.row().attachments.length, 1); assert.equal(f.ui.draft.value, 'Keep this caption');
});
test('removing one failed upload cannot clear another failed upload', async () => {
  const f = await fixture(), one = f.item('one.pdf'), two = f.item('two.pdf'); f.failPut.add(one.name); f.failPut.add(two.name);
  await f.select(one, two); await f.remove(one); assert.equal(f.sd.uploadError, true); assert.equal(f.view.attach[0], two);
  await f.sd.retry(); assert.equal(f.sd.uploadError, true); assert.equal(f.row().attachments.length, 0); assert.equal(f.counts.sends, 0);
});
test('remove while PUT is pending removes the saved item without orphaning it', async () => {
  const f = await fixture(), it = f.item('one.pdf'), gate = f.holdPut(), put = f.select(it); await tick();
  const removal = f.remove(it); gate.resolve(); await Promise.all([put, removal]);
  assert.equal(f.row().attachments.length, 0); assert.equal(f.view.attach?.length || 0, 0); assert.equal(f.sd.uploadError, false);
});
test('failed GET stays selectable/removable, never disappears silently', async () => {
  const f = await fixture(); f.failGet.add('broken'); f.remoteAttachments([{id: 'broken', name: 'broken.png', mime: 'image/png', bytes: 9}]);
  await f.sd.check(true); assert.equal(f.sd.loadError, true); assert.equal(f.view.attach[0].sid, 'broken');
  await f.remove(f.view.attach[0]); assert.equal(f.sd.loadError, false); assert.equal(f.row().attachments.length, 0);
});
test('retry opens a failed download without losing text or the healthy attachment', async () => {
  const f = await fixture(), healthy = f.item('healthy.pdf'); await f.select(healthy); f.failGet.add('broken');
  f.remoteAttachments([...f.row().attachments, {id: 'broken', name: 'broken.png', mime: 'image/png', bytes: 9}]);
  await f.sd.check(true); assert.equal(f.sd.loadError, true); f.failGet.clear(); await f.sd.retry();
  assert.equal(f.sd.loadError, false); assert.equal(f.view.attach.length, 2); assert.ok(f.view.attach.includes(healthy));
  assert.equal(f.ui.draft.value, 'Keep this caption');
});
test('failed DELETE restores the chip and blocks until removal succeeds', async () => {
  const f = await fixture(), it = f.item('one.pdf'); await f.select(it); f.failDelete(true); await f.remove(it);
  assert.equal(f.sd.loadError, true); assert.equal(f.view.attach[0], it); assert.equal(f.row().attachments.length, 1);
  f.failDelete(false); await f.sd.retry(); assert.equal(f.sd.loadError, false); assert.equal(f.row().attachments.length, 0);
});
test('late download cannot cross into another conversation', async () => {
  const f = await fixture(), gate = f.holdGet(); f.remoteAttachments([{id: 'slow', name: 'slow.png', mime: 'image/png', bytes: 9}]);
  const load = f.sd.check(true); await tick(); f.replaceView(); gate.resolve(); await load;
  assert.deepEqual(f.view.attach.map(a => a.name), ['bob-only']);
});
for (const emptyDestination of [true, false]) {
  test('caption-cleared autosave survives navigation during held upload to ' + (emptyDestination ? 'empty' : 'nonempty') + ' composer', async () => {
    const f = await fixture();
    const gate = f.holdPut(), file = f.item('alice-held.pdf');
    const upload = f.select(file); await gate.entered.promise;
    f.ui.draft.value = '';
    // Execute the actual production save handler BEFORE releasing its awaited upload.
    const saving = f.sd.save();
    assert.equal(f.counts.draftDeletes, 0);
    f.sd.stop(); f.replaceView(emptyDestination);
    const destination = f.view.attach;
    gate.resolve(); await upload; await saving;
    assert.equal(f.row() !== null, true, 'REGRESSION_AUTOSAVE_NAVIGATION_DELETED_ATTACHMENT_DRAFT');
    assert.equal(f.row().text, '');
    assert.equal(f.row().person_id, 'alice');
    assert.equal(f.row().identity_id, 'signal-alice');
    assert.deepEqual(f.row().attachments.map(a => a.name), ['alice-held.pdf']);
    assert.equal(file.sid, f.row().attachments[0].id);
    assert.equal(file.blob.size, 3);
    assert.strictEqual(f.view.attach, destination, 'old save must not replace the destination tray');
    assert.equal(f.counts.draftDeletes, 0);
    assert.equal(f.counts.sends, 0);
    assert.equal(f.sd.conflict, null);
  });
}

test('navigation flush captures old controller handles after global tray was cleared', async () => {
  const f = await fixture();
  const gate = f.holdPut(), file = f.item('alice-flush.pdf');
  const upload = f.select(file); await gate.entered.promise;
  f.ui.draft.value = ''; f.replaceView(true);
  const saving = f.sd.save(); f.sd.stop();
  gate.resolve(); await upload; await saving;
  assert.ok(f.row(), 'REGRESSION_NAVIGATION_FLUSH_LOST_CONTROLLER_HANDLES');
  assert.equal(f.row().text, '');
  assert.deepEqual(f.row().attachments.map(a => a.id), [file.sid]);
  assert.equal(f.view.attach, null);
  assert.equal(f.counts.sends, 0);
});

test('suspended autosave freezes text and identity and ignores destination edit state', async () => {
  const f = await fixture();
  const gate = f.holdPut(), file = f.item('alice-frozen.pdf');
  const upload = f.select(file); await gate.entered.promise;
  f.ui.draft.value = 'Frozen Alice caption';
  const saving = f.sd.save();
  f.sd.stop(); f.replaceView(); f.view.edit = {id: 'bob-edit'};
  f.ui.draft.value = 'Not the frozen caption'; f.ui.channel.value = 'bob-channel';
  gate.resolve(); await upload; await saving;
  assert.equal(f.row().text, 'Frozen Alice caption');
  assert.equal(f.row().identity_id, 'signal-alice');
  assert.equal(f.view.attach[0].key, 'bob-only');
  const writes = f.requests.filter(r => r.method === 'POST');
  assert.ok(writes.every(r => r.body.person_id === 'alice' && r.body.identity_id === 'signal-alice'));
  assert.equal(f.counts.sends, 0);
});

test('newer autosave supersedes an older snapshot suspended on the same upload', async () => {
  const f = await fixture();
  const gate = f.holdPut(), file = f.item('alice-latest.pdf');
  const upload = f.select(file); await gate.entered.promise;
  f.ui.draft.value = 'Old caption'; const first = f.sd.save();
  f.ui.draft.value = 'Newest caption'; const latest = f.sd.save();
  gate.resolve(); await upload; await Promise.all([first, latest]);
  assert.equal(f.row().text, 'Newest caption');
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.body.text), ['Newest caption']);
  f.sd.stop();
});

test('send generation fences a suspended autosave rather than resurrecting a sent draft', async () => {
  const f = await fixture();
  const gate = f.holdPut(), file = f.item('alice-send.pdf');
  const upload = f.select(file); await gate.entered.promise;
  f.ui.draft.value = 'Must not resurrect'; const saving = f.sd.save();
  f.view.attach = null; f.ui.draft.value = ''; f.sd.closeForSend();
  gate.resolve(); await upload; await saving; await f.sd.closing;
  assert.equal(f.row(), null);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0, 'stale save must not recreate a closed draft');
  assert.equal(f.counts.draftDeletes, 1);
  assert.equal(f.counts.sends, 0);
  f.sd.stop();
});

test('send barrier waits for pending upload and uses its final revision exactly once', async () => {
  const f = await fixture(), gate = f.holdPut(), upload = f.select(f.item('one.pdf')); await tick();
  f.sd.closeForSend(); gate.resolve(); await upload; await f.sd.afterSend();
  assert.equal(f.row(), null); assert.equal(f.counts.puts, 1); assert.equal(f.sd.loadError, false); assert.equal(f.sd.uploadError, false);
});

// Issue 463: the box stored the photo but its answer was lost (gateway 502, dropped connection).
test('a lost upload answer becomes the saved attachment: one copy, no warning, no conflict', async () => {
  const f = await fixture(), it = f.item('photo.jpg'); f.loseAnswers(1); await f.select(it);
  assert.equal(f.row().attachments.length, 1, 'never stored twice'); assert.equal(it.sid, f.row().attachments[0].id);
  assert.equal(f.sd.uploadError, false); assert.equal(f.sd.conflict, null); assert.equal(f.sd.row.revision, f.row().revision); assert.deepEqual(f.errors, []);
  await f.sd.check(false); assert.equal(f.view.attach.length, 1, 'a poll adds no second chip');
});
test('passing trouble retries by itself, then stops and asks for Retry', async () => {
  const once = await fixture(), a = once.item('a.jpg'); once.flaky(1); await once.select(a);
  assert.equal(once.counts.puts, 2); assert.equal(once.sd.uploadError, false); assert.equal(once.row().attachments.length, 1);
  const f = await fixture(), it = f.item('b.jpg'); f.flaky(99); await f.select(it);
  assert.equal(f.counts.puts, 4, 'one try plus three automatic retries'); assert.equal(f.sd.uploadError, true); assert.equal(it.uploadFailed, true);
  assert.deepEqual(f.errors, [], 'no error toast for passing trouble: the photo carries Retry');
  f.flaky(0); await f.sd.retry(); assert.equal(f.sd.uploadError, false); assert.equal(f.row().attachments.length, 1);
});
test('a refusal from Messenger is not retried by itself', async () => {
  const f = await fixture(), it = f.item('big.pdf'); f.failPut.add(it.name); await f.select(it);
  assert.equal(f.counts.puts, 1); assert.equal(f.sd.uploadError, true);
});
test('stored, then every retry fails: the next poll adopts the stored copy by its key', async () => {
  // The box stored it, the phone never heard back and gave up (no sid, uploadFailed); then a drafts poll arrives.
  const f = await fixture(), photo = f.item('photo.jpg');
  photo.upkey = 'u-known-key-1'; photo.uploadFailed = true; f.view.attach = [photo];
  f.remoteAttachments([{id: 'stored', name: 'photo.jpg', mime: 'application/pdf', bytes: 3, key: 'u-known-key-1'}]);
  await f.sd.check(false);
  assert.equal(photo.sid, 'stored'); assert.equal(photo.uploadFailed, false); assert.equal(f.view.attach.length, 1, 'no second chip');
  assert.equal(f.sd.uploadError, false);
});

// Issue 481: attachments go up 3 at a time into one draft, and a file handed to Send keeps uploading (even after
// leaving the chat) while the draft waits for the send to take it.
test('three files go up side by side into one draft', async () => {
  const f = await fixture(null); f.slow();
  const items = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].map(f.item);
  await f.select(...items);
  assert.equal(f.counts.peak, 3, 'three uploads in flight at once');
  assert.equal(f.row().attachments.length, 4); assert.equal(f.counts.creates, 1, 'one draft for all of them');
  assert.deepEqual(items.map(it => it.draft), items.map(() => 'synthetic-draft'));
  assert.equal(new Set(items.map(it => it.sid)).size, 4);
  assert.equal(f.sd.row.revision, f.row().revision, 'the newest revision is kept, whatever order the answers came in');
  assert.equal(f.sd.uploadError, false); assert.deepEqual(f.errors, []);
});
test('a file handed to Send keeps uploading and the draft waits for the send to take it', async () => {
  const f = await fixture(), gate = f.holdPut(), it = f.item('photo.jpg'), upload = f.select(it); await gate.entered.promise;
  it.sending = true; const took = defer();
  const closing = f.sd.closeForSend('', took.promise);
  f.replaceView(); // the owner goes back to the Inbox right after Send
  gate.resolve(); await upload;
  assert.ok(it.sid, 'the draft copy finished'); assert.equal(it.draft, 'synthetic-draft');
  await tick(); await tick();
  assert.ok(f.row(), 'the draft is kept until its send has taken the file');
  took.resolve(); await closing;
  assert.equal(f.row(), null, 'then it is deleted');
});
