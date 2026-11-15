const test = require('node:test');
const assert = require('node:assert/strict');
const {chatReadNotices} = require('../static/unified.js');
// wizard-ux issue 1276: a chat read in Messenger tells Wizard which network app's notification to clear, by network
// and the names that app shows (the bridge's account label, plus the chat's own name).

test('a LINE chat names its network, the LINE name and the chat name', () => {
  assert.deepEqual(chatReadNotices({display_name: 'Mike', identities: [{network: 'line', label: 'Mike Tanaka', kind: 'person'}]}),
    [{network: 'line', names: ['Mike Tanaka', 'Mike']}]);
});

test('a merged person gives one entry per bridged network; Wizard chats give none', () => {
  assert.deepEqual(chatReadNotices({display_name: 'Ann', identities: [
    {network: 'whatsapp', label: 'Ann'}, {network: 'messenger', label: 'Ann'}, {network: 'private', label: 'x'}, {network: 'telegram', label: 'Ann B'}, {network: 'whatsapp', label: 'Ann work'}]}),
    [{network: 'whatsapp', names: ['Ann', 'Ann work']}, {network: 'telegram', names: ['Ann B', 'Ann']}]);
  assert.deepEqual(chatReadNotices({display_name: 'Me', identities: [{network: 'messenger', label: 'Me'}]}), []);
});

test('missing or odd input never throws and caps what it sends', () => {
  assert.deepEqual(chatReadNotices(null), []);
  assert.deepEqual(chatReadNotices({}), []);
  assert.deepEqual(chatReadNotices({display_name: '  ', identities: [{network: 'line', label: ''}]}), []);
  const many = {display_name: 'G', identities: ['a', 'b', 'c', 'd'].map(n => ({network: n, label: n}))};
  assert.equal(chatReadNotices(many).length, 3);
  const names = {display_name: 'x'.repeat(201), identities: Array.from({length: 12}, (_, i) => ({network: 'line', label: 'n' + i}))};
  assert.deepEqual(chatReadNotices(names)[0].names.length, 8);
  assert.ok(!chatReadNotices(names)[0].names.includes('x'.repeat(201)));
});
