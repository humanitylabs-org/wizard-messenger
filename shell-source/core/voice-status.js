/* Wizard UX core: the voice transcription provider card for Settings (feature/chat-polish). Both shells.
 * Read-only: GET <transcribe endpoint's folder>/status, e.g. /wizard/voice/status →
 *   { ready, provider, name, model, attested }   (legacy voice.ts VoiceProviderStatus)
 * WizCore.voiceStatus.card() returns the card's HTML from the last reading and starts a fresh read when the
 * last one is over a minute old; onChange(fn) fires when a reading lands so an open Settings can repaint.
 */
(() => {
  'use strict';
  const C = window.WizCore = window.WizCore || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let st = null, at = 0, loading = null;
  const subs = new Set();
  function url() {
    const W = window.WizConfig;
    if (W && W.has && !W.has('voice')) return '';
    const t = (W && W.endpoint && W.endpoint('transcribe')) || '/wizard/voice/transcribe';
    return t.replace(/[^/]*$/, 'status');
  }
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const u = url();
      if (!u) { st = { ready: false, provider: '', name: 'Voice isn’t set up on this Wizard', model: '', attested: false, off: true }; }
      else {
        try {
          const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const v = await r.json();
          st = { ready: v.ready === true, provider: typeof v.provider === 'string' ? v.provider : '', name: typeof v.name === 'string' && v.name ? v.name : 'Voice unavailable', model: typeof v.model === 'string' ? v.model : '', attested: v.attested === true };
        } catch (e) { st = { ready: false, provider: '', name: 'Voice unavailable', model: '', attested: false, err: true }; }
      }
      at = Date.now(); loading = null;
      subs.forEach(f => { try { f(st); } catch (e) {} });
      return st;
    })();
    return loading;
  }
  function card() {
    if (!st || Date.now() - at > 60e3) load();
    const s = st;
    const head = '<h4>Voice transcription</h4>';
    if (!s) return `<div class="st-group vx-card" data-voicecard="loading">${head}<div class="st-row static"><span class="st-tx"><b>Checking…</b><small>Reading this Wizard’s speech-to-text setup</small></span></div></div>`;
    const state = s.ready ? 'ready' : 'down';
    const sub = s.ready
      ? [s.model, s.attested ? 'Attested · audio is transcribed in a verified private enclave' : 'Ready'].filter(Boolean).join(' · ')
      : s.off ? 'Ask your Wizard to set up a transcription provider' : s.err ? 'Couldn’t read the voice status · it will retry' : 'Not ready · voice notes wait in Unsent until it is';
    return `<div class="st-group vx-card" data-voicecard="${state}">${head}<div class="st-row static"><span class="st-tx"><b>${esc(s.name)}${s.attested ? ' <i class="vx-badge" data-voiceattested>Attested</i>' : ''}</b><small>${esc(sub)}</small></span><span class="vx-dot ${state}" aria-label="${s.ready ? 'Ready' : 'Not ready'}"></span></div></div>`;
  }
  C.voiceStatus = { load, card, onChange: f => { subs.add(f); return () => subs.delete(f); }, get state() { return st; } };
})();
