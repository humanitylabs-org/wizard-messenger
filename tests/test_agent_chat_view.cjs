const test = require('node:test');
const assert = require('node:assert/strict');
const {agentChatRows, agentChatSnippet, agentReportSnippet, notificationReports, reportsUnread} = require('../static/unified.js');
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

test('the Reports chat shows only reports, oldest first like any chat, and its row names the newest', () => {
  const all = {entries: [...state.entries, {id: 'p9', kind: 'report', by: 'agent', text: 'Later\nmore', at: 9000}]};
  const rows = agentChatRows(all, 'reports');
  assert.deepEqual(rows.map(r => r.id), ['p3', 'p9']);
  assert.equal(rows[0].who, 'Oscar');
  assert.equal(rows[1].who, 'Your agent');
  assert.deepEqual(agentReportSnippet(all), {text: 'Later', at: 9000, urgent: false});
  assert.equal(agentReportSnippet({entries: state.entries.slice(0, 2)}), null);
  assert.equal(agentReportSnippet(null), null);
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

test('issue 266: a photo or voice note shows as media, and the row says what it is', () => {
  const media = {entries: [
    {id: 'n1', kind: 'note', by: 'owner', text: '', at: 10, seen: null, media: {type: 'photo', mime: 'image/png', size: 9, file: 'a'.repeat(32)}},
    {id: 'n2', kind: 'note', by: 'owner', text: '', at: 20, seen: {at: 30}, media: {type: 'voice', mime: 'audio/ogg', duration: 4200, transcript: 'Call the vet', file: 'b'.repeat(32)}},
    {id: 'n3', kind: 'note', by: 'owner', text: 'x', at: 40, seen: null, media: {type: 'svg'}}]};
  const rows = agentChatRows(media);
  assert.deepEqual(rows.map(r => r.media), [{type: 'photo', duration: null, transcript: null}, {type: 'voice', duration: 4200, transcript: 'Call the vet'}, null]);
  assert.equal(rows[1].ticked, true);
  assert.equal(agentChatSnippet({entries: media.entries.slice(0, 1)}).text, 'You: Photo');
  assert.equal(agentChatSnippet({entries: media.entries.slice(0, 2)}).text, 'You: Voice note');
});

// Issue 276: every notification also shows in Reports, read-only, by time.
const items = [
  {id: 'b', title: 'Morning Report', message: 'Three things today', time: 1700000300, link: '/morning-report/', read: false},
  {id: 'a', title: 'Sniper scan done', message: '', details: '2 new matches', time: 1700000100, link: 'https://sniper.example/r/1', read: true},
  {id: 'c', title: '', message: 'Backup finished', time: 1700000200, link: 'javascript:alert(1)'},
  {id: 'd', title: 'No time', time: 0}, null, 'x', {title: 'no id', time: 5},
];

test('notifications become read-only Reports rows: title, text, link, oldest first', () => {
  const rows = notificationReports(items, 'https://box.example');
  assert.deepEqual(rows.map(r => r.id), ['notification:a', 'notification:c', 'notification:b']);
  assert.deepEqual(rows.map(r => r.at), [1700000100000, 1700000200000, 1700000300000]);
  assert.equal(rows[0].text, 'Sniper scan done\n2 new matches');
  assert.equal(rows[1].text, 'Notification\nBackup finished');
  assert.equal(rows[2].text, 'Morning Report\nThree things today');
  assert.deepEqual(rows.map(r => r.link), ['https://sniper.example/r/1', null, 'https://box.example/morning-report/']);
  assert.ok(rows.every(r => r.side === 'in' && r.kind === 'notification' && r.who === 'Notifications'));
  assert.equal(notificationReports(items, '')[2].link, null);
  assert.equal(notificationReports([{id: 'p', title: 'x', time: 1, link: '//evil.example/'}], 'https://box.example')[0].link, null);
  assert.deepEqual(notificationReports(null), []);
});

test('Reports mixes reports and notifications by time, and its row names the newest', () => {
  const st = {entries: [{id: 'p3', kind: 'report', by: 'agent', text: 'Weekly\nstats', at: 1700000150000}]};
  const notes = notificationReports(items, 'https://box.example');
  assert.deepEqual(agentChatRows(st, 'reports', notes).map(r => r.id), ['notification:a', 'p3', 'notification:c', 'notification:b']);
  assert.deepEqual(agentReportSnippet(st, notes), {text: 'Morning Report', at: 1700000300000, urgent: false});
  assert.deepEqual(agentChatRows(st, 'reports').map(r => r.id), ['p3']);
  // The Agent chat never shows them.
  assert.deepEqual(agentChatRows(st, 'chat', notes), []);
  assert.deepEqual(agentReportSnippet(null, notes).text, 'Morning Report');
});

test('the Reports count adds notifications newer than its read mark that are still unread in Notifications', () => {
  const notes = notificationReports(items, 'https://box.example');
  assert.equal(reportsUnread({reports_unread: 1, reports_read_at: 0}, notes), 1);
  assert.equal(reportsUnread({reports_unread: 1, reports_read_at: 1700000000000}, notes), 3);
  assert.equal(reportsUnread({reports_unread: 0, reports_read_at: 1700000250000}, notes), 1);
  assert.equal(reportsUnread(null, notes), 0);
});
