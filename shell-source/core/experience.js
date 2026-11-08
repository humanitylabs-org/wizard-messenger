/* Skins and tweaks are separate choices (Miguel, 30 Oct 2026). A skin is only a look. Every
 * tweak (web/tweaks/<author>/<id>) is one switch, off by default, labelled with its author; a quick
 * button per author turns all of theirs on (or off). Catalog `defaults` are built-in features, not experiments: on for
 * everyone, with an owner off-switch. Cached on each device as { mix } in wos.skin-tweaks.v1. A device from before keeps
 * exactly what it ran: the set its color used to bring (with its offs) is written into mix once, then never again.
 * The mix here is this device's cached copy; core/look-sync.js keeps it the owner's one set on every device. */
(() => {
  'use strict';
  const KEY = 'wos.skin-tweaks.v1', ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
  const Store = {
    read() { try { const v = JSON.parse(localStorage.getItem(KEY)); return v?.version === 1 && v.off && typeof v.off === 'object' ? v : null; } catch (_) { return null; } },
    write(value) { try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (_) {} },
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const desktop = document.documentElement?.dataset?.shell === 'desktop';
  const DESKTOP_VIEW = 'wos.desktop-view.v1', DESKTOP_SEED = 'wos.desktop-view-migration.v1';
  const desktopViews = ['classic', 'ai-apps', 'orb', 'apps'];
  let desktopView = '', desktopMigration = null;
  try { const saved = localStorage.getItem(DESKTOP_VIEW); if (desktopViews.includes(saved)) desktopView = saved; } catch (_) {}
  let state = Store.read() || { version: 1, off: {} };
  if (desktop && !desktopView) try { const seed = JSON.parse(localStorage.getItem(DESKTOP_SEED)); if (seed?.version === 1 && seed.off && typeof seed.off === 'object') desktopMigration = seed; } catch (_) {}
  let retried = false;  // one quiet retry when a slow network made the whole set fail to load
  let catalog = null, slots = null, set = null, owner = null, manifests = new Map(), generation = 0, error = '', busy = false;
  // Tweak files are static per release: read each once per page (a failure is forgotten so the next call retries).
  const files = new Map();
  const fetchOnce = async (url, ms = 6000) => {
    const r = await fetch(new URL(url, document.baseURI), { cache: /[?&]v=/.test(url) ? 'default' : 'no-cache', signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`Could not read ${url} (${r.status})`); return r.json();
  };
  // Release-stamped like every other shell file, so the browser keeps them until the next release.
  const rel = () => document.querySelector?.('meta[name="wos-release"]')?.content || '';
  const read = url => {
    if (/profile\.json$/.test(url)) return fetchOnce(url); // a published profile can change; manifests cannot
    if (/^[0-9a-f]{6,40}$/.test(rel())) url += (url.includes('?') ? '&' : '?') + 'v=' + rel();
    if (!files.has(url)) files.set(url, fetchOnce(url).catch(() => fetchOnce(url, 30000)).catch(e => { files.delete(url); throw e; }));
    return files.get(url).then(v => JSON.parse(JSON.stringify(v)));
  };
  const changed = () => window.dispatchEvent(new Event('wos:experience'));
  const WHO = /^[a-z0-9][a-z0-9-]*$/, STANDARD = 'wizard';
  // The set a color used to bring before the split: only for a device that has no preset saved yet.
  function legacyOwner() {
    const S = window.WosSkin; if (!S) return STANDARD;
    let chosen = null; try { chosen = localStorage.getItem('wos.skin'); } catch (_) {}
    if (!chosen) return STANDARD;
    const fid = S.familyOf?.(chosen), fam = (S.families || []).find(f => f.id === fid);
    return fam?.tweaks && WHO.test(fam.tweaks) ? fam.tweaks : 'none';
  }
  // One preset per device, chosen once (or carried over); 'none' = no set, only what the owner switches on.
  function wornOwner() {
    if (typeof state.preset !== 'string' || !(state.preset === 'none' || WHO.test(state.preset))) {
      // The old per-skin offs were a full list (absence = published defaults); apply() turns them into choices.
      const who = legacyOwner();
      state.preset = who; state.mix = {}; if (Object.hasOwn(state.off, who)) state.carry = [...state.off[who]];
      Store.write(state);
    }
    return state.preset === 'none' ? null : state.preset;
  }
  // The owner's own on/off per tweak, over the preset's published defaults.
  const mixOf = id => state.mix && Object.hasOwn(state.mix, id) ? state.mix[id] : undefined;
  const presetOn = id => !!set?.tweaks.includes(id) && !(set.off || []).includes(id);
  // Ids switched off for this preset: the owner's explicit offs plus the published default-offs he has not touched.
  const offFor = () => [...Object.keys(state.mix || {}).filter(id => state.mix[id] === false), ...(set?.off || []).filter(id => mixOf(id) === undefined)];
  // Move the legacy Layout choice into the Wizard tweak once, even if another skin is worn now.
  try {
    if (localStorage.getItem('wos.layout') === 'two-orb' && !localStorage.getItem('wos.two-orbs.migrated.v1')) {
      if (!Object.hasOwn(state.off, 'wizard')) { state.off.wizard = ['wizard/app-borders']; Store.write(state); }
      localStorage.setItem('wos.two-orbs.migrated.v1', 'true');
    }
  } catch (_) {}
  // Preserve a deliberate old framed choice once; explicit offs after this migration always win.
  try {
    if (!localStorage.getItem('wos.app-borders.migrated.v1')) {
      const saved = JSON.parse(localStorage.getItem('wos.skin.composition.v1') || 'null');
      const off = new Set(state.off.wizard || ['wizard/two-orbs']);
      if (saved?.frame?.foundation !== 'framed') off.add('wizard/app-borders');
      else off.delete('wizard/app-borders');
      state.off.wizard = [...off]; Store.write(state);
      localStorage.setItem('wos.app-borders.migrated.v1', 'true');
    }
  } catch (_) {}
  const recipe = () => window.WosMySkin?.active;
  // Release-wide defaults are independent of skin. Saved offs and recipe choices keep their meaning across renames.
  const canonical = id => catalog?.aliases?.[id] || id;
  const globalIds = () => catalog?.defaults || [];
  const globalOff = id => (state.defaultsOff || []).includes(id);
  function migrateDefaults() {
    if (state.defaultsMigrated) return;
    const off = new Set(state.defaultsOff || []);
    for (const ids of Object.values(state.off)) for (const id of ids) if (globalIds().includes(canonical(id))) off.add(canonical(id));
    state.defaultsOff = [...off]; state.defaultsMigrated = true; Store.write(state);
  }
  const recipeChoice = (own, id) => {
    if (!own) return undefined;
    if (Object.hasOwn(own.tweaks, id)) return own.tweaks[id];
    for (const [old, current] of Object.entries(catalog?.aliases || {})) if (current === id && Object.hasOwn(own.tweaks, old)) return own.tweaks[old];
    return undefined;
  };
  const enabled = (id, own = recipe()) => globalIds().includes(id) ? !globalOff(id) && recipeChoice(own, id) !== false
    : own ? (recipeChoice(own, id) ?? presetOn(id)) : (mixOf(id) ?? presetOn(id));
  // Packages that fill the same place (two Home maps): the first one listed in a catalog `oneOf` group wins.
  // An explicit off for any member (My skin recipe, a saved off, a release-wide off) turns the whole group off.
  const oneOf = (ids, own = recipe()) => { const out = [...ids]; for (const g of catalog?.oneOf || []) { const off = g.some(id => recipeChoice(own, id) === false || offFor(owner).includes(id) || globalOff(id)), on = g.filter(x => out.includes(x)); for (const id of off ? on : on.slice(1)) out.splice(out.indexOf(id), 1); } return out; };
  const groupOf = id => (catalog?.oneOf || []).find(g => g.includes(id)) || null;
  // One switch per group in Settings: the member this skin's profile lists, else the first one installed.
  const shownInGroup = id => { const g = groupOf(id); if (!g) return true; const present = g.filter(x => manifests.has(x)); return id === (present.find(x => set?.tweaks.includes(x)) || present[0]); };
  const groupOn = id => { const own = recipe(); return oneOf([...manifests.keys()].filter(x => enabled(x, own)), own).some(x => groupOf(id).includes(x)); };
  const explicitOff = id => recipeChoice(recipe(), id) === false || offFor(owner).includes(id) || globalOff(id);
  async function setOne(id, on) {
    if (globalIds().includes(id)) {
      const off = new Set(state.defaultsOff || []); on ? off.delete(id) : off.add(id);
      state.defaultsOff = [...off]; Store.write(state);
      if (recipe()) await window.WosMySkin.update({ tweaks: { [id]: on } });
      // Safe built-in preference only, never personal-script approval.
      try { window.dispatchEvent(new CustomEvent('wos:tweak-choice', { detail: { id, on, scope: 'default' } })); } catch (_) {}
      return;
    }
    if (recipe()) { await window.WosMySkin.update({ tweaks: { [id]: on } }); return; }
    if (!catalog?.tweaks.includes(id)) return;
    const mix = { ...(state.mix || {}) }; if (on === presetOn(id)) delete mix[id]; else mix[id] = on;
    state.mix = mix; Store.write(state);
    // An owner's own switch (not a migration): core/look-sync.js shares it with his other devices.
    try { window.dispatchEvent(new CustomEvent('wos:tweak-choice', { detail: { id, on } })); } catch (_) {}
  }
  const profileReads = new Map();
  function profile(who) {
    if (!profileReads.has(who)) {
      const pending = read(`tweaks/${who}/profile.json`).catch(e => { profileReads.delete(who); throw e; });
      profileReads.set(who, pending);
    }
    return profileReads.get(who);
  }
  let installedP = null;
  function installed() {
    installedP ||= (async () => {
      catalog ||= await read('tweaks/catalog.json');
      for (const who of catalog.profiles || []) void profile(who).catch(() => {});
      return Promise.all(catalog.tweaks.map(async id => ({ id, ...await read(`tweaks/${id}/manifest.json`) })));
    })().then(v => { installedP.settled = true; return v; }, e => { installedP = null; throw e; });
    return installedP.then(list => list.map(m => ({ ...m })));
  }
  // A new skin starts from what this device runs now (the color no longer decides tweaks).
  async function defaults() {
    const list = await installed();
    // What actually runs now, including the worn own skin's choices.
    return Object.fromEntries(list.map(m => [m.id, enabled(m.id, recipe())]));
  }
  // Authors with tweaks here, for the quick buttons: display name from their profile, else the id.
  async function authors() {
    catalog ||= await read('tweaks/catalog.json');
    const names = new Map(await Promise.all((catalog.profiles || []).map(async who => { try { const p = await profile(who); return [who, typeof p.name === 'string' ? p.name : who]; } catch (_) { return [who, who]; } })));
    const out = new Map();
    for (const id of catalog.tweaks) { if (globalIds().includes(id)) continue; const who = id.split('/')[0]; if (!out.has(who)) out.set(who, { id: who, name: names.get(who) || who, ids: [] }); out.get(who).ids.push(id); }
    return [...out.values()];
  }
  let applying = Promise.resolve();
  function apply(warm = false) { return applying = applyNow(warm); }
  async function applyNow(warm = false) {
    const seq = ++generation; busy = true; error = ''; changed();
    try {
      // Retain explicit legacy offs across overlapping refreshes / interrupted migration.
      // This local fallback is never a shared per-shell choice or a Look-sync seed.
      if (desktop && !desktopView && !desktopMigration) {
        desktopMigration = copy(state);
        try { desktopMigration.materializedLayout = localStorage.getItem('wos.layout'); localStorage.setItem(DESKTOP_SEED, JSON.stringify(desktopMigration)); } catch (_) {}
      }
      const who = wornOwner();
      // A legacy layout can boot before this deferred module; the worn family now owns it.
      if (window.WosSkinHost.layout === 'two-orb' && !window.WosSkinHost.tweakState.includes('wizard/two-orbs')) window.WosSkinHost.setLayout('classic');
      catalog ||= await read('tweaks/catalog.json'); slots ||= await read('core/slots.json'); migrateDefaults();
      // A preset pick uses the profile the installed list already warmed; other refreshes re-read it for news.
      const next = who ? await (warm === true && profileReads.has(who) ? profileReads.get(who) : read(`tweaks/${who}/profile.json`)) : null;
      if (seq !== generation) return;
      if (next && (next.id !== who || !Array.isArray(next.tweaks) || next.tweaks.some(id => !ID.test(id) || !catalog.tweaks.includes(id)) || (next.off !== undefined && (!Array.isArray(next.off) || next.off.some(id => !next.tweaks.includes(id)))))) throw new Error('This skin’s tweaks could not be read');
      owner = who; set = next;
      if (Array.isArray(state.carry)) {
        const mix = {}; for (const id of next?.tweaks || []) { const on = !state.carry.includes(id); if (on !== presetOn(id)) mix[id] = on; }
        state.mix = mix; delete state.carry; Store.write(state);
      }
      // Flatten once: what the old set turned on becomes the owner's own switches; from now on everything starts off.
      if (who) {
        const mix = {};
        for (const id of catalog.tweaks) if (!globalIds().includes(id) && (mixOf(id) ?? presetOn(id))) mix[id] = true;
        state.mix = mix; state.preset = 'none'; Store.write(state); owner = null; set = null;
      }
      if (who) profileReads.set(who, Promise.resolve(next));
      // A renamed or merged tweak keeps the device's own switch: an old id's saved on/off moves to its new id once.
      for (const [old, current] of Object.entries(catalog.aliases || {})) if (state.mix && Object.hasOwn(state.mix, old)) {
        const mix = { ...state.mix }; if (!Object.hasOwn(mix, current)) mix[current] = mix[old]; delete mix[old]; state.mix = mix; Store.write(state);
      }
      // 31 Oct 2026 (James): the network Home left the release-wide defaults and is now Miguel's tweak. A device that ran it
      // and already wears Miguel's tweaks keeps it, once; everyone else starts without it and can still switch it on.
      // A device flattening its preset in this same pass takes it from the published profile instead.
      if (!state.machinesHomeMoved) {
        const ran = !who && !globalOff('wizard/machines-home') && !globalOff('miguel/machines-home');
        if (ran && mixOf('miguel/machines-home') === undefined && Object.entries(state.mix || {}).some(([id, on]) => on === true && id.startsWith('miguel/'))) state.mix = { ...state.mix, 'miguel/machines-home': true };
        state.machinesHomeMoved = true; Store.write(state);
      }
      const own = recipe();
      // Every installed tweak is offered, whoever wrote it; the preset only sets which start on.
      const all = [...new Set([...catalog.tweaks, ...globalIds()])];
      manifests = new Map(await Promise.all(all.map(async id => [id, await read(`tweaks/${id}/manifest.json`)])));
      if (seq !== generation) return;
      if (desktop && !desktopView) migrateDesktopView(desktopMigration);
      const worn = wornView(own);
      // Keep the last canonical desktop choice if an older sync writer later omits views.
      if (desktop && chosenView('desktop') !== undefined && desktopView !== effectiveDesktopView()) rememberDesktopView(effectiveDesktopView());
      if (desktop) window.WosSkinHost.setStandardLayout?.(effectiveDesktopView());
      await window.WosSkinHost.loadTweaks(oneOf(all.filter(id => desktop && layoutForView(id) ? false : viewOf(id) ? id === worn : enabled(id, own)), own), slots, { teamAuthors: catalog.teamAuthors });
      if (desktop) window.WosSkinHost.setStandardLayout?.(effectiveDesktopView());
    } catch (e) { if (seq === generation) { error = e.message; if (!retried) { retried = true; setTimeout(() => { if (seq === generation) apply(); }, 5000); } } } finally { if (seq === generation) { busy = false; changed(); } }
  }
  /* Shell views: a tweak whose manifest names a `view` wears a whole shell (e.g. Orb, Apps, AI apps). One view per shell
   * type (Miguel, 4 Nov 2026): the desktop and the phone each wear their own, or none (the stock shell, Desks). A manifest
   * may name the shells it supports (`shells: ["desktop"]`); none named = both. The choice per shell type is kept in
   * state.views { desktop, phone } (a view id, '' = Desks); a shell type with no choice yet keeps the old meaning: the
   * first view switched on in the mix (catalog order) that supports this shell. */
  const SHELLS = ['desktop', 'phone'];
  const shellHere = () => { try { return document.documentElement?.dataset?.shell === 'desktop' ? 'desktop' : 'phone'; } catch (_) { return 'phone'; } };
  const viewOf = id => { const v = manifests.get(id)?.view; return typeof v === 'string' && v.trim() ? v.trim().slice(0, 24) : ''; };
  const shellsOf = id => { const s = manifests.get(id)?.shells; const ok = Array.isArray(s) ? SHELLS.filter(x => s.includes(x)) : []; return ok.length ? ok : [...SHELLS]; };
  const viewIds = (shell = shellHere()) => [...manifests.keys()].filter(id => viewOf(id) && shellsOf(id).includes(shell));
  const chosenView = shell => typeof state.views?.[shell] === 'string' ? state.views[shell] : undefined;
  const layoutForView = id => { const layout = manifests.get(id)?.layout; return viewOf(id) && desktopViews.includes(layout) ? layout : ''; };
  function rememberDesktopView(id) { desktopView = id; try { localStorage.setItem(DESKTOP_VIEW, id); localStorage.removeItem?.(DESKTOP_SEED); } catch (_) {} }
  function migrateDesktopView(legacy) {
    const ids = viewIds('desktop').filter(layoutForView);
    const offs = legacy.carry || legacy.off?.[legacy.preset || legacyOwner()] || [];
    const explicit = ids.some(id => typeof legacy.mix?.[id] === 'boolean' || offs.includes(id) || typeof recipeChoice(recipe(), id) === 'boolean');
    const chosen = ids.find(id => enabled(id, recipe()));
    const oldLayout = legacy.materializedLayout;
    rememberDesktopView(chosen ? layoutForView(chosen) : explicit ? 'classic' : desktopViews.includes(oldLayout) ? oldLayout : 'ai-apps');
  }
  // Canonical shared per-shell intent wins, including explicit Desks ('').
  // A supported old shared single-view choice still wins over the local default.
  function effectiveDesktopView() {
    const chosen = chosenView('desktop');
    if (chosen !== undefined) return viewIds('desktop').includes(chosen) ? layoutForView(chosen) || 'classic' : 'classic';
    const legacy = viewIds('desktop').find(id => enabled(id, recipe()));
    return legacy ? layoutForView(legacy) || 'classic' : desktopView || 'ai-apps';
  }
  const wornView = (own, shell = shellHere()) => {
    const chosen = chosenView(shell);
    if (chosen !== undefined) return viewIds(shell).includes(chosen) ? chosen : '';
    if (desktop && shell === 'desktop') return viewIds(shell).find(id => layoutForView(id) === effectiveDesktopView()) || '';
    return viewIds(shell).find(id => enabled(id, own)) || '';
  };
  const cleanViews = v => Object.fromEntries(SHELLS.filter(s => typeof v?.[s] === 'string' && (v[s] === '' || ID.test(v[s]))).map(s => [s, v[s]]));
  const experience = {
    get state() {
      return copy({ owner, busy, error, active: window.WosSkinHost?.tweakState || [],
        shell: shellHere(),
        tweaks: [...manifests].filter(([id]) => shownInGroup(id)).map(([id, m]) => ({ id, name: m.name, description: m.description || '', author: id.split('/')[0], builtin: globalIds().includes(id), layout: layoutForView(id), view: viewOf(id), on: groupOf(id) ? groupOn(id) : enabled(id) })).map(t => t.view ? { ...t, shells: shellsOf(t.id), on: t.id === wornView(recipe()) } : t) });
    },
    installed, defaults, authors,
    // Initial shell routes must see the selected view, including overlapping refreshes.
    async whenReady() { let p; do { p = applying; await p; } while (p !== applying); },
    get desktopView() { return desktop ? effectiveDesktopView() : null; },
    get desktopViews() { return desktop ? desktopViews.map(id => { const l = window.WosSkinHost.layouts?.find(l => l.id === id); return { id, name: id === 'classic' ? 'Desks' : l?.name || id }; }) : []; },
    chooseDesktopView(id) {
      if (!desktop || !desktopViews.includes(id)) return Promise.resolve();
      const pick = id === 'classic' ? '' : viewIds('desktop').find(v => layoutForView(v) === id);
      if (pick === undefined) return Promise.resolve();
      state.views = { ...cleanViews(state.views), desktop: pick }; Store.write(state);
      rememberDesktopView(id);
      window.WosSkinHost.setStandardLayout?.(id); changed(); // paint before I/O
      try { window.dispatchEvent(new CustomEvent('wos:view-choice', { detail: { shell: 'desktop', id: pick } })); } catch (_) {}
      return apply();
    },
    // Replacement groups (catalog `oneOf`): each loads only its first enabled member. Read after installed() settles.
    groups: () => (catalog?.oneOf || []).map(g => [...g]),
    get installedReady() { return !!installedP?.settled; },
    // Look sync (core/look-sync.js): the tweaks switched on here, and wearing the owner's shared set instead.
    get mix() { return copy(state.mix || {}); },
    get defaultChoices() { return recipe() ? {} : Object.fromEntries(globalIds().map(id => [id, !globalOff(id)])); },
    // The view chosen per shell type ({ desktop, phone }: a view id, '' = Desks; a missing type = no choice yet).
    get views() { return cleanViews(state.views); },
    // Tweaks this release offers as switches (retired ids in an old device mix are not counted as choices).
    async tweakIds() { catalog ||= await read('tweaks/catalog.json'); return catalog.tweaks.filter(id => !globalIds().includes(id)); },
    // The shared set is complete: every tweak here is on or off, so this device's one-time migrations never add to it.
    // `views` (look sync): the owner's view per shell type; a type left out has no choice yet. Left out = untouched.
    async adopt(mix, views, defaults = {}) {
      catalog ||= await read('tweaks/catalog.json');
      const grouped = new Set((catalog.oneOf || []).flat()), next = {};
      for (const id of catalog.tweaks) if (!globalIds().includes(id) && !grouped.has(id)) next[id] = false;
      for (const [id, on] of Object.entries(mix || {})) if (on === true && ID.test(id)) next[canonical(id)] = true;
      // Old files omit defaults: retain local offs until the upgrade seeds them.
      const off = new Set(state.defaultsOff || []);
      const shared = recipe() ? [] : globalIds().filter(id => typeof defaults[id] === 'boolean');
      for (const id of shared) defaults[id] ? off.delete(id) : off.add(id);
      state.defaultsOff = [...off]; if (shared.length) state.defaultsMigrated = true;
      state.mix = next; state.preset = 'none'; delete state.carry;
      if (views && typeof views === 'object') state.views = cleanViews(views);
      Store.write(state);
      return apply();
    },
    refresh: apply,
    // A color pick never changes tweaks; kept so older callers stay harmless.
    chooseSkin() { if (error || wornOwner() !== owner) return apply(); return Promise.resolve(); },
    async toggle(id) {
      const item = experience.state.tweaks.find(t => t.id === id); if (!item) return;
      if (desktop && layoutForView(id)) return experience.chooseDesktopView(item.on ? 'classic' : layoutForView(id));
      if (item.view) {  // one view per shell type: on = this one on this type of shell, off = Desks here; the other type keeps its own
        const shell = shellHere(); if (!item.shells.includes(shell)) return;
        const pick = item.on ? '' : id;
        state.views = { ...cleanViews(state.views), [shell]: pick }; Store.write(state);
        try { window.dispatchEvent(new CustomEvent('wos:view-choice', { detail: { shell, id: pick } })); } catch (_) {}
        return apply();
      }
      // A oneOf group is one switch: off = this member off (that turns the group off); on = clear every member's off.
      if (item.on) await setOne(id, false);
      else for (const m of groupOf(id) || [id]) if (m === id || explicitOff(m)) await setOne(m, true);
      return apply();
    },
  };
  window.WosExperience = experience;
  window.addEventListener('wos:skin-host-ready', apply);
  window.addEventListener('wos:own-skin', apply);
  window.addEventListener('wos:skin', () => { void experience.chooseSkin(); });
  if (window.WosSkinHost?.personalState.ready) void apply();
  // Pick up the author's newly published tweaks on reopen, keeping the owner's offs by id.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && owner && !busy) void apply(); });
})();
