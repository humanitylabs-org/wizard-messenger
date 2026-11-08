/* App-declared home-screen capabilities (wizard.md `home_screen`). The shell holds NO per-app table:
 * an installed app opts in itself, the Agent Service carries the declaration, and this module is the only
 * place that validates it (shell page, pinned-session page and service worker all use it).
 *   offline        a home-screen pin of this app may open with no connection (shell prepared ahead, route and
 *                  reading position kept in the app's WizOffline replica, crash-durably)
 *   position_keys  localStorage key patterns ('*' wildcard) holding SCREEN position; kept per pin, not shared
 *   route_state    history.state key the app restores its own route from at boot (shell won't replay popstate)
 * Unknown or malformed input yields null: an app never gains a capability by being sloppy. */
(() => {
  'use strict';
  const STATE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
  // A pattern must name its app: at least 3 literal characters before the first '*', no controls, bounded length.
  const KEY = /^[^\x00-\x1f\x7f*]{3,}[^\x00-\x1f\x7f]{0,117}$/;
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Array.isArray(raw.position_keys ?? raw.positionKeys) ? (raw.position_keys ?? raw.positionKeys) : [];
    const out = {
      offline: raw.offline === true,
      positionKeys: Object.freeze(keys.filter(k => typeof k === 'string' && k.length <= 120 && KEY.test(k)).slice(0, 8)),
      routeState: typeof (raw.route_state ?? raw.routeState) === 'string' && STATE.test(raw.route_state ?? raw.routeState) ? (raw.route_state ?? raw.routeState) : '',
    };
    return out.offline || out.positionKeys.length || out.routeState ? Object.freeze(out) : null;
  }
  const escape = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  function matcher(caps) {
    const res = (caps?.positionKeys || []).map(p => new RegExp('^' + p.split('*').map(escape).join('.*') + '$'));
    return key => { const k = String(key); return res.some(r => r.test(k)); };
  }
  /* The replica a pinned offline app keeps its presentation in: the app's WizOffline prefix, `<id>-`. */
  const replicaPrefix = id => /^[a-z][a-z0-9-]*$/.test(String(id)) ? id + '-' : '';
  const api = Object.freeze({ sanitize, matcher, replicaPrefix });
  globalThis.WizHomeScreenCapabilities = api;
  if (typeof window !== 'undefined') window.WizHomeScreenCapabilities = api;
})();
