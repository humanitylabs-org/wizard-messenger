// Forward to Wizard toasts name what happened (wizard-ux issue 1745), not one "Sharing unavailable" for every receipt.
const test = require('node:test');
const assert = require('node:assert/strict');
const {forwardProblem} = require('../static/unified.js');

test('a sent forward has no problem', () => assert.equal(forwardProblem('sent'), null));
test('each receipt gets its own words, and the selection is kept', () => {
  assert.equal(forwardProblem('cancelled'), 'Share cancelled · selection kept');
  assert.match(forwardProblem('unsupported'), /^Send to Wizard can’t open in this window .* selection kept$/);
  assert.equal(forwardProblem('failed'), 'Couldn’t send to Wizard · selection kept');
  assert.equal(forwardProblem('busy'), 'Not sent to Wizard (busy) · selection kept');
  assert.equal(forwardProblem(undefined), 'Not sent to Wizard (no answer) · selection kept');
  for (const r of ['cancelled', 'unsupported', 'failed', 'odd', null]) assert.doesNotMatch(forwardProblem(r), /Sharing unavailable/);
});
