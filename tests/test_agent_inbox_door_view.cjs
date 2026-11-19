const test = require('node:test');
const assert = require('node:assert/strict');
const {agentChatRows, agentChatSnippet, doorCard} = require('../static/unified.js');
// Issue 325 (switch agent-inbox-door): the box's agent inbox card as the Agent chat draws it.

const card = {schema: 'wizard.agent-sweep/1', id: 'sweep_' + 'a'.repeat(24), at: 1,
  waiting: {items: [
    {id: 'inbox_1', title: 'Electricity bill', ask: 'Pay it today?', recommendation: 'Pay now', seen: 1, confirm: false,
      options: [{token: 'pay-now'}, {token: 'wait'}, {token: 'ask-landlord'}, {token: 'skip'}, {token: 'fifth'}], default_option: 'pay-now',
      state: 'surfaced', link: '/wizard-os-home/?session=t1'},
    {id: 'inbox_2', title: 'Contract', ask: 'Send it?', recommendation: '', seen: 3, confirm: true, options: [{token: 'send'}],
      state: 'surfaced', link: '/wizard-os-home/?session=t2'},
    {id: 'inbox_3', title: 'Car service', ask: 'Book Tuesday?', options: [{token: 'yes'}], state: 'answered', answer: 'yes', link: 'javascript:alert(1)'},
  ], more: 4, link: '/wizard-os-home/?inbox=waiting'},
  done: {items: [{id: 'inbox_9', title: 'Booked the dentist', link: '/wizard-os-home/?session=d'}], more: 0, link: '/wizard-os-home/?inbox=done'},
  running: {count: 2, stale: 0, link: '/wizard-os-home/?inbox=running'}, later: {count: 0, link: '/wizard-os-home/?inbox=later'},
  parked: {count: 1, link: '/wizard-os-home/?inbox=parked'}, yes_to_all: {count: 1, skipped: 1}};

test('waiting items carry up to 4 buttons from their options; a confirm item has none', () => {
  const c = doorCard(card);
  assert.deepEqual(c.waiting.map(i => i.state), ['open', 'open', 'answered']);
  assert.deepEqual(c.waiting[0].buttons, [{label: 'Pay now', value: 'pay-now'}, {label: 'Wait', value: 'wait'},
    {label: 'Ask landlord', value: 'ask-landlord'}, {label: 'Skip', value: 'skip'}]);
  assert.equal(c.waiting[0].recommendation, 'Pay now');
  assert.deepEqual([c.waiting[1].confirm, c.waiting[1].buttons, c.waiting[1].link], [true, [], '/wizard-os-home/?session=t2']);
  assert.deepEqual([c.waiting[2].answer, c.waiting[2].buttons, c.waiting[2].link], ['Yes', [], null]);
  assert.deepEqual([c.more, c.moreLink, c.yes], [4, '/wizard-os-home/?inbox=waiting', 1]);
  assert.deepEqual(c.done, [{id: 'inbox_9', title: 'Booked the dentist', link: '/wizard-os-home/?session=d'}]);
  assert.deepEqual(c.counts.map(k => [k.label, k.count]), [['Running', 2], ['Parked', 1]]);
});

test('the card is the sweep post in the chat, and the row says how many wait', () => {
  const state = {entries: [
    {id: 's1', kind: 'ask', ask: 'sweep', by: 'owner', at: 10, seen: {at: 10, by: 'agent inbox'}, done: 'p2'},
    {id: 'p2', kind: 'sweep', by: 'agent', agent: null, text: '', link: null, items: [], card, at: 10, reply_to: 's1'}]};
  const rows = agentChatRows(state);
  assert.equal(rows[1].who, 'Your agent');
  assert.equal(rows[1].card.id, card.id);
  assert.equal(agentChatSnippet(state).text, 'Sweep: 2 to answer');
  const empty = {entries: [{...state.entries[1], card: {id: 'sweep_x', waiting: {items: []}, done: {items: []}}}]};
  assert.equal(agentChatSnippet(empty).text, 'Sweep: nothing needs you');
});

test('an agent-written sweep has no card (switch off: unchanged)', () => {
  const rows = agentChatRows({entries: [{id: 'p1', kind: 'sweep', by: 'agent', agent: 'Oscar', text: '', items: [], at: 1}]});
  assert.equal(rows[0].card, null);
});
