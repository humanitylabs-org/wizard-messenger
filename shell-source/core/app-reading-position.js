/* Shell-owned reading places. Registered same-origin app documents only;
 * no app SDK, content storage, routing changes, or native rebuild required. */
(() => {
  'use strict';
  const PREFIX = 'wos.app-reading.v1:', MAX = 80, WAIT = 15000;
  const active = new Set();
  function selector(el, doc) {
    if (el === doc.scrollingElement) return ':root';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n !== doc.documentElement && parts.length < 16; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      parts.unshift(n.localName + ':nth-of-type(' + (1 + [...(n.parentElement?.children || [])].filter(x => x.localName === n.localName).indexOf(n)) + ')');
    }
    return parts.join(' > ');
  }
  function find(doc, path) { try { return path === ':root' ? doc.scrollingElement : doc.querySelector(path); } catch (_) { return null; } }
  function hash(el) {
    let h = 2166136261;
    for (const c of (el.textContent || '').trim().slice(0, 160)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }
  function visible(el) { return el && el.clientHeight > 0 && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'; }
  function flowAnchor(el, owner, doc) {
    // A sticky/fixed header does not move with the scroller. Its viewport offset
    // cannot reconstruct a reading place; keep the saved numerical position.
    for (let n = el; n && n !== owner; n = n.parentElement) {
      if (['sticky','fixed'].includes(doc.defaultView.getComputedStyle(n).position)) return false;
    }
    return true;
  }
  function snapshot(el, doc) {
    const root = el === doc.scrollingElement, box = root ? { top: 0, bottom: doc.defaultView.innerHeight } : el.getBoundingClientRect();
    // A short visible text block anchors the paragraph as fonts/images above it change.
    const anchor = [...el.querySelectorAll('p,h1,h2,h3,h4,li,blockquote,pre')].slice(0, 4000).find(n => {
      const b = n.getBoundingClientRect();
      let owner = n.parentElement;
      while (owner && owner !== el && !/auto|scroll/.test(doc.defaultView.getComputedStyle(owner).overflowY)) owner = owner.parentElement;
      return owner === el && flowAnchor(n, el, doc) && b.height > 0 && b.bottom > box.top + 1 && b.top < box.bottom;
    });
    return { path: selector(el, doc), x: el.scrollLeft, y: el.scrollTop, height: el.scrollHeight,
      ...(anchor ? { anchor: selector(anchor, doc), hash: hash(anchor), offset: anchor.getBoundingClientRect().top - box.top } : {}) };
  }
  function attach(frame, { appId, authorize, storage = sessionStorage }) {
    let current = null, stopped = false;
    const slot = frame.closest('[data-win]')?.dataset.win || appId;
    const keyFor = w => PREFIX + JSON.stringify([appId, slot, w.location.pathname + w.location.search + w.location.hash]);
    function bind(restore = true) {
      if (stopped || !authorize()) return;
      const w = frame.contentWindow, doc = w.document;
      if (!doc.body || (current?.doc === doc && current.key === keyFor(w))) return;
      current?.dispose();
      const key = keyFor(w), tracked = new Set(), offs = [];
      let restoring = true, held = false, pending = null, saveTimer = null, quiet = null, deadline = null, raf = null, budget = WAIT, started = 0;
      try {
        const value = JSON.parse(storage.getItem(key));
        if (restore && value?.v === 1 && Array.isArray(value.scrolls)) pending = value.scrolls.slice(0, 24).filter(s => typeof s.path === 'string' && s.path.length < 1500 && Number.isFinite(s.y) && s.y >= 0 && Number.isFinite(s.x) && Number.isFinite(s.height));
      } catch (_) {}
      const allowed = () => !stopped && frame.isConnected && authorize() && frame.contentWindow.document === doc && keyFor(w) === key;
      function save() {
        if (!allowed() || restoring || held || !visible(frame) || !visible(doc.documentElement)) return;
        for (const el of tracked) if (!el.isConnected || el.ownerDocument !== doc) tracked.delete(el);
        const root = doc.scrollingElement;
        if (root) tracked.add(root);
        // Includes a nested panel whose initial scroll was assigned by its own router.
        for (const el of doc.querySelectorAll('*')) {
          if (tracked.size >= 24) break;
          if (el.scrollTop > 0 || el.scrollLeft > 0) tracked.add(el);
        }
        const scrolls = [...tracked].filter(el => el.isConnected && visible(el) && (el === root || /auto|scroll/.test(w.getComputedStyle(el).overflowY + w.getComputedStyle(el).overflowX))).slice(0, 24).map(el => snapshot(el, doc));
        if (!scrolls.length) return;
        try {
          storage.setItem(key, JSON.stringify({ v: 1, at: Date.now(), scrolls }));
          const keys = Object.keys(storage).filter(k => k.startsWith(PREFIX));
          if (keys.length > MAX) keys.sort((a,b) => (JSON.parse(storage.getItem(a) || '{}').at || 0) - (JSON.parse(storage.getItem(b) || '{}').at || 0)).slice(0, keys.length - MAX).forEach(k => storage.removeItem(k));
        } catch (_) {} // storage denial must not break an app or Reload
      }
      function pause() {
        clearTimeout(quiet); clearTimeout(deadline); deadline = null;
        if (started) budget = Math.max(0, budget - (performance.now() - started));
        started = 0;
      }
      function stopRestore(reason = 'success') {
        if (!restoring) return;
        restoring = false; pending = null; held = reason === 'timeout';
        pause(); if (raf) cancelAnimationFrame(raf);
        observer.disconnect(); resize.disconnect();
        if (reason === 'success' || reason === 'user') save();
      }
      function attempt() {
        if (!restoring) return;
        if (!allowed()) { stopRestore('dispose'); return; }
        if (doc.hidden || !visible(frame) || !visible(doc.documentElement)) { pause(); return; }
        if (!deadline) {
          started = performance.now();
          deadline = setTimeout(() => { if (doc.hidden || !visible(frame)) pause(); else stopRestore('timeout'); }, budget);
        }
        let complete = true;
        for (const s of pending || []) {
          const el = find(doc, s.path);
          if (!visible(el)) { complete = false; continue; }
          tracked.add(el); resize.observe(el);
          const root = el === doc.scrollingElement, anchor = s.anchor && find(doc, s.anchor);
          let y = s.y;
          if (anchor && flowAnchor(anchor, el, doc) && hash(anchor) === s.hash && visible(anchor)) y = el.scrollTop + anchor.getBoundingClientRect().top - (root ? 0 : el.getBoundingClientRect().top) - s.offset;
          const max = Math.max(0, el.scrollHeight - el.clientHeight);
          // Reachable alone is insufficient: a surviving anchor can appear early
          // while the earlier text is still loading. Keep the original checkpoint.
          if (max + 2 < y || el.scrollHeight + 2 < s.height) complete = false;
          el.scrollTo({ left: s.x, top: Math.min(y, max), behavior: 'instant' });
        }
        clearTimeout(quiet);
        if (complete && doc.readyState === 'complete' && doc.fonts?.status !== 'loading' && ![...doc.images].some(img => !img.complete)) quiet = setTimeout(() => { if (doc.hidden || !visible(frame)) pause(); else stopRestore(); }, 1000);
      }
      function schedule() {
        if (!restoring || raf) return;
        raf = requestAnimationFrame(() => { raf = null; attempt(); });
      }
      const observer = new MutationObserver(schedule), resize = new ResizeObserver(schedule);
      function listen(target, type, fn, opts) { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); }
      const scroll = e => {
        if (authorize() && frame.contentWindow.document === doc && keyFor(w) !== key) { bind(false); current?.save(); return; }
        if (!allowed()) return;
        const el = e.target === doc ? doc.scrollingElement : e.target;
        if (el?.nodeType === 1) {
          for (const old of tracked) if (!old.isConnected || old.ownerDocument !== doc) tracked.delete(old);
          if (tracked.size < 24 || tracked.has(el)) tracked.add(el);
        }
        if (restoring) schedule();
        else { clearTimeout(saveTimer); saveTimer = setTimeout(save, 120); }
      };
      const user = e => {
        if (!e.isTrusted || (e.type === 'keydown' && !['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key))) return;
        if (restoring) stopRestore('user');
        else held = false; // after timeout, an actual user action adopts the current place
      };
      const routeFlush = () => { if (authorize() && frame.contentWindow.document === doc && keyFor(w) !== key) bind(false); current?.save(); };
      listen(doc, 'scroll', scroll, true);
      for (const t of ['pointerdown','touchstart','wheel','keydown']) listen(doc, t, user, { capture: true, passive: true });
      listen(w, 'pagehide', () => { save(); dispose(); });
      listen(w, 'beforeunload', routeFlush);
      listen(w, 'resize', schedule);
      listen(w, 'load', schedule, true);
      listen(w, 'hashchange', () => bind(false));
      listen(w, 'popstate', () => { if (keyFor(w) !== key) bind(false); });
      listen(doc, 'visibilitychange', () => { if (doc.hidden) { save(); pause(); } else schedule(); });
      function dispose() { save(); stopRestore('dispose'); clearTimeout(saveTimer); offs.forEach(off => off()); }
      current = { doc, key, save, dispose };
      if (pending?.length) {
        try { w.history.scrollRestoration = 'manual'; } catch (_) {}
        observer.observe(doc.body, { childList: true, subtree: true, attributes: true, characterData: true });
        resize.observe(doc.documentElement); resize.observe(frame);
        // Start the bounded restore window only when this parked app is visible.
        doc.fonts?.ready.then(schedule).catch(() => {});
        attempt();
      } else restoring = false;
    }
    const onLoad = () => { try { bind(); } catch (_) {} };
    const flush = () => { try { if (current && authorize() && current.doc === frame.contentWindow.document && current.key !== keyFor(frame.contentWindow)) bind(false); current?.save(); } catch (_) {} };
    const detach = () => { flush(); stopped = true; current?.dispose(); frame.removeEventListener('load', onLoad); active.delete(flush); };
    frame.addEventListener('load', onLoad); active.add(flush); onLoad();
    return detach;
  }
  const flush = () => { for (const save of active) save(); };
  addEventListener('pagehide', flush); addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.WizAppReadingPosition = Object.freeze({ attach, flush });
})();
