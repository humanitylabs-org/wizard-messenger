// Issue 487: a refused send's toast is one clean sentence: the error's own "Tap to retry." and full stop go.
const test = require('node:test'), assert = require('node:assert/strict');
const {sendReason} = require('../static/unified.js');

test('the upload error loses its retry advice and full stop', () => {
  assert.equal(sendReason('Upload failed. Tap to retry.') + '. Your message is back in the box.', 'Upload failed. Your message is back in the box.');
  assert.equal(sendReason('Voice note upload stalled. Tap to retry.'), 'Voice note upload stalled');
});

test('a box message ending in a full stop gives no doubled stop', () => {
  assert.equal(sendReason('This photo type is not supported.'), 'This photo type is not supported');
  assert.equal(sendReason('Photo refused by the box'), 'Photo refused by the box');
  assert.equal(sendReason('Too big...  '), 'Too big');
});

test('missing, empty or long messages give the fallback', () => {
  assert.equal(sendReason(undefined), 'Not sent');
  assert.equal(sendReason(''), 'Not sent');
  assert.equal(sendReason('Tap to retry.'), 'Not sent');
  assert.equal(sendReason('x'.repeat(80)), 'Not sent');
  assert.equal(sendReason(undefined, ''), '');
});
