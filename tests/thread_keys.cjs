'use strict';
// Synthetic production-source checks only: no browser, accounts, messages or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.MESSENGER_THREAD_SOURCE || path.join(__dirname, '../static/unified.js'), 'utf8');
const initial = source.match(/^  const store = (.+);$/m);
const resets = [...source.matchAll(/\bstore\.threads\s*=(?!=)\s*([^;]+);/g)];
const saved = source.match(/^      const threads = (.+);$/m);
assert.ok(initial && saved, 'production thread-map initialization and cache writer remain discoverable');
test('all whole-map replacement sites retain a null prototype', () => {
  assert.equal(resets.length, 1, 'every whole-map replacement must be reviewed and covered');
  for (const reset of resets) assert.equal(reset[1].trim(), 'Object.create(null)', 'a replacement must retain a null prototype');
});

for (const [name, expression] of [['initial', `(${initial[1]}).threads`], ['feed reset', resets[0][1]], ['cache writer', saved[1]]]) {
  test(`${name}: reserved chat IDs are own entries, not inherited objects`, () => {
    const context = vm.createContext({});
    const threads = vm.runInContext(`(${expression})`, context);
    assert.equal(Object.getPrototypeOf(threads), null);
    for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      assert.equal(threads[id], undefined, `${id} must not resolve before an own entry exists`);
      const row = {person: {display_name: 'Synthetic'}, messages: []};
      threads[id] = row;
      assert.equal(Object.hasOwn(threads, id), true);
      assert.equal(threads[id], row);
    }
    assert.equal(Object.getPrototypeOf(threads), null);
    const roundTrip = JSON.parse(JSON.stringify(threads));
    for (const id of Object.keys(threads)) assert.ok(Object.hasOwn(roundTrip, id));
  });
}

test('production send guard ignores an unknown reserved chat ID before preparing a send', () => {
  const begin = source.indexOf('  function queueSend(id, job) {');
  const end = source.indexOf('\n  // A send Messenger refused', begin);
  assert.ok(begin >= 0 && end > begin, 'production queueSend remains discoverable');
  const context = vm.createContext({uid() { throw new Error('unknown chat passed the send guard'); }});
  vm.runInContext(`const store = ${initial[1]};\n${source.slice(begin, end)}\nglobalThis.queueSend = queueSend; globalThis.store = store;`, context);
  // With an empty safe map the guard returns before UI, send or failure callbacks.
  // The vulnerable ordinary-object map instead resolves Object.prototype and
  // passes the guard. This tests admission, not a demonstrated pollution exploit.
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.doesNotThrow(() => context.queueSend(id, {text: 'Synthetic never sent'}));
  }
});

test('production cache restore keeps reserved IDs as data on a safe live map', () => {
  const begin = source.indexOf('  function restore() {');
  const end = source.indexOf('\n  // App badge:', begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({localStorage: {getItem() {
    return '{"lists":{"people":[]},"order":["__proto__"],"threads":{"__proto__":{"person":{"display_name":"Synthetic"},"messages":[]}}}';
  }}});
  vm.runInContext(`const CACHE_KEY = 'synthetic'; const store = ${initial[1]}; let savedOrder = [];\n${source.slice(begin, end)}\nglobalThis.restored = restore(); globalThis.store = store;`, context);
  assert.equal(context.restored, true);
  assert.equal(Object.getPrototypeOf(context.store.threads), null);
  assert.equal(Object.hasOwn(context.store.threads, '__proto__'), true);
  assert.equal(context.store.threads.__proto__.stale, true);
  assert.equal(vm.runInContext('Object.prototype.person', context), undefined);
});

test('production cache persist serializes a reserved own chat ID without changing the map prototype', () => {
  const begin = source.indexOf('  function persist() {');
  const end = source.indexOf('\n  function restore()', begin);
  assert.ok(begin >= 0 && end > begin);
  let serialized;
  const context = vm.createContext({syncBadge() {}, shareTargets() {}, clearTimeout() {}, setTimeout(fn) { fn(); },
    localStorage: {setItem(_key, value) { serialized = value; }}});
  vm.runInContext(`const store = ${initial[1]}; let saveTimer = null; const CACHE_KEY = 'synthetic', THREADS_KEPT = 40, MESSAGES_KEPT = 80;
    const savedOrder = ['__proto__']; Object.defineProperty(store.threads, '__proto__', {value: {person: {display_name: 'Synthetic'}, messages: []}, enumerable: true});
    ${source.slice(begin, end)}\npersist();`, context);
  assert.ok(serialized);
  const cache = JSON.parse(serialized);
  assert.equal(Object.hasOwn(cache.threads, '__proto__'), true);
  assert.equal(cache.threads.__proto__.person.display_name, 'Synthetic');
});
