// Issue 445 (switch calls): the message that carries a call's join link into the chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const {callInvite} = require('../static/unified.js');

test('a join link becomes a plain message any network can carry', () => {
  assert.equal(callInvite('https://call-0a1b2c.example.org/c/AbC_d-0123456789'), 'Join my video call: https://call-0a1b2c.example.org/c/AbC_d-0123456789');
});

test('nothing else is ever sent as a call link', () => {
  for (const bad of [null, undefined, '', 'http://call.example.org/c/abc', 'https://call.example.org/k/abc/join/',
    'https://call.example.org/c/abc?x=1', 'javascript:alert(1)', 'https://user@call.example.org/c/abc']) {
    assert.equal(callInvite(bad), '', String(bad));
  }
});
