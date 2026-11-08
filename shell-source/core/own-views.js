/* Own screen opening is shell-owned. App messages can report a load failure, never revert.
 * Revert uses the same owner-only listener as Settings → Updates, then reads it back.
 * No new Back/history stack: Settings and window lifetimes remain the shell's. */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const own = a => a?.source === 'apps.json' && a.view?.mode === 'own' && a.view.url === `/wizard/views/${a.id}/`;
  const broken = new Map(), mounted = new WeakSet();
  // Each registry() call constructs a subscriber and emits wizard:apps. Cache the
  // two projections before registering our listener; never construct one in it.
  const apps = () => registries.flatMap(r => r.APPS);
  const app = id => apps().find(a => a.id === id);
  const frameUrl = (a, saved) => {
    if (own(a)) { if (broken.has(a.id)) { a.url = a.originalUrl; return a.originalUrl; } return saved?.startsWith(a.view.url) ? saved : a.view.url; }
    return saved?.startsWith(`/wizard/views/${a?.id}/`) ? a.originalUrl || a.url : saved || a?.url || '/';
  };
  const marker = a => own(a) ? `<button type="button" class="own-view-marker" data-own-original="${esc(a.id)}" title="Use original screen">Your version</button>` : '';
  if (typeof module !== 'undefined' && module.exports) { module.exports = { own, frameUrl, marker }; return; }
  const registries = ['mobile', 'desktop'].map(k => window.WizCore.apps(k));
  const API = new URL('../store-install/_views/', document.currentScript.src).href;
  let selected = '', busy = false, note = '';
  const frames = id => [...document.querySelectorAll('iframe[data-own-app]')].filter(f => f.dataset.ownApp === id);
  function failure(id, file) {
    if (broken.has(id)) return;
    let name = 'index.html';
    try { name = new URL(String(file || name), location.href).pathname.split('/').pop() || name; } catch (_) {}
    name = name.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'index.html';
    const a = app(id); if (!a || !own(a)) return;
    const text = `Your version couldn’t load ${name}. Showing the original screen.`;
    broken.set(id, text);
    for (const a of apps().filter(a => a.id === id)) a.url = a.originalUrl;
    for (const f of frames(id)) {
      f.src = a.originalUrl;
      const host = f.closest('.win'), old = host?.querySelector('.own-view-note');
      if (host && !old) { const p = document.createElement('p'); p.className = 'own-view-note'; p.setAttribute('role', 'status'); p.textContent = text; f.parentElement.insertBefore(p, f); }
    }
  }
  async function watch(f) {
    const a = app(f.dataset.ownApp); if (!own(a) || mounted.has(f) || broken.has(a.id)) return;
    mounted.add(f);
    const timer = setTimeout(() => { if (f.isConnected && !f.dataset.ownReady) failure(a.id, 'index.html'); }, 12000);
    f.addEventListener('load', () => {
      if (!f.isConnected || broken.has(a.id)) { clearTimeout(timer); return; }
      // HTTP error documents have load events too. A successful own document has
      // the Service's boot script (also required by the readiness watchdog).
      try { if (!f.contentDocument?.querySelector('script[src="/wizard/views/_boot.js"]')) failure(a.id, 'index.html'); } catch (_) { failure(a.id, 'index.html'); }
    });
    f.addEventListener('error', () => failure(a.id, 'index.html'));
    try {
      const r = await fetch(a.view.url, { credentials: 'same-origin', cache: 'no-store' });
      if (f.isConnected && (!r.ok || !(r.headers.get('content-type') || '').includes('text/html'))) failure(a.id, 'index.html');
    } catch (_) { if (f.isConnected) failure(a.id, 'index.html'); }
    f._ownTimer = timer;
  }
  const scan = () => document.querySelectorAll('iframe[data-own-app]').forEach(watch);
  addEventListener('wizard:apps', () => {
    for (const f of document.querySelectorAll('iframe[data-own-app]')) {
      const a = app(f.dataset.ownApp); if (!a) continue;
      const url = frameUrl(a, f.getAttribute('src'));
      const host = f.closest('.win'), bar = host?.querySelector('.wbar');
      const badge = bar?.querySelector('[data-own-original]');
      if (own(a) && !badge) bar?.insertAdjacentHTML('beforeend', marker(a));
      if (!own(a)) { badge?.remove(); host?.querySelector('.own-view-note')?.remove(); broken.delete(a.id); }
      if (url !== f.getAttribute('src')) {
        clearTimeout(f._ownTimer); delete f.dataset.ownReady; mounted.delete(f); f.src = url; watch(f);
      }
    }
  });
  addEventListener('message', e => {
    if (e.origin !== location.origin || !['wizard:own-view:ready', 'wizard:own-view:error'].includes(e.data?.type)) return;
    const f = [...document.querySelectorAll('iframe[data-own-app]')].find(f => f.contentWindow === e.source);
    const a = f && app(f.dataset.ownApp); if (!own(a) || broken.has(a.id) || !f.getAttribute('src')?.startsWith(a.view.url)) return;
    if (e.data.type === 'wizard:own-view:error') failure(a.id, e.data.file);
    else { f.dataset.ownReady = 'true'; clearTimeout(f._ownTimer); }
  });
  async function revert(id) {
    busy = true; note = ''; window.WosSettings.refresh();
    try {
      const url = API + encodeURIComponent(id);
      const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type':'application/json', 'X-Wizard-Store':'1' }, body: JSON.stringify({ action: 'revert' }) });
      if (!r.ok) throw new Error('Couldn’t use the original. The App Manager needs an owner connection.');
      const check = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!check.ok || (await check.json()).active !== false) throw new Error('The App Manager hasn’t confirmed the original yet.');
      const original = app(id)?.originalUrl;
      await window.WizCore.refreshApps();
      if (app(id)?.view?.mode !== 'original') throw new Error('The app list hasn’t confirmed the original yet. Try again.');
      broken.delete(id);
      for (const f of frames(id)) { f.closest('.win')?.querySelector('.own-view-note')?.remove(); f.src = original; }
      document.querySelectorAll('[data-own-original]').forEach(b => { if (b.dataset.ownOriginal === id) b.remove(); });
      selected = ''; note = 'Using the original screen. Your files are kept.';
    } catch (e) { note = e.message; }
    finally { busy = false; window.WosSettings.refresh(); }
  }
  window.WosSettings.register({ id:'own-views', aliases:['own-views'], available: () => !!selected || apps().some(own), html: () => {
    const a = app(selected), list = [...new Map(apps().filter(own).map(a => [a.id, a])).values()];
    return `<div class="st-group"><h4>Your app screens</h4>${a && own(a) ? `<p class="st-note">Use the original screen for ${esc(a.name)}? Your version’s files are kept.</p><button class="st-wide" data-own-confirm="${esc(a.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Switching…' : 'Use original'}</button><button class="st-wide" data-own-cancel ${busy ? 'disabled' : ''}>Keep your version</button>` : list.map(a => `<button class="st-row" data-own-original="${esc(a.id)}"><span class="st-tx"><b>${esc(a.name)}</b><small>Your version · use original</small></span></button>`).join('')}${note ? `<p class="st-note" role="status">${esc(note)}</p>` : ''}</div>`;
  } });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-own-original], [data-own-confirm], [data-own-cancel]'); if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    // Synthetic clicks, postMessage and iframe documents cannot authorize a revert.
    if (!e.isTrusted || (e.view && e.view !== window) || window.top !== window || busy) return;
    if (b.hasAttribute('data-own-confirm')) { if (b.dataset.ownConfirm === selected && own(app(selected))) revert(selected); return; }
    if (b.hasAttribute('data-own-cancel')) { selected = ''; note = ''; window.WosSettings.refresh(); return; }
    selected = b.dataset.ownOriginal; note = ''; window.WosSettings.refresh();
    window.WizCore.deeplink.route(location.pathname + '?view=own-views');
  }, true);
  const mount = () => { new MutationObserver(scan).observe(document.body, { childList:true, subtree:true }); scan(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.WosOwnViews = { frameUrl, marker, noteHtml: a => broken.has(a?.id) ? `<p class="own-view-note" role="status">${esc(broken.get(a.id))}</p>` : '' };
})();
