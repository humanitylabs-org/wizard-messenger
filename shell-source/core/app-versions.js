/* Per-app "updated · Reload" (James, 19 Oct: "similar to the whole app shell, when there's an update it posts
 * update ready and I hit refresh. Can we do that per app too?").
 *
 * An open app window keeps the code it loaded until it reloads, so an app released while its window is open
 * kept running the old version. This watches each installed app's live revision (the store-data installed-apps
 * feed: WAM commit, else version) and, for every app frame whose document loaded an older revision:
 *  - on screen: a strip at the top of that app's window, "<App> updated · Reload". Reload reloads only that
 *    frame, same URL and hash, so the app comes back where it was. Unsaved work (update holds) makes it wait.
 *  - off screen: reloads it quietly when nothing would be lost (no hold, capture, playing media, embedded
 *    player or typed text), so switching back already shows the new version; otherwise the strip waits there.
 * Cost: one ~5 KB same-origin GET every 2 min while Wizard is on screen, plus a local scan every 3 s. Apps need
 * no changes. Apps served by the shell itself are covered by the shell's own banner (core/web-update.js). */
(() => {
  'use strict';
  if (window.WizAppVersions) return;
  const S = window.WizAppServices;
  if (!S?.update?.frames) return;
  const FEED = new URL('../store-data/wizard/v1/installed-apps', document.currentScript.src).href;
  const POLL = 120e3, FRESH = 15e3, TICK = 3000;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let revs = null, at = 0, inflight = null, off = false;
  const hist = [];                 // recent feed readings [{ at, revs }], to date documents that loaded between checks
  const base = new WeakMap();      // app document -> revision live when it loaded
  const reloading = new WeakMap(); // frame -> the document being replaced (skip until it is gone)
  const strips = new Map();        // frame -> { el, rev, armed }
  const dismissed = new WeakMap(); // frame -> revision whose strip was closed with ×
  const log = [];
  const note = (...a) => { log.push([Date.now(), ...a]); if (log.length > 60) log.shift(); };

  function fetchRevs(force) {
    if (off) return Promise.resolve(revs);
    if (!force && revs && Date.now() - at < FRESH) return Promise.resolve(revs);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await fetch(FEED, { cache: 'no-store', credentials: 'same-origin' });
        if (r.status === 404) { off = true; note('feed-missing'); return revs; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json(), m = new Map();
        for (const a of Array.isArray(d?.wam) ? d.wam : []) {
          if (!a || typeof a.id !== 'string') continue;
          const rev = typeof a.commit === 'string' && a.commit ? a.commit : typeof a.version === 'string' ? a.version : '';
          if (rev) m.set(a.id, rev.slice(0, 80));
        }
        revs = m; at = Date.now(); hist.push({ at, revs: m }); if (hist.length > 30) hist.shift(); return revs;
      } catch (e) { note('feed-error', String(e?.message || e).slice(0, 80)); return revs; }
      finally { inflight = null; }
    })();
    return inflight;
  }
  function docOf(frame) {
    try { const d = frame.contentDocument; return d && d.location.href !== 'about:blank' && d.readyState !== 'loading' ? d : null; } catch (_) { return null; }
  }
  // The revision a document loaded: the last reading taken before it started loading. A release landing between
  // that reading and the load shows the strip once more than needed (a harmless reload); it is never missed.
  function loadedRev(doc, appId, now) {
    let t = 0; try { t = doc.defaultView.performance.timeOrigin; } catch (_) {}
    for (let i = hist.length - 1; i >= 0; i--) if (hist[i].at <= t) return hist[i].revs.get(appId) || now;
    return now; // loaded before Wizard's first reading: the shell and the app booted together
  }
  function appName(id) {
    try { for (const k of ['mobile', 'desktop']) { const a = window.WizCore.apps(k).APPS.find(x => x.id === id); if (a?.name) return a.name; } } catch (_) {}
    return id;
  }
  // Nothing the owner made or is hearing would be lost by reloading this app now.
  function safe(f) {
    if (f.holds.length || f.suspect) return false;
    try { if (window.WizAppCapture?.getState?.()?.active) return false; } catch (_) { return false; } // any recording: leave it alone
    const doc = docOf(f.frame); if (!doc) return false;
    try {
      const w = doc.defaultView;
      if (w.navigator.mediaSession?.playbackState === 'playing') return false;
      if ([...doc.querySelectorAll('audio,video')].some(m => !m.paused && !m.ended)) return false;
      if (doc.querySelector('iframe,embed,object')) return false; // embedded players and editors: leave to the owner
      if ([...doc.querySelectorAll('textarea,input')].some(e => !/^(hidden|checkbox|radio|range|button|submit|reset|file|color|image)$/i.test(e.type) && e.value !== e.defaultValue)) return false;
      if (doc.activeElement?.isContentEditable) return false;
    } catch (_) { return false; }
    return true;
  }
  function reload(f, how) {
    const doc = docOf(f.frame); if (!doc || reloading.get(f.frame) === doc) return;
    note('reload', f.appId, how); clearStrip(f.frame);
    reloading.set(f.frame, doc);
    try { f.frame.contentWindow.location.reload(); } catch (_) { try { f.frame.src = f.frame.src; } catch (__) {} }
  }
  function clearStrip(frame) { const s = strips.get(frame); if (!s) return; s.el.remove(); strips.delete(frame); }
  function paint(f, s) {
    const wait = s.armed ? (f.holds[0] || 'saving') : '';
    s.el.innerHTML = `<span class="app-upd-m"><b>${esc(appName(f.appId))}</b> updated</span>` +
      `<button type="button" data-go class="${wait ? 'armed' : ''}" ${s.keeping ? 'disabled aria-busy="true"' : ''}>${s.keeping ? 'Getting ready…' : wait ? 'Reloads after ' + esc(String(wait).toLowerCase().slice(0, 40)) : 'Reload'}</button>` +
      `<button type="button" class="app-upd-x" data-x aria-label="Hide until the next update" title="Later">×</button>`;
  }
  function showStrip(f, rev) {
    if (dismissed.get(f.frame) === rev) return;
    let s = strips.get(f.frame);
    if (s && s.rev === rev && s.el.isConnected) return;
    const host = f.frame.parentElement; if (!host) return;
    if (getComputedStyle(host).position === 'static') host.classList.add('app-upd-host');
    if (!s) {
      const el = document.createElement('div');
      el.className = 'app-upd'; el.setAttribute('role', 'status'); el.dataset.app = f.appId;
      s = { el, rev, armed: false }; strips.set(f.frame, s);
      el.addEventListener('click', async e => {
        let live = S.update.frames().find(x => x.frame === f.frame); if (!live) return clearStrip(f.frame);
        if (e.target.closest('[data-x]')) { dismissed.set(f.frame, s.rev); note('dismiss', f.appId); return clearStrip(f.frame); }
        if (!e.target.closest('[data-go]')) return;
        if (s.keeping) return;
        if (s.armed) { s.armed = false; paint(live, s); return; }          // second tap cancels the wait
        if (live.keepable && S.update.keepDrafts) {
          const doc = docOf(f.frame); s.keeping = true; paint(live, s);
          try { await S.update.keepDrafts(f.frame); } catch (_) { /* Unconfirmed holds still block. */ }
          finally { s.keeping = false; }
          live = S.update.frames().find(x => x.frame === f.frame);
          if (!live || docOf(f.frame) !== doc || strips.get(f.frame) !== s) return;
        }
        if (live.holds.length) { s.armed = true; paint(live, s); note('armed', f.appId); return; }
        reload(live, 'tap');
      });
    }
    s.rev = rev; paint(f, s);
    if (s.el.parentElement !== host) host.appendChild(s.el);
    note('strip', f.appId);
  }
  let scanning = false;
  async function scan(net) {
    if (scanning) return; scanning = true;
    try {
      let list = S.update.frames();
      // A document seen for the first time takes the revision live now: fetch one if ours is stale.
      const fresh = list.some(f => { const d = docOf(f.frame); return d && !base.has(d) && reloading.get(f.frame) !== d; });
      const r = await fetchRevs(net || (fresh && Date.now() - at > FRESH)); if (!r) return;
      list = S.update.frames();
      for (const s of [...strips.keys()]) if (!list.some(f => f.frame === s)) clearStrip(s);
      for (const f of list) {
        const doc = docOf(f.frame); if (!doc) continue;
        if (reloading.get(f.frame) === doc) continue;
        reloading.delete(f.frame);
        const now = r.get(f.appId); if (!now) continue;
        if (!base.has(doc)) base.set(doc, loadedRev(doc, f.appId, now));
        if (base.get(doc) === now) { clearStrip(f.frame); continue; }
        const s = strips.get(f.frame);
        if (s?.armed) { if (!f.holds.length) reload(f, 'after-hold'); else paint(f, s); continue; }
        const seen = !document.hidden && f.visible;
        if (!seen && safe(f)) { reload(f, 'quiet'); continue; }
        if (seen) showStrip(f, now);
      }
    } finally { scanning = false; }
  }
  let lastNet = 0;
  function tick() {
    const due = !document.hidden && Date.now() - lastNet > POLL;
    if (due) lastNet = Date.now();
    scan(due).catch(e => note('scan-error', String(e?.message || e).slice(0, 80)));
  }
  setInterval(tick, TICK);
  setTimeout(() => { lastNet = Date.now(); scan(true).catch(() => {}); }, 1200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastNet > 20e3) { lastNet = Date.now(); scan(true).catch(() => {}); } });
  window.WizAppVersions = Object.freeze({
    check: () => { lastNet = Date.now(); return scan(true); },
    state: () => ({ off, at, revs: revs ? Object.fromEntries(revs) : null, strips: [...strips.entries()].map(([fr, s]) => ({ app: s.el.dataset.app, rev: s.rev, armed: s.armed })), log: log.slice() }),
  });
})();
