// Issue 409: Messenger keeps its Inbox row (and never uses the window title bar) on the desktop shell.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {desktopShell} = require('../static/unified.js');

test('the Wizard page says which shell it is', () => {
  assert.equal(desktopShell('desktop', true, 400), true, 'a touch laptop on the desktop shell is desktop');
  assert.equal(desktopShell('phone', false, 1200), false, 'the phone shell is a phone, whatever the screen');
});
test('without a shell answer, a phone is a touch-first device with a small screen', () => {
  assert.equal(desktopShell('', true, 412), false);
  assert.equal(desktopShell('', true, 768), true, 'a tablet keeps the desktop Inbox row');
  assert.equal(desktopShell('', false, 412), true, 'a mouse means desktop');
  assert.equal(desktopShell(undefined, false, 1080), true);
  assert.equal(desktopShell('', true, 0), true, 'no screen size: desktop, the safe side (the Inbox row always works)');
});
