/* Pinned Chats threads, the same on every device of the owner. Shared by phone and desktop shells.
 * The list lives in Agent Service's box-wide shell preferences (pinnedChats via /wizard/v1/ui-preferences, the
 * path live.js already syncs); localStorage is only this device's offline cache of it. Pins made on a device
 * before pins synced (Novaire's device-local wos.chats.pinned.v1) are merged into the shared list once.
 * Pin design: Novaire (wizard-ux #250).
 *
 * Sync (28 Oct 2026: pins didn't stay the same across devices): a pin or unpin is queued as an operation, never
 * saved as this device's whole list. Each sync reads the shared list fresh, replays this device's pending
 * operations on top and writes the result, so a phone that hasn't pulled yet can't drop a pin made on the
 * desktop (or bring back one unpinned there). Operations stay queued across reloads and offline spells until
 * the service has taken them. */
(() => {
  'use strict';
  const KEY = 'wos.chats.pinned.v2', OPS = 'wos.chats.pinned.ops.v1', LEGACY = 'wos.chats.pinned.v1', MIGRATED = 'wos.chats.pinned.migrated.v1';
  const URL = '/wizard/v1/ui-preferences';
  const MAX = 300, MAX_OPS = 200, ID = /^[A-Za-z0-9._:-]{1,180}$/;
  const clean = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && ID.test(id)))].slice(0, MAX) : [];
  const parse = raw => { try { return clean(JSON.parse(raw || '[]')); } catch (_) { return []; } };
  const parseOps = raw => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.filter(o => o && typeof o.id === 'string' && ID.test(o.id) && typeof o.on === 'boolean').slice(-MAX_OPS) : []; } catch (_) { return []; } };
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  // Pin = append (keeps pin order), unpin = remove. Replaying an operation twice changes nothing.
  const apply = (base, ops) => { let ids = base.slice(); for (const { id, on } of ops) { ids = ids.filter(x => x !== id); if (on) ids.push(id); } return clean(ids); };
  let cache = null, cacheKey = null;
  // What this device shows: the last shared list it saw, plus its own changes the service hasn't taken yet.
  const read = () => { const raw = get(KEY), ops = get(OPS), k = `${raw}\u0000${ops}`; if (k !== cacheKey || !cache) { cacheKey = k; cache = apply(parse(raw), parseOps(ops)); } return cache; };
  const emit = () => window.dispatchEvent(new Event('wos:chat-pins'));

  let running = null, again = false, retry = 0, retryTimer = 0, off = false;
  async function write(list) {
    // Through live.js when present, so its 30s pull can't land a stale list over this write.
    if (window.WizLive?.putPrefs) return await window.WizLive.putPrefs({ pinnedChats: list }, { requireShared: true }) === true;
    const r = await fetch(URL, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinnedChats: list }) });
    return r.ok;
  }
  async function syncOnce() {
    const ops = parseOps(get(OPS));
    if (!ops.length || off) return true;
    const r = await fetch(URL, { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 404) { off = true; return true; } // an Agent Service without shared preferences: pins stay on this device
    if (!r.ok) return false;
    const j = await r.json(), shared = clean(j?.pinnedChats), next = apply(shared, ops);
    if (JSON.stringify(next) !== JSON.stringify(shared)) {
      if (!(await write(next))) return false;
      // Two devices syncing at the same moment can both read before either writes; the later write would drop the
      // other's pin. Read back: if this pass's taps didn't stick, keep them queued and replay onto the newer list.
      const back = await fetch(URL, { cache: 'no-store', credentials: 'same-origin' });
      if (!back.ok) return false;
      const stored = clean((await back.json())?.pinnedChats), want = new Map(ops.map(o => [o.id, o.on]));
      if ([...want].some(([id, on]) => stored.includes(id) !== on)) return 'conflict';
    }
    // Drop only the operations this pass delivered; a tap made meanwhile stays queued for the next pass.
    const now = parseOps(get(OPS)), sent = ops.length, same = now.slice(0, sent).every((o, i) => o.id === ops[i].id && o.on === ops[i].on);
    set(KEY, JSON.stringify(next)); set(OPS, JSON.stringify(same ? now.slice(sent) : now));
    emit();
    return true;
  }
  function sync() {
    if (running) { again = true; return running; }
    clearTimeout(retryTimer);
    running = (async () => {
      let ok = false;
      try {
        // A conflict replays at once onto the newer list, a few times; each pass re-reads, so it converges.
        for (let pass = 0; pass < 6; pass++) { again = false; ok = await syncOnce(); if (ok === 'conflict') { ok = false; continue; } if (!ok || !again) break; }
      } catch (_) { ok = false; }
      running = null;
      if (ok) retry = 0;
      else { retry = Math.min(retry + 1, 6); retryTimer = setTimeout(sync, 2000 * 2 ** retry); } // offline: keep the taps, try again
      return ok;
    })();
    return running;
  }

  async function migrate() {
    let legacy = [];
    try { if (localStorage.getItem(MIGRATED)) return; legacy = parse(localStorage.getItem(LEGACY)); } catch (_) { return; }
    if (!legacy.length) { set(MIGRATED, '1'); return; }
    try {
      const r = await fetch(URL, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return; // older service or offline: try again next load, keep the local pins meanwhile
      const j = await r.json(), shared = clean(j?.pinnedChats);
      const merged = clean(shared.concat(legacy.filter(id => !shared.includes(id))));
      if (merged.length !== shared.length) {
        const w = await fetch(URL, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinnedChats: merged }) });
        if (!w.ok) return;
      }
      try { localStorage.setItem(KEY, JSON.stringify(merged)); localStorage.setItem(MIGRATED, '1'); localStorage.removeItem(LEGACY); } catch (_) {}
      emit();
    } catch (_) {}
  }
  const api = Object.freeze({
    scope: 'owner',
    ids: () => read().slice(),
    has(id) { return read().includes(String(id || '')); },
    toggle(id) {
      id = String(id || ''); if (!ID.test(id)) return false;
      const on = !read().includes(id);
      set(OPS, JSON.stringify(parseOps(get(OPS)).concat({ id, on }).slice(-MAX_OPS)));
      emit();
      sync();
      return on;
    },
    partition(rows, eligible = () => true) {
      const list = Array.isArray(rows) ? rows : [], byId = new Map(list.map(row => [String(row?.id || ''), row]));
      const pinned = read().map(id => byId.get(id)).filter(row => row && eligible(row));
      const selected = new Set(pinned);
      return { pinned, rest: list.filter(row => !selected.has(row)) };
    },
    pending: () => parseOps(get(OPS)).length,
    sync,
    _migrate: migrate,
  });
  window.WosChatPins = api;
  // Another tab on this device, or a pull of the shared list (live.js writes the cache, then fires wos:prefs).
  window.addEventListener('storage', e => { if (e?.key === KEY || e?.key === OPS) emit(); });
  let last = JSON.stringify(read());
  window.addEventListener('wos:prefs', () => { const now = JSON.stringify(read()); if (now !== last) { last = now; emit(); } });
  window.addEventListener('wos:chat-pins', () => { last = JSON.stringify(read()); });
  window.addEventListener('online', () => { if (api.pending()) sync(); });
  setTimeout(() => { migrate(); if (api.pending()) sync(); }, 1500);
})();
