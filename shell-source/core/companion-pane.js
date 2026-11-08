/* Companion panes v1: one bound same-app view beside its owner, on either shell.
 * App Services verifies live registry/frame/document/path authority; this module owns
 * only placement, pairing, bounded delivery and lifetime. No app IDs or routes here. */
(() => {
  'use strict';
  const pairs = new Map(), ORIGIN = location.origin;
  const shell = () => window.__wos || window.__wux;
  const phone = () => !!window.__wos;
  const frame = id => document.querySelector(`.win[data-win="${id}"] iframe`);
  const idOf = f => f?.closest('.win')?.dataset.win;
  const desks = () => phone() ? shell()?.desks : shell()?.ws;
  const deskOf = id => desks()?.findIndex(d => d.wins.includes(id)) ?? -1;
  function focus(id) {
    const s = shell(), at = deskOf(id); if (!s?.wins[id] || at < 0) return false;
    if (phone()) s.goDesk(at, true); else if (s.cur !== at) s.goWs(at);
    s.focusWin(id); return true;
  }
  function pairOf(f) { const id = idOf(f); return [...pairs.values()].find(p => p.owner === id || p.peer === id); }
  function alive(p) {
    const s = shell(), f = frame(p.owner);
    return !!s?.wins[p.owner] && !!s.wins[p.peer] && f === p.frame &&
      f.contentDocument === p.doc && window.WizAppServices?.authorized(f) === true;
  }
  function close(p) {
    if (!p) return false;
    pairs.delete(p.owner);
    const s = shell(), owner = s?.wins[p.owner];
    const active = phone() ? s?.desks?.[s.idx]?.focus : s?.ws?.[s.cur]?.focus;
    if (owner) { if (p.oldShare === undefined) delete owner.share; else owner.share = p.oldShare; }
    p.off?.();
    if (s?.wins[p.peer]) s.closeWin(p.peer, true);
    if (owner && active === p.peer) focus(p.owner);
    else if (!phone() && s?.wins[active]) s.focusWin(active);
    return true;
  }
  // JSON-only and bounded, even for the synchronous client. Never relay arbitrary RPC or frame targets.
  function data(value) {
    const text = JSON.stringify(value ?? null);
    if (!text || text.length > 32768) throw new Error('Companion message must be JSON up to 32 KB');
    return JSON.parse(text);
  }
  function deliver(p, target, value, from) {
    const f = frame(target);
    if (!alive(p) || !f || window.WizAppServices?.authorized(f) !== true) return false;
    f.contentWindow.postMessage({ type: 'wizard:app:companion', version: 1, from, data: value }, ORIGIN);
    window.dispatchEvent(new CustomEvent('wizard:companion-delivery', { detail: { frame: f, data: value, from } }));
    return true;
  }
  function open(st, opts = {}) {
    const s = shell(), owner = idOf(st.frame), w = s?.wins?.[owner];
    if (!w || !desks() || deskOf(owner) < 0) throw new Error('Companion panes need the workspace shell');
    if (w.companionOwner) throw new Error('A companion cannot open another companion');
    const initial = data(opts.data);
    const share = opts.share === undefined ? 0.36 : opts.share;
    if (!Number.isFinite(share) || share < 0.15 || share > 0.6) throw new Error('Companion share must be between 0.15 and 0.6');
    if (opts.ownerShare !== undefined && (!Number.isFinite(opts.ownerShare) || opts.ownerShare < 0.15 || opts.ownerShare > 0.8)) throw new Error('Invalid owner share');
    let p = pairs.get(owner);
    if (p && (!alive(p) || p.path !== opts.path)) { close(p); p = null; }
    if (!p) {
      const oldShare = w.share, before = phone() ? s.desks[s.idx]?.id : s.ws[s.cur]?.focus;
      const spec = { app: 'frame', appId: st.appId + '-companion', servicesAs: st.appId,
        url: opts.path, title: String(opts.title || 'Companion').slice(0, 80), companionOwner: owner, share };
      let peer;
      if (phone()) {
        s.goDesk(deskOf(owner), true);
        peer = s.openWin(spec, { stay: true });
        if (peer) {
          const chat = s.desks.find(d => d.wins.some(id => s.wins[id]?.app === 'chats'));
          const app = s.desks.find(d => d.wins.includes(owner)), companion = s.desks.find(d => d.wins.includes(peer.id));
          if (app && companion && app !== companion) {
            const first = [chat, app, companion].filter((d, i, all) => d && !d.home && all.indexOf(d) === i);
            s.reorderDesks([...first.map(d => d.id), ...s.desks.filter(d => !d.home && !first.includes(d)).map(d => d.id)]);
          }
        }
        const back = s.desks.findIndex(d => d.id === before); if (back >= 0) s.goDesk(back, true);
      } else {
        if (opts.ownerShare !== undefined) w.share = opts.ownerShare;
        peer = s.newWin(spec, { ws: deskOf(owner) });
        if (before && s.wins[before]) s.focusWin(before);
      }
      if (!peer) { if (oldShare === undefined) delete w.share; else w.share = oldShare; return null; }
      p = { owner, peer: peer.id, frame: st.frame, doc: st.frame.contentDocument, path: opts.path, oldShare };
      pairs.set(owner, p);
      const f = frame(p.peer), load = () => ready(f);
      f?.addEventListener('load', load); p.off = () => f?.removeEventListener('load', load);
    }
    p.data = initial;
    deliver(p, p.peer, initial, 'app');
    if (opts.focus) focus(p.peer);
    return { id: p.peer };
  }
  function post(f, value) {
    const p = pairOf(f); if (!p || !alive(p)) return false;
    const owner = idOf(f) === p.owner, clean = data(value);
    if (owner) p.data = clean;
    return deliver(p, owner ? p.peer : p.owner, clean, owner ? 'app' : 'companion');
  }
  function ready(f) { const p = pairOf(f); if (p && idOf(f) === p.peer) deliver(p, p.peer, p.data, 'app'); }
  function back(id) { const p = [...pairs.values()].find(p => p.peer === id); return !!p && alive(p) && focus(p.owner); }
  function detach(f) { const p = pairs.get(idOf(f)); if (p?.frame === f) close(p); }
  function sweep() { for (const p of pairs.values()) if (!alive(p)) close(p); }
  function mount() { new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
  window.WizCompanionPane = Object.freeze({ open, post, ready, back, detach,
    close: f => close(pairOf(f)),
    focusApp: f => { const p = pairOf(f); return !!p && alive(p) && focus(p.owner); },
    inspect: () => [...pairs.values()].map(p => ({ owner: p.owner, peer: p.peer })),
  });
})();
