/* Small common action/view registry for voice commands, deep links and both window hosts. Never listed in Settings (James, 25 Oct 2026). */
(() => {
  'use strict';
  const entries = new Map(); let H;
  const retired = w => !!w && (['review', 'maps'].includes(w.app) || w.appId === 'system' || w.app === 'feature' && ['day', 'week', 'month', 'maps', 'command'].includes(w.featureId));
  const api = window.WosFeatures = {
    retired,
    register(f) { if (!f.id || entries.has(f.id)) throw Error('Unique feature id required'); entries.set(f.id, f); window.WosSettings.refresh?.(); return () => entries.delete(f.id); },
    pruneWindows(wins) {
      for (const [id, w] of Object.entries(wins)) {
        if (retired(w)) delete wins[id];
      }
    },
    install(host) { H = host; },
    has: id => entries.has(id),
    open(id, opts = {}) { const f = entries.get(id); if (!f || !H || f.available && !f.available()) return false; if (f.run) f.run(H, opts); else H.openFeature(id, {...opts,context:opts.context || H.context?.()}); return true; },
    mount(id, root, opts = {}) { const f = entries.get(id); if (!f) return; return f.mount?.(root, H, opts); },
    get entries() { return [...entries.values()]; }
  };
})();
