/* Home-screen identity for a Wizard app opened directly at its own path (/morning-report/…), not inside the
 * shell. Loaded by core/app-client.js for top-level documents; an app may also include it directly.
 *
 * The first path segment is only a lookup key. Name, root (start_url/scope) and icon all come from the
 * registry, through the shell's read-only responder /wizard-os-home/install/at/<segment>.webmanifest, which
 * matches only a registered app whose url is exactly /<segment>/ on this origin. An unregistered path gets a
 * 404 and nothing is added. Precedence: an app's own <link rel=manifest> wins (we add no manifest and never
 * redirect); existing apple-touch-icon / apple-mobile-web-app-* tags are never replaced, only filled in. */
(() => {
  'use strict';
  if (window.WizardAppIdentity) return;
  window.WizardAppIdentity = true;
  try { if (parent !== window) return; } catch (_) { return; }
  const seg = location.pathname.split('/')[1] || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(seg) || seg === 'wizard-os-home' || seg === 'wizard-ux' || seg === 'wizard'
      || !location.pathname.startsWith('/' + seg + '/')) return;
  const head = document.head || document.documentElement;
  const has = sel => !!document.querySelector(sel);
  const own = has('link[rel~="manifest"]');
  const href = '/wizard-os-home/install/at/' + seg + '.webmanifest';
  const add = (tag, attrs) => { const el = document.createElement(tag); for (const k in attrs) el.setAttribute(k, attrs[k]); el.dataset.wizardHome = ''; head.appendChild(el); return el; };
  // Added synchronously so Chrome sees it on first manifest check; removed again if the app isn't registered.
  const link = own ? null : add('link', { rel: 'manifest', href, crossorigin: 'use-credentials' });
  fetch(href, { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r.status)).then(m => {
    if (!m || typeof m.name !== 'string' || typeof m.start_url !== 'string' || !Array.isArray(m.icons)) throw new Error('manifest');
    const touch = (m.icons.find(i => i.sizes === '180x180') || m.icons.find(i => i.sizes === '192x192') || m.icons[0] || {}).src;
    if (typeof touch === 'string' && touch.startsWith('/wizard-os-home/') && !has('link[rel~="apple-touch-icon"]')) add('link', { rel: 'apple-touch-icon', href: touch });
    const name = m.name.slice(0, 80);
    if (!has('meta[name="apple-mobile-web-app-title"]')) add('meta', { name: 'apple-mobile-web-app-title', content: name });
    if (!has('meta[name="application-name"]')) add('meta', { name: 'application-name', content: name });
    if (!has('meta[name="apple-mobile-web-app-capable"]')) add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    if (!has('meta[name="mobile-web-app-capable"]')) add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    // iOS Safari saves the page being read (a single report) and ignores start_url. An iOS home-screen launch
    // (navigator.standalone) starts at the app root once per cold launch (sessionStorage is fresh each
    // launch); in-app navigation afterwards is untouched. Not in Chrome: it already honours start_url, and its
    // installed window can legitimately open in-scope deep links (e.g. from a notification).
    const start = new URL(m.start_url, location.origin);
    if (!own && navigator.standalone === true && start.origin === location.origin && start.pathname === '/' + seg + '/') {
      let first = false;
      try { first = !sessionStorage.getItem('wizardApp.launched:' + seg); sessionStorage.setItem('wizardApp.launched:' + seg, '1'); } catch (_) {}
      if (first && location.href !== start.href) location.replace(start.href);
    }
  }).catch(() => { link?.remove(); });
})();
