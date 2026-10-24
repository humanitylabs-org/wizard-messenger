'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const events = {};
const shown = [], opened = [];
let clients = [];
const context = {URL, self: {
  location: {origin: 'https://wizard.example.test'},
  addEventListener: (name, callback) => {events[name] = callback;},
  registration: {showNotification: async (...args) => {shown.push(args);}},
  clients: {matchAll: async () => clients, openWindow: async url => {opened.push(url);}}
}};
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../service-worker.js'), 'utf8'), context);
async function fire(name, overrides) {
  let pending;
  events[name]({waitUntil: promise => {pending = promise;}, ...overrides});
  await pending;
}
(async () => {
  await fire('push', {data: {json: () => ({v: 1, tag: 'a'.repeat(64), body: 'SECRET', url: 'https://evil.test/'})}});
  assert.equal(shown.length, 1);
  assert.equal(shown[0][1].body, 'You have a new message.');
  assert.ok(!JSON.stringify(shown).includes('SECRET'));
  await fire('push', {data: {json: () => ({v: 1, tag: '../evil'})}});
  await fire('push', {data: {json: () => {throw Error('invalid');}}});
  assert.equal(shown.length, 1);
  let closed = 0, focused = 0;
  const notification = {close: () => closed++, data: {url: 'https://evil.test/'}};
  clients = [{url: 'https://evil.test/apps/messenger/', focus: () => {throw Error('off origin');}},
    {url: 'https://wizard.example.test/apps/messenger/admin', focus: () => {throw Error('wrong path');}}];
  await fire('notificationclick', {notification});
  assert.equal(opened[0], 'https://wizard.example.test/apps/messenger/');
  clients = [{url: opened[0], focus: async () => {focused++;}}];
  await fire('notificationclick', {notification});
  assert.equal(closed, 2); assert.equal(focused, 1); assert.equal(opened.length, 1);
  console.log('service worker behavior: PASS (minimal content, invalid payload, origin/path, focus/open)');
})().catch(error => {console.error(error); process.exitCode = 1;});
