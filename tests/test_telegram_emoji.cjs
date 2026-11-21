const test = require('node:test');
const assert = require('node:assert/strict');
const {emojiToneKey, emojiTones, emojiUsage, emojiRanked, emojiDelete, emojiPanelHeight, EMOJI_CATEGORY_ICONS} = require('../static/unified.js');
// Issue 349 (switch telegram-emoji): the pure parts of the Telegram-style emoji panel.

test('emoji that take one skin tone get six choices, plain first', () => {
  assert.deepEqual(emojiTones('👍'), ['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿']);
  // The variation selector makes way for the tone (☝️ -> ☝🏽), and a ZWJ sequence keeps its tail.
  assert.equal(emojiTones('☝️')[3], '☝🏽');
  assert.equal(emojiTones('🏃‍♀️')[3], '🏃🏽‍♀️');
  // A toned emoji gives the same six (Recent holds toned ones).
  assert.deepEqual(emojiTones('👍🏽'), emojiTones('👍'));
  // No tones: things, faces, flags, several people.
  for (const k of ['😀', '❤️', '🏁', '🇳🇱', '👨‍👩‍👧', '🍔']) assert.equal(emojiTones(k), null, k);
});

test('one tone key for every tone of an emoji', () => {
  assert.equal(emojiToneKey('👍🏽'), emojiToneKey('👍'));
  assert.equal(emojiToneKey('☝🏽'), emojiToneKey('☝️'));
  assert.notEqual(emojiToneKey('👍'), emojiToneKey('👎'));
});

test('Recent ranks by how often and how recently, one entry per emoji', () => {
  const day = 864e5, t0 = 1_800_000_000_000;
  let u = {};
  for (let i = 0; i < 5; i++) u = emojiUsage(u, '😂', t0 + i);
  u = emojiUsage(u, '🔥', t0 + 10);
  // Five uses beat one newer use...
  assert.deepEqual(emojiRanked(u, t0 + 20), ['😂', '🔥']);
  // ...but weeks later a fresh favourite overtakes an old one.
  let later = u; for (let i = 0; i < 3; i++) later = emojiUsage(later, '🔥', t0 + 28 * day + i);
  assert.deepEqual(emojiRanked(later, t0 + 28 * day + 10), ['🔥', '😂']);
  // Picking another tone moves the emoji's score to the new tone.
  let tones = emojiUsage(emojiUsage({}, '👍', t0), '👍', t0 + 1);
  tones = emojiUsage(tones, '👍🏽', t0 + 2);
  assert.deepEqual(Object.keys(tones), ['👍🏽']);
  assert.ok(tones['👍🏽'].s > 2.9);
  // Bounded, and n limits the row.
  let many = {}; for (let i = 0; i < 100; i++) many = emojiUsage(many, String.fromCodePoint(0x1F600 + i), t0 + i);
  assert.equal(Object.keys(many).length, 60);
  assert.equal(emojiRanked(many, t0 + 200, 27).length, 27);
  // Junk in storage is ignored.
  assert.deepEqual(emojiRanked({'x': null, '': {s: 1, t: 1}, '🙂': {s: 'a', t: 1}, '😀': {s: 1, t: t0}}, t0), ['😀']);
  assert.deepEqual(emojiRanked(null, t0), []);
});

test('the delete key removes one whole emoji or letter before the caret, or the selection', () => {
  assert.deepEqual(emojiDelete('😀😀', 4, 4), {value: '😀', at: 2});
  assert.deepEqual(emojiDelete('hi 👍🏽', 7, 7), {value: 'hi ', at: 3});
  assert.deepEqual(emojiDelete('a🇳🇱b', 5, 5), {value: 'ab', at: 1});
  assert.deepEqual(emojiDelete('👨‍👩‍👧', 8, 8), {value: '', at: 0});
  assert.deepEqual(emojiDelete('abc', 1, 1), {value: 'bc', at: 0});
  assert.deepEqual(emojiDelete('abc', 0, 0), {value: 'abc', at: 0});
  assert.deepEqual(emojiDelete('abcdef', 1, 4), {value: 'aef', at: 1});
  // No caret known: from the end.
  assert.deepEqual(emojiDelete('ab😀', null, null), {value: 'ab', at: 2});
});

test('the panel takes a believable keyboard height, else keeps its own', () => {
  assert.equal(emojiPanelHeight(301.4, 844), 301);
  assert.equal(emojiPanelHeight(0, 844), 0);
  assert.equal(emojiPanelHeight(80, 844), 0); // a toolbar, not a keyboard
  assert.equal(emojiPanelHeight(700, 844), 0); // more than most of the screen
  assert.equal(emojiPanelHeight(undefined, 844), 0);
  assert.equal(emojiPanelHeight(300, 0), 0);
});

test('the category bar follows Telegram', () => {
  assert.deepEqual(Object.values(EMOJI_CATEGORY_ICONS), ['🕘', '😀', '🐻', '🍔', '⚽', '🚗', '💡', '🔣', '🏁']);
  assert.equal(EMOJI_CATEGORY_ICONS.Flags, '🏁');
});
