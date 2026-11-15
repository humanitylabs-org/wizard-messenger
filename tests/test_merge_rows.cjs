const test = require('node:test');
const assert = require('node:assert/strict');
const {mergeRows} = require('../static/unified.js');
// Issue 228: a PDF with a caption went out as two sent messages, yet a third bubble (the PDF and caption together)
// stayed on the pending clock. Live sync had already delivered the file row (no client id yet) before the send
// answered, so the answer replaced the synced row and left the pending bubble in the thread.

const pending = {id: 'pending:wabc12345', client_id: 'wabc12345', outgoing: true, pending: true, original: "oscar's report",
  msgtype: 'm.file', timestamp: 3000, media: {filename: 'report.pdf'}};
const fileRow = (extra = {}) => ({id: '$file', outgoing: true, original: '', msgtype: 'm.file', timestamp: 2000, media: {filename: 'report.pdf'}, ...extra});
const captionRow = (extra = {}) => ({id: '$caption', outgoing: true, original: "oscar's report", msgtype: 'm.text', timestamp: 2001, ...extra});
const before = () => [{id: '$old', original: 'hi', timestamp: 1000}];

test('the send answer clears the pending bubble when sync delivered the file first', () => {
  const messages = [...before(), {...pending}];
  mergeRows(messages, [fileRow()], false); // live sync: the file row, no client id yet
  assert.equal(messages.length, 3);
  mergeRows(messages, [fileRow({client_id: 'wabc12345'}), captionRow({client_id: 'wabc12345.caption'})], false); // the send answer
  assert.deepEqual(messages.map(m => m.id), ['$old', '$file', '$caption']);
  assert.ok(!messages.some(m => m.pending));
});

test('sync rows arriving after the send answer add nothing', () => {
  const messages = [...before(), {...pending}];
  mergeRows(messages, [fileRow({client_id: 'wabc12345'}), captionRow({client_id: 'wabc12345.caption'})], false);
  mergeRows(messages, [fileRow(), captionRow()], false);
  assert.deepEqual(messages.map(m => m.id), ['$old', '$file', '$caption']);
});

test('a plain send still swaps its pending bubble and keeps the local preview', () => {
  const messages = [...before(), {...pending, msgtype: 'm.image', local: 'blob:photo'}];
  mergeRows(messages, [{id: '$photo', client_id: 'wabc12345', outgoing: true, msgtype: 'm.image', timestamp: 2000}], false);
  assert.deepEqual(messages.map(m => m.id), ['$old', '$photo']);
  assert.equal(messages[1].local, 'blob:photo');
});

test('older rows outside a partial thread stay out', () => {
  const messages = [{id: '$a', timestamp: 5000}];
  mergeRows(messages, [{id: '$z', timestamp: 10}], true);
  assert.deepEqual(messages.map(m => m.id), ['$a']);
});
