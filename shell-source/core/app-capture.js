/* Shared durable capture resource v1. Load in the shell (or the standalone client),
 * never in each hosted frame. No navigation/unload handler cancels a capture.
 * ack is a task's explicit assertion of durable backend readback, not upload initiation.
 */
(function (W) {
  'use strict';
  // SAME file also serves its worklet under script-src 'self': no blob/eval.
  if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
    class CapturePCM extends AudioWorkletProcessor {
    constructor() { super(); this.buf=new Int16Array(4000); this.len=0; this.acc=0; this.n=0; this.pos=0;
      this.port.onmessage=e=>{if(e.data==='flush')this.emit(true);}; }
    emit(final) { const out=this.buf.slice(0,this.len); this.port.postMessage({samples:out,final},[out.buffer]); this.len=0; }
    process(inputs) { const a=inputs[0]; if(!a?.[0])return true;
      for(let i=0;i<a[0].length;i++){let x=0;for(const c of a)x+=c[i];this.acc+=x/a.length;this.n++;this.pos++;
        if(this.pos>=sampleRate/16000){this.pos-=sampleRate/16000;const v=Math.max(-1,Math.min(1,this.acc/this.n));this.acc=0;this.n=0;
          this.buf[this.len++]=v<0?v*32768:v*32767;if(this.len===4000)this.emit(false);}}return true;}}
    registerProcessor('wizard-capture-pcm',CapturePCM);
    return;
  }
  if (W.WizAppCapture || W.parent !== W) return; // Hosted frames never own a second resource.
  const WORKLET_URL = W.document?.currentScript?.src || Array.from(W.document?.scripts || []).find(s => /\/app-capture\.js(?:[?#]|$)/.test(s.src))?.src;
  const DB_NAME = 'wizard-app-capture-v1', LOCK = DB_NAME + ':microphone';
  const MAX_CHUNK = 1024 * 1024, DEFAULT_LIMIT = 512 * 1024 * 1024;
  let dbPromise, active = null, configuredNative = null, attachedMeetingBridge = null, recoveryError = null, unknownMeetingActive = false;
  const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);
  const safeCall = (fn, ...args) => { try { fn?.(...args); } catch (_) { /* observer cannot break capture */ } };
  let ownershipLoaded = false;
  const ownedRows = new Map(), recoveryLive = new Set(), preparations = new Map();
  const memoryTakes = new Map(); // stopped instant results awaiting the app's handoff acknowledgement
  function state() {
    const deviceRows = [...ownedRows.values()].filter(r => r.native === 'wizard-device');
    const nativeDeviceTakeIds = [...new Set(deviceRows.map(r => r.nativeId).filter(Boolean))];
    let live = [...recoveryLive].map(id => ownedRows.get(id)).find(Boolean), unknownNative = false;
    try {
      const a = JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null');
      live ||= deviceRows.find(r => r.nativeId && r.nativeId === a?.id);
      if(a?.id && !live) {
        const inPageVoice=W.__wos?.V?.native===a.id && !['idle',undefined].includes(W.__wos?.voice);
        const savedVoice=!a.kind && (!!W.WosModels?.voiceRoute?.(a.id) || !!W.__wosVoiceTake?.(a.id) || !!W.__wosReplyTake?.(a.id)); // Positive persisted legacy voice provenance on older ABIs.
        if(!['auto','command','dictation'].includes(a.kind) && !inPageVoice && !savedVoice){unknownNative=true;live=deviceRows.find(r=>!r.nativeId);}
      }
    } catch (_) { unknownNative=true; } // Malformed/unknown bridge truth never authorizes voice/reload.
    const recording = !!active || !!live || unknownNative || unknownMeetingActive;
    return { version: 1, active: !!active, recording,
      appId: active?.row.appId || live?.appId || null, id: active?.row.id || live?.id || null,
      phase: active?.phase || (live ? 'recoverable' : 'idle'), native: !!active?.row.native || !!live,
      hold: recording || preparations.size > 0 || [...ownedRows.values()].some(r=>r.native && !r.nativeId && r.status==='recoverable'),
      // Registry readiness is separate from recorder classification: explicit recovery may inspect an unknown ABI.
      nativeRegistryReady: ownershipLoaded && !deviceRows.some(r => !r.nativeId) && preparations.size === 0 &&
        !(active?.row.native === 'wizard-device' && !active.row.nativeId),
      nativeOwnershipReady: ownershipLoaded && !unknownNative && !deviceRows.some(r => !r.nativeId) &&
        !(active?.row.native === 'wizard-device' && !active.row.nativeId), nativeDeviceTakeIds,
      voiceBorrow: active?.borrow ? { ...active.borrow } : null,
      meetingId: active?.row.kind === 'meeting' ? active.row.meta.meetingId : live?.kind === 'meeting' ? live.meta.meetingId : null,
      error: active?.error?.code || recoveryError?.code || null };
  }
  function changed() { W.dispatchEvent(new CustomEvent('wizard-app-capture-state', { detail: state() })); }
  // Diagnostics are codes only: never include a browser's arbitrary error message/content.
  function storageFailure(e) {
    const detail = /^(timeout|blocked|unavailable|QuotaExceededError|InvalidStateError|UnknownError|AbortError|NotFoundError|VersionError|SecurityError)$/.test(e?.detail) ? e.detail : (/^(QuotaExceededError|InvalidStateError|UnknownError|AbortError|NotFoundError|VersionError|SecurityError)$/.test(e?.name) ? e.name : 'UnknownError');
    return fail('storage_failed', 'On-device audio storage failed (' + detail + ').', { detail });
  }
  function bounded(work, ms = 1500, code = 'storage_failed') {
    let timer;
    return Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(code, code === 'storage_failed' ? 'On-device audio storage timed out (timeout).' : code === 'recovery_timeout' ? 'Recorder recovery timed out. Your audio is kept (RECOVERY_TIMEOUT).' : 'Audio stop timed out; the take is kept. Retry Send or Discard.', { detail: 'timeout' })), ms);
    })]).finally(() => clearTimeout(timer));
  }
  // Use the existing append-only private diagnostics collector (no backend/APK restart).
  // Build every field here: never forward exceptions, rows, blobs, metadata or lock client IDs.
  function storageDiagnostic(operation, error, started, info = {}) {
    try {
      if (!W.WizardOSNative || typeof W.fetch !== 'function') return;
      const code = error ? storageFailure(error).detail : 'ok';
      const mode = ['readonly', 'readwrite'].includes(info.mode) ? info.mode : null;
      const phase = ['lock', 'rows', 'native_status', 'native_recover', 'save', 'complete'].includes(info.phase) ? info.phase : null;
      const key = [operation, code, mode, phase].join(':');
      const seen = storageDiagnostic.seen ||= new Set();
      if (seen.has(key) || seen.size >= 24) return;
      seen.add(key);
      const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      const result = { db: DB_NAME, requestedVersion: 1, code, mode, phase,
        elapsedMs: number(Math.max(0, Math.round(Date.now() - started))), blocked: info.blocked === true,
        oldVersion: number(info.oldVersion), newVersion: number(info.newVersion), actualVersion: number(info.actualVersion),
        sessionCount: number(info.sessionCount) };
      // These are aggregate control metadata only. A hung estimate/query must not delay the report.
      const metadata = Promise.allSettled([
        Promise.resolve().then(() => navigator.storage?.estimate?.()).then(v => {
          result.quota = number(v?.quota); result.usage = number(v?.usage);
        }),
        Promise.resolve().then(() => W.indexedDB?.databases?.()).then(list => {
          const db = list?.find(v => v.name === DB_NAME); if (db) result.actualVersion = number(db.version);
        }),
        Promise.resolve().then(() => navigator.locks?.query?.()).then(v => {
          if (v) { result.heldLocks = v.held?.filter(l => l.name === LOCK).length || 0;
            result.pendingLocks = v.pending?.filter(l => l.name === LOCK).length || 0; }
        })
      ]);
      let timer;
      void Promise.race([metadata, new Promise(resolve => { timer = setTimeout(resolve, 300); })]).then(() => {
        clearTimeout(timer);
        let platform = ''; try { platform = W.WizardOSNative.platform?.() || ''; } catch (_) {}
        const version = /^android:([0-9]+\.[0-9]+\.[0-9]+)$/.exec(platform)?.[1];
        const model = /\b(SM-[A-Z0-9-]{1,20})\b/.exec(navigator.userAgent || '')?.[1] || 'Android-WebView';
        const payload = { schema: 1, session: { id: 'web-storage', model, ...(version ? { appVersion: version } : {}) },
          events: [{ method: 'storage.' + operation, data: { result } }] };
        return W.fetch('/wizard-os-home/api/diagnostics/scroll-capture', { method: 'POST', credentials: 'same-origin',
          redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          signal: AbortSignal.timeout(3000), keepalive: true });
      }).catch(() => {}); // Diagnostics never alter capture custody or admission.
    } catch (_) {}
  }
  function openDB() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const started = Date.now(), info = { blocked: false };
      if (!W.indexedDB) { const e = fail('storage_unavailable', 'Durable capture storage is unavailable.', { detail: 'unavailable' }); storageDiagnostic('open', e, started, info); return reject(e); }
      let settled = false, req;
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        storageDiagnostic('open', error, started, { ...info, actualVersion: db?.version });
        if (error) reject(storageFailure(error)); else resolve(db);
      };
      const timer = setTimeout(() => finish({ detail: 'timeout' }), 1500);
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { finish(e); return; }
      req.onupgradeneeded = e => {
        info.oldVersion = e.oldVersion; info.newVersion = e.newVersion;
        if (settled) { req.transaction?.abort(); return; }
        req.result.createObjectStore('sessions', { keyPath: 'id' });
        req.result.createObjectStore('chunks', { keyPath: ['id', 'seq'] }).createIndex('id', 'id');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        finish(null, db);
      };
      req.onerror = () => finish(req.error);
      req.onblocked = e => { info.blocked = true; info.oldVersion = e.oldVersion; info.newVersion = e.newVersion; finish({ detail: 'blocked' }); };
    });
    const opening = dbPromise;
    opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
    return opening;
  }
  async function transaction(stores, mode, work) {
    const db = await openDB(), started = Date.now();
    return new Promise((resolve, reject) => {
      let tx, settled = false, timer;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        // Report failures and the first successful write only, not every audio chunk/read.
        if (error || mode === 'readwrite') storageDiagnostic('transaction', error, started, { mode, actualVersion: db.version });
        if (error) reject(error); else resolve(result);
      };
      let result;
      try { tx = db.transaction(stores, mode); } catch (e) { finish(e); return; }
      timer = setTimeout(() => { finish(fail('storage_failed', 'On-device audio storage timed out (timeout).', { detail: 'timeout' })); try { tx.abort(); } catch (_) {} }, 1500);
      tx.oncomplete = () => finish();
      tx.onerror = tx.onabort = () => finish(tx.error || fail('storage_failed', 'Capture could not be saved.'));
      try { result = work(tx); } catch (e) { finish(e); try { tx.abort(); } catch (_) {} }
    });
  }
  async function rows() {
    let values;
    await transaction(['sessions'], 'readonly', tx => {
      tx.objectStore('sessions').getAll().onsuccess = e => { values = e.target.result; };
    });
    return values;
  }
  const put = async row => { await transaction(['sessions'], 'readwrite', tx => tx.objectStore('sessions').put(row));
    ownedRows.set(row.id, structuredClone(row)); changed(); channel?.postMessage('changed'); };
  async function parts(id, source = 'me') {
    let values;
    await transaction(['chunks'], 'readonly', tx => {
      tx.objectStore('chunks').index('id').getAll(id).onsuccess = e => { values = e.target.result; };
    });
    return values.filter(c => (c.source || 'me') === source).sort((a, b) => a.seq - b.seq).map(c => c.blob);
  }
  async function remove(id) {
    await transaction(['sessions', 'chunks'], 'readwrite', tx => {
      tx.objectStore('sessions').delete(id);
      const req = tx.objectStore('chunks').index('id').openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
    });
    ownedRows.delete(id); recoveryLive.delete(id); changed(); channel?.postMessage('changed');
  }
  function validate(appId, opts) {
    if (typeof appId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId)) throw fail('invalid_app', 'Invalid capture owner.');
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw fail('invalid_options', 'Invalid capture options.');
    for (const key of ['chunkMs', 'maxMs', 'maxBytes']) {
      if (opts[key] != null && (!Number.isFinite(opts[key]) || opts[key] <= 0)) throw fail('invalid_options', key + ' must be positive.');
    }
    if (opts.meta != null && (typeof opts.meta !== 'object' || Array.isArray(opts.meta))) throw fail('invalid_options', 'Capture metadata must be an object.');
    if (['auto', 'command', 'dictation'].includes(opts.kind)) throw fail('reserved_kind', 'Wizard voice owns this capture kind.');
    const meta = JSON.parse(JSON.stringify(opts.meta || {}));
    if (JSON.stringify(meta).length > 16384) throw fail('invalid_options', 'Capture metadata is too large.');
    return meta;
  }
  async function acquire(wait = false) {
    if (!navigator.locks) throw fail('capture_lock_unavailable', 'This browser cannot safely arbitrate the microphone.');
    let release;
    const held = new Promise(resolve => { release = resolve; });
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      const timer = wait ? setTimeout(() => abort.abort(), 1500) : null;
      const request = navigator.locks.request(LOCK, wait ? { mode: 'exclusive', signal: abort.signal } : { mode: 'exclusive', ifAvailable: true }, async lock => {
        clearTimeout(timer);
        if (!lock) {
          const owner = [...ownedRows.values()].find(r => r.status === 'recording' || r.status === 'starting');
          reject(fail('busy', 'Microphone held by ' + (owner?.appId || 'another capture window'), { appId: owner?.appId || null }));
          return;
        }
        resolve(() => { release(); return request; }); await held;
      }).catch(async e => {
        clearTimeout(timer);
        if (e.name === 'AbortError') { const owner = [...ownedRows.values()].find(r => ['recording', 'starting', 'recoverable'].includes(r.status)); reject(fail('busy', 'Microphone held by ' + (owner?.appId || 'another capture window'), { appId: owner?.appId || null })); }
        else reject(e);
      });
    });
  }
  function wav(chunks, bytes) {
    const h = new ArrayBuffer(44), v = new DataView(h);
    const text = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    text(36, 'data'); v.setUint32(40, bytes, true);
    return new Blob([h, ...chunks], { type: 'audio/wav' });
  }
  async function result(row) {
    const chunks = await parts(row.id);
    const blob = row.pcm ? wav(chunks, chunks.reduce((n, c) => n + c.size, 0)) : new Blob(chunks, { type: row.mime });
    const meta = { ...row.meta };
    if (row.status === 'recoverable') meta.captureRecovery = { resumable: true, error: row.recoveryError || null };
    if (row.tracks?.them) {
      const them = await parts(row.id, 'them');
      meta.captureTracks = [{ source: 'them', blob: wav(them, them.reduce((n, c) => n + c.size, 0)), mime: 'audio/wav', startMs: row.tracks.them.startMs || 0 }];
    }
    return { id: row.id, blob, mime: row.mime, startedAt: row.startedAt,
      durationMs: row.durationMs || 0, meta, streamChunks: await streamChunks(row), ...(row.partial ? { partial: true } : {}) };
  }
  // Atomically save each bounded piece AND its recovery metadata. The queue keeps
  // failed writes for an explicit stop retry; never acknowledge/delete on a failed save.
  function enqueue(s, blob, source = 'me', startMs) {
    if (!blob?.size || s.discard || s.inputStopped) return;
    for (let off = 0; off < blob.size; off += MAX_CHUNK) {
      const part = { blob: blob.slice(off, off + MAX_CHUNK), source, startMs: startMs == null ? undefined : startMs + off / 32 };
      s.queue.push(part);
      // Instant takes retain references to ALL pieces (committed and queued) until handoff.
      // Reading IDB back cannot recover committed bytes when the store itself is broken.
      if (s.instant) (s.memoryParts ||= []).push(part);
    }
    s.queuedBytes = (s.queuedBytes || 0) + blob.size;
    if (s.instant && s.row.bytes + (s.queuedBytes || 0) >= s.limit) {
      emit(s, 'warn', 'Recording reached its size limit; keeping the take for you.');
      void finish(s, true).catch(() => {});
    }
    if (s.phase !== 'starting' && !s.persistencePending) s.writes = s.writes.then(() => drain(s));
  }
  function uploadChunk(s, source, blob, startMs, final = false) {
    if (s.row.native === 'wizard-meetings') return;
    s.uploads ||= {};
    const u = s.uploads[source] ||= { parts: [], bytes: 0, seq: s.opts.seqBase?.[source] || 0, startMs };
    if (blob?.size) { if (!u.bytes) u.startMs=startMs; u.parts.push(blob); u.bytes += blob.size; }
    const target = 32 * Math.max(100, Math.min(5000, s.opts.chunkMs || 5000));
    if (u.bytes && (final || !s.row.pcm || u.bytes >= target)) {
      const out = s.row.pcm ? wav(u.parts, u.bytes) : new Blob(u.parts, { type: s.row.mime });
      const item={id:s.row.id,seq:u.seq++,blob:out,startMs:(s.opts.offsetMs||0)+u.startMs,source};
      s.row.delivery ||= {};s.row.delivery.history ||= [];s.row.delivery.history.push({source,seq:item.seq,startMs:item.startMs,bytes:u.bytes});
      emit(s, 'chunk', item);
      u.startMs += s.row.pcm ? u.bytes / 32 : 0; u.parts = []; u.bytes = 0;
    }
  }
  // Native meetings upload full-quality audio to the meeting backend themselves; the on-device
  // PCM copy is only a partial backup. A slow or broken phone store must never block or stop them.
  function dropLocalBackup(s, e) {
    if (s.noLocal) return;
    s.noLocal = true; s.queue.length = 0; s.queuedBytes = 0; s.error = null; s.partial = true;
    emit(s, 'warn', 'On-device backup is unavailable (' + storageFailure(e).detail + '). Recording continues to the meeting server.');
    changed();
  }
  async function softStore(s, work) {
    if (!s.meetingNative) return work();
    if (s.noLocal) return undefined;
    try { return await work(); }
    catch (e) {
      // Ownership/native errors still refuse; only storage failures fall back.
      if (typeof e?.code === 'string' && !/^(storage_|recovery_timeout)/.test(e.code)) throw e;
      dropLocalBackup(s, e); return undefined;
    }
  }
  function noLocalResult(s) {
    recoveryLive.delete(s.row.id);
    return { id: s.row.id, blob: new Blob([], { type: s.row.mime || 'audio/wav' }), mime: s.row.mime || 'audio/wav', startedAt: s.row.startedAt,
      durationMs: s.final?.durationMs ?? 0, meta: { ...s.row.meta, ...(s.final?.meta ? { native: s.final.meta } : {}) },
      streamChunks: [], durable: false, storageError: 'local_backup_skipped', partial: true };
  }
  function drain(s) {
    if (s.drainPromise) return s.drainPromise;
    s.drainPromise = drainQueue(s).finally(() => { s.drainPromise = null; });
    return s.drainPromise;
  }
  async function drainQueue(s) {
    if (s.persistencePending || s.memoryOnly) return;
    if (s.noLocal) { s.queue.length = 0; s.queuedBytes = 0; return; }
    while (s.queue.length && !s.discard) {
      const { blob, source, startMs } = s.queue[0];
      const track = s.row.tracks?.[source] || { seq: 0, bytes: 0, startMs: startMs || 0 };
      const tracks = { ...s.row.tracks, [source]: { ...track, seq: track.seq + 1, bytes: track.bytes + blob.size } };
      const row = { ...s.row, seq: s.row.seq + 1, bytes: s.row.bytes + blob.size, tracks,
        partial: !!s.partial,
        durationMs: s.row.pcm ? Math.max(...Object.values(tracks).map(t => t.startMs + t.bytes / 32)) : (s.pausedAt || Date.now()) - s.row.startedAt - (s.pausedTotal || 0) };
      try {
        await transaction(['sessions', 'chunks'], 'readwrite', tx => {
          tx.objectStore('chunks').put({ id: row.id, seq: s.row.seq, blob, source, startMs: startMs ?? (track.startMs + track.bytes / 32) });
          tx.objectStore('sessions').put(row);
        });
        if (s.discard || s.memoryOnly) return; // a timed-out write must not mutate a handed-off take
        s.row = row; ownedRows.set(row.id, structuredClone(row)); s.queue.shift(); s.queuedBytes = Math.max(0, (s.queuedBytes || 0) - blob.size); s.error = null;
        uploadChunk(s, source, blob, startMs ?? (track.startMs + track.bytes / 32));
      } catch (e) {
        if (s.meetingNative) { dropLocalBackup(s, e); return; }
        s.error = storageFailure(e);
        s.partial = true; changed();
        // Only instant takes may hand off an in-memory result. Durable recorders stay strict.
        if (s.instant) { emit(s, 'warn', 'On-device saving failed (' + s.error.detail + '). Keep Wizard open; Send or Discard still works.'); return; }
        void finish(s, true).catch(() => {}); return;
      }
      if (s.row.bytes >= s.limit && !s.finishPromise) { s.partial = true; void finish(s, true).catch(() => {}); }
    }
  }
  function level(s, value) { for (const cb of s.levels) safeCall(cb, value); }
  function cleanup(s) {
    clearInterval(s.meter); clearTimeout(s.maxTimer);
    for (const off of s.offs) safeCall(off);
    for (const node of s.nodes || []) { try { node.disconnect(); } catch (_) {} }
    s.stream?.getTracks().forEach(t => t.stop());
    s.display?.getTracks().forEach(t => t.stop());
    if (!s.display) s.displayPromise?.then(stream => stream?.getTracks().forEach(t => t.stop()));
    void s.ctx?.close().catch(() => {});
    level(s, 0); s.levels.clear();
  }
  function release(s) {
    cleanup(s); s.unlock?.(); s.unlock = null;
    if(s.inputStopped || s.discard)recoveryLive.delete(s.row.id); if (active === s) active = null; changed();
  }
  function memoryResult(s, error) {
    const chunks = (s.memoryParts || []).filter(p => p.source === 'me').map(p => p.blob);
    const bytes = chunks.reduce((n, b) => n + b.size, 0);
    if (!bytes) throw fail('memory_result_failed', 'Audio could not be prepared. The take is kept; retry Send or Discard.', { detail: 'empty' });
    const blob = s.row.pcm ? wav(chunks, bytes) : new Blob(chunks, { type: s.row.mime });
    return { id: s.row.id, blob, mime: s.row.mime, startedAt: s.row.startedAt,
      durationMs: s.final?.durationMs ?? (s.row.pcm ? bytes / 32 : (s.pausedAt || s.stopAt) - s.row.startedAt - (s.pausedTotal || 0)),
      meta: { ...s.row.meta }, streamChunks: [], durable: false, storageError: storageFailure(error).detail,
      ...(s.final?.partial ? { partial: true } : {}) };
  }
  function finish(s, partial = false) {
    if (s.discard || s.cancelPromise) return Promise.reject(fail('cancelled', 'Capture was cancelled.'));
    if (s.finishPromise) return s.finishPromise;
    s.finishPromise = (async () => {
      if (s.borrowWork) await s.borrowWork.catch(() => {});
      s.error = null; s.phase = 'stopping'; s.stopAt ||= Date.now(); s.partial = !!(s.partial || partial); changed();
      if (!s.inputStopped) {
        try {
          // Input is stopped BEFORE any storage await, even when its final flush fails.
          const stopping = Promise.resolve().then(() => s.engine.stop());
          s.final = await (s.instant ? bounded(stopping, 6000, 'stop_timeout') : stopping);
          if (s.discard) throw fail('cancelled', 'Capture was cancelled.');
          if (s.final?.blob) enqueue(s, s.final.blob);
          s.inputStopped = true;
        } finally { cleanup(s); }
      }
      const save = async () => {
        if (s.noLocal) return noLocalResult(s);
        if (s.persistencePending) await s.persistence;
        let writes;
        do { writes = s.writes; await writes; await drain(s); if (s.error) throw s.error; }
        while (!s.discard && !s.memoryOnly && (s.queue.length || writes !== s.writes));
        if (s.discard || s.memoryOnly) throw fail('cancelled', 'Capture was cancelled or handed off.');
        if (s.noLocal) return noLocalResult(s);
        if (s.queue.length || s.error) throw s.error || fail('storage_failed', 'Capture was not saved.');
        for (const source of Object.keys(s.uploads || {})) uploadChunk(s, source, null, 0, true);
        if (s.final?.meta) s.row.meta = { ...s.row.meta, native: s.final.meta };
        if (s.final?.partial) s.partial = true;
        const row = { ...s.row, status: 'pending', partial: !!s.partial, durationMs: s.final?.durationMs ?? (s.row.durationMs || (s.row.pcm && !s.row.native ? 0 : (s.pausedAt || s.stopAt) - s.row.startedAt - (s.pausedTotal || 0))) };
        recoveryLive.delete(row.id);
        await softStore(s, () => put(row)); if (s.noLocal) return noLocalResult(s);
        if (s.discard || s.memoryOnly) throw fail('cancelled', 'Capture was cancelled or handed off.');
        s.row = row; return result(row);
      };
      let out;
      try { out = await (s.instant ? bounded(save()) : save()); }
      catch (e) {
        if (!s.instant || s.discard) throw e;
        s.memoryOnly = true;
        try { out = memoryResult(s, e); }
        catch (_) { throw fail('memory_result_failed', 'Audio could not be prepared. The take is kept in memory; keep Wizard open and retry Send or Discard.', { detail: storageFailure(e).detail }); }
      }
      if (s.discard) throw fail('cancelled', 'Capture was cancelled.');
      if (out.durable === false) memoryTakes.set(s.row.id, { session: s, result: out });
      else { s.memoryParts = []; s.final = null; }
      s.phase = 'stopped'; release(s); return out;
    })();
    s.finishPromise.catch(e => { cleanup(s); s.error = e; s.phase = 'error'; s.finishPromise = null; changed(); });
    return s.finishPromise;
  }
  function cancelSession(s) {
    if (s.cancelPromise) return s.cancelPromise;
    s.cancelPromise = (async () => {
      // Explicit Discard may follow a failed Stop, or wait for a genuinely in-flight one.
      if (s.finishPromise) await bounded(s.finishPromise, 8000, 'stop_timeout').catch(() => {});
      s.phase = 'cancelling'; s.discard = true; changed();
      try { await bounded(Promise.resolve().then(() => s.engine.cancel()), 1500, 'stop_timeout').catch(() => {}); }
      finally {
        s.inputStopped = true; cleanup(s); s.queue.length = 0; s.memoryParts = []; s.final = null; s.uploads = {}; s.queuedBytes = 0;
        memoryTakes.delete(s.row.id);
        // Never let a broken disk hold the mic or its Web Lock after the owner discarded.
        await bounded(remove(s.row.id)).catch(() => {});
        ownedRows.delete(s.row.id); recoveryLive.delete(s.row.id); s.phase = 'cancelled'; release(s);
      }
    })();
    return s.cancelPromise;
  }
  function emit(s, key, value) { for (const cb of [...(s.listeners?.[key] || [])]) safeCall(cb, value); }
  function observe(s, key, cb) {
    if (typeof cb !== 'function') throw fail('invalid_callback', 'A capture listener is required.');
    s.listeners ||= {}; (s.listeners[key] ||= new Set()).add(cb); return () => s.listeners[key]?.delete(cb);
  }
  function capabilities(opts = {}) {
    const a = adapter(opts);
    const b = attachedMeetingBridge || W.wizardNative?.meetings;
    const AC = W.AudioContext || W.webkitAudioContext;
    const browserPCM = !!(navigator.mediaDevices?.getUserMedia && AC && 'audioWorklet' in AC.prototype && W.AudioWorkletNode && WORKLET_URL);
    return { native: a?.name || null, pcm: a ? a.name === 'wizard-meetings' : browserPCM, pause: true,
      systemAudioStart: a ? !!b && (b.systemAudio === true || typeof b.onState !== 'function') : !!navigator.mediaDevices?.getDisplayMedia,
      systemAudio: a ? !!b?.setSystemAudio : !!navigator.mediaDevices?.getDisplayMedia };
  }
  // Sync activation before app domain requests. Tokens are owner-bound and never time-expire.
  function prepare(appId, opts = {}) {
    validate(appId, opts);
    let nativeActive;try{nativeActive=JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.()||'null');}catch(_){throw fail('busy','Native recorder ownership is unknown.');}
    if(nativeActive?.id)throw fail('busy','An existing native recorder is held.',{appId:'native-recording'});
    const st = state(); if (st.hold) throw fail('busy', 'Microphone held by ' + (st.appId || 'another app'), { appId: st.appId });
    const p = { id: crypto.randomUUID(), appId, ctx: null, display: null };
    if (!adapter(opts)) {
      const AC = W.AudioContext || W.webkitAudioContext;
      if (AC) { p.ctx = new AC(); void p.ctx.resume().catch(() => {}); }
      if (opts.systemAudio) {
        if (!navigator.mediaDevices?.getDisplayMedia) { void p.ctx?.close(); throw fail('system_audio_unavailable', 'Computer audio sharing is unavailable.'); }
        p.display = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); p.display.catch(() => {});
      }
    }
    preparations.set(p.id, p); changed();
    return Object.freeze({ id: p.id, release: () => discardPrepared(appId, p.id) });
  }
  function discardPrepared(appId, id) {
    const p = preparations.get(id); if (!p || p.appId !== appId) return;
    preparations.delete(id); void p.ctx?.close().catch(() => {});
    p.display?.then(st => st.getTracks().forEach(t => t.stop())).catch(() => {}); changed();
  }
  async function streamChunks(row) {
    if (!row.pcm || row.native === 'wizard-meetings') return [];
    let saved;
    await transaction(['chunks'], 'readonly', tx => { tx.objectStore('chunks').index('id').getAll(row.id).onsuccess = e => { saved = e.target.result; }; });
    const d = row.delivery || {}, target = 32 * Math.max(100, Math.min(5000, d.chunkMs || 5000)), out = [];
    if (d.history?.length) {
      for (const source of [...new Set(saved.map(c=>c.source||'me'))]) {
        const raw=new Blob(saved.filter(c=>(c.source||'me')===source).sort((a,b)=>a.seq-b.seq).map(c=>c.blob));
        let offset=0,last=null;
        for(const h of d.history.filter(h=>h.source===source)) {out.push({source,seq:h.seq,startMs:h.startMs,durationMs:h.bytes/32,blob:wav([raw.slice(offset,offset+h.bytes)],h.bytes)});offset+=h.bytes;last=h;}
        if(offset<raw.size) {const n=raw.size-offset;out.push({source,seq:last?last.seq+1:(d.seqBase?.[source]||0),startMs:last?last.startMs+last.bytes/32:(d.offsetMs||0)+(row.tracks?.[source]?.startMs||0),durationMs:n/32,blob:wav([raw.slice(offset)],n)});}
      }
      return out;
    }
    for (const source of [...new Set(saved.map(c => c.source || 'me'))]) {
      const list = saved.filter(c => (c.source || 'me') === source).sort((a,b) => a.seq-b.seq);
      let seq = d.seqBase?.[source] || 0, startMs = (d.offsetMs || 0) + (row.tracks?.[source]?.startMs || 0), group = [], bytes = 0;
      const flush = () => { if (!bytes) return; out.push({ source, seq: seq++, startMs, durationMs: bytes/32, blob: wav(group,bytes) }); startMs += bytes/32; group=[];bytes=0; };
      for (let i=0; i<list.length; i++) {
        const at = (d.offsetMs || 0) + (list[i].startMs ?? (startMs + bytes/32 - (d.offsetMs || 0)));
        if (Math.abs(at - (startMs + bytes/32)) > .01) { flush(); startMs=at; }
        group.push(list[i].blob); bytes += list[i].blob.size;
        if (bytes >= target || i === list.length - 1) flush();
      }
    }
    return out;
  }
  function session(s) {
    return Object.freeze({ id: s.row.id, reattached: () => !!s.reattached,
      getInfo: () => ({ phase:s.phase,inputStopped:!!s.inputStopped,error:s.error?.code||null,warning:s.error?.message||null,native: s.row.native || null, backendStopOwned: !!s.engine?.backendStopOwned, livePcm: s.engine?.livePcm !== false,
        hasSystemAudio: !!s.hasSystemAudio, paused: s.phase === 'paused' || s.phase === 'handoff',
        durationMs: s.nativeState?.mediaMs ?? (s.row.pcm && !s.row.native ? s.row.durationMs : (s.pausedAt || Date.now()) - s.row.startedAt - (s.pausedTotal || 0)),
        state: s.nativeState || null, meta: JSON.parse(JSON.stringify(s.row.meta)), capabilities: capabilities({ kind: s.row.kind, pcm: s.row.pcm }) }),
      onPcm: fn => observe(s,'pcm',fn), onChunk: fn => observe(s,'chunk',fn),
      onState: fn => observe(s,'state',fn), onWarn: fn => observe(s,'warn',fn),
      chunks: async () => { const all = await streamChunks(s.row);
        return all.filter(c => c.seq < (s.uploads?.[c.source]?.seq ?? (s.opts.seqBase?.[c.source] || 0))); },
      setSystemAudio: on => { if (active !== s) throw fail('capture_inactive', 'This capture has stopped.');
        if (!s.engine?.setSystemAudio) throw fail('system_audio_unavailable', 'Computer audio cannot be changed here.');
        return s.engine.setSystemAudio(!!on); },
      onLevel(fn) { if (typeof fn !== 'function') throw fail('invalid_callback', 'A level listener is required.'); s.levels.add(fn); return () => s.levels.delete(fn); },
      stop() { return finish(s); },
      async pause() {
        if(active===s && s.borrow){s.borrow.pausedByHandoff=false;const marker=s.row.meta.handoffs?.find(x=>x.id===s.borrow.id);if(marker)marker.pausedByHandoff=false;await softStore(s, () => put(s.row));if(s.row.native)await s.engine.pause();emit(s,'state',{paused:true,recording:true});changed();return;}
        if (active !== s || s.phase !== 'recording') return;
        if (!s.engine.pause) throw fail('pause_unavailable', 'This recorder cannot pause.');
        await s.engine.pause(); s.pausedAt = Date.now(); s.phase = 'paused'; emit(s,'state',{paused:true,recording:true}); changed();
      },
      async resume() {
        if(s.borrow)throw fail('mic_borrowed','Finish the orb recording before resuming the meeting.');
        if (active !== s || s.phase !== 'paused') return;
        if (s.engineDetached) await reopenBorrowedEngine(s); else await s.engine.resume();
        s.pausedTotal = (s.pausedTotal || 0) + Date.now() - s.pausedAt; s.pausedAt = 0; s.phase = 'recording'; emit(s,'state',{paused:false,recording:true}); changed();
      },
      cancel() { return cancelSession(s); }
    });
  }
  // PCM algorithm above retains Mizel mono16k box-filter downsampling and
  // 250 ms live PCM rather than compressed STT input.
  async function browserEngine(s) {
    // The browser path does not pass through native.start's admission guard.
    // Recheck under the shared lock, after recovery, including direct (unprepared) starts.
    let nativeActive;
    try { nativeActive = JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null'); }
    catch (_) { throw fail('busy', 'Native recorder ownership is unknown.'); }
    const nativeOwner = [...ownedRows.values()].find(r => recoveryLive.has(r.id) || (r.native && !r.nativeId && r.status === 'recoverable'));
    if (nativeActive?.id || nativeOwner || unknownMeetingActive) throw fail('busy', 'An existing native recorder is held.', { appId: nativeOwner?.appId || 'native-recording' });
    if (!navigator.mediaDevices?.getUserMedia) throw fail('unsupported', 'Microphone capture is unavailable.');
    s.stage = 'microphone permission';
    s.stream = await navigator.mediaDevices.getUserMedia({ audio: s.opts.audio ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (s.timedOut) { s.stream.getTracks().forEach(t => t.stop()); s.stream = null; throw fail('start_abandoned', 'Capture start was abandoned.'); }
    s.stage = 'audio engine';
    // On the Android app the browser recorder skips the native phone-mic guard; ask Android where it really listens.
    if (await externalMic()) { s.stream.getTracks().forEach(t => t.stop()); s.stream = null; throw fail('external_mic', EXTERNAL_MIC); }
    s.stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { if (s.phase === 'starting') s.interrupted = true; else if (!s.inputStopped && !s.discard && active === s) void finish(s, true).catch(() => {}); }));
    const ctx = s.ctx, source = ctx?.createMediaStreamSource(s.stream), analyser = ctx?.createAnalyser();
    s.nodes = []; if (analyser) { analyser.fftSize = 512; source.connect(analyser); s.nodes.push(source, analyser); }
    const isPCM = s.opts.pcm === true || s.opts.systemAudio === true || s.opts.kind === 'meeting' || s.opts.mime === 'audio/wav';
    if (isPCM) {
      if (!ctx?.audioWorklet || !W.AudioWorkletNode) throw fail('pcm_unavailable', 'This browser cannot provide PCM capture.');
      s.row.pcm = true; s.row.mime = 'audio/wav';
      if (!WORKLET_URL) throw fail('pcm_module_url_missing', 'Load the shared capture resource through its external script URL.');
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination); s.nodes.push(sink);
      const taps = []; let systemTap = null, systemEndMs = 0;
      const flushTap = tap => new Promise((resolve,reject) => {
        if (tap.ended) return resolve();
        const timeout = setTimeout(() => { tap.flushed=null; reject(fail('pcm_flush_timeout','Final PCM has not been saved; retry Stop.')); },5000);
        tap.flushed=()=>{clearTimeout(timeout);resolve();}; tap.node.port.postMessage('flush');
      });
      const addTap = (name, input, baseMs = 0) => {
        const node = new AudioWorkletNode(ctx, 'wizard-capture-pcm'); input.connect(node); node.connect(sink); s.nodes.push(node);
        const tap = { node, ms: baseMs, flushed: null }; taps.push(tap);
        node.port.onmessage = e => {
          if (tap.ended) return;
          const { samples, final } = e.data;
          if (samples?.length) {
            const pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), at = tap.ms;
            tap.ms += pcm.byteLength / 32; enqueue(s, new Blob([pcm]), name, at);
            if (name === 'me') emit(s, 'pcm', { pcm, startMs: (s.opts.offsetMs || 0) + at, source: name });
          }
          if (final) { tap.ended = true; tap.flushed?.(); }
        };
        return tap;
      };
      addTap('me', analyser, s.row.tracks?.me ? s.row.tracks.me.startMs + s.row.tracks.me.bytes / 32 : 0);
      const attachSystem = stream => {
        if (!stream) return;
        stream.getVideoTracks().forEach(t=>{t.stop();stream.removeTrack(t);});
        if (!stream.getAudioTracks().length) { stream.getTracks().forEach(t=>t.stop()); emit(s,'warn','No computer audio was shared.'); return; }
        s.display=stream; s.hasSystemAudio=true;
        const input=ctx.createMediaStreamSource(stream), an=ctx.createAnalyser(); an.fftSize=512;input.connect(an);
        s.nodes.push(input,an); s.systemAnalyser=an; systemTap=addTap('them',an,Math.max(taps[0].ms,systemEndMs));
        systemTap.input=input;systemTap.an=an;
        stream.getAudioTracks().forEach(t=>t.addEventListener('ended',()=>{ if(s.hasSystemAudio && !s.inputStopped) void s.engine?.setSystemAudio(false).catch(()=>{}); },{once:true}));
      };
      attachSystem(await s.displayPromise);
      let changing = null;
      s.engine = {
        stop: async () => {
          if (changing) await changing;
          if (ctx.state === 'suspended') await ctx.resume();
          await Promise.all(taps.map(flushTap));
        }, cancel: async () => { if (changing) await changing; }, pause: () => ctx.suspend(), resume: () => ctx.resume(),
        setSystemAudio: on => {
          if (changing) return Promise.reject(fail('busy','Computer audio is already changing.'));
          if (on === !!s.hasSystemAudio) return Promise.resolve();
          // Invoke the picker before the first await, in the originating user gesture.
          const request = on ? navigator.mediaDevices.getDisplayMedia({audio:true,video:true}) : null;
          changing=(async()=>{
            if(on) { const stream=await request; if(s.inputStopped||s.discard) {stream.getTracks().forEach(t=>t.stop());return;} attachSystem(stream); }
            else {
              const tap=systemTap; if(tap) {await flushTap(tap); systemEndMs=Math.ceil(tap.ms); tap.input.disconnect();tap.an.disconnect();tap.node.disconnect();await s.writes;await drain(s);uploadChunk(s,'them',null,0,true);await softStore(s, () => put(s.row));}
              s.hasSystemAudio=false;s.systemAnalyser=null;systemTap=null;
              const display=s.display;s.display=null;display?.getTracks().forEach(t=>t.stop());
            }
            emit(s,'state',{recording:true,paused:s.phase==='paused',hasSystemAudio:!!s.hasSystemAudio});changed();
          })().finally(()=>{changing=null;});return changing;
        }
      };
    } else {
      if (!W.MediaRecorder) throw fail('unsupported', 'Audio recording is unavailable.');
      const mime = s.opts.mime || ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
      if (mime && !MediaRecorder.isTypeSupported(mime)) throw fail('unsupported_mime', 'Unsupported capture format.');
      const rec = new MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined); s.row.mime = rec.mimeType || mime;
      let stopped;
      rec.ondataavailable = e => enqueue(s, e.data);
      rec.onstop = () => { if (stopped) stopped(); else void finish(s, true).catch(() => {}); };
      rec.onerror = () => { s.partial = true; void finish(s, true).catch(() => {}); };
      s.engine = { stop: () => rec.state === 'inactive' ? Promise.resolve() : new Promise(resolve => { stopped = resolve; rec.stop(); }), cancel: async () => { rec.ondataavailable = null; rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); }, pause: async () => rec.pause(), resume: async () => rec.resume() };
      rec.start(Math.max(100, Math.min(5000, s.opts.chunkMs || 1000)));
      s.rec = rec;
    }
    if (ctx?.state === 'suspended') { if (isPCM) await ctx.resume(); else void ctx.resume().catch(() => {}); }
    if (analyser) {
      const values = new Uint8Array(analyser.fftSize);
      s.meter = setInterval(() => { analyser.getByteTimeDomainData(values); let sum = 0; for (const v of values) sum += ((v - 128) / 128) ** 2; if (s.systemAnalyser) { s.systemAnalyser.getByteTimeDomainData(values); let them = 0; for (const v of values) them += ((v - 128) / 128) ** 2; level(s, { me: s.phase === 'paused' ? 0 : Math.min(1, Math.sqrt(sum / values.length) * 3.2), them: s.phase === 'paused' ? 0 : Math.min(1, Math.sqrt(them / values.length) * 3.2) }); } else level(s, s.phase === 'paused' ? 0 : Math.min(1, Math.sqrt(sum / values.length) * 3.2)); }, 100);
    }
  }
  // Host-only microphone loan. Keep the capture row, chunk sequence, observers and
  // Web Lock; never make another app appear idle while the orb borrows its mic.
  function beginVoiceBorrow(eventId) {
    const s=active;
    if (s?.borrowWork) return Promise.reject(fail('busy','A microphone handoff is already changing.'));
    const work=beginVoiceBorrowImpl(eventId);
    if(s) { s.borrowWork=work; work.finally(()=>{if(s.borrowWork===work)s.borrowWork=null;}).catch(()=>{}); }
    return work;
  }
  async function beginVoiceBorrowImpl(eventId) {
    const s = active;
    if (!s || s.row.kind !== 'meeting' || (s.row.native && s.row.native !== 'wizard-meetings') || !s.row.pcm)
      throw fail('handoff_unavailable', 'This recorder cannot hand off its microphone.');
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(eventId)) throw fail('invalid_id','Invalid handoff id.');
    if (!['recording','paused'].includes(s.phase) || s.borrow) throw fail('busy','A microphone handoff is already active.');
    if (s.row.native === 'wizard-meetings') {
      const d=W.WizardOSDevice;
      if(typeof d?.recHandoffVersion!=='function' || d.recHandoffVersion()<1 || typeof d.recStartBorrowed!=='function') throw fail('handoff_unavailable','Update Wizard Android to borrow the meeting microphone.');
      const receipt=JSON.parse(d.recHandoffBegin(eventId,s.row.meta.meetingId)||'null');
      if(receipt?.status!=='paused' || receipt.open!==true || receipt.id!==eventId || receipt.meetingId!==s.row.meta.meetingId) throw fail('handoff_unavailable','Native microphone release was not confirmed.');
      receipt.micReleased=true; // ABI v1 begin returns only after capture join, flush and mic release
      s.borrow=receipt;s.row.meta.handoffs ||= [];s.row.meta.handoffs.push({...receipt,status:'paused'});
      try { await softStore(s, () => put(s.row)); } catch(e) { d.recHandoffEnd(eventId);s.borrow=null;throw e; }
      s.phase='handoff';changed();return {...receipt};
    }
    const wasPaused = s.phase === 'paused', hadSystemAudio = s.hasSystemAudio;
    s.phase = 'handoff';
    s.borrow = { id:eventId, meetingId:s.row.meta.meetingId, pausedByHandoff:!wasPaused, pausedAt:Date.now(), micReleased:false };
    changed();
    try {
      await s.engine.stop(); // final AudioWorklet acknowledgement, then durable queue drain
      s.inputStopped = true;
      clearInterval(s.meter);
      for (const node of s.nodes || []) { try { node.disconnect(); } catch (_) {} }
      s.stream?.getTracks().forEach(t=>t.stop()); s.display?.getTracks().forEach(t=>t.stop());
      await s.ctx?.close(); s.ctx=null; s.stream=null; s.display=null; s.displayPromise=null;
      s.hasSystemAudio=false; s.systemAnalyser=null; s.engineDetached=true;
      await s.writes; await drain(s);
      if (s.error || s.queue.length) throw s.error || fail('storage_failed','Meeting boundary was not saved.');
      for (const source of Object.keys(s.uploads || {})) uploadChunk(s,source,null,0,true);
      s.borrow.atMediaMs=(s.opts.offsetMs||0)+(s.row.durationMs||0);
      s.row.meta.handoffs ||= [];
      s.row.meta.handoffs.push({ ...s.borrow, status:'paused' });
      await softStore(s, () => put(s.row));
      if (active!==s || s.finishPromise) throw fail('stale_handoff','Meeting was stopped during handoff.');
      s.pausedAt ||= Date.now(); s.borrow.micReleased=true;
      emit(s,'state',{recording:true,paused:true,hasSystemAudio:false,handoffId:eventId});
      if(hadSystemAudio) emit(s,'warn','Computer audio is off after the microphone handoff. Re-enable it explicitly to record it again.');
      changed();
      return {...s.borrow};
    } catch(e) { s.error=e; s.phase='error'; changed(); throw e; }
  }
  async function reopenBorrowedEngine(s) {
    const AC=W.AudioContext||W.webkitAudioContext;
    s.ctx=new AC(); s.inputStopped=false;
    // A display picker needs a fresh gesture. Do not silently reopen computer audio.
    s.opts.systemAudio=false;
    try { await browserEngine(s); s.engineDetached=false; }
    catch(e) { s.stream?.getTracks().forEach(t=>t.stop()); await s.ctx?.close(); s.ctx=null; s.inputStopped=true; throw e; }
  }
  function endVoiceBorrow(eventId, detail={}) {
    const s=active;
    if(s?.borrowWork) return Promise.reject(fail('busy','A microphone handoff is already changing.'));
    const work=endVoiceBorrowImpl(eventId,detail);
    if(s) { s.borrowWork=work; work.finally(()=>{if(s.borrowWork===work)s.borrowWork=null;}).catch(()=>{}); }
    return work;
  }
  async function endVoiceBorrowImpl(eventId, detail={}) {
    const s=active;
    if (!s || s.borrow?.id!==eventId || !s.borrow.micReleased) throw fail('stale_handoff','This microphone loan is not active.');
    const b=s.borrow, marker=s.row.meta.handoffs.find(x=>x.id===eventId);
    Object.assign(marker,{status:detail.status==='cancelled'?'cancelled':'captured',voiceTakeId:String(detail.voiceTakeId||''),endedAt:Date.now()});
    await softStore(s, () => put(s.row)); // marker survives even if reacquiring the microphone fails
    if(s.row.native === 'wizard-meetings') {
      const receipt=JSON.parse(W.WizardOSDevice.recHandoffEnd(eventId)||'null'); // stopped voice already returned the native lease
      if(receipt?.id!==eventId || receipt.open!==false)throw fail('handoff_unavailable','Native microphone return was not confirmed.');
      marker.pausedByHandoff=receipt.pausedByHandoff;marker.resumeStatus=receipt.status;await softStore(s, () => put(s.row));
      s.borrow=null;s.phase=receipt.status==='recording'?'recording':'paused';changed();
      if(s.closeRequested) void finish(s).catch(()=>{}); // its app was closed during the loan
      return {...marker};
    }
    s.phase='paused'; s.borrow=null;
    // App closed while the orb borrowed its mic: never reopen the microphone for a closed app; save the take.
    if(s.closeRequested) { marker.resumeStatus='closed'; await softStore(s, () => put(s.row)); changed(); void finish(s).catch(()=>{}); return {...marker}; }
    if(b.pausedByHandoff && !s.finishPromise) {
      try { await reopenBorrowedEngine(s); s.pausedTotal=(s.pausedTotal||0)+Date.now()-s.pausedAt; s.pausedAt=0; s.phase='recording'; marker.resumeStatus='recording'; }
      catch(e) { marker.resumeStatus='failed'; s.error=e; emit(s,'warn','Meeting remains paused: microphone could not resume.'); }
    } else marker.resumeStatus='paused';
    await softStore(s, () => put(s.row));
    emit(s,'state',{recording:true,paused:s.phase==='paused',hasSystemAudio:false}); changed();
    return {...marker};
  }
  function deviceAdapter(d) {
    const parse = text => { try { return JSON.parse(text); } catch (_) { return null; } };
    async function read(id) {
      const blobs = []; let off = 0;
      for (let i = 0; i < 16384; i++) {
        const c = parse(d.recRead(id, off));
        if (!c || typeof c.b64 !== 'string') throw fail('native_read_failed', 'Native capture audio could not be read.');
        const bin = atob(c.b64), bytes = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        blobs.push(bytes);
        if (c.next < 0) return new Blob(blobs, { type: 'audio/aac' });
        if (!Number.isInteger(c.next) || c.next <= off) throw fail('native_read_failed', 'Native capture read did not advance.');
        off = c.next;
      }
      throw fail('native_read_failed', 'Native capture exceeds the bounded read limit.');
    }
    return { name: 'wizard-device',
      async start(opts, hooks, previous) {
        if (opts.systemAudio) throw fail('system_audio_unavailable', 'This native recorder does not capture computer audio.');
        let a = parse(d.recActive());
        if (a?.id && a.id !== previous?.nativeId) throw fail('busy', 'Microphone held by Wizard voice', { appId: 'wizard-voice' });
        let id = previous?.nativeId || d.recStart(opts.kind || 'app');
        if (!id) {
          hooks.stage?.('microphone permission');
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach(t => t.stop());
          hooks.stage?.('native recorder');
          id = d.recStart(opts.kind || 'app');
        }
        if (!id) throw fail('native_start_failed', 'Native recording could not start.');
        const timer = setInterval(() => hooks.level(Math.max(0, Math.min(1, Number(d.recLevel()) / 100))), 100);
        return { nativeId: id, mime: 'audio/aac', stop: async () => {
          clearInterval(timer); const current = parse(d.recActive());
          const meta = parse(current?.id === id ? d.recStop(id) : d.recClaim(id));
          if (!meta) throw fail('native_stop_failed', 'Native capture is still recoverable; retry Stop.');
          return { blob: await read(id), durationMs: Number(meta.ms) || 0, meta };
        }, cancel: async () => {
          clearInterval(timer); d.recCancel(id);
          for (let i = 0; i < 50; i++) { if (parse(d.recActive())?.id !== id) return; await new Promise(resolve => setTimeout(resolve, 100)); }
          throw fail('native_cancel_timeout', 'Native capture has not cancelled yet; retry Cancel.');
        }, pause: async () => d.recPause(true), resume: async () => d.recPause(false), detach: () => clearInterval(timer) };
      },
      async recover(row, {stopOnly = false} = {}) {
        const a = parse(d.recActive());
        if (a?.id === row.nativeId && !stopOnly) return { live: true };
        // Stop/claim only the row's proven native owner; never call recStart or steal another app's mic.
        const meta = parse(a?.id === row.nativeId ? d.recStop(row.nativeId) : d.recClaim(row.nativeId));
        if (!meta) throw fail('native_claim_pending', 'Native capture is not ready to claim; restore the bridge and retry recovery.');
        return { blob: await read(row.nativeId), durationMs: Number(meta.ms) || 0, meta };
      },
      ack: row => d.recDone(row.nativeId)
    };
  }
  function meetingAdapter(b) {
    return { name: 'wizard-meetings',
      async start(opts, hooks, previous) {
        const meetingId = opts.meta?.meetingId || previous?.meta?.meetingId;
        if (typeof meetingId !== 'string' || !meetingId) throw fail('meeting_id_required', 'Create the meeting task before capture.');
        const current = await b.status?.();
        if (current?.recording && current.meetingId !== meetingId) throw fail('busy', 'Microphone held by mizel', { appId: 'mizel' });
        let pcm = false;
        const offs = [b.onLevel?.(hooks.level), b.onState?.(st => safeCall(opts.onNativeState, st)), b.onPcm?.(frame => {
          if (frame.meetingId !== meetingId) return;
          safeCall(opts.onPcm, frame); hooks.chunk(new Blob([frame.pcm]), 'me', frame.startMs);
        })];
        let st;
        try {
          if (previous && current?.recording) st = current;
          else {
            try { st = await b.start({ meetingId, includeSystemAudio: !!opts.systemAudio }); }
            catch (e) { if (e.code !== 'mic_permission') throw e; hooks.stage?.('microphone permission'); const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach(t => t.stop()); hooks.stage?.('native recorder'); st = await b.start({ meetingId, includeSystemAudio: !!opts.systemAudio }); }
          }
          safeCall(opts.onNativeState, st);
          if (b.pcm && st?.livePcm) { await b.pcm(meetingId, true); pcm = true; }
        } catch (e) { offs.forEach(off => safeCall(off)); throw e; }
        const detach = async () => { if (pcm) { try { await b.pcm(meetingId, false); } catch (e) { safeCall(opts.onWarn, 'PCM listener cleanup: ' + e.message); } pcm = false; } offs.forEach(off => safeCall(off)); };
        const stopNative = async () => {
          const st = await b.status?.();
          if (st?.recording && st.meetingId !== meetingId) throw fail('busy', 'Microphone held by another meeting', { appId: 'mizel' });
          if (st?.recording === false) return st;
          try { return await b.stop(); } catch (e) {
            const after = await b.status?.();
            if (after?.recording === false) return after;
            throw e;
          }
        };
        return { nativeId: meetingId, mime: 'audio/wav', pcm: true, livePcm: !!pcm, backendStopOwned: typeof b.onState === 'function',
          ...(b.setSystemAudio ? { setSystemAudio: on => b.setSystemAudio(on) } : {}),
          stop: async () => { const final = await stopNative(); await detach(); safeCall(opts.onNativeState, final);
            // The existing bridge owns full-quality 5s uploads + final_seq. PCM tee
            // is a recoverable local *partial* backup, never a replacement upload.
            return { partial: true, ...(final?.mediaMs != null ? {durationMs:final.mediaMs} : {}), meta: { meetingId, status: final, backendOwned: true, backendStopOwned: typeof b.onState === 'function' } }; },
          cancel: async () => { await stopNative(); await detach(); }, pause: () => b.pause?.(), resume: () => b.resume?.(), detach: () => { offs.forEach(off => safeCall(off)); }
        };
      },
      async recover(row) { const st = await b.status?.(); return st?.recording && st.meetingId === row.nativeId ? { live: true } : { partial: true, meta: { meetingId: row.nativeId, status: st, backendOwned: true, backendStopOwned: typeof b.onState === 'function' } }; },
      ack: async () => {} // native meeting chunks follow the task backend's own retention policy
    };
  }
  let rawMeetingBridge;
  function nativeMeetingPort() {
    if (rawMeetingBridge) return rawMeetingBridge;
    const port = W.wizardMizelPort;
    if (!port || typeof port.postMessage !== 'function') return null;
    // Only install when no app/shell wrapper already owns the port. The host can
    // supply an existing bridge via configureNativeBridge without duplicate listeners.
    if (port.onmessage) throw fail('native_bridge_owned', 'Attach the existing meeting bridge instead of replacing its listener.');
    const waiting = new Map(), levels = new Set(), states = new Set(), pcms = new Set(); let n = 0;
    const send = (cmd, extra = {}) => new Promise((resolve, reject) => {
      const id = 'capture-' + (++n), timer = setTimeout(() => { waiting.delete(id); reject(fail('native_timeout', 'Native recorder has not replied; its take is still recoverable.')); }, 12000);
      waiting.set(id, { resolve, reject, timer });
      try { port.postMessage(JSON.stringify({ id, cmd, ...extra })); }
      catch (e) { clearTimeout(timer); waiting.delete(id); reject(e); }
    });
    port.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      const pending = waiting.get(m.id);
      if (pending) {
        waiting.delete(m.id); clearTimeout(pending.timer);
        if (m.ok) pending.resolve(m.status || null);
        else pending.reject(fail(['mic_busy', 'busy_other_meeting'].includes(m.error) ? 'busy' : m.error || 'native_failed', m.error || 'Native recorder failed.', { appId: m.error === 'mic_busy' ? 'wizard-voice' : 'mizel', status: m.status }));
      } else if (m.type === 'level') levels.forEach(cb => safeCall(cb, { me: Number(m.me) || 0, them: 0 }));
      else if (m.type === 'state') states.forEach(cb => safeCall(cb, m));
      else if (m.type === 'pcm' && typeof m.pcm === 'string' && m.pcm.length <= 12000) {
        try { const bin = atob(m.pcm); if (bin.length % 2) return; const pcm = Uint8Array.from(bin, c => c.charCodeAt(0)); pcms.forEach(cb => safeCall(cb, { meetingId: m.meetingId, startMs: m.startMs, pcm })); } catch (_) {}
      }
    };
    const listen = set => cb => { set.add(cb); return () => set.delete(cb); };
    rawMeetingBridge = { start: ({ meetingId }) => send('start', { meetingId }), stop: () => send('stop'), status: () => send('status'), pause: () => send('pause'), resume: () => send('resume'), pcm: (meetingId, enabled) => send('pcm', { meetingId, enabled }), onLevel: listen(levels), onState: listen(states), onPcm: listen(pcms) };
    return rawMeetingBridge;
  }
  // James's contract (18 Oct 2026): Wizard records only from the phone's own mic, never a Bluetooth speaker's.
  const EXTERNAL_MIC = "Android moved the microphone to a Bluetooth or external device. Wizard records only from the phone's own mic. Try again, or choose another mic in Settings → Microphone.";
  async function externalMic() {
    const d = W.WizardOSDevice; if (!d || typeof d.micRoute !== 'function') return false;
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 120));
      let v = 'unknown'; try { v = String(d.micRoute()); } catch (_) { return false; }
      if (v === 'external') return true;
      if (v !== 'unknown') return false;
    }
    return false;
  }
  function adapter(opts, row) {
    if (configuredNative) return configuredNative;
    const b = attachedMeetingBridge || W.wizardNative?.meetings || ((opts.kind === 'meeting' || row?.native === 'wizard-meetings') ? nativeMeetingPort() : null);
    if ((opts.kind === 'meeting' || row?.native === 'wizard-meetings') && b) return meetingAdapter(b);
    const d = W.WizardOSDevice;
    if (d && typeof d.recStart === 'function') {
      // Do not silently flatten a meeting's 16k PCM/two-track contract into AAC.
      if (opts.kind === 'meeting' && !row) throw fail('native_meeting_adapter_required', 'Attach the existing native meeting/PCM bridge before capture.');
      // DeviceBridge is AAC-only. Explicit non-meeting PCM uses the SAME shared
      // browser engine/lock/custody, never a fabricated meeting or an app recorder.
      // Persisted native rows must still recover/resume/ack through their bridge.
      if (!row && opts.kind !== 'meeting' && opts.pcm === true) return null;
      return deviceAdapter(d);
    }
    if (row?.native) throw fail('native_unavailable', 'The native capture bridge must be restored to recover this take.');
    return null;
  }
  function meetingBridge() { return attachedMeetingBridge || W.wizardNative?.meetings || (W.wizardMizelPort ? nativeMeetingPort() : null); }
  let recoveryLease = null;
  function yieldRecovery() {
    if (!recoveryLease) return;
    recoveryLease.cancelled = true; const released = recoveryLease.unlock(); recoveryLease = null; return released;
  }
  async function recoverLocked(lease) {
    const check = () => { if (lease?.cancelled) throw fail('recovery_yielded', 'Recovery yielded to microphone start.'); };
    check();
    if (lease) lease.phase = 'rows';
    let all = await rows(); if (lease) lease.sessionCount = all.length; check(); ownedRows.clear(); for (const r of all) ownedRows.set(r.id, r); ownershipLoaded = true; changed();
    const meeting = meetingBridge(); let meetingStatus = null;
    const readMeetingStatus = async () => {
      let st;
      try { if (lease) lease.phase = 'native_status'; st = await meeting.status(); }
      catch (_) { st = null; }
      check();
      if (typeof st?.recording !== 'boolean') recoveryError = fail('native_owner_uncertain', 'Native recorder status is unknown.');
      return st;
    };
    if (meeting?.status) {
      const st = await readMeetingStatus(); meetingStatus = st;
      // A live status without an ID still owns the mic; never invent an ID to recover it.
      const unknown = !!(st?.recording && !st.meetingId);
      if (unknown !== unknownMeetingActive) { unknownMeetingActive = unknown; changed(); }
      if (st?.recording && st.meetingId && !all.some(r=>r.native==='wizard-meetings' && r.nativeId===st.meetingId)) {
        const row={id:crypto.randomUUID(),appId:'mizel',kind:'meeting',native:'wizard-meetings',nativeId:st.meetingId,
          status:'recoverable',partial:true,startedAt:Date.now()-(st.mediaMs||0),durationMs:st.mediaMs||0,seq:0,bytes:0,pcm:true,mime:'audio/wav',meta:{meetingId:st.meetingId}};
        recoveryLive.add(row.id);await put(row);all=await rows();
      }
    }
    // Positive proof that no native recorder runs: the device reports no take and the meeting bridge (if any) is not recording.
    let nativeQuiet = false;
    try { nativeQuiet = JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null') === null && !unknownMeetingActive &&
      (!meeting?.status || meetingStatus?.recording === false); } catch (_) { nativeQuiet = false; }
    check();
    for (const row of all) {
      check();
      if (!['starting', 'recording', 'recoverable'].includes(row.status)) continue;
      // An ID-less native reservation with no live native recorder cannot hold the mic (e.g. after an app kill):
      // keep it as pending partial custody instead of a permanent microphone lock.
      if (row.native && !row.nativeId) { await put({ ...row, status: nativeQuiet ? 'pending' : 'recoverable', partial: true, recoveryError: 'native_owner_uncertain' }); continue; }
      if (active?.row.id === row.id) continue;
      try {
      if (row.native && row.nativeId) {
        const a = adapter({ kind: row.kind }, row);
        if (lease) lease.phase = 'native_recover';
        const recovered = await a.recover?.(row); check();
        if (recovered?.live) { recoveryLive.add(row.id); await put({ ...row, status: 'recoverable', partial: true, recoveryError: null }); continue; }
        recoveryLive.delete(row.id);
        if (recovered?.blob && !row.bytes) {
          const s = { row, queue: [], writes: Promise.resolve(), opts: {}, limit: DEFAULT_LIMIT };
          enqueue(s, recovered.blob); await s.writes; check(); if (s.error) throw s.error; Object.assign(row, s.row); row.rescueComplete = true;
        }
        if (recovered?.meta) row.meta = { ...row.meta, native: recovered.meta };
        if (recovered?.durationMs != null) row.durationMs = recovered.durationMs;
      }
      // No assumption that an empty take succeeded: expose even zero-byte partial
      // metadata so the task can show interrupted start rather than silently erase it.
      if (lease) lease.phase = 'save';
      await put({ ...row, status: 'pending', partial: true });
      } catch (e) {
        check(); recoveryError = e;
        await put({ ...row, status: 'recoverable', partial: true, recoveryError: e.code || 'native_recovery_failed' });
      }
    }
    // Native notification controls can start while rows/chunks are read. Never call the old idle
    // snapshot fresh truth. A newly seen owner is blocked until a later pass adopts its real ID.
    if (meeting?.status) {
      const st = await readMeetingStatus();
      const knownLive = st?.recording === true && !!st.meetingId && [...recoveryLive].some(id => {
        const r = ownedRows.get(id); return r?.native === 'wizard-meetings' && r.nativeId === st.meetingId;
      });
      const unknown = st?.recording === true && !knownLive;
      if (unknown !== unknownMeetingActive) { unknownMeetingActive = unknown; changed(); }
    }
  }
  async function acquireBounded() {
    let expired = false;
    const waiting = acquire().then(unlock => {
      if (expired) { unlock(); throw fail('recovery_timeout', 'Recorder lock timed out. Your audio is kept.'); }
      return unlock;
    });
    try { return await bounded(waiting, 1500, 'recovery_timeout'); }
    finally { expired = true; }
  }
  async function recover() {
    let unlock, lease; const started = Date.now();
    try { unlock = await acquireBounded();
      if (active?.instant) return;
      lease = { unlock, cancelled: false, phase: 'rows' }; recoveryLease = lease;
      recoveryError = null; await bounded(recoverLocked(lease), 4500, 'recovery_timeout');
      storageDiagnostic('recovery', recoveryError, started, { phase: 'complete', sessionCount: lease.sessionCount }); }
    catch (e) { if (e.code === 'recovery_yielded') return; storageDiagnostic('recovery', e, started, { phase: lease?.phase || 'lock', sessionCount: lease?.sessionCount }); if (e.code !== 'busy') { recoveryError = e; throw e; }
      const all = await rows(); ownedRows.clear(); for (const r of all) ownedRows.set(r.id,r); ownershipLoaded = true; changed(); }
    finally { if (lease) lease.cancelled = true; if (recoveryLease === lease) recoveryLease = null; unlock?.(); changed(); }
  }
  // Start budget per attempt. Messenger hands its composer back at 8 s; the shared bound frees the mic just after.
  const START_BOUND_MS = 10000, PROMPT_BOUND_MS = 60000;
  async function micPromptOpen() {
    try { return await Promise.race([navigator.permissions.query({ name: 'microphone' }).then(p => p.state === 'prompt'), new Promise(r => setTimeout(() => r(false), 500))]); }
    catch (_) { return false; }
  }
  // The bound fired: free the microphone now and tell the app which stage hung. A native reservation stays
  // recoverable (recoverLocked claims or clears it); a reservation that never reached a recorder is dropped.
  function abandonStart(s, resuming) {
    s.timedOut = true;
    const stage = s.stage || 'start';
    const e = fail('start_timeout', 'The microphone did not start (stuck at ' + stage + '). Try again.', { stage, id: s.row.id, appId: s.row.appId });
    const saved = s.row.native ? put({ ...s.row, status: 'recoverable', partial: true, recoveryError: 'start_timeout' })
      : resuming ? Promise.resolve() : remove(s.row.id);
    release(s); s.readyResolve();
    // With no native recorder running, the recovery pass turns an ID-less reservation into pending custody, so it
    // stops holding updates; a recorder that really started keeps it recoverable until it is claimed.
    void saved.catch(() => {}).then(() => active ? null : recover()).catch(() => {});
    return e;
  }
  // The abandoned start settled after all. It never touches `active` (a newer take may own the mic): it returns
  // a lock it acquired late, cancels a fresh native take nobody is waiting for, and leaves a resumed take recoverable.
  function lateStart(s, resuming, error) {
    cleanup(s); s.unlock?.(); s.unlock = null;
    if (!s.engine) {
      // A definitive late rejection created no take. Remove only that empty reservation;
      // unknown native outcomes retain custody until the bridge can establish ownership.
      const quiet = (() => { try { return JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null') === null; } catch (_) { return false; } })();
      if (!resuming && !s.row.nativeId && (quiet || ['busy','permission_denied','mic_permission','mic_busy','native_busy'].includes(error?.code))) void remove(s.row.id).catch(() => {});
      return;
    }
    if (resuming) { safeCall(s.engine.detach); return; }
    Promise.resolve().then(() => s.engine.cancel?.()).then(() => remove(s.row.id)).catch(() => {});
  }
  async function start(appId, opts = {}) {
    const meta = validate(appId, opts);
    const prepared = opts.preparedId ? preparations.get(opts.preparedId) : null;
    if (opts.preparedId && (!prepared || prepared.appId !== appId)) throw fail('invalid_preparation', 'Preparation belongs to another app.');
    if (active) throw fail('busy', 'Microphone held by ' + active.row.appId, { appId: active.row.appId });
    const s = { row: { id: crypto.randomUUID(), appId, kind: opts.kind || 'audio', status: 'starting', startedAt: Date.now(), durationMs: 0, seq: 0, bytes: 0, mime: '', meta, delivery: { chunkMs: opts.chunkMs || 5000, offsetMs: opts.offsetMs || 0, seqBase: opts.seqBase || { me: 0, them: 0 } } },
      phase: 'starting', opts: { ...opts }, listeners: {}, levels: new Set(), offs: [], queue: [], writes: Promise.resolve(), limit: Math.min(DEFAULT_LIMIT, opts.maxBytes || DEFAULT_LIMIT) };
    for (const [key,opt] of [['pcm','onPcm'],['chunk','onChunk'],['state','onNativeState'],['warn','onWarn']])
      if (typeof opts[opt] === 'function') observe(s,key,opts[opt]);
    if (prepared) { preparations.delete(prepared.id); s.ctx = prepared.ctx; s.displayPromise = prepared.display?.catch(e => { emit(s,'warn','Computer audio was not captured: ' + e.message); return null; }); }
    s.readyPromise = new Promise(resolve => { s.readyResolve = resolve; });
    s.instant = !opts.resumeId && ['audio','song'].includes(opts.kind || 'audio') && !opts.pcm && !opts.systemAudio && opts.mime !== 'audio/wav';
    active = s; if (s.instant) s.recoveryYield = yieldRecovery(); changed();
    // Bounded start (James's phone, 31 Oct 2026): a start that never settles must not hold the microphone. Before
    // this bound a hung store/recovery/permission/native await kept `active` set, so every app read the mic as busy
    // until Wizard reloaded, and the app's update hold never ended.
    let timer;
    const bound = new Promise((_, reject) => {
      const arm = ms => { timer = setTimeout(async () => {
        if (s.phase !== 'starting' || s.engine || s.settled) return;
        // The owner may still be reading Android's microphone prompt: give that one stage a longer budget.
        if (!s.promptExtended && s.stage === 'microphone permission' && await micPromptOpen()) { s.promptExtended = true; arm(PROMPT_BOUND_MS - START_BOUND_MS); return; }
        if (s.phase !== 'starting' || s.engine || s.settled) return;
        reject(abandonStart(s, !!opts.resumeId));
      }, ms); };
      if (s.instant) arm(START_BOUND_MS); // meetings, PCM and resume keep their established protocol
    });
    const run = startRun(s, appId, opts, meta, prepared);
    run.catch(() => {}); // after a timeout nobody awaits the late outcome; startRun cleans it up itself
    try { return await Promise.race([run, bound]); } finally { clearTimeout(timer); }
  }
  async function startRun(s, appId, opts, meta, prepared) {
    // Every await re-checks the bound: a start that resolves after it gave up must not write rows or claim the mic.
    const live = v => { if (s.timedOut) throw fail('start_abandoned', 'Capture start was abandoned.'); return v; };
    // WebAudio activation happens synchronously in the gesture, before IDB awaits.
    try {
      let native = adapter(opts);
      s.meetingNative = native?.name === 'wizard-meetings';
      if (!native) {
        const AC = W.AudioContext || W.webkitAudioContext; if (AC && !s.ctx) { s.ctx = new AC(); void s.ctx.resume().catch(() => {}); }
        if (opts.systemAudio && !s.displayPromise) {
          if (!navigator.mediaDevices?.getDisplayMedia) throw fail('system_audio_unavailable', 'Computer audio sharing is unavailable.');
          s.displayPromise = navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }).catch(e => { safeCall(opts.onWarn, 'Computer audio was not captured: ' + e.message); return null; });
        }
      }
      if (s.instant) {
        // Ask for the exclusive lock without queueing behind another recording. Store/recovery are not
        // microphone admission. Keep their slow I/O out of the tap-to-audio critical path.
        s.stage = 'microphone lock'; if (s.recoveryYield) await s.recoveryYield; s.unlock = await acquire(); live();
        // Native start enforces its own MicOwner. Browser capture must additionally honor an attached meeting.
        const meeting = meetingBridge();
        if (meeting?.status && (await meeting.status())?.recording) throw fail('busy', 'Microphone held by another meeting', { appId: 'native-recording' });
        live();
        let nativeTake; try { nativeTake = JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null'); } catch (_) { nativeTake = { unknown: true }; }
        if (nativeTake || [...recoveryLive].length) {
          // Existing physical recordings are not fresh starts. Retain owner-scoped reattachment and
          // the resume-required identity instead of opening a second mic or replacing their custody.
          live(await ready); live(await recoverLocked());
          const prior = [...ownedRows.values()].find(r => recoveryLive.has(r.id));
          if (prior?.appId === appId) throw fail('resume_required', 'This app has a live recoverable recording. Resume or discard it first.', { id: prior.id, appId });
          throw fail('busy', 'An existing native recorder is held.', { appId: prior?.appId || 'native-recording' });
        }
      } else {
      s.stage = 'shared capture store'; live(await ready);
      s.stage = 'microphone lock'; s.unlock = await acquire(true); live();
      s.stage = 'recovery check'; live(await softStore(s, () => recoverLocked()));
      if (recoveryError?.code === 'native_owner_uncertain') throw recoveryError;
      const recoverable = (live(await softStore(s, rows)) || []).find(r => r.appId === appId && r.status === 'recoverable');
      if (recoverable && !opts.resumeId) throw fail('resume_required', 'Resume the existing native capture before starting another.', { id: recoverable.id, appId });
      if (opts.resumeId) {
        const row = (live(await softStore(s, rows)) || []).find(r => r.id === opts.resumeId && r.appId === appId && r.status === 'recoverable');
        if (!row) throw fail('not_recoverable', 'No native recording is available to resume.');
        s.row = row; recoveryLive.delete(row.id); s.partial = false; s.opts = { ...row.delivery, ...s.opts }; native = adapter({ ...opts, kind: row.kind }, row); s.meetingNative = native?.name === 'wizard-meetings';
        if (!native) throw fail('native_unavailable', 'Restore the native bridge before resuming this take.');
      }
      // The persistence request is advisory; the IDB write itself is mandatory.
      try { void navigator.storage?.persist?.().catch(() => {}); } catch (_) {}
      s.stage = 'saving the take'; live(await softStore(s, () => put(s.row)));
      }
      if (native) {
        s.row.native = native.name || 'configured';
        if (s.row.native === 'wizard-meetings') s.row.nativeId = opts.meta?.meetingId || s.row.nativeId;
        if (!s.instant) live(await softStore(s, () => put(s.row)));
        s.hasSystemAudio = !!opts.systemAudio && capabilities(opts).systemAudioStart;
        s.stage = 'native recorder';
        s.engine = await native.start({ ...opts, onPcm: frame => emit(s,'pcm',frame), onNativeState: st => { if(!st)return; s.nativeState=st; if(st.hasSystemAudio != null)s.hasSystemAudio=!!st.hasSystemAudio;
          if(st.recording && ['recording','paused'].includes(s.phase)) {
            if(st.paused && s.phase!=='paused'){s.pausedAt=Date.now();s.phase='paused';}
            else if(!st.paused && s.phase==='paused'){s.pausedTotal=(s.pausedTotal||0)+Date.now()-s.pausedAt;s.pausedAt=0;s.phase='recording';}
          }
          emit(s,'state',st); if(st.recording===false && active===s && ['recording','paused'].includes(s.phase) && !s.finishPromise) void finish(s).catch(()=>{}); }, onWarn: msg => emit(s,'warn',msg) }, { level: value => level(s, value), chunk: (blob, source, startMs) => enqueue(s, blob, source, startMs), stage: name => { s.stage = name; } }, opts.resumeId ? s.row : null);
        live();
        s.row.nativeId = s.engine.nativeId; s.row.mime = s.engine.mime || 'audio/wav'; s.row.pcm = !!s.engine.pcm;
        if (s.engine.detach) s.offs.push(s.engine.detach);
      } else { s.stage = 'browser microphone'; await browserEngine(s); live(); }
      s.row.status = 'recording'; s.row.startedAt = opts.resumeId ? s.row.startedAt : Date.now();
      if (!s.instant) { s.stage = 'saving the take'; await softStore(s, () => put(s.row)); }
      s.settled = true; live();
      s.phase = s.nativeState?.paused ? 'paused' : 'recording';if(s.nativeState?.paused)s.pausedAt=Date.now(); if (!s.instant) s.writes = s.writes.then(() => drain(s)); changed();
      if (s.instant) {
        s.persistencePending = true;
        const notice = setTimeout(() => { if (s.persistencePending && !s.discard) emit(s, 'warn', 'Recording is kept in memory while saving catches up. Keep Wizard open.'); }, 1000);
        // The session is already recording. Buffer chunks until its first row can commit. Recovery
        // runs at boot/pending(), never as an admission requirement for a fresh voice/song take.
        s.persistence = (async () => {
          try { await openDB(); if (!s.discard && !s.memoryOnly) await put(s.row); }
          catch (e) { s.error = storageFailure(e); emit(s, 'warn', 'On-device saving failed (' + s.error.detail + '). Keep Wizard open; Send or Discard still works.'); changed(); }
          finally { clearTimeout(notice); s.persistencePending = false; }
          if (!s.discard) s.writes = s.writes.then(() => drain(s));
        })();
      }
      if (s.interrupted) void finish(s, true).catch(() => {});
      else if (s.closeRequested) void finish(s).catch(() => {}); // its app closed while the mic was starting
      if (opts.maxMs) s.maxTimer = setTimeout(() => { void finish(s).catch(() => {}); }, Math.min(opts.maxMs, 2147483647));
      return session(s);
    } catch (e) {
      if (s.timedOut) { lateStart(s, !!opts.resumeId, e); throw e; }
      s.settled = true;
      // An established recorder must not be deleted on a storage failure. Preserve
      // its owner and expose retryable Stop instead of starting another physical mic.
      if (s.engine) { e.id = s.row.id; e.appId = s.row.appId; s.error = e; s.partial = true; s.phase = 'error'; changed(); void finish(s, true).catch(() => {}); }
      else {
        cleanup(s);
        // A native start might have succeeded before its bridge reply failed.
        // Keep the reservation recoverable instead of deleting the only owner hint.
        if (s.row.native && !['mic_permission','mic_busy','native_busy','busy_other_meeting','bad_meeting_id','permission_denied','busy'].includes(e.code) && e.name!=='NotAllowedError') {
          s.row.status='recoverable';s.row.partial=true;try {await put(s.row);const recovered=await adapter(opts)?.recover?.(s.row);if(recovered?.live)recoveryLive.add(s.row.id);}catch(_){}
        }
        else { try { await remove(s.row.id); } catch (_) {} }
        release(s);
      }
      if (e.name === 'NotAllowedError') throw fail('permission_denied', 'Microphone access was denied.', { cause: e });
      throw e;
    } finally { s.readyResolve(); }
  }
  // Recover only this app's live take. Never accept a caller-supplied owner or borrow another app's mic.
  async function attach(appId) {
    validate(appId, {});
    const s = active;
    if (s?.row.appId === appId) {
      await s.readyPromise;
      if (active !== s) return null;
      s.reattached = true; // a stale document's failed start must not stop the take this document now owns
      return session(s);
    }
    if (s) return null;
    // Nothing physical to reattach: an old browser take is pending custody, not a live mic.
    // Do not wait on IndexedDB/recovery before a fresh tap can start.
    if (!configuredNative && !meetingBridge()) {
      let a; try { a = JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null'); } catch (_) { a = { unknown: true }; }
      if (!a && ![...recoveryLive].some(id => ownedRows.get(id)?.appId === appId)) return null;
    }
    await ready; await recover();
    const row = [...recoveryLive].map(id => ownedRows.get(id)).find(r => r?.appId === appId);
    return row ? start(appId, {kind: row.kind, resumeId: row.id, meta: row.meta}) : null;
  }
  // A chat opening may salvage its own orphan, but must never attach()/resume() it as a live mic.
  async function settle(appId, keepId = null) {
    validate(appId, {});
    const prior = active; // snapshot BEFORE awaits: a later mic tap is never stopped by old cleanup
    if (prior?.row.appId === appId && prior.row.id !== keepId) await closeApp(appId);
    await ready;
    let unlock, lease;
    try {
      unlock = await acquire(true);
      lease = {unlock, cancelled:false}; recoveryLease = lease;
      await recoverLocked(lease);
      for (const row of await rows()) {
        if (lease.cancelled || active) break; // a tap yielded recovery; never touch the newer recorder
        if (row.appId !== appId || row.id === keepId || row.kind !== 'audio' || !row.nativeId || row.status !== 'recoverable') continue;
        const a = adapter({kind:row.kind}, row);
        const recovered = await a.recover?.(row, {stopOnly:true});
        if (!recovered || recovered.live) continue; // unknown custody is retained, never acknowledged
        recoveryLive.delete(row.id);
        if (recovered.blob && !row.bytes) {
          const s = {row, queue:[], writes:Promise.resolve(), opts:{}, limit:DEFAULT_LIMIT};
          enqueue(s, recovered.blob); await s.writes; if (s.error) throw s.error; Object.assign(row,s.row);
        }
        if (recovered.meta) row.meta = {...row.meta,native:recovered.meta};
        if (recovered.durationMs != null) row.durationMs = recovered.durationMs;
        await put({...row,status:'pending',partial:true,recoveryError:null});
      }
    } catch (e) { if (!['busy','recovery_yielded'].includes(e.code)) throw e; }
    finally { if (recoveryLease === lease) recoveryLease = null; unlock?.(); }
    // Busy/yielded recovery is not a settled take. Never offer a live orphan for upload/ack.
    return Promise.all((await rows()).filter(r => r.appId === appId && r.status === 'pending').map(result));
  }
  async function pending(appId) {
    validate(appId, {});
    const memory = [...memoryTakes.values()].filter(t => t.session.row.appId === appId).map(t => t.result);
    if (memory.length) return memory; // keep a retry usable even while the store is unavailable
    await ready; await recover();
    const selected = (await rows()).filter(r => r.appId === appId && ['pending', 'recoverable'].includes(r.status));
    // Expose safely repaired browser takes even if an unrelated native bridge is indeterminate.
    // But [] is used by app owners as positive empty-custody proof: never forge that proof from unknown truth.
    if (!selected.length && (recoveryError || unknownMeetingActive || !ownershipLoaded ||
        [...ownedRows.values()].some(r => r.appId === appId && r.status !== 'pending')))
      throw recoveryError || fail('capture_custody_uncertain', 'Capture ownership is still being recovered.');
    return Promise.all(selected.map(result));
  }
  async function ack(appId, id) {
    validate(appId, {});
    const memory = memoryTakes.get(id);
    if (memory) {
      const s = memory.session;
      if (s.row.appId !== appId) throw fail('forbidden', 'Capture belongs to another app.');
      // The app has confirmed its own durable backend/outbox handoff. No IDB row is required.
      if (s.row.nativeId && s.row.native !== 'wizard-meetings')
        await bounded(Promise.resolve().then(() => adapter({ kind: s.row.kind }, s.row).ack?.(s.row))).catch(() => {});
      await bounded(remove(id)).catch(() => {});
      memoryTakes.delete(id); ownedRows.delete(id); s.memoryParts = []; s.queue.length = 0; s.final = null; s.uploads = {};
      changed(); return;
    }
    await ready;
    if (typeof id !== 'string' || id.length > 128) throw fail('invalid_id', 'Invalid capture id.');
    if (active?.row.id === id) throw fail('capture_active', 'Stop capture before acknowledging it.');
    // A pending upload may finish while a NEW take owns the mic. Serialize only
    // acknowledgments of this row, never claim the physical microphone lock.
    return navigator.locks.request(DB_NAME + ':ack:' + id, async () => {
      const row = (await rows()).find(r => r.id === id && r.appId === appId);
      if (!row) throw fail('not_found', 'No pending capture belongs to this app.');
      if (row.status !== 'pending') throw fail('capture_active', 'A recoverable native recording must be stopped before acknowledgment.');
      if (row.nativeId && row.native !== 'wizard-meetings') await adapter({ kind: row.kind }, row).ack?.(row);
      await remove(id);
    });
  }
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(DB_NAME + ':ownership') : null;
  if (channel) channel.onmessage = () => { rows().then(all => { ownedRows.clear(); for (const r of all) ownedRows.set(r.id,r); ownershipLoaded = true; changed(); }).catch(() => {}); };
  const ready = openDB().then(() => recover()).catch(e => { recoveryError = e; changed(); });
  /* Closing an app closes it (James, 19 Oct 2026). The shell calls this when the last window of an app is
   * closed: the app's microphone stops at once and its take is saved (status pending, never discarded), so
   * the app offers it for recovery the next time it opens. Frame reloads, hidden desks and Back never call
   * this; only an explicit close does. Host-only: apps cannot close another app's capture. */
  function closeApp(appId) {
    validate(appId, {});
    for (const p of [...preparations.values()]) if (p.appId === appId) discardPrepared(appId, p.id);
    const s = active;
    if (!s || s.row.appId !== appId || s.discard || s.cancelPromise) return Promise.resolve(null);
    s.closeRequested = true;
    // Starting or lent to the orb: the start/loan return path finishes it, without reopening the mic.
    if (s.phase === 'starting' || s.borrow) { changed(); return Promise.resolve({ id: s.row.id, deferred: true }); }
    if (s.borrowWork) { // a loan is starting or ending: settle it first, then whichever path owns the boundary stops
      const work = s.borrowWork;
      return work.catch(() => {}).then(() => active === s && !s.borrow && !s.finishPromise ? finish(s) : null).then(() => ({ id: s.row.id, saved: true }));
    }
    return finish(s).then(() => ({ id: s.row.id, saved: true }));
  }
  /* Shell reload ("Update ready · Reload"). Only a native meeting recorder runs outside this page: the Android
   * foreground service keeps recording and uploading, and the next page load re-adopts it (recoverLocked marks
   * the row live, the app reattaches with resumeId). Every other recorder (browser mic, device AAC takes, a
   * microphone loan to the orb, start/stop/save in flight, an unknown native owner) would lose audio, so it
   * blocks. keeps names the meeting that survives; the shell uses it to let that app's capture holds through. */
  // Synchronous page-memory proof, independent of slow/unavailable durable recovery.
  // Stored rows survive navigation; in-page engines and unacknowledged takes do not.
  function pageAudioFree() {
    if (active || preparations.size || memoryTakes.size || attachedMeetingBridge ||
        W.wizardNative?.meetings || configuredNative) return false;
    try { return !JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null')?.id; }
    catch (_) { return false; }
  }
  function cancelReloadRecovery() {
    if (!pageAudioFree()) return false;
    // Cancel before navigation so late storage/native callbacks cannot adopt an owner.
    yieldRecovery(); return true;
  }
  function reloadCheck() {
    const no = reason => {
      const row = active?.row || [...memoryTakes.values()][0]?.session?.row || [...recoveryLive].map(id => ownedRows.get(id)).find(Boolean) || [...ownedRows.values()].find(r => r.status !== 'pending');
      return { safe: false, reason, keeps: null, appId: row?.appId || null, startedAt: row?.startedAt || null, recheck: !active && preparations.size === 0 };
    };
    const pageHoldsNoAudio = !active && preparations.size === 0 && !recoveryLease &&
      !attachedMeetingBridge && !W.wizardNative?.meetings && !configuredNative;
    if (preparations.size) return no('capture_starting');
    if (memoryTakes.size) return no('capture'); // this page still owns audio until the app acknowledges handoff
    let uncertain = !ownershipLoaded || recoveryError ? 'capture_custody_uncertain' : null;
    if (!uncertain && (unknownMeetingActive || [...ownedRows.values()].some(r => r.native && !r.nativeId && ['starting', 'recording', 'recoverable'].includes(r.status)))) uncertain = 'native_owner_uncertain';
    if (uncertain && !pageHoldsNoAudio) return no(uncertain);
    try { if (JSON.parse((W.WizardOSDevice || W.WosDeviceRecording?.device())?.recActive?.() || 'null')?.id) return no('device_recording'); } catch (_) { return no('device_recording'); }
    // Only the Android app's meeting port (MeetingRecorderService) is known to record and upload on its own
    // through a page reload. The Mac app's recorder and any bridge attached in-page wait for the end instead.
    const survives = !attachedMeetingBridge && !W.wizardNative?.meetings && !!W.wizardMizelPort;
    const isMeeting = r => survives && r?.native === 'wizard-meetings' && !!r.nativeId && r.kind === 'meeting';
    const keep = r => ({ appId: r.appId, id: r.id, meetingId: r.meta?.meetingId || r.nativeId });
    const live = [...recoveryLive].map(id => ownedRows.get(id)).filter(Boolean);
    if (!uncertain && [...ownedRows.values()].some(r => r.status !== 'pending' && !(active && r.id === active.row.id) && !recoveryLive.has(r.id))) uncertain = 'capture_custody_uncertain';
    if (uncertain && !pageHoldsNoAudio) return no(uncertain);
    if (active) {
      const s = active;
      const steady = isMeeting(s.row) && !!s.engine && ['recording', 'paused'].includes(s.phase) && !s.borrow && !s.borrowWork &&
        !s.finishPromise && !s.error && !s.engineDetached && !s.interrupted && !s.discard;
      if (live.some(r => r.id !== s.row.id)) return no('capture_custody_uncertain');
      if (!steady) {
        const blocked = no(s.borrow || s.borrowWork ? 'microphone_loan' : 'capture');
        // Waiting for an end is a positive live-engine contract, not a synonym for unsafe custody.
        blocked.waitForEnd = !!s.engine && ['recording', 'paused', 'stopping'].includes(s.phase) &&
          !s.borrow && !s.borrowWork && !s.error && !s.engineDetached && !s.interrupted && !s.discard;
        return blocked;
      }
      return { safe: true, reason: null, keeps: keep(s.row) };
    }
    if (live.length > 1 || live.some(r => !isMeeting(r))) return no('capture');
    // IndexedDB rows and Android services survive reload. Unknown custody is not page-held audio;
    // retain the uncertainty (never a durable/empty-custody proof) and leave recovery to the next boot.
    if (uncertain && pageHoldsNoAudio) return { safe: true, reason: null, keeps: live[0] ? keep(live[0]) : null,
      recheck: true, durable: false, uncertain };
    return { safe: true, reason: null, keeps: live[0] ? keep(live[0]) : null,
      recheck: true, durable: ownershipLoaded && !recoveryError && live.length === 0 &&
        [...ownedRows.values()].every(r => r.status === 'pending') };
  }
  /* Host-only rescue. Metadata exposed to notices is app + date only, never a title/content.
   * A stored browser row belongs to a previous page unless it is the active session. Native
   * rows require positive quiet truth at execution time; age alone never proves native quiet. */
  function staleTakes() {
    if (active || preparations.size) return [];
    const all = new Map(ownedRows);
    for (const [id, t] of memoryTakes) all.set(id, t.session.row);
    return [...all.values()].filter(r => r.id !== active?.row.id && !preparations.size &&
      // Only takes from an earlier page session that are over 10 minutes old: a take this page started (an
      // upload or acknowledgement the app is still running) is never offered for Save/Discard.
      Number(r.startedAt) < PAGE_BOOT_AT && Date.now() - Number(r.startedAt) > 10 * 60e3 &&
      (!r.native || (r.status === 'pending' && r.rescueComplete === true)) && !recoveryLive.has(r.id)).map(r =>
      ({ id: r.id, appId: r.appId, startedAt: r.startedAt, memory: memoryTakes.has(r.id) }));
  }
  const PAGE_BOOT_AT = Date.now(); // takes started before this page loaded are the only rescue candidates
  let rescueWork = null;
  function rescueTake(id, action, confirmed = false) {
    if (!['save', 'discard'].includes(action)) return Promise.reject(fail('invalid_action', 'Choose Save to Files or Discard.'));
    if (action === 'discard' && confirmed !== true) return Promise.reject(fail('confirm_discard', 'Tap Discard again to permanently delete this recording.'));
    if (rescueWork) return Promise.reject(fail('busy', 'A recording is already being saved.'));
    rescueWork = rescueRun(id, action).finally(() => { rescueWork = null; });
    return rescueWork;
  }
  async function rescueRun(id, action) {
    let unlock;
    const quiet = async row => {
      if (active || preparations.size || recoveryLease || unknownMeetingActive ||
          !staleTakes().some(t => t.id === id)) throw fail('capture_active', 'A recording is running or still being recovered. Nothing was cleared.');
      let device;
      const deviceBridge = W.WizardOSDevice || W.WosDeviceRecording?.device();
      try { device = JSON.parse(deviceBridge?.recActive?.() || 'null'); }
      catch (_) { throw fail('native_owner_uncertain', 'Could not check the phone recorder. Nothing was cleared.'); }
      if (device !== null) throw fail('capture_active', 'The phone recorder is running. Nothing was cleared.');
      const bridge = meetingBridge();
      if (row.native && ((row.native === 'wizard-device' && typeof deviceBridge?.recActive !== 'function') ||
          (row.native === 'wizard-meetings' && !bridge) || !['wizard-device', 'wizard-meetings'].includes(row.native)))
        throw fail('native_owner_uncertain', 'The native recorder cannot be checked. Nothing was cleared.');
      if (bridge) {
        const st = await bounded(Promise.resolve().then(() => bridge.status?.()), 1500, 'recovery_timeout');
        if (st?.recording !== false) throw fail('native_owner_uncertain', 'The native recorder is running or cannot be checked. Nothing was cleared.');
      }
      if (row.native && row.status !== 'pending') throw fail('native_owner_uncertain', 'Recover this recording in Recorder first. Nothing was cleared.');
    };
    try {
      unlock = await acquireBounded(); // non-queuing; another page or recording always wins
      const memory = memoryTakes.get(id);
      const row = memory?.session.row || (await bounded(rows())).find(r => r.id === id);
      if (!row) throw fail('not_found', 'This recording has already been cleared.');
      await quiet(row);
      let receipts = [];
      if (action === 'save') {
        const take = memory?.result || await bounded(result(row));
        if (!memory) {
          const blobs = [take.blob, ...(take.meta?.captureTracks || []).map(t => t.blob)];
          const payloadBytes = blobs.reduce((n, b) => n + b.size - (row.pcm ? 44 : 0), 0);
          if (!row.bytes || payloadBytes !== row.bytes) throw fail('empty_audio', 'Not every stored audio chunk could be read. Nothing was cleared.');
        }
        const audio = [{ blob: take.blob, source: 'voice' }, ...(take.meta?.captureTracks || []).map(t => ({ blob: t.blob, source: t.source }))];
        if (!audio[0].blob?.size) throw fail('empty_audio', 'No stored audio could be read. Nothing was cleared.');
        const stamp = new Date(row.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
        for (const track of audio) {
          const blob = track.blob;
          if (!blob?.size) throw fail('empty_audio', 'Part of this recording could not be read. Nothing was cleared.');
          const mime = blob.type || row.mime || 'audio/webm', ext = /wav/.test(mime) ? 'wav' : /mp4|aac/.test(mime) ? 'm4a' : 'webm';
          // Existing Chats upload route puts these in owner Files (no folder API on this route).
          const filename = 'Recovered-recording-' + stamp + '-' + track.source + '.' + ext;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          try {
            await bounded((async () => {
            const response = await fetch(W.WizConfig?.endpoint?.('upload') || '/wizard/files/upload', {
              method: 'POST', credentials: 'same-origin', signal: controller.signal,
              headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': filename, 'X-Wizard-Mime': mime }, body: blob });
            const receipt = await response.json();
            if (!response.ok || !/^[A-Za-z0-9._:-]{1,256}$/.test(receipt.file?.id || '') || receipt.file.bytes !== blob.size)
              throw fail('upload_unverified', 'Files did not confirm every audio byte. The recording is still kept.');
            const readback = await fetch('/wizard/files/' + encodeURIComponent(receipt.file.id) + '/content', { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
            if (!readback.ok || readback.status !== 200 || Number(readback.headers.get('content-length')) !== blob.size)
              throw fail('upload_unverified', 'Files could not read back every audio byte. The recording is still kept.');
            receipts.push(receipt.file);
            })(), 30000, 'upload_timeout');
          } finally { clearTimeout(timer); }
        }
      }
      // Native notifications are outside the browser lock. Check again after slow upload.
      await quiet(row);
      if (row.nativeId && row.native !== 'wizard-meetings')
        await bounded(Promise.resolve().then(() => adapter({ kind: row.kind }, row).ack?.(row)));
      // Only this explicit discard or verified upload authorizes removal. Never swallow a failed delete.
      await bounded(remove(id));
      if (memory) {
        memoryTakes.delete(id); memory.session.memoryParts = []; memory.session.queue.length = 0;
        memory.session.final = null; memory.session.uploads = {};
      }
      recoveryLive.delete(id); changed(); return { cleared: true, files: receipts };
    } finally { unlock?.(); }
  }
  // Reload may re-probe an abandoned owner, never Stop/Cancel a live session. Recovery holds the same
  // microphone lock as Start and only commits pending custody; no ack/delete or app data is involved.
  let reloadReconcile = null;
  function reconcileReload() {
    if (!reloadReconcile) reloadReconcile = (async () => {
      await ready;
      if (!active && !preparations.size) await recover();
      return reloadCheck();
    })().finally(() => { reloadReconcile = null; });
    return reloadReconcile;
  }
  // Last moment before the shell reloads with a kept native meeting: let queued backup-PCM writes land (bounded).
  async function prepareReload() {
    const s = active; if (!s) return;
    await Promise.race([Promise.resolve(s.writes).catch(() => {}), new Promise(r => setTimeout(r, 1200))]);
  }
  // Host-only adapter seam. Apps get only the frozen facade via app-services;
  // never expose configureNative through RPC or allow arbitrary bridge eval.
  W.WizAppCapture = Object.freeze({ version: 1, start, attach, settle, pending, ack, prepare, discardPrepared, capabilities, getState: state,
    beginVoiceBorrow, endVoiceBorrow, reloadCheck, reconcileReload, pageAudioFree, cancelReloadRecovery, prepareReload, closeApp, staleTakes, rescueTake,
    current(appId) { validate(appId,{}); const r=active?.row.appId===appId ? active.row : [...recoveryLive].map(id=>ownedRows.get(id)).find(r=>r?.appId===appId);
      const live = active?.row.id === r?.id;
      return r ? {id:r.id,appId:r.appId,active:live,recording:live && active.phase === 'recording' && !!active.engine && !active.inputStopped,
        startedAt:r.startedAt,meta:JSON.parse(JSON.stringify(r.meta)),phase:live ? active.phase : 'recoverable'} : null; },
    configureNativeBridge(bridge) {
      if (active) throw fail('busy', 'Cannot replace an active meeting bridge.');
      if (bridge && (typeof bridge.start !== 'function' || typeof bridge.stop !== 'function')) throw fail('invalid_adapter', 'Meeting bridge must implement start/stop.');
      attachedMeetingBridge = bridge;
    },
    configureNative(value) { if (active) throw fail('busy', 'Cannot replace an active native adapter.'); if (value && typeof value.start !== 'function') throw fail('invalid_adapter', 'Native adapter must implement start.'); configuredNative = value; },
    async resume(appId, id, opts = {}) {
      if (active?.row.appId === appId && active.row.id === id) {
        if (active.phase === 'starting') throw fail('capture_starting', 'Wait for capture to finish starting.');
        for (const [key,opt] of [['pcm','onPcm'],['chunk','onChunk'],['state','onNativeState'],['warn','onWarn']])
          if (typeof opts[opt] === 'function') active.listeners[key]=new Set([opts[opt]]);
        return session(active);
      }
      return start(appId, { ...opts, resumeId: id });
    }
  });
  // Visibility/Back/frame reloads intentionally do nothing to the recorder; only an explicit app close
  // (closeApp, driven by the shell's window model) stops it. Before
  // shell unload request a last compressed chunk; durable prior chunks survive a
  // process kill. Web capture cannot physically continue through shell destruction.
  W.addEventListener('pagehide', () => { try { if (active?.rec?.state === 'recording') active.rec.requestData(); } catch (_) {} });
})(typeof window === 'undefined' ? globalThis : window);
