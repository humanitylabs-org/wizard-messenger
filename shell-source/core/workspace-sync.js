/* Workspace sync (Miguel's release): the same workspaces on every Wizard client.
 *
 * Each shell keeps its desks in localStorage. This module mirrors the part that should follow the owner between
 * devices to the box (Agent Service /wizard/v1/workspaces, owner access only): which desks exist, their
 * order, the apps on each, and the page or thread an app has open when it first arrives on a device. Window
 * layout, focus, full screen and the current desk stay per device, and an app already open on a device keeps its
 * own page (another device never yanks it). Closing a desk closes it everywhere; the box keeps it under Recently
 * closed (Settings) so any device can reopen it.
 *
 *   const sync = WosWorkspaceSync.create({ shell, read, apply })
 *     read()          → { desks: [{ id, wins: [window objects] }] }   this device's desks, in order
 *     apply(state, o) ← put the shared desks on this device; apply(null, { focus: deskId }) shows one desk
 *   sync.changed()  call after every local save; a real change is pushed, debounced
 *
 * Merging is per desk: an edit made here while another device changed a different desk keeps both; the same
 * desk edited on two devices keeps the later save. A device joining for the first time adopts the box's desks
 * and adds only those of its own the box lacks (by their apps), so each device's starter Chats desk never piles up. */
(() => {
  'use strict';
  const API = '/wizard/v1/workspaces'; // Agent Service (docs/workspaces.md in wizard-agent-service)
  // Phone and desktop keep separate desk stores on the same origin, so each keeps its own sync checkpoint.
  const KEY = shell => `wos.wsync.v2.${shell}`, OFF = 'wos.wsync.off';
  const APPS = new Set(['chats', 'frame', 'feature']);
  const FIELDS = ['appId', 'url', 'thread', 'agent', 'chatsProvider', 'title', 'query', 'featureId', 'featureOptions'];
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  // Bound views and review peeks belong to the chat that opened them; device-only apps stay on their device.
  const syncable = w => !!w && APPS.has(w.app) && !window.WosFeatures?.retired(w) && !w.bound && !w.from && !w.servicesAs && !w.preview;
  function pick(w) {
    const o = { id: w.id, app: w.app };
    for (const k of FIELDS) { const v = w[k]; if (v != null && v !== '' && !(k === 'thread' && v === '__new__')) o[k] = v; }
    return o;
  }
  const norm = s => ({ desks: (s?.desks || []).map(d => ({ id: d.id, wins: (d.wins || []).filter(syncable).map(pick) })).filter(d => d.wins.length) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const looseSig = d => d.wins.map(w => [w.app, w.appId || '', w.agent || ''].join('|')).sort().join('&');

  /* Three-way merge: start from the box's desks, replay what this device changed since `base`.
   * Closing wins over edits: a window or desk closed on one device stays closed when the other device only changed
   * something inside it (its page, thread or title). Only windows opened since `base` keep a closed desk alive, so a
   * close never needs doing twice. */
  const ids = d => new Set((d?.wins || []).map(w => w.id));
  function mergeDesk(b, mine, theirs) {
    const inBase = ids(b), inTheirs = ids(theirs), inMine = ids(mine);
    const baseWin = new Map(b.wins.map(w => [w.id, w])), theirWin = new Map(theirs.wins.map(w => [w.id, w]));
    const wins = mine.wins
      .filter(w => !inBase.has(w.id) || inTheirs.has(w.id))                     // closed there stays closed
      .map(w => (inBase.has(w.id) && same(baseWin.get(w.id), w) ? theirWin.get(w.id) : w)); // their edit unless mine
    for (const w of theirs.wins) if (!inBase.has(w.id) && !inMine.has(w.id)) wins.push(w); // opened there
    return { ...theirs, wins };
  }
  function merge(base, local, remote) {
    const B = new Map(base.desks.map(d => [d.id, d])), L = new Map(local.desks.map(d => [d.id, d]));
    const out = remote.desks.map(d => ({ ...d }));
    const at = id => out.findIndex(d => d.id === id);
    for (const [id, d] of B) { // closed here: gone, unless the other device opened something new on it meanwhile
      const j = at(id); if (L.has(id) || j < 0) continue;
      const fresh = out[j].wins.filter(w => !ids(d).has(w.id));
      if (fresh.length) out[j] = { ...out[j], wins: fresh }; else out.splice(j, 1);
    }
    local.desks.forEach((d, i) => {
      const b = B.get(d.id), j = at(d.id);
      if (!b) { if (j < 0) out.splice(Math.min(i, out.length), 0, d); }                         // opened here
      else if (!same(b, d)) {                                                                    // edited here
        if (j >= 0) out[j] = mergeDesk(b, d, out[j]);
        else { const fresh = d.wins.filter(w => !ids(b).has(w.id)); if (fresh.length) out.splice(Math.min(i, out.length), 0, { ...d, wins: fresh }); }
      }
    });
    // Desks reordered here: shared desks follow this device's order, the others keep their places.
    const order = ids => ids.filter(id => L.has(id) && B.has(id));
    if (!same(order(local.desks.map(d => d.id)), order(base.desks.map(d => d.id)))) {
      const slots = out.map((d, i) => (L.has(d.id) ? i : -1)).filter(i => i >= 0);
      const moved = slots.map(i => out[i]).sort((a, b) => local.desks.findIndex(d => d.id === a.id) - local.desks.findIndex(d => d.id === b.id));
      slots.forEach((i, k) => { out[i] = moved[k]; });
    }
    // A window changed here keeps this device's change wherever it now lives (the other device may have moved it).
    const all = s => new Map(s.desks.flatMap(d => d.wins.map(w => [w.id, w])));
    const baseAll = all(base), localAll = all(local);
    for (const d of out) d.wins = d.wins.map(w => { const l = localAll.get(w.id), b = baseAll.get(w.id); return l && b && !same(l, b) ? l : w; });
    // A window lives on one desk: where this device put it wins, otherwise its first desk.
    const mine = new Map(); local.desks.forEach(d => d.wins.forEach(w => mine.set(w.id, d.id)));
    const home = id => mine.has(id) && out.some(d => d.id === mine.get(id) && d.wins.some(w => w.id === id)) ? mine.get(id) : null;
    const seen = new Set();
    for (const d of out) d.wins = d.wins.filter(w => { const h = home(w.id); if (seen.has(w.id) || (h && h !== d.id)) return false; seen.add(w.id); return true; });
    return { desks: out.filter(d => d.wins.length) };
  }

  /* Put shared desks onto a device's own desk list. Desks and windows keep their local objects (focus, layout, the
   * page an app is on); new ones come from `state`; device-only windows stay on their desk; a desk with more
   * windows than the device shows keeps the rest in `d.more` so nothing is dropped from the shared copy. */
  function reconcile(localDesks, W, state, { fresh, max = Infinity }) {
    state = norm(state); // Old box checkpoints must not resurrect retired shell views.
    const placed = new Set(localDesks.flatMap(d => d.wins)), out = [], added = [];
    const remoteIds = new Set(state.desks.map(d => d.id));
    for (const r of state.desks) {
      const L = localDesks.find(d => d.id === r.id), d = L ? { ...L } : fresh(r.id);
      const ids = r.wins.map(w => { if (!W[w.id]) { W[w.id] = JSON.parse(JSON.stringify(w)); added.push(w.id); } return w.id; });
      const own = (L ? L.wins : []).filter(id => W[id] && !syncable(W[id]));
      const all = [...ids, ...own];
      d.wins = all.slice(0, max);
      const rest = all.slice(max).filter(id => syncable(W[id]));
      if (rest.length) d.more = rest.map(id => pick(W[id])); else delete d.more;
      rest.forEach(id => delete W[id]);
      if (!d.wins.includes(d.focus)) d.focus = d.wins[d.wins.length - 1] || null;
      out.push(d);
    }
    // Desks only this device has: device-only apps, or a fresh empty desk, stay where they were.
    localDesks.forEach((L, i) => {
      if (remoteIds.has(L.id)) return;
      const own = L.wins.filter(id => W[id] && !syncable(W[id]));
      if (L.wins.length && !own.length) return; // closed on another device
      const d = { ...L, wins: own }; delete d.more;
      if (!d.wins.includes(d.focus)) d.focus = d.wins[d.wins.length - 1] || null;
      out.splice(Math.min(i, out.length), 0, d);
    });
    const now = new Set(out.flatMap(d => d.wins));
    const removed = [...placed].filter(id => !now.has(id) && W[id]);
    return { desks: out, removed, added };
  }

  function label(shell) {
    const ua = navigator.userAgent || '';
    let what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'device';
    if (what === 'Android') {
      // WebView includes the model; reduced browser UAs expose only "K". Never label two phones just Android.
      const model = (ua.match(/Android[^;)]*;\s*([^;)]+)/)?.[1] || '').split(/\s+Build\//)[0].trim();
      let id = ls.get('wos.wsync.device', '');
      if (!id) { id = Math.random().toString(36).slice(2, 8); ls.set('wos.wsync.device', id); }
      what = model && !/^(K|wv)$/i.test(model) ? model.slice(0, 45) : `Android ${id}`;
    }
    return shell === 'desktop' ? `${what} desktop` : what;
  }

  function create({ shell, read, apply, title }) {
    const name = label(shell);
    const key = KEY(shell);
    // base = the box's desks as of rev; last = this device's desks as of base. Both are saved, so edits made offline
    // survive a reload and are merged and pushed when the box answers again.
    let st = ls.get(key, null) || { rev: -1, base: null, last: null };
    let lastLocal = st.last || null;
    let absent = false;
    let closed = [], info = { device: '', at: '' }, ok = null, timer = 0, busy = false, again = false, applying = false, alive = true;
    const off = () => ls.get(OFF, false) === true;
    const persist = () => { st.last = lastLocal; ls.set(key, st); };
    const emit = () => { try { window.dispatchEvent(new Event('wos:workspace-sync')); window.WosSettings?.refresh(); } catch (e) {} };
    const take = j => { closed = Array.isArray(j.closed) ? j.closed : []; info = { device: j.device || '', at: j.at || '' }; };
    const now = () => norm(read());
    // What this device shows is not on the box yet: keep the box's copy as the baseline (saved), so a reload still pushes it.
    const unsent = () => { lastLocal = st.base; persist(); };
    function put(state, opts = {}) {
      applying = true;
      try { apply(state, opts); } catch (e) { console.error('workspace sync', e); }
      finally { applying = false; }
      lastLocal = now(); persist();
    }
    async function req(method, path, body, signal) {
      const r = await fetch(API + path, { method, signal, cache: 'no-store', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => null);
      if (r.status === 404 && !(j && 'rev' in j)) { const e = new Error('absent'); e.absent = true; throw e; }
      if (j?.state) {
        j.state = norm(j.state); // Ignore retired windows from older clients, without changing their other desks.
        if (Array.isArray(j.closed)) j.closed = j.closed.map(c => ({ ...c, desk: norm({ desks: [c.desk] }).desks[0] })).filter(c => c.desk);
      }
      return { status: r.status, j };
    }
    let pending = null; // desks to save that already merge this device's edits onto the box's newest copy
    async function push() {
      timer = 0;
      if (off() || !alive || !st.base) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        for (let tries = 0; tries < 4; tries++) {
          const local = now();
          if (!pending && lastLocal && same(local, lastLocal)) break;
          const want = pending || merge(lastLocal || st.base, local, st.base);
          const { status, j } = await req('PUT', '', { baseRev: st.rev, device: name, state: want });
          if (!j || !Array.isArray(j.state?.desks)) throw new Error('state ' + status);
          st = { rev: j.rev, base: j.state }; persist(); take(j);
          if (status === 200) { pending = null; const cur = now(); if (same(cur, local)) put(j.state); else { pending = merge(local, cur, j.state); put(pending); unsent(); again = true; } break; }
          if (status !== 409) throw new Error('state ' + status);
          // Another device saved first: lay this device's edits over theirs, show that, save it.
          pending = merge(lastLocal || want, now(), j.state); put(pending); unsent();
        }
        ok = true;
      } catch (e) { if (e.absent) ok = null; else { ok = false; setTimeout(schedule, 5000); } }
      finally { busy = false; emit(); if (again) { again = false; schedule(); } }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(push, 500); }
    function changed() { if (!applying && !off()) schedule(); }
    function arrive(j) {
      take(j);
      const local = now();
      if (!st.base) { // first join: the box's desks, plus this device's own desks the box lacks
        const have = new Set(j.state.desks.map(looseSig)), ids = new Set(j.state.desks.map(d => d.id));
        const extra = local.desks.filter(d => !ids.has(d.id) && !have.has(looseSig(d)));
        st = { rev: j.rev, base: j.state }; persist();
        const joined = { desks: [...j.state.desks, ...extra] };
        put(joined, { join: true });
        if (extra.length) { pending = joined; unsent(); schedule(); }
        return;
      }
      const dirty = !!lastLocal && !same(local, lastLocal);
      st = { rev: j.rev, base: j.state }; persist();
      if (!dirty) { put(j.state); return; }
      pending = merge(lastLocal, local, j.state); put(pending); unsent(); schedule();
    }
    // One reader per client. A foreground/online event interrupts its hidden wait, backoff or suspended fetch;
    // starting a second loop here would race the first one and could apply an older snapshot after a save.
    let poll = null, wakeWait = null;
    function pause(ms) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(t); if (wakeWait === done) wakeWait = null; resolve(); };
        const t = setTimeout(done, ms); wakeWait = done;
      });
    }
    function wake() {
      if (!alive || off() || document.hidden) return;
      ok = null; // the next GET must be an immediate read, not another 25-second long-poll
      if (poll) { poll.woken = true; poll.abort(); }
      wakeWait?.();
      if (st.base && lastLocal && !same(now(), lastLocal)) schedule();
    }
    async function loop() {
      let fails = 0;
      while (alive) {
        if (off()) { await pause(5000); continue; }
        const controller = new AbortController(), baseline = st;
        poll = controller;
        const deadline = setTimeout(() => controller.abort(), 35000);
        try {
          const wait = document.hidden || !st.base || ok !== true ? 0 : 25; // answer at once until in sync, then long-poll
          const { status, j } = await req('GET', `?since=${st.base ? st.rev : -1}&wait=${wait}`, undefined, controller.signal);
          if (!alive || controller.woken || off()) continue;
          if (status !== 200 || !j || !Array.isArray(j.state?.desks)) throw new Error('state ' + status);
          // Revisions can be reused after restore/reset. Validate the snapshot too, including the first read of a
          // saved checkpoint. Ignore a read overtaken by this client's PUT instead of rolling its baseline back.
          if (!busy && st === baseline) {
            if (j.rev !== st.rev || !st.base || !same(j.state, st.base)) arrive(j); else take(j);
          }
          if (ok !== true) { ok = true; } emit(); fails = 0;
          if (document.hidden) await pause(15000);
        } catch (e) {
          if (!alive) break;
          if (controller.woken) continue;
          if (e.absent) { absent = true; ok = null; emit(); return; } // this box has no workspace sync: one-device shell, quietly
          ok = false; emit(); fails++;
          await pause(Math.min(30000, 1500 * 2 ** Math.min(fails, 5)));
        } finally {
          clearTimeout(deadline); if (poll === controller) poll = null;
        }
      }
    }
    function reopen(deskId) {
      const c = closed.find(x => x.desk?.id === deskId); if (!c) return false;
      const local = now();
      applying = true;
      try { apply({ desks: [...local.desks.filter(d => d.id !== deskId), c.desk] }, { reopen: true }); apply(null, { focus: deskId }); }
      finally { applying = false; }
      closed = closed.filter(x => x !== c); schedule(); emit(); return true;
    }
    function setOff(v) { ls.set(OFF, !!v); if (!v) { st = { rev: -1, base: null, last: null }; lastLocal = null; persist(); wake(); } emit(); }
    const flush = () => { if (timer) { clearTimeout(timer); push(); } };
    addEventListener('pagehide', flush);
    for (const type of ['pageshow', 'focus', 'online']) addEventListener(type, wake);
    for (const type of ['visibilitychange', 'resume']) document.addEventListener?.(type, wake);
    const start = setTimeout(loop, 300);
    if (st.base && lastLocal && !same(now(), lastLocal)) setTimeout(schedule, 0); // offline edits from before a reload
    const api = {
      changed, reopen, setOff, title, stop() {
        alive = false; clearTimeout(start); clearTimeout(timer); poll?.abort(); wakeWait?.();
        window.removeEventListener?.('pagehide', flush);
        for (const type of ['pageshow', 'focus', 'online']) window.removeEventListener?.(type, wake);
        for (const type of ['visibilitychange', 'resume']) document.removeEventListener?.(type, wake);
      },
      get on() { return !off(); }, get absent() { return absent; }, get ok() { return ok; }, get closed() { return closed; }, get info() { return info; }, get name() { return name; }, get rev() { return st.rev; },
    };
    window.WosWorkspaceSync.current = api;
    return api;
  }

  /* Settings › Workspace sync: on/off for this device, last change, Recently closed with Reopen. */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = iso => { const t = Date.parse(iso || ''); if (!isFinite(t)) return ''; const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const appName = w => { if (w.app === 'chats') return 'Chats'; try { return window.WosWorkspaceSync.current?.title?.(w) || w.title || w.appId || 'App'; } catch (e) { return w.title || w.appId || 'App'; } };
  const deskName = d => [...new Set(d.wins.map(appName))].join(', ');
  const shown = () => { const s = window.WosWorkspaceSync.current; return !!s && (s.ok !== null || !s.on); };
  function html() {
    const s = window.WosWorkspaceSync.current; if (!shown()) return '';
    const status = !s.on ? 'Off on this device' : s.ok === false ? 'Offline · your changes sync when you are back' : s.info.at ? `In sync · last change ${ago(s.info.at)}${s.info.device ? ' on ' + s.info.device : ''}` : 'In sync';
    const rows = s.on ? s.closed.slice(0, 6).map(c => `<button class="st-row" data-wsync="reopen" data-wsync-desk="${esc(c.desk.id)}" aria-label="Reopen ${esc(deskName(c.desk))}"><span class="st-ic">▢</span><span class="st-tx"><b>${esc(deskName(c.desk))}</b><small>Closed ${esc(ago(c.closedAt))}${c.device ? ' on ' + esc(c.device) : ''} · tap to reopen</small></span><span class="st-go">↺</span></button>`).join('') : '';
    return `<div class="st-group" data-wsync-group><h4>Workspace sync</h4><button class="st-row" data-wsync="toggle" role="switch" aria-checked="${s.on}"><span class="st-ic">⇄</span><span class="st-tx"><b>Same workspaces on every device</b><small>${esc(status)}</small></span><span class="st-go">${s.on ? 'On' : 'Off'}</span></button></div>${rows ? `<div class="st-group" data-wsync-closed><h4>Recently closed</h4>${rows}</div>` : ''}`;
  }
  function act(ctx, el) {
    const b = el.closest('[data-wsync]'), s = window.WosWorkspaceSync.current; if (!b || !s) return false;
    if (b.dataset.wsync === 'toggle') { s.setOff(s.on); ctx.toast?.('⇄', s.on ? 'Workspace sync on' : 'Workspace sync off on this device', 1800); }
    if (b.dataset.wsync === 'reopen') { const id = b.dataset.wsyncDesk; if (id && s.reopen(id)) ctx.toast?.('▢', 'Reopened', 1600); }
    ctx.render?.(); return true;
  }
  window.WosWorkspaceSync = { create, merge, reconcile, norm, syncable, html, current: null };
  try { window.WosSettings?.register({ id: 'workspace-sync', page: 'chats', aliases: ['workspace-sync', 'workspaces'], available: shown, html, act }); } catch (e) { console.error(e); }
})();
