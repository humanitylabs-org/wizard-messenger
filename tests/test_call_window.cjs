// Issue 445 (switch calls): how the owner's own call opens (phone call window, the shell's browser route, a plain tab).
const test = require('node:test');
const assert = require('node:assert/strict');
const {callRoute, callWindowURL} = require('../static/unified.js');

test('the phone app opens a call window; a shell frame goes through the shell; a plain tab opens a window', () => {
  assert.equal(callRoute(true, true), 'phone');
  assert.equal(callRoute(true, false), 'phone');
  assert.equal(callRoute(false, true), 'shell');
  assert.equal(callRoute(false, false), 'window');
});

test('the call window asks Element Call to let the phone pick earpiece, speaker or headset', () => {
  const base = 'https://box.example.ts.net/messenger/';
  const open = 'https://box.example.ts.net/messenger/call/k/Key_1/join/#/c?roomId=%21r&password=p&confineToRoom=true&lang=en';
  assert.equal(callWindowURL(open, base), open + '&controlledAudioDevices=true');
  assert.equal(callWindowURL('call/k/K/join/', base), 'https://box.example.ts.net/messenger/call/k/K/join/#?controlledAudioDevices=true');
  assert.equal(callWindowURL('call/k/K/join/#/c', base), 'https://box.example.ts.net/messenger/call/k/K/join/#/c?controlledAudioDevices=true');
});

test('nothing but a web address becomes a call window', () => {
  const base = 'https://box.example.ts.net/messenger/';
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pw@box.example.ts.net/x', 'http://[bad']) {
    assert.equal(callWindowURL(bad, base), '', bad);
  }
});
