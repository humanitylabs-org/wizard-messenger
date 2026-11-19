// Issue 288: Create address in the Mac window showed "Couldn't connect. Try again when your Wizard is reachable."
// The Wizard had answered (origin_forbidden), but every code the view had no words for fell through to that line.
// Now only a request that never got an answer says so; known codes get plain words, any other shows its code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
const start = source.indexOf('  function friendly(');
const end = source.indexOf('  function eraseView(');
assert.ok(start > 0 && end > start, 'friendly() is found in app.js');
const context = vm.createContext({state: {mode: 'setup_required'}});
vm.runInContext(source.slice(start, end) + '\nthis.friendly = friendly;', context);
const {friendly} = context;

class APIError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
const reachable = "Couldn't connect. Try again when your Wizard is reachable.";

// The answers that used to read "Couldn't connect".
for (const code of ['origin_forbidden', 'csrf_forbidden', 'engine_start_failed', 'engine_unavailable', 'vault_unavailable', 'relock_required']) {
  const text = friendly(new APIError(code, 403));
  assert.notEqual(text, reachable, code);
  assert.doesNotMatch(text, /reachable/, code);
}
// An answer with no words of its own names its code, so a screenshot tells what happened.
assert.equal(friendly(new APIError('something_new', 500)), "Messenger couldn't finish this. Try again. (something_new)");
assert.equal(friendly(new APIError('<b>x</b> y', 500)), "Messenger couldn't finish this. Try again. (bxby)");
// Only a request that never reached Messenger (fetch's TypeError) is about reaching the Wizard.
assert.equal(friendly(vm.runInContext("new TypeError('Failed to fetch')", context)), reachable);
// Codes that already had words keep them.
assert.equal(friendly(new APIError('marmot_operation_failed', 502)), "Messenger couldn't reach its chat servers. Check this Wizard's internet connection and try again.");
assert.equal(friendly(new APIError('vault_unlock_failed', 401)), "That passphrase isn't right.");
console.log('ok test_setup_error_words');
