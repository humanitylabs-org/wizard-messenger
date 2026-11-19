// Issue 326: a restart error's message was the bare code (APIError did super(message || code)), and unified.js
// prints e.message as is, so the red notice line read "server_restarting". Now an error with no server sentence
// carries the plain words for its code; a server's own sentence is kept.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
const cls = app.slice(app.indexOf('  class APIError'), app.indexOf('  // Reads ride out a restarting server'));
const words = app.slice(app.indexOf('  function friendly('), app.indexOf('  function eraseView('));
assert.ok(cls.includes('class APIError') && words.includes('function friendly'), 'APIError and friendly() are found');
const context = vm.createContext({state: {mode: 'ready'}});
vm.runInContext(cls + words + '\nthis.APIError = APIError;', context);
const {APIError} = context;

const restarting = new APIError('server_restarting', 502);
assert.equal(restarting.message, 'Messenger is restarting. Try again in a moment.');
assert.equal(restarting.code, 'server_restarting');
assert.equal(restarting.status, 502);
assert.doesNotMatch(new APIError('request_failed', 500).message, /^request_failed$/);
assert.equal(new APIError('not_found', 404, 'That chat is gone.').message, 'That chat is gone.');

// unified.js: background work stays quiet on a restart, an owner's action shows the sentence, and the line clears
// itself on the next answer. Other errors keep their words and are not cleared.
const unified = fs.readFileSync(path.join(__dirname, '..', 'static', 'unified.js'), 'utf8');
const part = unified.slice(unified.indexOf('  const RESTARTING ='), unified.indexOf('  // Issue 251: Catch me up'));
assert.ok(part.includes('clearRestartNotice'), 'restart notice helpers are found');
const box = {textContent: ''};
const ui = vm.createContext({errorBox: () => box});
vm.runInContext(part + '\nthis.error = error; this.clear = clearRestartNotice;', ui);
const down = new APIError('server_restarting', 502);
ui.error(down, true);
assert.equal(box.textContent, '', 'a background read stays quiet');
ui.error(down);
assert.equal(box.textContent, 'Messenger is restarting. Try again in a moment.');
ui.error(vm.runInContext("new TypeError('Failed to fetch')", ui));
assert.equal(box.textContent, 'Messenger is restarting. Try again in a moment.', 'a dropped connection reads the same');
ui.clear();
assert.equal(box.textContent, '', 'cleared once Messenger answers');
ui.error(new APIError('not_found', 404, 'That chat is gone.'));
ui.clear();
assert.equal(box.textContent, 'That chat is gone.', 'other errors stay until replaced');
console.log('ok test_restart_words');
