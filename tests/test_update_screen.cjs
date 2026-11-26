// Issue 439: during an automatic App Store update Messenger is down for minutes, and its page flipped between
// "Opening your messages…" and "Messenger is restarting…" without ever saying it was updating. The page now asks the
// App Manager (GET /wizard-os-home/store-install/_app-updates, `running`) whether this app is the one updating.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {ownAppIds, updatingNow} = require('../static/app.js');

// The ids this Messenger may have on the box: its Wizard path, its page path, and the Store id.
assert.deepEqual(ownAppIds('/messenger/', '/messenger/'), ['messenger']);
assert.deepEqual(ownAppIds('/chat-app/', '/chat-app/index.html'), ['chat-app', 'messenger']);
assert.deepEqual(ownAppIds('', '/'), ['messenger']);   // the raw app port
assert.deepEqual(ownAppIds(null, '/Bad Path/'), ['messenger']);

const ids = ownAppIds('/messenger/', '/messenger/');
const running = step => ({app_mode: 'auto', running: [{app: 'messenger', from: 173, to: 174, to_version: '0.2.0-unified.16.125', step, started: 1, by: 'app-updates'}]});
for (const step of ['preparing', 'updating', 'checking', 'rolling back', 'installing']) assert.equal(updatingNow(running(step), ids), true, step);
assert.equal(updatingNow({running: [{app: 'wizard-calendar', step: 'updating'}]}, ids), false, 'another app updating is not this one');
assert.equal(updatingNow({running: []}, ids), false);
assert.equal(updatingNow({}, ids), false, 'an older App Manager without `running`');
assert.equal(updatingNow(null, ids), false);
assert.equal(updatingNow({running: [null, {app: 5}]}, ids), false);

// The boot loop uses it: an update keeps one steady screen with the spinner and never drops to the Try again card.
const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
assert.match(app, /UPDATING_TEXT = 'Messenger is updating · back in a moment'/);
assert.match(app, /fetch\('\/wizard-os-home\/store-install\/_app-updates'/);
assert.match(app, /if \(updating \|\| bootTries <= 40\)/, 'an update never shows the Try again card');
assert.match(app, /\(state\.retrying && state\.mode === 'opening'\)/, 'the spinner stays on between retries');
console.log('ok test_update_screen');
