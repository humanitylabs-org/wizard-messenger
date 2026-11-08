/* Look sync: the owner's skin and tweak choices are one set, the same on every device and app (Miguel, 1 Nov 2026).
 *
 * The shared copy is one small file in the owner's Files, Pages/wizard-look/look.json, read and written through the
 * Agent Service Pages file API (GET/PUT /wizard/v1/pages/<slug>/<file>: owner only, versioned, a stale save is a 409
 * carrying the newer text, every save kept in Pages history). It has no page.json, so it is never listed as a page.
 * Each device still paints its last copy (wos.skin, wos.skin-tweaks.v1) at first frame; the box copy then wins.
 *
 *   { version: 1, skin: { id, at }, tweaks: { '<author>/<id>': { on, at } }, defaults?: { '<author>/<id>': { on, at } }, views?: { desktop?: { id, at }, phone?: { id, at } }, updated }
 *
 * `at` = an observed logical revision (not a device clock). 0 = an old local seed: never newer than a
 * real change. Merging is per choice, newest wins, so two devices switching different tweaks keep both. A device with
 * nothing on never writes until its owner changes something. The first device with tweaks on seeds the box; a device
 * syncing for the first time with more tweaks on than the box's seeds replaces those seeds (the set in daily use beats
 * one just being set up) and keeps every real change made since. Shell views
 * (manifest `view`) are chosen per shell type (Miguel, 4 Nov 2026): `views.desktop` / `views.phone` = the view id worn on
 * every desktop / every phone ('' = Desks), merged per type, newest wins; all his desktops match, all his phones match.
 * A type with no entry (every file from before) keeps the old meaning: the view switched on in `tweaks` is worn on every
 * shell it supports, and those legacy view entries stay exclusive (the newest one on is kept). `views` is only written
 * once a per-type choice is made, so an untouched file stays byte for byte as it was; an older shell ignores `views`
 * (its parse drops unknown fields) and, if it saves, the file falls back to the old meaning. Offline or failing box: the device keeps its
 * own copy, retries with backoff, and sends its changes when the box answers. Active foreground shells refresh every
 * 30 seconds and on load/foreground events. Built-in switches do not change owned recipes or script approval.
 *
 *   WosLookSync.create({ req, store, exp, skin }) → { sync, schedule, stop, state }   (started below for the shell) */
(() => {
  'use strict';
  const PATH = '/wizard/v1/pages/wizard-look/look.json', META = 'wos.look-sync.v1';
  const ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/, SKIN = /^[a-z0-9][a-z0-9-]{0,47}$/;
  const BACKGROUNDS = ['living', 'custom', 'landscapes', 'lake', 'valley', 'moonrise', 'sea', 'clouds', 'glass'];
  const fileId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
  function backdrop(v) {
    if (!v || !BACKGROUNDS.includes(v.id) || (v.id === 'custom' && !fileId(v.wide))) return null;
    return { id: v.id, ...(fileId(v.wide) ? { wide: v.wide, ...(fileId(v.tall) ? { tall: v.tall } : {}) } : {}), at: at(v.at) };
  }
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const SHELLS = ['desktop', 'phone'];
  const at = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const empty = () => ({ version: 1, skin: null, tweaks: {} });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Lenient: anything malformed is dropped, the rest kept (the agent or an older shell may have written the file).
  function parse(value) {
    let j = value;
    if (typeof value === 'string') { try { j = JSON.parse(value); } catch (_) { return null; } }
    if (!isObj(j) || j.version !== 1) return null;
    const out = empty();
    if (isObj(j.skin) && typeof j.skin.id === 'string' && SKIN.test(j.skin.id)) out.skin = { id: j.skin.id, at: at(j.skin.at) };
    if (isObj(j.tweaks)) for (const [id, t] of Object.entries(j.tweaks)) if (ID.test(id) && isObj(t) && typeof t.on === 'boolean') out.tweaks[id] = { on: t.on, at: at(t.at) };
    if (isObj(j.defaults)) for (const [id, t] of Object.entries(j.defaults)) if (ID.test(id) && isObj(t) && typeof t.on === 'boolean') (out.defaults ||= {})[id] = { on: t.on, at: at(t.at) };
    if (isObj(j.views)) for (const s of SHELLS) { const v = j.views[s]; if (isObj(v) && typeof v.id === 'string' && (v.id === '' || ID.test(v.id))) (out.views ||= {})[s] = { id: v.id, at: at(v.at) }; }
    const bg = backdrop(j.desktopBackdrop); if (bg) out.desktopBackdrop = bg;
    return out;
  }
  // Per choice, newest wins; a tie keeps the box's.
  function merge(box, mine) {
    const out = { version: 1, skin: box?.skin || null, tweaks: { ...(box?.tweaks || {}) } };
    if (mine?.skin && (!out.skin || mine.skin.at > out.skin.at)) out.skin = mine.skin;
    for (const [id, t] of Object.entries(mine?.tweaks || {})) if (!out.tweaks[id] || t.at > out.tweaks[id].at) out.tweaks[id] = t;
    for (const [id, t] of Object.entries(box?.defaults || {})) (out.defaults ||= {})[id] = t;
    for (const [id, t] of Object.entries(mine?.defaults || {})) if (!out.defaults?.[id] || t.at > out.defaults[id].at) (out.defaults ||= {})[id] = t;
    for (const s of SHELLS) {  // per shell type, newest wins; the key only appears once a type has a choice
      const a = box?.views?.[s], b = mine?.views?.[s], v = b && (!a || b.at > a.at) ? b : a;
      if (v) (out.views ||= {})[s] = v;
    }
    const a = box?.desktopBackdrop, b = mine?.desktopBackdrop;
    if (a || b) {
      const selected = b && (!a || b.at > a.at) ? b : a;
      // A built-in choice from a stale device may not know the uploaded files.
      // Keep those references independently; an explicit replacement wide image
      // still replaces the pair, including intentionally omitted portrait art.
      const files = selected.wide ? selected : (a?.wide ? a : b);
      out.desktopBackdrop = { id: selected.id, ...(files?.wide ? { wide: files.wide, ...(files.tall ? { tall: files.tall } : {}) } : {}), at: selected.at };
    }
    return out;
  }
  const onIds = doc => Object.keys(doc?.tweaks || {}).filter(id => doc.tweaks[id].on).sort();
  const mixOn = mix => Object.keys(mix || {}).filter(id => ID.test(id) && mix[id] === true).sort();
  const pick = (doc, keep) => {
    const out = { version: 1, skin: doc.skin && keep(doc.skin) ? doc.skin : null, tweaks: Object.fromEntries(Object.entries(doc.tweaks).filter(([, t]) => keep(t))) };
    for (const [id, t] of Object.entries(doc.defaults || {})) if (keep(t)) (out.defaults ||= {})[id] = t;
    for (const s of SHELLS) if (doc.views?.[s] && keep(doc.views[s])) (out.views ||= {})[s] = doc.views[s];
    if (doc.desktopBackdrop && keep(doc.desktopBackdrop)) out.desktopBackdrop = doc.desktopBackdrop;
    return out;
  };
  // The view each shell type wears by its own choice ({ desktop: id, phone: '' }); a type without one is left out.
  const shellViews = doc => Object.fromEntries(SHELLS.filter(s => doc?.views?.[s]).map(s => [s, doc.views[s].id]));
  const seeds = doc => pick(doc, t => !t.at), changes = doc => pick(doc, t => t.at > 0);
  // One shell view at a time (views = ids in catalog order): the newest one on wins, a tie keeps the first.
  function exclusive(doc, views) {
    const on = views.filter(id => doc.tweaks[id]?.on);
    if (on.length < 2) return doc;
    const keep = on.reduce((a, b) => (doc.tweaks[b].at > doc.tweaks[a].at ? b : a));
    const tweaks = { ...doc.tweaks };
    for (const id of on) if (id !== keep) tweaks[id] = { on: false, at: tweaks[keep].at };
    return { ...doc, tweaks };
  }

  function create({ req, store, exp, skin, active = () => true, now = () => Date.now(), later = (f, ms) => setTimeout(f, ms), cancel = t => clearTimeout(t), on = () => {} }) {
    const load = () => {
      try {
        const m = JSON.parse(store.getItem(META));
        if (isObj(m)) return { version: typeof m.version === 'string' ? m.version : null, synced: m.synced === true, pending: parse({ version: 1, ...(isObj(m.pending) ? m.pending : {}) }) || empty() };
      } catch (_) {}
      return { version: null, synced: false, pending: empty() };
    };
    let meta = load(), busy = false, again = false, timer = 0, refresh = 0, fails = 0, off = false, applying = false, last = 'idle', boxDoc = null, known = null;
    const live = id => !known || known.has(id); // retired ids an old device still stores are no choice: never seeded, never counted
    // What a set switches on here: retired ids on the box are never worn, or this device would never match the box and
    // re-apply every tweak on every pass (settle() after each apply: a reload storm that flickers the whole shell).
    const wear = doc => onIds(doc).filter(live);
    const save = () => { try { store.setItem(META, JSON.stringify({ version: meta.version, synced: meta.synced, pending: { skin: meta.pending.skin, tweaks: meta.pending.tweaks, ...(meta.pending.defaults ? { defaults: meta.pending.defaults } : {}), ...(meta.pending.views ? { views: meta.pending.views } : {}), ...(meta.pending.desktopBackdrop ? { desktopBackdrop: meta.pending.desktopBackdrop } : {}) } })); } catch (_) {} };
    let clock = 0;
    const observe = d => { clock = Math.max(clock, d?.desktopBackdrop?.at || 0, d?.skin?.at || 0, ...Object.values(d?.tweaks || {}).map(t => t.at || 0), ...Object.values(d?.views || {}).map(t => t.at || 0), ...Object.values(d?.defaults || {}).map(t => t.at || 0)); };
    observe(meta.pending);
    const stamp = () => ++clock;
    // Before the first observation (also restored storage), or while a request
    // is in flight, an intent needs that response as its causal base. An idle
    // choice already has an observed base: a newer remote writer can beat it.
    // Traverse every field together; never restamp an already-sent choice on 409.
    const choices = doc => [doc.skin, doc.desktopBackdrop, ...Object.values(doc.tweaks || {}), ...Object.values(doc.views || {}), ...Object.values(doc.defaults || {})].filter(Boolean);
    let unbased = new WeakSet(choices(meta.pending));
    const intent = t => { if (!boxDoc || busy) unbased.add(t); return t; };
    function baseChoices() {
      // A legacy view selection shares one revision across its on AND off members.
      // Rebase equality groups in original order, not field traversal order: splitting
      // a group can let a stale off erase the winner of a concurrent selection.
      const revisions = new Map();
      const pending = choices(meta.pending).filter(t => unbased.has(t)).sort((a, b) => a.at - b.at);
      for (const t of pending) {
        if (!revisions.has(t.at)) revisions.set(t.at, stamp());
        t.at = revisions.get(t.at);
      }
      unbased = new WeakSet();
    }
    const dirty = () => !!meta.pending.desktopBackdrop || !!meta.pending.skin || Object.keys(meta.pending.tweaks).length > 0 || Object.keys(meta.pending.views || {}).length > 0 || Object.keys(meta.pending.defaults || {}).length > 0;
    // Experience modules from before per-shell views have no `views`: they keep the old one-view-everywhere meaning.
    const perShell = () => { try { return isObj(exp.views); } catch (_) { return false; } };
    const views = () => { try { return (exp.state?.tweaks || []).filter(t => t.view).map(t => t.id); } catch (_) { return []; } };
    // What this device runs now, as seeds.
    function local() {
      const doc = empty(), s = skin.chosen;
      if (typeof s === 'string' && SKIN.test(s)) doc.skin = { id: s, at: 0 };
      for (const id of mixOn(exp.mix)) if (live(id)) doc.tweaks[id] = { on: true, at: 0 };
      if (perShell()) for (const [shell, id] of Object.entries(exp.views)) (doc.views ||= {})[shell] = { id, at: 0 };
      // Backdrops are independent of the active skin and phone. Never seed an implicit Living default.
      const bg = backdrop(skin.desktopBackdrop); if (bg && bg.id !== 'living') doc.desktopBackdrop = { ...bg, at: 0 };
      return doc;
    }
    const defaultChoices = () => exp.defaultChoices || {};
    const defaultSeeds = () => Object.fromEntries(Object.entries(defaultChoices()).filter(([id, on]) => ID.test(id) && typeof on === 'boolean').map(([id, on]) => [id, { on, at: 0 }]));
    const wornDefaults = doc => Object.fromEntries(Object.entries(doc.defaults || {}).filter(([id]) => Object.hasOwn(defaultChoices(), id)).map(([id, t]) => [id, t.on]));
    const defaultsMatch = doc => Object.entries(wornDefaults(doc)).every(([id, on]) => defaultChoices()[id] === on);
    const absent = () => Object.assign(new Error('absent'), { absent: true });
    async function get() {
      const r = await req(PATH, { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json().catch(() => null);
      if (r.status === 200 && typeof j?.text === 'string') return { doc: parse(j.text) || empty(), version: typeof j.version === 'string' ? j.version : null };
      if (r.status === 404 && j?.error === 'file_not_found') return { doc: null, version: null };
      if (r.status === 404 || r.status === 403) throw absent(); // no Pages on this box, or not the owner: this device only
      throw new Error('look ' + r.status);
    }
    async function put(doc, version) {
      const text = JSON.stringify({ ...doc, updated: new Date(now()).toISOString() }, null, 1) + '\n';
      const r = await req(PATH, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, version }) });
      const j = await r.json().catch(() => null);
      if (r.ok && typeof j?.version === 'string') return { ok: true, version: j.version };
      if (r.status === 409 && isObj(j?.current)) return { ok: false, doc: j.current.exists ? parse(j.current.text) || empty() : null, version: typeof j.current.version === 'string' ? j.current.version : null };
      if (r.status === 404 || r.status === 403) throw absent();
      throw new Error('look ' + r.status);
    }
    // Wear the box's set here. Our own listeners ignore the events this raises.
    function adopt(doc) {
      doc = exclusive(doc, views());
      applying = true;
      try {
        if (doc.skin && doc.skin.id !== skin.current && skin.has(doc.skin.id)) skin.set(doc.skin.id);
        if (doc.desktopBackdrop && skin.adoptDesktopBackdrop) {
          const { at: _at, ...bg } = doc.desktopBackdrop;
          if (!same(bg, skin.desktopBackdrop)) skin.adoptDesktopBackdrop(bg);
        }
        const want = wear(doc), views = shellViews(doc);
        if (!same(want, mixOn(exp.mix).filter(live)) || (perShell() && !same(views, exp.views)) || !defaultsMatch(doc)) exp.adopt(Object.fromEntries(want.map(id => [id, true])), perShell() ? views : undefined, wornDefaults(doc));
      } finally { applying = false; }
    }
    // Drop only what this pass delivered; a change made meanwhile stays queued.
    function sent(p) {
      if (p.desktopBackdrop && meta.pending.desktopBackdrop?.at === p.desktopBackdrop.at) delete meta.pending.desktopBackdrop;
      if (p.skin && meta.pending.skin && meta.pending.skin.at === p.skin.at) meta.pending.skin = null;
      for (const [id, t] of Object.entries(p.tweaks)) if (meta.pending.tweaks[id]?.at === t.at) delete meta.pending.tweaks[id];
      for (const [s, t] of Object.entries(p.views || {})) if (meta.pending.views?.[s]?.at === t.at) delete meta.pending.views[s];
      if (meta.pending.views && !Object.keys(meta.pending.views).length) delete meta.pending.views;
      for (const [id, t] of Object.entries(p.defaults || {})) if (meta.pending.defaults?.[id]?.at === t.at) delete meta.pending.defaults[id];
      if (meta.pending.defaults && !Object.keys(meta.pending.defaults).length) delete meta.pending.defaults;
    }
    async function sync() {
      if (off) return;
      if (busy) { again = true; return; }
      busy = true; cancel(timer); timer = 0; last = 'syncing';
      try {
        if (!known) try { known = new Set(await exp.tweakIds()); } catch (_) { /* catalog unreadable now: count every id */ }
        let { doc, version } = await get();
        for (let tries = 0; tries < 4; tries++) {
          observe(doc);
          baseChoices(); // also covers a synced device choosing while GET/PUT was in flight
          const pending = JSON.parse(JSON.stringify(meta.pending));
          let want = null;
          if (!doc) { const mine = merge(local(), pending); if (onIds(mine).length || mine.desktopBackdrop || mine.skin || Object.keys(mine.views || {}).length || dirty()) want = mine; } // seed; an untouched empty device never writes
          else if (dirty()) want = merge(doc, pending);
          // First sync of a device whose old local set is bigger than the box's seeds: its seeds replace them; real changes stay.
          else if (!meta.synced && onIds(local()).length > onIds(seeds(doc)).filter(live).length) want = merge(changes(doc), local());
          // Upgrade old files without replacing an existing default or per-shell choice.
          const defaults = merge({ defaults: doc?.defaults }, { defaults: defaultSeeds() });
          const sharedDefaults = merge(defaults, { defaults: pending.defaults }).defaults;
          if (sharedDefaults) want = { ...(want || doc || empty()), defaults: sharedDefaults };
          if (want) want = exclusive(want, views());
          if (want && !same(want, doc)) {
            const w = await put(want, version);
            if (!w.ok) { doc = w.doc; version = w.version; continue; } // another device saved first: merge onto theirs
            doc = want; version = w.version; sent(pending);
          } else if (doc) sent(pending);
          // A PUT acknowledgement is only its captured choice. Keep a later
          // local choice visible while that newer pending revision waits to save.
          if (doc) { meta.version = version; meta.synced = true; boxDoc = doc; adopt(merge(doc, meta.pending)); }
          save(); last = 'ok'; break;
        }
        if (last !== 'ok') throw new Error('look busy'); // four other saves in a row: try again later
        fails = 0;
      } catch (e) {
        if (e?.absent) { off = true; last = 'local'; }
        else { last = 'offline'; fails++; timer = later(sync, Math.min(60000, 2000 * 2 ** Math.min(fails, 5))); }
      } finally {
        busy = false; on(last);
        if (again) { again = false; schedule(); }
      }
    }
    function schedule(ms = 600) { if (off) return; cancel(timer); timer = later(sync, ms); }
    function tweakChoice(id, value) {
      if (applying || !ID.test(String(id))) return;
      const group = views();
      if (group.includes(id)) {
        if (value) { const at = stamp(); for (const key of group) meta.pending.tweaks[key] = intent({ on: key === id, at }); }
        else {
          const selected = group.find(key => key !== id && meta.pending.tweaks[key]?.on);
          meta.pending.tweaks[id] = intent({ on: false, at: selected ? meta.pending.tweaks[selected].at : stamp() });
        }
      } else meta.pending.tweaks[id] = intent({ on: !!value, at: stamp() });
      save(); schedule();
    }
    // The owner chose a view for this type of shell (experience.js raises wos:view-choice): every shell of that type follows.
    function viewChoice(shell, id) {
      if (applying || !SHELLS.includes(shell) || typeof id !== 'string' || !(id === '' || ID.test(id))) return;
      (meta.pending.views ||= {})[shell] = intent({ id, at: stamp() }); save(); schedule();
    }
    function defaultChoice(id, value) {
      if (applying || !ID.test(String(id)) || typeof value !== 'boolean' || !Object.hasOwn(defaultChoices(), id)) return;
      (meta.pending.defaults ||= {})[id] = intent({ on: value, at: stamp() }); save(); schedule();
    }
    function backdropChoice(value) {
      const bg = backdrop(value); if (applying || !bg) return;
      meta.pending.desktopBackdrop = intent({ ...bg, at: stamp() }); save(); schedule();
    }
    function skinChoice(id) {
      if (applying || typeof id !== 'string' || !SKIN.test(id)) return;
      meta.pending.skin = intent({ id, at: stamp() }); save(); schedule();
    }
    // Views are known once the tweaks have loaded. A box copy with two views on (an older client, the agent) is fixed
    // on the box too (the newest one stays), so a stale view never comes back; a device-only both-on is fixed here.
    function settle() {
      if (applying || busy || !views().length) return;
      let want;
      if (boxDoc && !dirty()) {
        const fixed = exclusive(boxDoc, views());
        if (!same(fixed, boxDoc)) {
          for (const [id, t] of Object.entries(fixed.tweaks)) if (!same(t, boxDoc.tweaks[id])) meta.pending.tweaks[id] = t;
          boxDoc = fixed; save(); schedule(0);
        }
        want = wear(fixed);
      } else want = wear(exclusive(local(), views()));
      const mine = local();
      if (!same(want, onIds(mine))) { applying = true; try { exp.adopt(Object.fromEntries(want.map(id => [id, true]))); } finally { applying = false; } }
    }
    return {
      sync, schedule, tweakChoice, viewChoice, defaultChoice, skinChoice, backdropChoice, settle,
      start() {
        if (off || refresh) return;
        const poll = async () => {
          refresh = 0; if (off) return;
          if (active() && !busy && !timer) await sync();
          if (!off) refresh = later(poll, 30000);
        };
        refresh = later(poll, 30000);
      },
      stop() { off = true; cancel(timer); cancel(refresh); timer = refresh = 0; },
      get state() { return { last, off, busy, synced: meta.synced, pending: JSON.parse(JSON.stringify(meta.pending)) }; },
    };
  }

  window.WosLookSync = { create, parse, merge, exclusive, PATH, current: null };
  const E = window.WosExperience, S = window.WosSkin;
  if (!E || !S || typeof window.fetch !== 'function' || typeof E.adopt !== 'function') return;
  const sync = create({
    req: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    store: localStorage, exp: E, active: () => !document.hidden,
    skin: { get chosen() { return S.chosen; }, get current() { return S.current; }, get desktopBackdrop() { return S.desktopBackdrop; }, adoptDesktopBackdrop: bg => S.adoptDesktopBackdrop(bg), has: id => S.list.some(s => s.id === id), set: id => S.set(id) },
  });
  window.WosLookSync.current = sync;
  window.addEventListener('wos:tweak-choice', e => e.detail?.scope === 'default' ? sync.defaultChoice(e.detail?.id, e.detail?.on) : sync.tweakChoice(e.detail?.id, e.detail?.on));
  window.addEventListener('wos:view-choice', e => sync.viewChoice(e.detail?.shell, e.detail?.id));
  window.addEventListener('wos:skin', e => sync.skinChoice(e.detail));
  window.addEventListener('wos:wallpaper', e => { if (e.detail?.desktopBackdrop) sync.backdropChoice(e.detail.desktopBackdrop); });
  // Wait for experience's first migration before publishing this device's seeds.
  let started = false, woke = 0;
  const begin = () => {
    if (started || E.state.busy || E.state.error || !E.state.tweaks.length) return;
    started = true; sync.start(); woke = Date.now(); void sync.sync();
  };
  window.addEventListener('wos:experience', () => { if (!started) begin(); else if (!E.state.busy) sync.settle(); });
  // Back in the foreground: another device may have changed the set meanwhile.
  const wake = () => { if (!started) return begin(); if (document.hidden || Date.now() - woke < 3000) return; woke = Date.now(); void sync.sync(); };
  for (const type of ['focus', 'online', 'pageshow']) window.addEventListener(type, wake);
  document.addEventListener('visibilitychange', wake);
  begin();
})();
