const test = require('node:test');
const assert = require('node:assert/strict');
const {draftFeedbackLine} = require('../static/unified.js');
// Issue 178: Settings > Agent access shows how the owner handled his agent's ready drafts.

test('nothing yet', () => {
  assert.equal(draftFeedbackLine(null), 'No agent drafts sent or discarded yet.');
  assert.equal(draftFeedbackLine({total: 0}), 'No agent drafts sent or discarded yet.');
});

test('counts, with bad numbers read as zero', () => {
  assert.equal(draftFeedbackLine({sent_as_drafted: 3, edited: 2, discarded: 1, total: 6}),
    'Agent drafts: 3 sent as drafted · 2 edited · 1 discarded');
  assert.equal(draftFeedbackLine({sent_as_drafted: '4', edited: -1, total: 1}),
    'Agent drafts: 0 sent as drafted · 0 edited · 0 discarded');
});
