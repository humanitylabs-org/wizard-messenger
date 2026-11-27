// Issue 481: what a send names for a file the composer already saved to the chat's draft.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {draftRef} = require(path.join(__dirname, '../static/unified.js'));

test('a saved photo, video or file is named by its draft attachment', () => {
  const blob = {size: 3};
  const it = {sid: '0123456789abcdef', draft: 'd'.repeat(32), blob};
  assert.equal(draftRef(it, 'image', blob), 'draft:image:0123456789abcdef');
  assert.equal(draftRef(it, 'video', blob), 'draft:video:0123456789abcdef');
  assert.equal(draftRef(it, 'file', undefined), 'draft:file:0123456789abcdef');
});

test('a file that never reached the draft, or other bytes than the draft holds, uploads from the phone', () => {
  const blob = {size: 3};
  assert.equal(draftRef({blob}, 'image', blob), null, 'no draft copy yet');
  assert.equal(draftRef({sid: '0123456789abcdef', blob}, 'image', blob), null, 'no draft id');
  assert.equal(draftRef({sid: 'file-1', draft: 'd', blob}, 'image', blob), null, 'not a box attachment id');
  // An animated GIF is saved as itself but goes into an album as its still JPEG.
  assert.equal(draftRef({sid: '0123456789abcdef', draft: 'd', blob}, 'image', {size: 2}), null);
  assert.equal(draftRef({sid: '0123456789abcdef', draft: 'd', blob}, 'voice', blob), null, 'voice notes are never drafts');
  assert.equal(draftRef(null, 'image', blob), null);
});
