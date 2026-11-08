/* Wizard UX core: voice capture and transcription, for shells that don't bring their own voice UI.
 * (The phone's orb has its own richer pipeline in app.js: arc controls, holds, aiming at desks.)
 *
 *   const v = WizCore.voice({ onState, onLevel })
 *   v.start()          → begins recording ('listen')
 *   v.finish()         → Promise<{ text, blob, ms }>: stops and transcribes via api/transcribe
 *                        (on failure: { text: '', blob, error }, so the caller can send the recording itself)
 *   v.cancel()         → deletes short takes; keeps ≥20 s ones in the shared cancelled-recordings store (returns true)
 *   v.state            → 'idle' | 'listen' | 'think'
 *   v.elapsed()        → ms recorded so far
 */
(() => {
  'use strict';
  // Opening a Bluetooth headset's mic flips the headset from music (A2DP) to call mode (HFP):
  // music goes muffled, quiet or drops out while you talk (James, 14 Oct). Record from the
  // computer's built-in mic instead, so headphones keep playing music. A USB/wired mic the
  // user plugged in still wins; no built-in mic → the system default, as before.
  const BLUETOOTH = /bluetooth|bluez|airpods|beats|buds|headset|hands-?free|\bh[fs]p\b|wh-1000|wf-1000|bose|jabra|soundcore|pixel buds/i;
  const BUILT_IN = /built-?in|internal|digital mic|macbook|laptop|analog stereo|front mic|dmic|imac|studio display|display audio/i;
  const WIRED = /usb|yeti|rode|shure|scarlett|focusrite|audio interface|webcam|brio|c9[0-9]{2}/i;
  async function pickMic() {
    try {
      if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) return null; // phones route mics themselves
      const ins = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && !/^(default|communications)$/.test(d.deviceId));
      if (!ins.some(d => d.label)) return null; // no permission yet: labels hidden
      const wired = ins.find(d => WIRED.test(d.label) && !BLUETOOTH.test(d.label));
      if (wired) return wired.deviceId; // pick it explicitly: the system default may be a Bluetooth headset
      const builtIn = ins.find(d => BUILT_IN.test(d.label) && !BLUETOOTH.test(d.label));
      return builtIn ? builtIn.deviceId : null;
    } catch (e) { return null; }
  }
  // Desktop: no echo cancellation. On macOS it switches the input to the system voice-processing path, which ducks
  // or briefly pauses whatever is playing (music in headphones dips each time a take starts). Speech is only
  // transcribed, and with headphones there is no echo to cancel. Phones keep it (speaker playback can echo).
  const PHONE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const BASE = { echoCancellation: PHONE, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } };
  // The Mac app (WKWebView) records the mono Mac mic as stereo Opus with the right channel silent (4 Nov 2026), so
  // every player and speech-to-text averages it down to half volume (-6 dB) and quiet takes lose words. When the
  // track is not already mono, record a mono copy: the left channel alone while the right one stays silent, the
  // average of both (no clipping) as soon as the right one carries sound, as a real stereo mic does. Anything off
  // (no Web Audio, a context that will not run) records the raw stream as before.
  const SILENT = 1e-4;
  async function monoFor(stream, ac) {
    try {
      const t = stream.getAudioTracks()[0]; const n = t?.getSettings?.().channelCount;
      if (!t || n === 1 || !ac || typeof ac.createMediaStreamDestination !== 'function') return null;
      if (ac.state !== 'running') { try { await Promise.race([ac.resume(), new Promise(r => setTimeout(r, 300))]); } catch (_) {} }
      if (ac.state !== 'running') return null; // a suspended graph would record silence
      const src = ac.createMediaStreamSource(stream), split = ac.createChannelSplitter(2);
      const left = ac.createGain(), right = ac.createGain(); left.gain.value = 1; right.gain.value = 0;
      const out = ac.createMediaStreamDestination(); out.channelCount = 1; out.channelCountMode = 'explicit'; out.channelInterpretation = 'discrete';
      src.connect(split); split.connect(left, 0); split.connect(right, 1); left.connect(out); right.connect(out);
      const probe = ac.createAnalyser(); probe.fftSize = 1024; split.connect(probe, 1);
      const buf = new Float32Array(probe.fftSize);
      const watch = setInterval(() => {
        if (ac.state === 'closed') return clearInterval(watch);
        probe.getFloatTimeDomainData(buf); let peak = 0; for (let k = 0; k < buf.length; k++) peak = Math.max(peak, Math.abs(buf[k]));
        if (peak > SILENT) { left.gain.value = 0.5; right.gain.value = 0.5; clearInterval(watch); }
      }, 100);
      return out.stream;
    } catch (_) { return null; }
  }
  async function openMic() {
    const id = await pickMic();
    if (id) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: { ...BASE, deviceId: { exact: id } } }); }
      catch (e) { if (e && e.name === 'NotAllowedError') throw e; } // device vanished: fall back to the default
    }
    return navigator.mediaDevices.getUserMedia({ audio: BASE });
  }
  function voice(opts = {}) {
    const V = { state: 'idle', chunks: [], rec: null, stream: null, ac: null, an: null, t0: 0, raf: 0 };
    const set = st => { V.state = st; try { opts.onState && opts.onState(st); } catch (e) {} };
    const stop = () => {
      try { V.stream && V.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { V.ac && V.ac.close(); } catch (e) {}
      cancelAnimationFrame(V.raf); V.stream = V.ac = V.an = null;
      try { opts.onLevel && opts.onLevel(0); } catch (e) {}
    };
    const tick = () => {
      if (V.an && opts.onLevel) {
        const a = new Uint8Array(V.an.fftSize); V.an.getByteTimeDomainData(a);
        let s = 0; for (let k = 0; k < a.length; k++) { const x = (a[k] - 128) / 128; s += x * x; }
        opts.onLevel(Math.min(1, Math.sqrt(s / a.length) * 4.2));
      }
      if (V.state === 'listen') V.raf = requestAnimationFrame(tick);
    };
    async function start() {
      if (V.state !== 'idle') return false;
      const shared = window.WizAppCapture?.getState?.();
      if (shared?.active || shared?.recording || shared?.hold) throw Object.assign(new Error('Microphone held by ' + (shared.appId || 'another app')), { code: 'busy', appId: shared.appId });
      V.pausedMs = 0; V.pauseAt = 0; V.chunks = []; V.captureId = 'capture-' + crypto.randomUUID(); V.t0 = performance.now(); V.cancelled = false; set('listen');
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('This browser has no microphone access here.');
        V.stream = await openMic();
        if (V.cancelled) { stop(); return false; }
        const AC = window.AudioContext || window.webkitAudioContext; V.ac = new AC();
        const src = V.ac.createMediaStreamSource(V.stream); V.an = V.ac.createAnalyser(); V.an.fftSize = 1024; src.connect(V.an);
        const mono = await monoFor(V.stream, V.ac);
        if (V.cancelled) { stop(); return false; }
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
        V.rec = new MediaRecorder(mono || V.stream, mime ? { mimeType: mime } : undefined);
        const captureId = V.captureId, chunks = V.chunks;
        V.rec.ondataavailable = e => { if (e.data && e.data.size) { chunks.push(e.data); window.WosOutbox?.capture(new Blob(chunks, { type: V.rec?.mimeType || 'audio/webm' }), captureId); } };
        V.rec.start(250); V.raf = requestAnimationFrame(tick);
        return true;
      } catch (e) { stop(); set('idle'); throw e; }
    }
    function cancel() {
      // A quick cancel is a decision: the take is deleted, not parked for recovery (James, 19 Oct). Only a long
      // take (≥ WosCancelled.KEEP_FROM_MS, 20 s) survives as a possible accident.
      V.cancelled = true; const id = V.captureId; V.captureId = null;
      const rec = V.rec, chunks = V.chunks, ms = (V.pauseAt || performance.now()) - V.t0 - (V.pausedMs || 0);
      const long = ms >= (window.WosCancelled?.KEEP_FROM_MS || 20000);
      if (id) { if (long) window.WosOutbox?.transition(id, 'held', 'Cancelled recording · original kept'); else Promise.resolve(window.WosOutbox?.get?.(id)?.captureWrite).catch(() => {}).then(() => window.WosOutbox?.remove(id)); }
      const keep = () => {
        if (!long || !chunks.length) return;
        const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' });
        if (id) Promise.resolve(window.WosOutbox?.capture(blob, id)).then(() => window.WosOutbox?.transition(id, 'held', 'Cancelled recording · original kept'));
        window.WosCancelled?.keepWeb(blob, ms, false, '', 'desktop');
      };
      // Capture this take before another recorder can replace V; onstop includes the final chunk.
      try { if (rec && rec.state !== 'inactive') { rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); }; rec.onstop = keep; rec.stop(); } else keep(); } catch (_) { keep(); }
      V.rec = null; stop(); set('idle');
      return long;
    }
    function finish(o = {}) {
      if (!['listen', 'paused'].includes(V.state)) return Promise.resolve(null);
      const ms = performance.now() - V.t0 - (V.pausedMs || 0) - (V.pauseAt ? performance.now() - V.pauseAt : 0);
      set('think');
      return new Promise(resolve => {
        const done = async () => {
          const blob = new Blob(V.chunks, { type: V.rec?.mimeType || 'audio/webm' });
          V.rec = null; stop();
          if (ms < 450 || blob.size < 1200) { set('idle'); return resolve({ text: '', blob: null, ms, error: 'Didn’t catch that' }); }
          // The durable outbox transcribes and keeps the recording itself: hand it the audio as is.
          if (o.transcribe === false) { set('idle'); return resolve({ text: '', blob, ms, captureId: V.captureId }); }
          try {
            const j = await window.WizConfig.transcribe(blob, { prompt: opts.prompt || window.WizConfig.voicePrompt() });
            set('idle'); resolve({ text: String(j.text || '').trim(), blob, ms, sttMs: j.ms });
          } catch (e) { set('idle'); resolve({ text: '', blob, ms, error: String(e.message || e) }); }
        };
        if (!V.rec || V.rec.state === 'inactive') return done();
        V.rec.onstop = done; try { V.rec.stop(); } catch (e) { done(); }
      });
    }
    function pause() { if (V.state !== 'listen' || V.rec?.state !== 'recording') return false; if (!window.WosCaptureTools.setPaused(V.rec,true)) return false; V.pauseAt = performance.now(); set('paused'); return true; }
    function resume() { if (V.state !== 'paused' || V.rec?.state !== 'paused') return false; if (!window.WosCaptureTools.setPaused(V.rec,false)) return false; V.pausedMs += performance.now() - V.pauseAt; V.pauseAt = 0; set('listen'); V.raf = requestAnimationFrame(tick); return true; }
    return { start, finish, cancel, pause, resume, get state() { return V.state; }, elapsed: () => (['listen','paused'].includes(V.state) ? (V.pauseAt || performance.now()) - V.t0 - (V.pausedMs || 0) : 0) };
  }
  window.WizCore = window.WizCore || {};
  window.WizCore.voice = voice;
  window.WizCore.voice.pickMic = pickMic;
  window.WizCore.voice.monoFor = monoFor;
})();
