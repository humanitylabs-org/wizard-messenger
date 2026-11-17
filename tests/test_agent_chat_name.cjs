const test = require('node:test');
const assert = require('node:assert/strict');
const {agentIdentity, agentHue, agentInk} = require('../static/unified.js');
// Issue 277 (switch agent-chat-name): the pinned Agent chat carries the owner's agent's own name and colour.

const main = {id: 'hermes', label: 'Hermes', is_default: true, appearance: {glyph: 'hat', hue: 265}};
const oscar = {id: 'oscar', label: 'Oscar', is_default: false, privacy: 'standard', appearance: {hue: 30}};
const lvl = (id, level, extra = {}) => ({id, label: id === 'hermes' ? 'Your Wizard agent' : id, level, main: id === 'hermes', last_used: 0, ...extra});

test('the agent with Draft-only access in Settings > Agents names the chat', () => {
  const who = agentIdentity([lvl('hermes', 'read_only'), lvl('oscar', 'draft_only')], [main, oscar]);
  assert.equal(who.name, 'Oscar'); assert.equal(who.id, 'oscar'); assert.equal(who.private, false);
  assert.equal(who.hue, 30);
});

test('the main agent wins when several have Draft-only, else the one used last', () => {
  const both = [lvl('hermes', 'draft_only'), lvl('oscar', 'draft_only', {last_used: 9})];
  assert.equal(agentIdentity(both, [main, oscar]).name, 'Hermes');
  const ivy = {id: 'ivy', label: 'Ivy'};
  const two = [lvl('hermes', 'read_only'), lvl('oscar', 'draft_only', {last_used: 5}), lvl('ivy', 'draft_only', {last_used: 9})];
  assert.equal(agentIdentity(two, [main, oscar, ivy]).name, 'Ivy');
});

test('with no Draft-only agent: the only agent, else the main agent', () => {
  assert.equal(agentIdentity([lvl('hermes', 'no_access')], [{...main, label: 'Oscar'}]).name, 'Oscar');
  assert.equal(agentIdentity([lvl('hermes', 'no_access')], [main, oscar]).name, 'Hermes');
});

test('Messenger\'s "hermes" is the Agent Service\'s default agent, whatever its id there', () => {
  const who = agentIdentity([lvl('hermes', 'draft_only')], [{id: 'main', label: 'Oscar', is_default: true}, {id: 'ivy', label: 'Ivy'}]);
  assert.equal(who.name, 'Oscar'); assert.equal(who.id, 'main');
});

test('no agent known keeps the word Agent (null)', () => {
  assert.equal(agentIdentity(null, null), null);
  assert.equal(agentIdentity([lvl('hermes', 'no_access')], null), null); // only the generic "Your Wizard agent"
  assert.equal(agentIdentity([], []), null);
  // Without the Agent Service, a Draft-only agent that sent its own name still names the chat.
  assert.equal(agentIdentity([lvl('oscar', 'draft_only', {label: 'Oscar'})], null).name, 'Oscar');
  assert.equal(agentIdentity([lvl('hermes', 'draft_only')], [{...main, label: '  '}]), null);
});

test('hidden agents never count, names are cleaned, private agents keep the private mark', () => {
  const who = agentIdentity([lvl('hermes', 'no_access')], [main, {...oscar, hidden: true}]);
  assert.equal(who.name, 'Hermes');
  const priv = agentIdentity([lvl('vault', 'draft_only')], [main, {id: 'vault', label: ' Vault\n agent ', privacy: 'private'}]);
  assert.equal(priv.name, 'Vault agent'); assert.equal(priv.private, true); assert.equal(priv.hue, 160);
});

test('colours match the Wizard: own hue, else stable; clashing hues step round the wheel', () => {
  assert.equal(agentHue(main, [main]), 265);
  assert.equal(agentHue({id: 'x', appearance: {hue: 270}}, [main, {id: 'x', appearance: {hue: 270}}]), (270 + 47) % 360);
  const stable = agentHue({id: 'oscar'});
  assert.equal(stable, Array.from('oscar').reduce((n, c) => (n * 31 + c.codePointAt(0)) % 360, 0));
});

test('agentInk turns the Wizard\'s HSL ink into the same colour in OKLCH', () => {
  // Checked in Chromium by painting both on a canvas: hsl(265 72% 62%) and this oklch give the same pixel (146,88,228).
  const [l, c, h] = agentInk(265);
  assert.ok(Math.abs(l - 0.595) < 0.002 && Math.abs(c - 0.2033) < 0.002 && Math.abs(h - 299.33) < 0.5, [l, c, h].join());
  assert.deepEqual(agentInk(-95), agentInk(265));
});
