/* Shared launcher policy. Synced UI preferences own these choices, registry owns app metadata.
 * localStorage is an offline read cache only. The seed endpoint owns the migration transaction. */
(() => {
  'use strict';
  const defaults = window.WizLauncherDefaults, key = 'wos.launcher.cache.v1', marker = 'launcher-seed-v1';
  let current = defaults, shared = false, settled = false;
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const listeners = new Set();
  function accept(prefs) {
    if (!object(prefs?.launcher)) return;
    const valid = Object.fromEntries(Object.entries(prefs.launcher).filter(([name, value]) =>
      Object.hasOwn(defaults, name) && (Array.isArray(defaults[name]) ? Array.isArray(value) : object(value))));
    const next = { ...defaults, ...valid };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    try { localStorage.setItem(key, JSON.stringify(prefs.launcher)); } catch (_) {}
    listeners.forEach(fn => fn());
    window.dispatchEvent(new Event('wizard:launcher'));
  }
  try { accept({ launcher: JSON.parse(localStorage.getItem(key) || 'null') }); } catch (_) {}
  let loading;
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        if (window.WizConfig?.ready) await window.WizConfig.ready;
        const options = { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6000) };
        let r = await fetch('/wizard/v1/ui-preferences', options);
        if (!r.ok) return;
        let prefs = await r.json();
        if (!Object.hasOwn(prefs.migrations || {}, marker)) {
          r = await fetch('/wizard/v1/ui-preferences/seed', { ...options, method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marker, launcher: defaults }) });
          // Old release: no migration is written anywhere. Compatibility values stay in one module.
          if (!r.ok) { accept(prefs); return; }
          prefs = (await r.json()).preferences;
        }
        shared = true; accept(prefs);
      } catch (_) { /* Offline: read cache (or compatibility values), never a local seed marker. */ }
    })().finally(() => { loading = null; });
    return loading;
  }
  window.WizLauncher = {
    get: name => current[name], accept, load, get shared() { return shared; },
    // True once the first preferences load has finished (answered, failed or timed out).
    get settled() { return settled; },
    // Paint from the cache/defaults after one second; the uncancelled load still
    // publishes late preferences through the registry's existing onChange path.
    async waitForShell() {
      let timer;
      try { await Promise.race([window.WizLauncher.ready, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
    },
    hasHostedThread: id => current.hostedThreadApps.includes(id),
    displayName: app => Object.hasOwn(current.displayNames, app.id) ? current.displayNames[app.id] : app.name,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  window.WizLauncher.ready = load().finally(() => { settled = true; });
  addEventListener('focus', load);
})();
