/* Background recording in the Wizard Shell Android app (android/shell), over window.wizardDevicePort v1.
 *
 * Optional: in a browser, the PWA or the full Wizard OS app (window.WizardOSDevice) this file does nothing and the
 * orb records exactly as before. In the shell it discovers `device.recording` and offers app.js the same small
 * recorder surface the full app's bridge has (recStart/recActive/recLevel/recPause/recCancel/recDone/recPending),
 * plus two async calls app.js awaits when it needs bytes (stopTake, readTake). The take is recorded by a native
 * foreground service, so it keeps going with the screen locked or another app in front.
 *
 * Custody: the native copy is released (ack) only after the web outbox holds the audio durably (app.js recDone).
 * Takes cut short by an app kill, stopped from the notification, or cancelled after 20 s (native keeps those) are moved into the outbox
 * as held recordings (Settings → Recordings) and only then released. Nothing is ever sent without a tap: a take the
 * floating orb stopped with its second tap (`send`) goes out as a new chat, like the full app's notification Send.
 */
(() => {
  'use strict';
  if (window.WosDeviceRecording) return;
  const CAP = 'device.recording';
  const call = (method, params, timeout) => window.WosDevicePort.call(method, params, timeout);
  let ready = false, status = { id: null, state: 'idle', ms: 0, level: 0, kind: '', last: { id: '', state: '' } };
  let pendingList = [], polling = 0, lastSeenEnd = '';
  const inflight = new Set(); // takes app.js is finishing: the recovery sweep leaves them alone
  const fetched = new Map();  // id → {meta, blob} read for app.js, until the outbox has it (recDone)
  let starting = '';

  const W$ = () => window.__wos;
  const toast = (i, t, ms) => W$()?.toast?.(i, t, ms);
  const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

  async function refresh() {
    let next; try { next = await call(CAP + '.status', {}, 8000); } catch (_) { return; }
    if (!next) return;
    if (starting && next.id !== starting) return; // the native start hasn't answered yet: keep the optimistic take
    status = { ...next, kind: next.id && next.id === status.id ? status.kind : next.kind || '' };
    const last = status.last || {};
    // The notification's Stop (or a lost mic) ended the take the orb is holding.
    const w = W$(), held = w?.V?.native;
    // Native overlay/notification controls can pause while the page is hidden. Reconcile the same take,
    // rather than showing a running timer over a paused recorder when the owner returns.
    if (held && status.id === held && !inflight.has(held) && ['listen', 'paused', 'command'].includes(w.voice)) {
      const paused = status.state === 'paused';
      if (paused !== (w.voice === 'paused')) {
        w.V.acc = (w.V.nativeSegmentBase || 0) + (Number(status.ms) || 0);
        w.V.t0 = performance.now();
        w.setVoice(paused ? 'paused' : w.V.kind === 'command' ? 'command' : 'listen');
      }
    }
    if (held && status.id !== held && last.id === held && lastSeenEnd !== held && !inflight.has(held)) {
      lastSeenEnd = held;
      w.V.native = null; w.setVoice('idle'); w.txHide();
      toast('⏸', 'Recording stopped · kept in Recordings', 3200);
      sweep('stopped');
    }
    if (!status.id && !w?.V?.native) stopPolling();
  }
  function startPolling() { if (!polling) polling = setInterval(refresh, 300); }
  function stopPolling() { clearInterval(polling); polling = 0; }

  async function readTake(id, expected) {
    const parts = []; let off = 0, size = 0;
    for (let k = 0; k < 4000 && off >= 0; k++) {
      const c = await call(CAP + '.read', { id, offset: off }, 20000);
      if (!c || typeof c.b64 !== 'string' || !Number.isInteger(c.next)) throw new Error('Incomplete recording read · original kept on this phone');
      const bin = atob(c.b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      if (!u.length || (c.next !== -1 && c.next !== off + u.length)) throw new Error('Invalid recording chunk · original kept on this phone');
      parts.push(u); size += u.length; off = c.next;
    }
    if (off !== -1 || (Number(expected) > 0 && size !== Number(expected))) throw new Error('Incomplete recording · original kept on this phone');
    return new Blob(parts, { type: 'audio/aac' });
  }

  /* Takes the page is not holding (app killed mid-take, notification Stop, long Cancel): into the durable outbox
   * as held recordings, then release the native copy. Never sends. */
  let sweeping = false;
  async function sweep(why) {
    const OUTBOX = window.WosOutbox;
    if (sweeping || !ready || !OUTBOX?.recoveryComplete) return;
    sweeping = true;
    try {
      pendingList = await call(CAP + '.pending', {}, 15000) || [];
      for (const t of pendingList) {
        if (inflight.has(t.id) || W$()?.V?.native === t.id) continue;
        const owned = OUTBOX.nativeItem?.(t.id);
        if (owned?.durable) { await call(CAP + '.ack', { id: t.id }).catch(() => {}); continue; }
        const blob = await readTake(t.id, t.bytes);
        if (t.send && await sendTake(t, blob)) continue; // the floating orb's take: the owner tapped to send it
        const cid = 'native-' + t.id;
        const item = await OUTBOX.capture(blob, cid);
        const reason = t.state === 'interrupted' ? 'Interrupted recording · original kept' : t.state === 'cancelled' ? 'Cancelled recording · original kept' : 'Stopped recording · original kept';
        await OUTBOX.transition(cid, 'held', reason);
        if (item?.durable) await call(CAP + '.ack', { id: t.id });
        toast('◉', t.state === 'interrupted' ? 'A recording cut short was saved · Settings → Recordings' : 'Recording kept · Settings → Recordings', 3600);
      }
    } catch (e) { console.warn('device recording sweep (' + why + '):', e); }
    finally { sweeping = false; }
  }

  /* A take the floating orb stopped with "send": a new chat through the durable outbox (which transcribes and
   * delivers it), exactly like the full app's notification Send. False (kept as held) when no model route exists. */
  async function sendTake(t, blob) {
    const OUTBOX = window.WosOutbox;
    let route = null;
    try { route = window.WosModels?.snapshot?.('', null, '') || null; } catch (_) { route = null; }
    if (!route?.model || typeof OUTBOX?.enqueue !== 'function') return false;
    const owner = window.WizConfig?.owner?.();
    const it = await OUTBOX.enqueue({ nativeId: t.id, createdAt: Number(t.startedAt) || undefined, ...route, kind: 'new', sessionId: '', text: '', audio: blob, source: 'orb', how: 'floating-orb',
      instructions: (owner ? owner + ' recorded' : 'The owner recorded') + ' this with the floating Wizard orb on their Android phone. The original recording is attached as a voice note.' });
    if (!it?.durable) return true; // the outbox keeps it in memory and retries; native keeps its copy until durable
    await call(CAP + '.ack', { id: t.id });
    toast('✦', 'Orb recording saved · check Chats for delivery', 2400);
    return true;
  }

  /* The recorder surface app.js already uses for the full app's bridge (synchronous answers come from the cache). */
  const device = {
    version: () => 1,
    keepsLongCancels: true,
    recStart(kind) {
      if (status.id) return '';
      const id = 'take-' + Date.now() + '-' + hex(4);
      status = { ...status, id, state: 'recording', ms: 0, level: 0, kind: String(kind || 'auto') };
      inflight.delete(id); starting = id;
      startPolling();
      call(CAP + '.start', { id, kind: String(kind || 'auto') }).then(r => { if (starting === id) starting = ''; if (r?.id !== id) throw new Error('Recorder refused'); })
        .catch(e => {
          if (starting === id) starting = '';
          if (status.id === id) status = { ...status, id: null, state: 'idle' };
          const w = W$();
          if (w?.V?.native === id) { w.V.native = null; w.cancelVoice?.(true); }
          toast('!', /not allowed/.test(e.message) ? 'Allow the microphone for the Wizard app to record' : 'Microphone unavailable · nothing recorded', 3600);
        });
      return id;
    },
    recActive() { return status.id ? JSON.stringify({ id: status.id, kind: status.kind || null, ms: status.ms, paused: status.state === 'paused', source: 'shell' }) : 'null'; },
    recLevel() { return Number(status.level) || 0; },
    recPause(on) {
      const id = status.id; if (!id) return;
      status = { ...status, state: on ? 'paused' : 'recording' };
      call(CAP + '.pause', { id, on: !!on }).catch(() => {});
    },
    recCancel(id) {
      if (!id) return;
      inflight.add(id);
      if (status.id === id) status = { ...status, id: null, state: 'idle' };
      call(CAP + '.cancel', { id }).then(r => { inflight.delete(id); if (r && r.released === false) sweep('cancel'); }).catch(() => inflight.delete(id));
    },
    recDone(id) { if (id) { fetched.delete(id); call(CAP + '.ack', { id }).catch(() => {}).finally(() => inflight.delete(id)); } },
    recPending() { return JSON.stringify([...pendingList.filter(t => !fetched.has(t.id)), ...[...fetched.values()].map(f => f.meta)]); },
    recClaim() { return 'null'; },
    recStop(id) { const f = fetched.get(id); return f ? JSON.stringify(f.meta) : 'null'; },
    cancelledList: () => '[]', // long Cancels are kept natively and swept into Recordings
    /* app.js nativeFinish: stop the live take (or describe a stopped one) and read its bytes, then finish as usual. */
    async fetch(id) {
      inflight.add(id);
      try {
        const meta = await call(CAP + '.stop', { id }, 20000);
        if (status.id === id) status = { ...status, id: null, state: 'idle' };
        if (!meta?.id || meta.released) throw new Error('Nothing recorded');
        fetched.set(id, { meta: { ...meta, kind: meta.kind === 'voice' ? 'auto' : meta.kind }, blob: await readTake(id, meta.bytes) });
      } catch (e) { inflight.delete(id); throw e; }
    },
    fetched: id => fetched.get(id) || null,
  };

  async function discover() {
    if (!window.WosDevicePort?.present || window.WizardOSDevice) return;
    const c = await window.WosDevicePort.capability(CAP, 1);
    if (!c || !['start', 'stop', 'read', 'ack', 'pending', 'status'].every(m => c.methods?.includes(CAP + '.' + m))) return;
    ready = true;
    await refresh();
    // Reopened while a take kept going (page reloaded, app restored): the orb picks it back up.
    const w = W$();
    if (status.id && w && w.voice === 'idle') { startPolling(); w.nativeResume?.({ id: status.id, kind: status.kind, ms: status.ms, paused: status.state === 'paused' }); }
    const later = () => { if (window.WosOutbox?.recoveryComplete) sweep('boot'); else setTimeout(later, 1000); };
    later();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ready) { refresh(); if (W$()?.voice === 'idle') sweep('visible'); } });

  window.WosDeviceRecording = {
    get ready() { return ready; },
    collect: why => sweep(why || 'collect'),
    device: () => (ready ? device : null),
    _state: () => ({ ready, status, pending: pendingList.length, inflight: [...inflight] }),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', discover, { once: true }); else discover();
})();
