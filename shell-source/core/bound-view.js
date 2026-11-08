/* Bound page provenance and feedback are shared; shell geometry is injected. */
(() => {
 'use strict';
  const BOUND_NOT = /^\/wizard\/(files|attachments|hermes|v1|api)\b|\.(png|jpe?g|gif|webp|avif|bmp|svg|pdf|apk|zip|mp4|mov|webm|mp3|m4a|wav|ogg)$/i;
  // Install and update pages are not views (James, 12 Oct: a Wizard OS release reply docked its download page). They
  // are about updating an app on the phone, not something to look at beside the thread. Wizard OS's own shell paths
  // are excluded too: the shell is already in front. Matching links are skipped; a later real view still binds.
  const BOUND_INSTALL = /^\/(index\.html)?$|^\/(downloads)\/|^\/reports\/(wizard-os|wizard-lock)(\/|$)|^\/wizard-os-home\/(?!(index|desktop)\.html$)./i;
  function boundAbs(href) {
    try { return window.WizConfig?.localURL ? window.WizConfig.localURL(href) : new URL(href, location.href); }
    catch (_) { return null; }
  }
  // What the latest reply in this painted thread points at: { key, app } or { key, url, title }, else null.
  function target(el, { findApp, APP, linkTitle, appAt }) {
    const all = el.querySelectorAll('.ch-msgs .msg.a'), last = all[all.length - 1]; if (!last) return null;
    const rk = all.length + ':' + last.textContent.length; // which reply this is (a new reply reloads the same view)
    for (const a of last.querySelectorAll('.bub a[href]')) {
      if (a.hasAttribute('data-session') || a.hasAttribute('data-mlink') || a.closest('[data-mi]')) continue;
      const u = boundAbs(a.getAttribute('href')); if (!u || !/^https?:$/.test(u.protocol) || u.origin !== location.origin) continue;
      if (BOUND_NOT.test(u.pathname) || BOUND_INSTALL.test(u.pathname)) continue;
      const DL = window.WizCore.deeplink;
      if (DL && DL.isOwn(u)) {
        const d = DL.parse(u.href), app = d && d.open && !d.video ? (APP[d.open] || findApp(d.open)) : null;
        if (app && app.kind === 'wizard' && app.url) return { key: 'app:' + app.id, win: { app: 'frame', appId: app.id }, rk };
        continue; // ?session= / ?view= links are this shell's own screens, not a view to review
      }
      const rel = u.pathname + u.search + u.hash;
      const owner = appAt && appAt(rel);
      if (owner) return { key: 'url:' + rel, win: { app: 'frame', appId: owner.id, url: rel, title: owner.name }, rk };
      return { key: 'url:' + rel, win: { app: 'frame', appId: 'link', url: rel, title: linkTitle(u) }, rk };
    }
    return null;
  }

 function create(H) {
   let busy = false; const off = new Map();
   const bound = id => H.windows().find(w => w.bound === id);
   function shown(wid, el) {
     if (busy) return; const w = H.win(wid); if (!w || w.app !== 'chats') return;
     busy = true;
     try {
       const sid = el && w.thread && w.thread !== '__new__' ? w.thread : '';
       let b = bound(wid);
       if (!sid || b && b.bsid !== sid) { if (b) H.close(b.id); off.delete(wid); b = null; if (!sid) return; }
       if (b && el.querySelector('.ch-msgs details.steps.live')) return;
       const t = target(el, H); if (!t) { if (b) H.close(b.id); return; }
       if (b && b.bkey === t.key) { if (b.brk !== t.rk && !H.visible(b.id)) { b.brk = t.rk; H.reload(b.id); } return; }
       if (off.get(wid) === sid + '|' + t.key || !H.visible(wid)) return;
       // A view James is looking at stays put for the reply it came from; a NEW reply that links somewhere else
       // replaces it (desktop shows it side by side, so it is always visible — James, 19 Oct 2026).
       if (b) { if (H.visible(b.id) && b.brk === t.rk) return; H.close(b.id); }
       const go = () => H.open({ ...t.win, from: Object.freeze({ ...H.from?.(wid), win: wid, sid, title: H.title(w), agent: w.agent || '' }), bound: wid, bsid: sid, bkey: t.key, brk: t.rk }, wid);
       // a layout placing the shell's opens (apps.routeOpens) may want no view beside the thread: links open when tapped
       if (!window.WosSkinHost?.routeOpen?.('beside', { url: t.win.url || '', app: t.win.appId || '' }, go)) go();
     } finally { busy = false; H.changed?.(); }
   }
   return { shown, dismiss(w) { if (w?.bound) off.set(w.bound, w.bsid + '|' + w.bkey); } };
 }
 function feedback(outbox, take, text, audio, files = []) {
   if (!take?.thread || take.thread === '__new__' || !take.route) return false;
   return outbox.enqueue({ kind: 'reply', sessionId: take.thread, text, audio, files, ...take.route, custodyId: take.custodyId, source: 'view-feedback', instructions: take.context || `Feedback on ${take.url || 'the bound page'}.` });
 }
 window.WosBoundView = { target, create, feedback, badge: w => w.from?.sid ? `<span class="rv-tag" title="Feedback goes to ${window.WizCore.esc(w.from.title || w.from.sid)}">Review</span>` : '' };
})();
