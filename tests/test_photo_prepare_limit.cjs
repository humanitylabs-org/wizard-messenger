// Issue 485: picked photos are prepared at most two at a time, in pick order, and each answer comes back on its own.
const assert = require('node:assert/strict');
const {limiter} = require('../static/unified.js');

(async () => {
  const limit = limiter(2), started = [], done = [], gates = {};
  let running = 0, most = 0;
  const task = name => limit(async () => {
    started.push(name); running++; most = Math.max(most, running);
    await new Promise(r => { gates[name] = r; });
    running--; done.push(name); return name + ' ready';
  });
  const answers = ['a', 'b', 'c', 'd'].map(task);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(started, ['a', 'b'], 'two start at once, in pick order');
  // The second finishes first: its answer is there before the first one's, and the third starts in its place.
  gates.b(); assert.equal(await answers[1], 'b ready');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(started, ['a', 'b', 'c'], 'the next photo takes the free place');
  gates.a(); gates.c(); await new Promise(r => setTimeout(r, 0)); gates.d();
  assert.deepEqual(await Promise.all(answers), ['a ready', 'b ready', 'c ready', 'd ready']);
  assert.equal(most, 2, 'never more than two at a time');
  // A photo that can't be read fails alone; the queue goes on.
  const bad = limit(async () => { throw new Error('unreadable'); }), good = limit(async () => 'fine');
  await assert.rejects(bad, /unreadable/); assert.equal(await good, 'fine');
  // A task that answers synchronously works too.
  assert.equal(await limit(() => 3), 3);
  console.log('pass test_photo_prepare_limit');
})().catch(e => { console.error(e); process.exit(1); });
