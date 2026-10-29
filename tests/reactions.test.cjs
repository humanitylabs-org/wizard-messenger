// Real handler and album projection, isolated from private state and the network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(process.env.REACTION_SOURCE || __dirname + '/../static/unified.js', 'utf8');
const section = (start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
function fixture(rows) {
  const store = {threads: {a: {messages: structuredClone(rows)}, b: {messages: []}}};
  const view = {id: 'a'}, s = {person: 'a'}, requests = [], errors = [], paints = [];
  const call = (path, body) => new Promise((resolve, reject) => requests.push({path, body, resolve, reject}));
  const code = section('  function albumPosts(', '  function nearBottom(') + section('  function mergeMessages(', '  function apply(') + section(src.includes('  const reactionEdits') ? '  const reactionEdits' : '  async function react(', '  async function del(');
  const build = new Function('store', 'view', 's', 'call', 'error', 'record', 'let recent = []; const paintThread = () => record(albumPosts(store.threads[view.id].messages));' + code + '; return {react, albumPosts, mergeMessages};');
  const api = build(store, view, s, call, e => errors.push(e.message), p => paints.push(structuredClone(p)));
  return {...api, store, view, s, requests, errors, paints, post: () => api.albumPosts(store.threads.a.messages)[0]};
}
const row = (id, reactions = [], album) => ({id, reactions, album, network: 'telegram', sender: 'Fixture', identity_id: 'fixture', timestamp: 1});
const r = (key, count, mine) => ({key, count, mine});
const flush = () => new Promise(resolve => setImmediate(resolve));
for (const album of [false, true]) test(`real handler paints canonical ${album ? 'album part' : 'message'} before HTTP completes`, async () => {
  const f = fixture(album ? [row('1', [], 'album'), row('2', [r('👍', 3, true), r('😁', 2, false)], 'album')] : [row('1', [r('👍', 3, true), r('😁', 2, false)])]);
  const promise = f.react(f.post(), '😁');
  assert.deepEqual(f.post().reactions, [r('👍', 2, false), r('😁', 3, true)]);
  assert.deepEqual(f.paints[0][0].reactions, f.post().reactions);
  assert.deepEqual(f.requests[0].body, {key: '😁'});
  assert.equal(f.requests[0].path, `messages/${album ? '2' : '1'}/react`);
  const target = f.store.threads.a.messages.at(-1);
  f.requests[0].resolve({message: structuredClone(target)}); await promise;
  const toggle = f.react(f.post(), '😁');
  assert.deepEqual(f.post().reactions, [r('👍', 2, false), r('😁', 2, false)]);
  f.requests[1].resolve({message: structuredClone(f.store.threads.a.messages.at(-1))}); await toggle;
});
test('failure restores unchanged counts, including another user on chosen key', async () => {
  const before = [r('👍', 2, true), r('😁', 4, false)], f = fixture([row('1', before)]);
  const done = f.react(f.post(), '😁'); f.requests[0].reject(new Error('Fixture bridge offline')); await done;
  assert.deepEqual(f.post().reactions, before); assert.deepEqual(f.errors, ['Fixture bridge offline']);
});
test('late response stays in originating thread, never paints another thread', async () => {
  const f = fixture([row('1')]), done = f.react(f.post(), '😁');
  f.view.id = f.s.person = 'b'; f.requests[0].resolve({message: row('1', [r('😁', 1, true)])}); await done;
  assert.equal(f.store.threads.b.messages.length, 0); assert.equal(f.paints.length, 1);
  assert.deepEqual(f.store.threads.a.messages[0].reactions, [r('😁', 1, true)]);
});
test('feed cannot erase pending selection; rapid toggles are sent in order', async () => {
  const f = fixture([row('1')]); const first = f.react(f.post(), '😁'), second = f.react(f.post(), '😂');
  assert.deepEqual(f.post().reactions, [r('😂', 1, true)]); assert.equal(f.requests.length, 1);
  f.mergeMessages('a', [row('1')]); assert.deepEqual(f.post().reactions, [r('😂', 1, true)]);
  f.requests[0].resolve({message: row('1', [r('😁', 1, true)])}); await flush();
  assert.deepEqual(f.post().reactions, [r('😂', 1, true)]); assert.equal(f.requests[1].body.key, '😂');
  f.requests[1].resolve({message: row('1', [r('😂', 1, true)])}); await Promise.all([first, second]);
});
test('signout abandons queued requests and ignores stale completion', async () => {
  const f = fixture([row('1')]), first = f.react(f.post(), '😁'), second = f.react(f.post(), '😂');
  f.store.threads = {a: {messages: [row('new')]}};
  f.requests[0].resolve({message: row('1', [r('😁', 1, true)])}); await Promise.all([first, second]);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.store.threads.a.messages, [row('new')]);
});
test('expanded picker retains old choices and includes exact grinning key once', () => {
  const data = new Function(section('  const QUICK =', '  // Saved copy') + '; return [...QUICK, ...MORE];')();
  assert.equal(data.filter(k => k === '😁').length, 1); assert.equal(new Set(data).size, data.length);
  assert(data.includes('👋') && data.includes('❤️') && data.includes('😊'));
});
