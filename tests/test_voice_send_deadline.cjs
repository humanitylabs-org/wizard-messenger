// Issue 273: a voice note whose archive or upload stalls must turn into the Retry bubble after a bounded wait, and
// later messages to the same person must not stay held behind it.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../static/unified.js'), 'utf8');
const {voiceDeadline, withDeadline, sendReason} = require('../static/unified.js');
const queue = source.slice(source.indexOf('  async function archiveVoiceOriginal('), source.indexOf('  // A send Messenger refused'));
assert.ok(queue.includes('function queueSend('), 'queue slice found');

function sandbox(stall) {
  const sizes = [], fetched = [], sent = [];
  const hang = (url, signal) => new Promise((_, no) => {
    fetched.push({url, hung: true, aborted: false});
    const entry = fetched.at(-1);
    signal?.addEventListener('abort', () => { entry.aborted = true; no(new DOMException('aborted', 'AbortError')); });
  });
  const fetch = async (url, options = {}) => {
    if (stall.test(url)) return hang(url, options.signal);
    fetched.push({url, hung: false});
    if (url.startsWith('api/view/voice-original?')) return new Response(JSON.stringify({ok: true, result: {id: 'orig1'}}));
    if (url.startsWith('api/view/voice-original/')) return new Response(new Uint8Array([1, 2, 3, 4]));
    if (url.includes('/upload?kind=voice')) return new Response(JSON.stringify({ok: true, result: {upload_id: 'up1'}}));
    throw new Error('unexpected ' + url);
  };
  const store = {threads: {p1: {person: {identities: [{network: 'telegram'}]}, messages: []}}, pending: 0};
  const ctx = vm.createContext({
    fetch, Response, Blob, Uint8Array, URLSearchParams, DOMException, AbortController, Promise, Error, TypeError, Math, Date, String,
    setTimeout, clearTimeout, encodeURIComponent, console,
    csrf: () => 'token', uid: () => Math.random().toString(36).slice(2), hold() {}, paintThread() {}, mergeMessages() {},
    toast() {}, saveVoiceRecording() {}, toOggOpus: async b => b,
    WizardApp: {capture: {ack: async () => {}}},
    call: async (p, body) => { sent.push(body); return {}; },
    store, s: {person: 'p1'},
    withDeadline, sendReason,
    // The real sizing is checked below; here every step gets 40 ms so the test runs fast.
    voiceDeadline: (...a) => { sizes.push(voiceDeadline(...a)); return 40; },
  });
  vm.runInContext(queue + '\nglobalThis.queueSend = queueSend; globalThis.queues = queues;', ctx);
  return {ctx, store, sizes, fetched, sent};
}

const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' still on the clock after ' + ms + ' ms')), ms))]);

(async () => {
  // Sizing: one minute floor, longer for bigger and longer takes, never over ten minutes.
  assert.equal(voiceDeadline(0, 0), 60000);
  assert.ok(voiceDeadline(2.6e6, 165000) > voiceDeadline(700e3, 165000), 'bigger take gets longer');
  assert.ok(voiceDeadline(2.6e6, 165000) >= 120000, 'a 2:45 phone take gets at least two minutes to upload and convert');
  assert.equal(voiceDeadline(1e9, 3600000), 600000);

  // withDeadline aborts the work's signal and rejects with the message.
  let aborted = false;
  await assert.rejects(withDeadline(signal => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })), 20, 'too slow'),
    e => e.message === 'too slow' && e.code === 'voice_timeout');
  assert.ok(aborted, 'stalled request is aborted');
  assert.equal(await withDeadline(async () => 'ok', 1000, 'x'), 'ok');

  for (const [name, stall] of [['upload', /\/upload\?kind=voice/], ['archive', /^api\/view\/voice-original\?/], ['readback', /^api\/view\/voice-original\//]]) {
    const {ctx, store, sizes, fetched, sent} = sandbox(stall);
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'audio/ogg'});
    ctx.queueSend('p1', {voice: {blob, take: 't1', duration: 165000, waveform: [], url: 'blob:x'}});
    ctx.queueSend('p1', {text: 'after the voice note'});
    await within(ctx.queues.p1, 2000, name + ' stall');
    const [voice, text] = store.threads.p1.messages;
    assert.equal(voice.pending, false, name + ': voice bubble left the clock');
    // The bubble reads 'Not sent · <reason> · Retry'; issue 487: the reason carries no second 'Tap to retry.'.
    assert.match(String(voice.failed), /^Voice note [^.]+$/, name + ': voice bubble names the stall, then shows Retry');
    assert.equal(typeof voice.retry, 'function');
    assert.ok(fetched.some(f => f.hung && f.aborted), name + ': stalled request was aborted');
    assert.ok(!text.failed, name + ': later message did not fail');
    assert.deepEqual(sent.map(b => b.text), ['after the voice note'], name + ': only the later text was sent');
    assert.equal(store.pending, 0);
    assert.ok(sizes.length >= 1 && sizes.every(ms => ms >= 60000 && ms <= 600000));
  }

  // A healthy voice note still goes through all three steps and sends.
  const {ctx, store, sent} = sandbox(/^$/);
  ctx.queueSend('p1', {voice: {blob: new Blob([new Uint8Array([1, 2, 3, 4])]), take: 't2', duration: 1000, waveform: [], url: 'blob:y'}});
  await within(ctx.queues.p1, 2000, 'healthy note');
  assert.equal(store.threads.p1.messages[0].failed, false);
  assert.equal(sent[0].upload_id, 'up1');
  console.log('voice send deadline: ok');
})().catch(e => { console.error(e); process.exitCode = 1; });
