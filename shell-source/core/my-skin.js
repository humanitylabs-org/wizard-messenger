/* My skin (Miguel, 20 Oct 2026): every owner has one personal stylesheet layered on top of whichever skin
 * they picked. It is a blank slate: empty = the picked skin exactly as its author made it.
 *
 * The folder lives on the box, outside this shell image: Skins/My skin/ in the owner's Files, served by
 * the Agent Service at GET /wizard/v1/my-skin (text/css, sanitised, size-capped). Shell and skin updates
 * never touch it, and the owner's agent edits it like any other file. James's and Miguel's skins keep
 * improving underneath; My skin's rules stay on top (same specificity, later in the cascade).
 *
 * CSS is applied as one <style> at the very end of <head>, after the base skin and its
 * package stylesheet, on phone and desktop. The last good copy is cached so it paints with the first frame.
 * Safety: an unreachable service keeps the cached copy; a service without My skin (404, older box) or any
 * non-CSS answer removes it; a bad rule only drops that rule (CSS error recovery). `?myskin=off` skips the
 * layer for one load, so a sheet that hides everything can always be fixed.
 *
 * Optional skin.js uses the package hook host, but only after a trusted Settings click approves its exact
 * SHA-256 on this device. Hash the response bytes and import those same bytes, never the URL again.
 * API: WosMySkin.state → { css, empty, info, off, script }, .refresh() → Promise, .reset() → Promise,
 *      .on(fn) (state changed), .FILE (the path inside Files). */
(function () {
  'use strict';
  const URL_CSS = '/wizard/v1/my-skin', CACHE = 'wos.myskin.v1', MAX = 64 * 1024;
  const FILE = 'Skins/My skin/skin.css', OK = 'wos.myskin.js.ok';
  const isDoc = typeof document !== 'undefined';
  let off = false;
  try { off = new URLSearchParams(location.search).get('myskin') === 'off'; } catch (_) {}
  const subs = new Set();
  const state = { css: '', empty: true, info: null, off, loaded: false };
  state.script = { exists: false, sha256: null, bytes: 0, approved: false };
  let verified = null, started = null, refreshSeq = 0;
  const approval = () => { try { return localStorage.getItem(OK); } catch (_) { return null; } };
  function stopScript() { window.WosSkinHost?.stopPersonal(); started = null; }
  function turnOff() {
    try { localStorage.removeItem(OK); } catch (_) {}
    state.script.approved = false; stopScript(); emit();
  }
  async function startScript() {
    const v = verified, host = window.WosSkinHost;
    if (off || !own() || !v || approval() !== v.sha256 || !host?.personalState.ready || started === v.sha256) return;
    started = v.sha256;
    await host.loadPersonal(v.bytes, () => !off && !!own() && verified === v && approval() === v.sha256, scriptFile());
    emit();
  }
  function turnOn(event) {
    // No agent/API approval, synthetic clicks or stale buttons. The trusted event must hit this exact version.
    const b = event?.target?.closest?.('button[data-myskin="on"]');
    if (off || !own() || !verified || verified.sha256 !== state.script.sha256 || typeof MouseEvent === 'undefined' || !(event instanceof MouseEvent) || !event.isTrusted || event.type !== 'click' || !b?.isConnected || b.disabled || b.dataset.myskinHash !== state.script.sha256 || !state.script.sha256) return false;
    try { localStorage.setItem(OK, state.script.sha256); } catch (_) { return false; }
    state.script.approved = true; startScript(); emit(); return true;
  }
  // Where the owner (and their agent) find the script: the worn own skin's folder in Files.
  const scriptFile = () => String(state.info?.path || FILE).replace(/skin\.css$/, 'skin.js');
  // A script that failed to load or set up is switched off (approval revoked, so the next load starts off) and
  // keeps its file and reason for Settings until different bytes arrive.
  function failed(detail) {
    if (!detail || !state.script.exists) return;
    state.script.error = { file: detail.file || scriptFile(), message: String(detail.message || 'error').slice(0, 160), sha256: state.script.sha256 };
    turnOff();
  }
  async function refreshScript(seq) {
    const info = state.info?.script;
    const lastError = state.script.error?.sha256 && state.script.error.sha256 === info?.sha256 ? state.script.error : null;
    if (info?.exists) { migrate('skin.js'); apply(state.css); }
    if (!info?.exists || verified?.sha256 !== info.sha256) { verified = null; stopScript(); }
    state.script = { exists: !!info?.exists, sha256: info?.sha256 || null, bytes: info?.bytes || 0, approved: false, file: scriptFile(), error: lastError };
    if (!info?.exists || approval() !== info.sha256) { turnOff(); }
    if (!info?.exists || !/^[a-f0-9]{64}$/.test(info.sha256 || '') || info.bytes > MAX) { stopScript(); return; }
    try {
      const r = await fetch(`${URL_CSS}/script`, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok || !(r.headers.get('content-type') || '').startsWith('application/javascript')) throw new Error('not a script');
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength > MAX) throw new Error('too large');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (seq !== refreshSeq) return;
      if (hash !== info.sha256 || hash !== r.headers.get('X-Wizard-Sha256')) throw new Error('script changed while reading');
      const problem = window.WosSkinHost?.scriptProblem(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (problem) { state.script.error = { file: scriptFile(), message: typeof problem === 'string' ? problem : 'use the skin hook API', sha256: hash }; throw new Error('use the skin hook API'); }
      verified = verified?.sha256 === hash ? verified : { bytes, sha256: hash };
      state.script.valid = true;
      state.script.approved = approval() === hash;
      if (!state.script.approved) stopScript();
      else await startScript();
    } catch (_) { if (seq === refreshSeq) { verified = null; turnOff(); } }
  }
  // The box owns recipes. Device previews stay recoverable without background box writes.
  const RECIPES = 'wos.own-skins.v1', BOX_CACHE = 'wos.own-skins.cache.v1', URL_SKINS = '/wizard/v1/skins';
  let serverMode = null, loadingRecipes = null, writing = Promise.resolve(), selecting = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  let recipes = { version: 1, skins: [], active: null, migrated: false };
  const DISMISSED = 'wos.own-skins.dismissed.v1';
  function devicePreviews() {
    try {
      const saved = JSON.parse(localStorage.getItem(RECIPES)), dismissed = JSON.parse(localStorage.getItem(DISMISSED) || '[]');
      if (saved?.version !== 1 || !Array.isArray(saved.skins)) return [];
      return clone(saved.skins.filter(s => s && typeof s.id === 'string' && s.id.length <= 64 && typeof s.name === 'string' && s.name.trim() && s.name.length <= 60 && typeof s.base === 'string' && s.tweaks && typeof s.tweaks === 'object' && !Array.isArray(s.tweaks) && !recipes.skins.some(r => r.id === s.id) && !(Array.isArray(dismissed) && dismissed.includes(s.id))));
    } catch (_) { return []; }
  }
  function dismissPreview(id) {
    if (!devicePreviews().some(s => s.id === id)) return;
    // Original bytes remain for rollback; only explicit recovery/discard hides this entry.
    try { const saved = JSON.parse(localStorage.getItem(DISMISSED) || '[]'); localStorage.setItem(DISMISSED, JSON.stringify([...new Set([...(Array.isArray(saved) ? saved : []), id])])); } catch (_) {}
    emit();
  }
  try {
    const saved = JSON.parse(localStorage.getItem(BOX_CACHE) || localStorage.getItem(RECIPES));
    if (saved?.version === 1 && Array.isArray(saved.skins)) {
      recipes = { version: 1, skins: saved.skins.filter(s => s && typeof s.id === 'string' && s.id.length <= 64 && typeof s.name === 'string' && s.name.trim() && s.name.length <= 60 && typeof s.base === 'string' && s.tweaks && typeof s.tweaks === 'object' && !Array.isArray(s.tweaks)), active: saved.active, migrated: !!saved.migrated };
      if (!recipes.skins.some(s => s.id === recipes.active)) recipes.active = null;
    }
  } catch (_) {}
  const own = () => recipes.skins.find(s => s.id === recipes.active) || null;
  function persist(next) {
    localStorage.setItem(RECIPES, JSON.stringify(next));
    if (serverMode === false) { try { localStorage.removeItem(BOX_CACHE); } catch (_) {} }
    recipes = next;
  }
  function migrate(css) {
    if (serverMode === true) return;
    if (recipes.migrated || emptyCss(css)) return;
    const skin = { id: 'my-skin', name: 'My skin', base: window.WosSkin?.current || 'nebula', tweaks: {}, legacy: true };
    try {
      persist({ version: 1, skins: [skin], active: skin.id, migrated: true });
      if (typeof Event !== 'undefined') window.dispatchEvent?.(new Event('wos:own-skin'));
    } catch (_) {}
  }
  function recipeChanged() {
    apply(state.css);
    if (!own()) stopScript(); else void startScript();
    emit();
    if (typeof Event !== 'undefined') window.dispatchEvent?.(new Event('wos:own-skin'));
  }
  function wear(id) {
    const skin = recipes.skins.find(s => s.id === id); if (!skin) throw new Error('Skin not found');
    persist({ ...recipes, active: id }); window.WosSkin?.set(skin.base); recipeChanged(); return clone(skin);
  }
  function leave() { if (!own()) return; persist({ ...recipes, active: null }); recipeChanged(); }
  function create({ name, base, tweaks }) {
    name = String(name || '').trim();
    if (!name || name.length > 60) throw new Error('Give your skin a name (up to 60 characters)');
    if (!window.WosSkin?.list.some(s => s.id === base)) throw new Error('Choose an installed color');
    if (recipes.skins.some(s => s.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('You already have a skin with that name');
    const map = Object.fromEntries(Object.entries(tweaks || {}).filter(([id,v]) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(id) && typeof v === 'boolean'));
    const skin = { id: 'skin-' + crypto.randomUUID(), name, base, tweaks: map };
    persist({ ...recipes, skins: [...recipes.skins, skin], active: skin.id, migrated: true });
    window.WosSkin.set(base); recipeChanged(); return clone(skin);
  }
  function update(values) {
    const skin = own(); if (!skin) return;
    const base = values.base || skin.base;
    if (!window.WosSkin?.list.some(s => s.id === base)) throw new Error('Choose an installed color');
    const next = { ...skin, base, tweaks: { ...skin.tweaks, ...(values.tweaks || {}) } };
    persist({ ...recipes, skins: recipes.skins.map(s => s.id === skin.id ? next : s) });
    if (window.WosSkin.current !== base) window.WosSkin.set(base); recipeChanged();
  }
  function remove(id) {
    const index = recipes.skins.findIndex(s => s.id === id); if (index < 0) return null;
    const snapshot = { skin: clone(recipes.skins[index]), index, worn: recipes.active === id };
    persist({ ...recipes, skins: recipes.skins.filter(s => s.id !== id), active: snapshot.worn ? null : recipes.active, migrated: true });
    if (snapshot.worn) window.WosSkin?.set(snapshot.skin.base); recipeChanged(); return snapshot;
  }
  function restore(snapshot) {
    if (!snapshot || recipes.skins.some(s => s.id === snapshot.skin.id)) return;
    const skins = [...recipes.skins]; skins.splice(snapshot.index, 0, snapshot.skin);
    persist({ ...recipes, skins, active: snapshot.worn ? snapshot.skin.id : recipes.active });
    if (snapshot.worn) window.WosSkin?.set(snapshot.skin.base); recipeChanged();
  }
  async function request(path, method = 'GET', body) {
    const r = await fetch(URL_SKINS + path, { method, credentials: 'same-origin', cache: 'no-store',
      ...(method === 'GET' ? {} : { headers: { 'X-Requested-With': 'wizard', 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }) });
    if (r.status === 404 || r.status === 405) {
      let code; try { code = (await r.json()).error; } catch (_) {}
      const e = new Error(code || 'Older Wizard'); e.older = r.status === 405 || !code || code === 'not_found'; throw e;
    }
    if (!r.ok) throw new Error(`Could not save skin on your Wizard (${r.status})`);
    return r.json();
  }
  function receive(list) {
    if (!list || !Array.isArray(list.skins)) throw new Error('Invalid skins response');
    const oldActive = recipes.active;
    const skins = list.skins.filter(s => s && typeof s.id === 'string' && !(s.id === 'My skin' && s.empty && !s.has_script && !s.has_recipe)).map(s => ({ ...s, tweaks: s.tweaks || {} }));
    const next = { version: 1, skins, active: list.active, migrated: true };
    const changed = JSON.stringify(recipes) !== JSON.stringify(next); recipes = next;
    // A storage quota failure must not turn a successful box write into a false failure.
    try { localStorage.setItem(BOX_CACHE, JSON.stringify(recipes)); } catch (_) {}
    if (oldActive !== recipes.active) { verified = null; stopScript(); apply(''); cache(''); }
    selecting = true;
    try { if (own() && window.WosSkin?.current !== own().base && window.WosSkin?.list.some(s => s.id === own().base)) window.WosSkin.set(own().base); }
    finally { selecting = false; }
    if (changed) recipeChanged();
  }
  async function loadRecipes() {
    if (serverMode === false) return;
    if (loadingRecipes) return loadingRecipes;
    loadingRecipes = (async () => {
      try {
        let list = await request('');
        if (!Array.isArray(list.skins)) throw new Error('Invalid skins response');
        serverMode = true;
        // Discovery is read-only: an old Service ignores migration_key and creates
        // suffixed empty folders. Keep device previews for recovery; never POST a
        // named skin or change the box selection without an explicit owner action.
        receive(list);
      } catch (e) {
        if (e.older) { serverMode = false; migrate(state.css); }
        // Offline / denied: keep the last box cache, never invent a successful write.
      } finally { loadingRecipes = null; }
    })();
    return loadingRecipes;
  }
  function boxAction(local, remote) {
    return (...args) => {
      if (serverMode === false) return local(...args);
      const action = writing.then(async () => {
        await loadRecipes();
        if (serverMode === false) return local(...args);
        if (serverMode !== true) throw new Error('Connect to your Wizard to save this skin');
        try { return await remote(...args); }
        catch (e) { if (!e.older) throw e; serverMode = false; return local(...args); }
      });
      writing = action.catch(() => {}); return action;
    };
  }
  async function syncBox() { receive(await request('')); await refresh(); }
  async function createOnBox({ name, base, tweaks }) {
    name = String(name || '').trim();
    if (!name || name.length > 60) throw new Error('Give your skin a name (up to 60 characters)');
    if (!window.WosSkin?.list.some(s => s.id === base)) throw new Error('Choose an installed color');
    if (recipes.skins.some(s => s.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('You already have a skin with that name');
    const made = await request('', 'POST', { name, base, tweaks: tweaks || {}, activate: true });
    await syncBox(); return clone(recipes.skins.find(s => s.id === made.id));
  }
  async function wearOnBox(id) {
    if (!recipes.skins.some(s => s.id === id)) throw new Error('Skin not found');
    receive(await request('/active', 'PUT', { id })); await refresh(); return clone(own());
  }
  async function leaveOnBox() { receive(await request('/active', 'PUT', { id: null })); await refresh(); }
  async function updateOnBox(values) {
    const s = own(); if (!s) return;
    receive(await request('/' + encodeURIComponent(s.id), 'PATCH', values));
    await refresh();
  }
  async function removeOnBox(id) {
    const skin = recipes.skins.find(s => s.id === id); if (!skin) return null;
    const snapshot = { skin: clone(skin), worn: recipes.active === id };
    const result = await request('/' + encodeURIComponent(id), 'DELETE', {});
    snapshot.trash = result.trash; receive(result.list); await refresh().catch(() => {}); return snapshot;
  }
  async function restoreOnBox(snapshot) {
    if (!snapshot?.trash || recipes.skins.some(s => s.id === snapshot.skin.id)) return;
    const result = await request('/restore', 'POST', { trash: snapshot.trash }); receive(result.list);
    if (snapshot.worn) receive(await request('/active', 'PUT', { id: result.id }));
    await refresh();
  }
  const emptyCss = css => !String(css || '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').trim();
  let el = null;

  function styleEl() {
    if (!isDoc) return null;
    if (!el) { el = document.createElement('style'); el.id = 'wosMySkin'; el.dataset.mySkin = ''; }
    // Always last in <head>: after core/skins.css, the skin package sheet and skin-frame.css.
    const head = document.head || document.documentElement;
    if (el.parentNode !== head || head.lastElementChild !== el) head.appendChild(el);
    return el;
  }
  function apply(css) {
    css = typeof css === 'string' && css.length <= MAX ? css : '';
    state.css = css; state.empty = emptyCss(css); migrate(css);
    if (!isDoc) return;
    if (off || !own() || state.empty) { if (el) { el.textContent = ''; el.remove(); } }
    else { const s = styleEl(); if (s.textContent !== css) s.textContent = css; }
    if (document.documentElement) document.documentElement.toggleAttribute('data-my-skin', !off && !!own() && !state.empty);
  }
  const emit = () => { for (const fn of [...subs]) { try { fn(state); } catch (_) {} } };
  const cache = css => { try { if (css && !emptyCss(css)) localStorage.setItem(CACHE, css); else localStorage.removeItem(CACHE); } catch (_) {} };

  async function refresh() {
    if (off) return state;
    await loadRecipes();
    const seq = ++refreshSeq;
    let r;
    try { r = await fetch(URL_CSS, { cache: 'no-cache', credentials: 'same-origin' }); }
    catch (_) { state.loaded = true; emit(); return state; } // offline: keep the last good copy
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && type.startsWith('text/css')) {
      let css = '';
      try { css = await r.text(); } catch (_) { return state; }
      if (seq !== refreshSeq) return state;
      apply(css); cache(state.css);
    } else if (r.status !== 304) { apply(''); cache(''); } // no My skin on this box (yet): the base skin, exactly
    state.loaded = true;
    try {
      const j = await fetch(`${URL_CSS}?format=json`, { cache: 'no-store', credentials: 'same-origin' });
      const info = j.ok ? await j.json() : null;
      if (seq !== refreshSeq) return state;
      state.info = info; await refreshScript(seq);
    } catch (_) { verified = null; stopScript(); }
    emit(); return state;
  }
  async function reset() {
    const r = await fetch(URL_CSS, { method: 'DELETE', credentials: 'same-origin', headers: { 'X-Requested-With': 'wizard' } });
    if (!r.ok) throw new Error(`My skin reset failed (${r.status})`);
    apply(''); cache('');
    return refresh();
  }

  // First paint: the cached copy, synchronously, then the box's current file.
  if (!off) { try { const c = localStorage.getItem(CACHE); if (c) apply(c); } catch (_) {} }
  const api = {
    get FILE() { return own() ? 'Skins/' + own().id + '/skin.css' : FILE; },
    get recipes() { return clone(recipes.skins); },
    get previews() { return devicePreviews(); },
    dismissPreview,
    get active() { return own() ? clone(own()) : null; },
    create: boxAction(create, createOnBox), wear: boxAction(wear, wearOnBox), leave: boxAction(leave, leaveOnBox), update: boxAction(update, updateOnBox), remove: boxAction(remove, removeOnBox), restore: boxAction(restore, restoreOnBox),
    get storage() { return serverMode === true ? 'box' : serverMode === false ? 'local' : 'offline'; },
    get state() { return state; },
    // The owner overlay stays above the skin and the tweaks it brings; changing skin never clears it.
    // Per-skin tweak offs live in experience.js until Agent Service offers an owner profile route.
    get experience() { return window.WosExperience || null; },
    refresh, reset, turnOn, turnOff, startScript,
    on(fn) { if (typeof fn === 'function') subs.add(fn); return () => subs.delete(fn); },
    _test: { apply, emptyCss },
  };
  if (typeof window !== 'undefined') {
    window.WosMySkin = api;
    if (own() && window.WosSkin?.list.some(s => s.id === own().base)) window.WosSkin.set(own().base);
    window.addEventListener?.('wos:skin', () => { if (!selecting && own() && own().base !== window.WosSkin.current) { const pending = api.leave(); pending?.catch?.(() => {}); } });
    if (isDoc && !off) {
      window.addEventListener?.('storage', e => { if (e.key === OK) { stopScript(); refresh(); } });
      window.addEventListener?.('wos:personal-error', e => failed(e.detail));
      refresh();
      // Stylesheets added to <head> later (skin packages) must not land above My skin.
      document.addEventListener('DOMContentLoaded', () => { if (!state.empty && el) styleEl(); });
      // Coming back to the app picks up an edit made meanwhile (in Files or by the agent).
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
