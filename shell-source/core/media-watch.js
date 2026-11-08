/* Now playing (Miguel, 4 Nov 2026): what the installed apps are playing, and one place to pause it.
 *
 * Hosted apps are same-origin frames (iframe[data-own-app] on both shells), so the shell can see their <audio> and
 * <video> elements without any app change: capture listeners on each frame's document (media events don't bubble,
 * but capture sees them), plus a wrapper on the frame's HTMLMediaElement.prototype.play for elements never put in
 * the page (Music plays through `new Audio()`). Titles come from the frame's navigator.mediaSession metadata, else
 * the element's title, else nothing (callers show the app's name). Pausing calls el.pause(): an app's own Media
 * Session handlers are not callable from outside, and pausing the element is what they do anyway.
 *
 * Inert until someone watches: nothing is armed, wrapped or observed while no watcher holds it (WosSkinHost hands
 * it to tweaks/layouts as api.media). `passive` watchers hear changes but never arm it on their own (a layout that
 * marks its app icons while the Now playing tweak is on). The last active watcher leaving disarms everything and
 * puts every wrapped play() back.
 *
 * What counts: sound the owner hears. Muted or silent elements and clips under 3 s (UI sounds) are left out. Rule
 * for the list: an item stays while it plays; once paused it stays (with a play button) for a minute, then drops;
 * an ended or emptied element drops after a 4 s grace (the next track usually starts in between); a closed or
 * reloaded app drops at once. Cross-origin content (a YouTube embed, a link opened in a new tab) is unreachable. */
(function () {
  'use strict';
  const PAUSED_MS = 60000, GAP_MS = 4000, MIN_S = 3, MAX = 12;
  const FRAMES = 'iframe[data-own-app]';
  const EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange', 'durationchange', 'loadedmetadata', 'timeupdate'];
  const active = new Set(), passive = new Set();
  const recs = new Map();          // key -> { key, el, frame, appId, kind, at, stopAt, gone }
  const keyOf = new WeakMap();     // element -> key
  const frameOn = new Map();   // frame -> load handler
  let docs = [], protos = [];      // [{ doc, fn }], [{ P, orig, ours }] while armed
  let mo = null, seq = 0, order = 0, queued = false, sweep = 0, lastSig = '';
  const isDoc = typeof document !== 'undefined';

  const finite = n => Number.isFinite(n) ? n : null;
  const audible = el => !el.muted && el.volume > 0 && !(finite(el.duration) != null && el.duration < MIN_S);
  const playing = el => !el.paused && !el.ended;
  function frameDoc(f) { try { const w = f.contentWindow, d = w && w.document; return d && d.documentElement ? d : null; } catch (_) { return null; } }

  function track(frame, el) {
    if (!el || (el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO') || !frame?.dataset?.ownApp) return null;
    let key = keyOf.get(el);
    if (!key) { key = frame.dataset.ownApp + ':' + (++seq); keyOf.set(el, key); }
    let r = recs.get(key);
    if (!r) {
      r = { key, el, frame, appId: frame.dataset.ownApp, kind: el.tagName === 'VIDEO' ? 'video' : 'audio', at: 0, ord: 0, stopAt: 0, gone: false };
      recs.set(key, r);
      // Elements outside the page (new Audio()) never reach the document's capture listeners: listen on them too.
      if (!el.isConnected) for (const t of EVENTS) el.addEventListener(t, onEl, true);
    }
    return r;
  }
  function onEl(e) { const k = keyOf.get(e.currentTarget), r = k && recs.get(k); if (r) note(r, e.type); }
  function note(r, type) {
    if (!active.size) return;
    const el = r.el, now = Date.now();
    if (playing(el)) { if (type === 'play' || type === 'playing' || !r.at) { r.at = now; r.ord = ++order; } r.stopAt = 0; }
    else if (!r.stopAt) r.stopAt = now;
    if (type === 'ended' || type === 'emptied') r.gone = true; else if (playing(el)) r.gone = false;
    changed(type === 'timeupdate');
  }
  function onDocEvent(frame) {
    return e => { const el = e.target; if (!el || (el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO')) return; const r = keyOf.has(el) ? recs.get(keyOf.get(el)) : (playing(el) ? track(frame, el) : null); if (r) note(r, e.type); };
  }
  function armDoc(frame) {
    const d = frameDoc(frame); if (!d || docs.some(x => x.doc === d)) return;
    const fn = onDocEvent(frame);
    for (const t of EVENTS) d.addEventListener(t, fn, true);
    docs.push({ doc: d, fn });
    // play() on an element that isn't in the page: wrap the frame's own prototype (put back on disarm).
    try {
      const P = d.defaultView?.HTMLMediaElement?.prototype;
      if (P && !protos.some(x => x.P === P)) {
        const orig = P.play;
        const ours = function () { let r = null; try { r = track(frame, this); } catch (_) {} const p = orig.apply(this, arguments); if (r) queueMicrotask(() => note(r, 'play')); return p; };
        P.play = ours; protos.push({ P, orig, ours });
      }
    } catch (_) {}
    // Already playing when we arrived (the tweak loaded after the app started).
    try { for (const el of d.querySelectorAll('audio, video')) if (playing(el)) note(track(frame, el), 'play'); } catch (_) {}
  }
  function armFrame(f) {
    if (!active.size || !f || f.tagName !== 'IFRAME' || !f.dataset?.ownApp) return;
    if (!frameOn.has(f)) { const on = () => { prune(); armDoc(f); }; frameOn.set(f, on); f.addEventListener('load', on); }
    armDoc(f);
  }
  function scan() { if (isDoc) for (const f of document.querySelectorAll(FRAMES)) armFrame(f); }
  function prune() {
    let gone = false;
    for (const [k, r] of recs) {
      const d = frameDoc(r.frame);
      if (!r.frame.isConnected || !d || r.el.ownerDocument !== d) { recs.delete(k); gone = true; }
    }
    docs = docs.filter(x => { const live = x.doc.defaultView && x.doc.defaultView.document === x.doc; if (!live) try { for (const t of EVENTS) x.doc.removeEventListener(t, x.fn, true); } catch (_) {} return live; });
    if (gone) changed();
  }
  function arm() {
    if (!isDoc || mo) return;
    mo = new MutationObserver(muts => {
      let removed = false;
      for (const m of muts) {
        for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches?.(FRAMES)) armFrame(n); else n.querySelectorAll?.(FRAMES).forEach(armFrame); }
        if (m.removedNodes.length) removed = true;
      }
      if (removed) prune();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }
  function disarm() {
    mo?.disconnect(); mo = null;
    for (const x of docs) try { for (const t of EVENTS) x.doc.removeEventListener(t, x.fn, true); } catch (_) {}
    for (const x of protos) try { if (x.P.play === x.ours) x.P.play = x.orig; } catch (_) {}
    for (const r of recs.values()) if (!r.el.isConnected) for (const t of EVENTS) r.el.removeEventListener(t, onEl, true);
    for (const [f, fn] of frameOn) f.removeEventListener('load', fn);
    frameOn.clear();
    docs = []; protos = []; recs.clear(); clearTimeout(sweep); sweep = 0; lastSig = '';
  }

  // The list as watchers see it: newest play first.
  function meta(r) {
    try {
      const m = r.frame.contentWindow?.navigator?.mediaSession?.metadata;
      // The page's Media Session describes the element it last started: only the newest item of that app wears it.
      const newest = [...recs.values()].filter(x => x.appId === r.appId && x.frame === r.frame).sort((a, b) => b.ord - a.ord)[0];
      if (m && newest === r) return { title: String(m.title || '').slice(0, 200), artist: String(m.artist || '').slice(0, 200) };
    } catch (_) {}
    return { title: String(r.el.getAttribute?.('title') || '').slice(0, 200), artist: '' };
  }
  function live(r, now) {
    if (!r.frame.isConnected || !audible(r.el) || !r.at) return false;
    if (playing(r.el)) return true;
    return now - r.stopAt < (r.gone ? GAP_MS : PAUSED_MS);
  }
  function list() {
    if (!active.size) return [];
    const now = Date.now();
    return [...recs.values()].filter(r => live(r, now)).sort((a, b) => b.ord - a.ord).slice(0, MAX)
      .map(r => Object.freeze({ key: r.key, appId: r.appId, kind: r.kind, playing: playing(r.el), at: r.at, ...meta(r) }));
  }
  function changed(quiet) {
    if (queued) return; queued = true;
    queueMicrotask(() => {
      queued = false; if (!active.size) return;
      const l = list(), sig = JSON.stringify(l.map(x => [x.key, x.playing, x.title, x.artist]));
      // Next drop of a paused / ended item: look again then.
      clearTimeout(sweep); sweep = 0; const now = Date.now();
      const due = [...recs.values()].filter(r => live(r, now) && !playing(r.el)).map(r => r.stopAt + (r.gone ? GAP_MS : PAUSED_MS) - now);
      if (due.length) sweep = setTimeout(() => changed(), Math.max(50, Math.min(...due) + 20));
      if (quiet !== false && sig === lastSig) return;
      lastSig = sig;
      for (const fn of [...active, ...passive]) { try { fn(l); } catch (e) { try { console.warn('[media]', e); } catch (_) {} } }
    });
  }
  const find = key => { const r = recs.get(String(key)); return r && live(r, Date.now()) ? r : null; };
  function pause(key) { const r = find(key); if (!r || !playing(r.el)) return false; try { r.el.pause(); } catch (_) { return false; } return true; }
  function play(key) {
    const r = find(key); if (!r || playing(r.el)) return false;
    try { const p = r.el.play(); p?.catch?.(() => {}); } catch (_) { return false; }
    return true;
  }
  function pauseAll() { let n = 0; for (const x of list()) if (x.playing && pause(x.key)) n++; return n > 0; }
  // One key: the item played most recently. Playing → pause it; paused (still listed) → play it again.
  function toggle() { const x = list()[0]; if (!x) return false; return x.playing ? pause(x.key) : play(x.key); }

  function watch(fn, { passive: quiet = false } = {}) {
    if (typeof fn !== 'function') return () => {};
    const was = active.size;
    (quiet ? passive : active).add(fn);
    if (!was && active.size) arm();
    if (active.size) changed(false);
    let done = false;
    return () => {
      if (done) return; done = true; passive.delete(fn);
      if (active.delete(fn) && !active.size) { disarm(); for (const p of [...passive]) try { p([]); } catch (_) {} }
    };
  }

  const api = Object.freeze({ watch, list, pause, play, pauseAll, toggle, get armed() { return !!mo; },
    _test: { scan, prune, get size() { return recs.size; }, get docs() { return docs.length; }, get protos() { return protos.length; } } });
  if (typeof window !== 'undefined') window.WosMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
