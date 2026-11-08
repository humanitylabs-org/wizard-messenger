/* WizOffline worker v1. App supplies only WIZ_OFFLINE_CONFIG then importScripts.
 * This is an opt-in replica, not an update/reload policy. Never navigate clients. */
'use strict';
(() => {
  const c = self.WIZ_OFFLINE_CONFIG;
  if (!c || !/^[a-z][a-z0-9-]*-$/.test(c.prefix) || !c.version) throw Error('Offline config required');
  const base = new URL('./', self.location.href);
  const url = s => new URL(s, base).href;
  const names = {shell: c.prefix+'shell-'+c.version, data: c.prefix+'data-v1', assets: c.prefix+'assets-v1'};
  const shell = new Set(c.shell.map(url));
  const match = (list, u) => (list || []).some(p => u.href.startsWith(url(p)));
  const unavailable = () => new Response(JSON.stringify({error:'Needs a connection'}), {status:503, headers:{'Content-Type':'application/json'}});
  // Optional shell-host policy: a navigation to <path>?<parameter>=<id> falls back to one fixed, cached document,
  // and only for an id the installed app declared (home_screen.offline) in the published snapshot.
  // No workspace page, auth redirect or arbitrary query is ever saved as a document.
  const nav = c.navigation;
  const sessionId = u => nav && nav.paths.includes(u.pathname) && u.searchParams.getAll(nav.parameter).length === 1 &&
    [...u.searchParams.keys()].every(k => k === nav.parameter) ? u.searchParams.get(nav.parameter) : null;
  async function declaredOffline(id) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id || '')) return false;
    try {
      const saved = await (await caches.open(nav.registryCache)).match(url(nav.registry));
      const list = saved ? (await saved.json()).ids : [];
      return Array.isArray(list) && list.includes(id);
    } catch (_) { return false; }
  }
  async function networkFirst(request, kind) {
    const cache = await caches.open(names[kind]);
    try {
      const response = await fetch(request, {cache:'no-store'});
      if(response.status>=500){const saved=await cache.match(request,{ignoreSearch:kind==='shell'});if(saved)return saved;}
      // Never replace good data with an error, redirect, or login HTML.
      if (response.ok && !response.redirected && kind !== 'shell') await cache.put(request, response.clone());
      return response;
    } catch (e) {
      const saved = await cache.match(request, {ignoreSearch:kind==='shell'});
      if (saved) return saved;
      if (request.mode==='navigate') {
        const home = await cache.match(url(nav?.fallback || './'));
        if (home) return home;
      }
      throw e;
    }
  }
  self.addEventListener('install', e => e.waitUntil((async () => {
    const cache = await caches.open(names.shell);
    // Reject install on any incomplete shell; old generation stays usable.
    await Promise.all([...shell].map(async u => {
      const r = await fetch(u, {cache:'no-store', credentials:'same-origin'});
      if (!r.ok || r.redirected) throw Error('Offline shell unavailable: '+u);
      await cache.put(u, r);
    }));
    await self.skipWaiting(); // activation is safe: no reload or client navigation
  })()));
  self.addEventListener('activate', e => e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(c.prefix+'shell-') && key!==names.shell) await caches.delete(key);
    await self.clients.claim();
  })()));
  // One fetch owner even when composed with the existing workspace worker.
  const handles = r => {
    const u = new URL(r.url), clean = new URL(u); clean.search = '';
    return r.method === 'GET' && u.origin === base.origin && !r.headers?.has('range') &&
      !/^\/wizard\/(?:attachments|files)(?:\/|$)/.test(u.pathname) &&
      (r.mode === 'navigate' ? (nav ? sessionId(u) !== null : u.pathname.startsWith(base.pathname)) : shell.has(clean.href) ||
        (c.data || []).some(p => u.pathname === new URL(p, base).pathname) || match(c.assets,u) || match(c.onlineOnly,u));
  };
  self.WizOfflineWorker = Object.freeze({handles});
  self.addEventListener('fetch', e => {
    const r=e.request, u=new URL(r.url);
    if (!handles(r)) return;
    if (nav && r.mode==='navigate') {
      // Claimed: an undeclared id is passed straight to the network, exactly as if this worker were absent.
      e.respondWith((async()=>(await declaredOffline(sessionId(u))) ? networkFirst(r,'shell') : fetch(r))());
      return;
    }
    if (match(c.onlineOnly,u) && self.navigator.onLine===false) {e.respondWith(unavailable());return;}
    if (r.method!=='GET') return; // writes belong to the durable client outbox, never CacheStorage
    const clean = new URL(u);clean.search='';
    if (r.mode==='navigate' && u.pathname.startsWith(base.pathname) || shell.has(clean.href)) e.respondWith(networkFirst(r,'shell'));
    else if ((c.data||[]).some(p=>u.pathname===new URL(p,base).pathname)) e.respondWith(networkFirst(r,'data'));
    else if (match(c.assets,u)) e.respondWith((async()=>{
      const cache=await caches.open(names.assets), saved=await cache.match(r);
      if(saved)return saved;const response=await fetch(r);
      if(response.ok&&!response.redirected)await cache.put(r,response.clone());return response;
    })());
    else if (match(c.onlineOnly,u)) e.respondWith(fetch(r).catch(unavailable));
  });
})();
