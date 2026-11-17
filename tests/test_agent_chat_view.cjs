const test = require('node:test');
const assert = require('node:assert/strict');
const {agentChatRows, agentChatSnippet} = require('../static/unified.js');
// Issue 265 (switch agent-chat): what the owner's Agent chat shows, from the box's state (agent_chat.state).

const state = {unread: 1, urgent: false, entries: [
  {id: 'n1', kind: 'note', by: 'owner', text: 'Buy dog food', at: 1000, seen: {at: 1100, by: 'Oscar'}},
  {id: 'n2', kind: 'note', by: 'owner', text: 'Call mum', at: 1200, seen: null},
  {id: 'p3', kind: 'report', by: 'agent', agent: 'Oscar', text: 'Weekly stats\nFollowers +12', at: 1300, items: []},
  {id: 's4', kind: 'ask', ask: 'sweep', by: 'owner', at: 1400, seen: null, done: 'p5'},
  {id: 'p5', kind: 'sweep', by: 'agent', agent: 'Oscar', text: '', at: 1500, reply_to: 's4', items: [
    {n: 1, text: "Buddy's comment", recommendation: 'Reply with thanks', buttons: [{label: 'Yes', value: 'yes'}, {label: 'Skip', value: 'skip'}], answer: null, result: null},
    {n: 2, text: 'Dentist', buttons: [{label: 'Tue', value: 'Tue'}], answer: {label: 'Tue', value: 'Tue', at: 1600, seen: null}, result: null},
    {n: 3, text: 'Invoice', buttons: [{label: 'Pay', value: 'pay'}], answer: {label: 'Pay', value: 'pay', at: 1600, seen: 1700}, result: null},
    {n: 4, text: 'Gym', buttons: [{label: 'Cancel', value: 'cancel'}], answer: {label: 'Cancel', value: 'cancel', at: 1600, seen: 1700}, result: 'Cancelled Thursday'}]},
]};

test('notes show on the right with a tick once picked up; reports stay out of the chat', () => {
  const rows = agentChatRows(state);
  assert.deepEqual(rows.map(r => [r.id, r.side]), [['n1', 'out'], ['n2', 'out'], ['s4', 'out'], ['p5', 'in']]);
  assert.deepEqual(rows.slice(0, 3).map(r => r.ticked), [true, false, true]);
  assert.equal(rows[2].text, 'Sweep');
});

test('a sweep item is open, answered (still changeable), locked once picked up, or done', () => {
  const items = agentChatRows(state).at(-1).items;
  assert.deepEqual(items.map(i => i.state), ['open', 'answered', 'answered', 'done']);
  assert.deepEqual(items[0].buttons.map(b => b.chosen), [false, false]);
  assert.deepEqual(items[1].buttons, [{label: 'Tue', value: 'Tue', chosen: true}]);
  assert.deepEqual(items[2].buttons, []);
  assert.equal(items[2].answer, 'Pay');
  assert.equal(items[3].result, 'Cancelled Thursday');
});

test('Reports shows only reports, newest first', () => {
  const rows = agentChatRows({entries: [...state.entries, {id: 'p9', kind: 'report', by: 'agent', text: 'Later', at: 9000}]}, 'reports');
  assert.deepEqual(rows.map(r => r.id), ['p9', 'p3']);
  assert.equal(rows[1].who, 'Oscar');
  assert.equal(rows[0].who, 'Your agent');
});

test('the pinned row says what is newest', () => {
  assert.equal(agentChatSnippet(state).text, 'Sweep: 1 to answer');
  assert.equal(agentChatSnippet({entries: state.entries.slice(0, 2)}).text, 'You: Call mum');
  const ping = {urgent: true, entries: [{id: 'p1', kind: 'ping', by: 'agent', text: "Buddy's comment needs a reply", at: 5}]};
  assert.deepEqual(agentChatSnippet(ping), {text: "Buddy's comment needs a reply", at: 5, urgent: true});
  assert.equal(agentChatSnippet({entries: []}), null);
  assert.equal(agentChatSnippet(null), null);
  assert.deepEqual(agentChatRows({entries: 'nope'}), []);
});
