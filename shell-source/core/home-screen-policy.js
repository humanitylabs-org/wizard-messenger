/* Pin identity is an app ID, never a caller-provided launch URL. */
(() => {
  'use strict';
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id);
  const isShell = value => { try { return /^\/wizard-os-home(?:[/-]|$)/.test(new URL(value,location.origin).pathname); } catch (_) { return true; } };
  function within(value, base, origin = location.origin) {
    try {
      const u = new URL(value, origin), b = new URL(base, origin);
      const root = b.pathname.endsWith('/') ? b.pathname : b.pathname.slice(0, b.pathname.lastIndexOf('/') + 1);
      return u.origin === origin && b.origin === origin && root !== '/' && !/%(?:2f|5c|2e|25)/i.test(u.pathname) && u.pathname.startsWith(root);
    } catch (_) { return false; }
  }
  const key = (origin, id) => 'wos.single.v1:' + JSON.stringify([origin, id]);
  // Registry names stay unchanged in desks; launcher/task names are app names.
  const displayName = app => window.WizLauncher?.displayName(app) || app.name;
  const requested = new URLSearchParams(location.search).get('app-session');
  // Even malformed session links must not reveal the workspace.
  const mode = requested !== null;
  const id = validId(requested) ? requested : '';
  if (mode) document.documentElement.setAttribute('data-app-session', id || 'unavailable');
  // What the pinned app declared for itself (wizard.md `home_screen`, see home-screen-capabilities.js). Nothing here
  // names an app: until configure() is given a declaration, every app keeps the plain shared-storage contract.
  let caps = null, matches = () => false, journal = null, preparing = null, presentationFailed = false, generation = 0;
  function configure(declared) {
    if (!mode || !id) return caps;
    const next = window.WizHomeScreenCapabilities?.sanitize(declared) || null;
    if (JSON.stringify(next) === JSON.stringify(caps)) return caps;
    // A registry refresh can change or withdraw authority. Existing facades consult this live matcher;
    // future route/position writes must never keep using a journal authorized by an older declaration.
    generation++; caps = next; journal = null; preparing = null; presentationFailed = false;
    matches = window.WizHomeScreenCapabilities?.matcher(caps) || (() => false);
    return caps;
  }
  const positionPrefix = () => key(location.origin,id) + ':presentation:';
  const positionKey = k => matches(k);
  function notifyPresentationFailure() {
    presentationFailed = true;
    // Quiet by contract: the app decides how to say so (an inline notice, never a popup).
    for (const f of document.querySelectorAll?.('iframe') || []) {
      try { f.contentWindow.dispatchEvent(new f.contentWindow.CustomEvent('wizard:presentation-save-failed')); } catch (_) {}
    }
  }
  function preparePresentation() {
    // Only an app that declared offline keeps a crash-durable journal, in its own replica; others keep localStorage.
    const prefix = window.WizHomeScreenCapabilities?.replicaPrefix(id);
    if (!caps?.offline || !prefix) return Promise.resolve();
    if (preparing) return preparing;
    if (!window.WizOffline?.presentation) { notifyPresentationFailure(); return Promise.resolve(false); }
    const epoch = generation;
    journal = window.WizOffline.presentation({ prefix,slot:key(location.origin,id),onFailure:() => { if (epoch === generation) notifyPresentationFailure(); },
      initial:() => {
        let route = null; try { route = JSON.parse(localStorage.getItem(key(location.origin,id))); } catch (_) {}
        const positions = Object.create(null), pre = positionPrefix();
        for (const k of Object.keys(localStorage)) if (k.startsWith(pre) && positionKey(k.slice(pre.length))) {
          const n = Number(localStorage.getItem(k)); if (Number.isFinite(n) && n >= 0 && n <= 1) positions[k.slice(pre.length)] = n;
        }
        return {route,positions:Object.fromEntries(Object.entries(positions).slice(-80))};
      }
    });
    preparing = journal.ready.then(() => epoch === generation, () => false);
    return preparing;
  }
  function presentationRoute() { return journal?.snapshot()?.route; }
  function savePresentationRoute(route) {
    if (!journal || presentationFailed) return;
    const current = journal.snapshot();
    // at is diagnostic; an unchanged route/state must not churn the disk every 750ms.
    if (current?.route?.href === route.href && current.route.base === route.base && JSON.stringify(current.route.state) === JSON.stringify(route.state)) return;
    void journal.commit({route}).catch(() => {});
  }
  function readPosition(k,storage) {
    const value = journal?.snapshot();
    if (value) return Object.hasOwn(value.positions,k) ? String(value.positions[k]) : null;
    return storage.getItem(positionPrefix()+k);
  }
  function savePosition(k,v,storage) {
    // The synchronous cache remains immediate; only the strict IDB commit is durable.
    try { storage.setItem(positionPrefix()+k,v); } catch (_) {}
    const n = Number(v), current = journal?.snapshot();
    if (!presentationFailed && current && Number.isFinite(n) && n >= 0 && n <= 1 && current.positions[k] !== n) {
      void journal.commit({positions:{[k]:n}}).catch(() => {});
    }
  }
  function installPresentationStorage(frame) {
    if (!mode || !id || frame === window || frame.location.origin !== location.origin || (frame.__wosPresentationStorageDocument && frame.__wosPresentationStorageDocument === frame.document)) return;
    const storage = frame.localStorage, prefix = positionPrefix();
    // The app declared which keys hold screen position (not content or preferences). Those are kept per pin;
    // size/theme, highlights, read/saved state and every other key stay shared.
    const map = k => positionKey(k) ? prefix + k : String(k);
    const facade = new Proxy(storage, {
      get(target, prop) {
        if (prop === 'getItem') return k => positionKey(k) && journal ? readPosition(String(k),target) : target.getItem(map(k));
        if (prop === 'setItem') return (k,v) => positionKey(k) && journal ? savePosition(String(k),v,target) : target.setItem(map(k),v);
        if (prop === 'removeItem') return k => { target.removeItem(map(k)); if (positionKey(k) && journal?.snapshot() && !presentationFailed) void journal.commit({positions:{[String(k)]:null}}).catch(() => {}); };
        const value = Reflect.get(target,prop,target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    Object.defineProperty(frame,'localStorage',{ configurable:true, value:facade });
    frame.__wosPresentationStorage = true;
    frame.__wosPresentationStorageDocument = frame.document;
  }
  window.WizHomeScreenPolicy = Object.freeze({ validId, isShell, within, key, displayName, mode, id, configure, get capabilities() { return caps; }, installPresentationStorage, preparePresentation, presentationRoute, savePresentationRoute, get presentationFailed() { return presentationFailed; } });
})();
