/* Wizard UX core: deep links (feature/chat-polish). Both shells.
 *
 *   ?session=<id>          open that thread inside the app (same path as the Android ACTION_THREAD handoff)
 *   ?view=<name>[&section] open a screen: work | chats | apps | settings | files | help | tour
 *   ?video=<32 hex>        play a Wizard attachment in the in-app viewer (checked with HEAD: must be video/*)
 *   ?open=<app id>         open an app (the desktop already had this; the phone gets it too)
 *   ?agent=<agent id>      open that agent's own Chats (Agents MVP)
 * A session is more specific than a view, so it wins when both are present (legacy deepLink.ts).
 * The params are removed from the address bar once used (history entry and its state are kept), so a
 * reload doesn't replay them and Back walks the app's own stack: thread → Chats list → Home, never out.
 *
 * Shells register handlers once: WizCore.deeplink.handle({ thread(id), view(name, section), video(item), app(id) })
 * then call WizCore.deeplink.consume() when they're ready. Links inside messages to this app's own URL
 * (…/wizard-os-home/?session=…) go through WizCore.deeplink.route(url) instead of reloading the page.
 */
(() => {
  'use strict';
  const C = window.WizCore = window.WizCore || {};
  const SESSION_ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/;
  const VIDEO_ID = /^[a-f0-9]{32}$/;
  const VIEWS = new Set(['home', 'work', 'chats', 'apps', 'store', 'install', 'agents', 'settings', 'files', 'usage', 'help', 'tour', 'skin']);
  const SECTIONS = new Set(['errors', 'working', 'ready', 'yesterday', 'pastWeek', 'deferred', 'archive', 'drafts']);
  const KEYS = ['session', 'view', 'section', 'video', 'open', 'agent'];
  let H = null;
  const log = s => { window.__deeplinkLog = (window.__deeplinkLog || []).concat(s).slice(-30); };

  function parse(href) {
    let u; try { u = new URL(href, location.href); } catch (e) { return null; }
    const q = u.searchParams, out = {};
    const installing=q.get('view')==='install' || (u.protocol==='wizard:' && u.hostname==='install');
    const sid = q.get('session') || ''; if (!installing && SESSION_ID.test(sid)) out.session = sid;
    const view = u.protocol==='wizard:' && u.hostname==='install' ? 'install' : (q.get('view') || '').trim(); if (!out.session && (VIEWS.has(view) || window.WosFeatures?.has(view) || window.WosSettings?.features.some(f => f.aliases.includes(view)) || window.WosSettings?.systemPages?.includes(view))) { out.view = view; const s = q.get('section') || ''; if (SECTIONS.has(s)) out.section = s === 'deferred' ? 'ready' : s; } // Deferred lives at the bottom of Ready
    if (out.view === 'install') { const q=new URLSearchParams(u.search), shell=q.has('shell'); q.delete('shell'); out.install=u.protocol==='wizard:'?u.href:shell?'?'+q:u.search; }
    const vid = (q.get('video') || '').trim().toLowerCase(); if (VIDEO_ID.test(vid)) out.video = vid;
    const open = (q.get('open') || '').trim(); if (!out.session && !out.view && (/^[a-z0-9-]{1,40}$/i.test(open) || /^agent:[a-z0-9][a-z0-9-]{0,40}$/.test(open))) out.open = open;
    // ?agent=<id>: that agent's own Chats (Agents MVP).
    const agent = (q.get('agent') || '').trim(); if (!out.session && !out.view && !out.open && /^[a-z0-9][a-z0-9-]{0,40}$/.test(agent)) out.agent = agent;
    return Object.keys(out).length ? out : null;
  }
  // Is this a link to this app (the Wizard UX page itself), as opposed to another app on the origin?
  function isOwn(u) {
    if(u?.protocol==='wizard:' && u.hostname==='install') return true;
    if (!u || u.origin !== location.origin) return false;
    // Only thread links own the old launcher roots; /?open=… and attachments are not shell routes.
    if ((u.pathname === '/' || u.pathname === '/wizard/') && SESSION_ID.test(u.searchParams.get('session') || '')) return true;
    const here = location.pathname.replace(/[^/]*$/, ''); // …/wizard-os-home/
    return u.pathname === here || u.pathname === here + 'index.html' || u.pathname === here + 'desktop.html';
  }
  async function playVideo(id) {
    const url = `/wizard/attachments/${id}`;
    try {
      const r = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
      const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
      if (!r.ok || !mime.startsWith('video/')) { log('video:unavailable'); H?.toast?.('▶', 'That video isn’t available', 2200); return false; }
      const cd = r.headers.get('content-disposition') || '';
      const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1] || '') || (cd.match(/filename="?([^";]+)"?/i) || [])[1] || 'Video';
      log('video:open');
      return !!H?.video?.({ url, mime, name, kind: 'video', id });
    } catch (e) { log('video:error'); return false; }
  }
  function run(d, src) {
    if (!d || !H) return false;
    if (d.session) { log('session:' + d.session); H.thread(d.session); }
    else if (d.view) { log('view:' + d.view); H.view(d.view, d.section || '', d.install || ''); }
    else if (d.open) { log('open:' + d.open); H.app?.(d.open, src || null); }
    else if (d.agent) { log('agent:' + d.agent); H.agent?.(d.agent); }
    if (d.video) playVideo(d.video);
    return true;
  }
  function strip() {
    const u = new URL(location.href); let had = false;
    if (u.searchParams.get('view') === 'install') for(const k of ['repo','commit','from']) u.searchParams.delete(k);
    for (const k of KEYS) if (u.searchParams.has(k)) { u.searchParams.delete(k); had = true; }
    if (had) history.replaceState(history.state, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : '') + u.hash);
  }
  C.deeplink = {
    parse, isOwn,
    // Normal Store window creation/reuse stays with each shell. Deliver without reloading its previous view.
    installInFrame(frame, query) {
      if(!frame) return false;
      const send=()=>frame.contentWindow?.__store?.openInstallLink(query);
      if(frame.contentWindow?.__store) send(); else frame.addEventListener('load',send,{once:true});
      return true;
    },
    handle(h) { H = h; },
    /* Use the page's own deep link once, then take it out of the address bar. */
    consume() { const d = parse(location.href); strip(); if (d) run(d); return d; },
    /* A link clicked inside the app. True when it was ours and is now open in-app. src = the tapped link, so
     * an app it opens knows where it came from (Back closes it and lands there again). */
    route(href, src) { let u; try { u = new URL(href, location.href); } catch (e) { return false; } if (!isOwn(u)) return false; const d = parse(u.href); if (!d) return !/[?&](session|view|video|open|agent)=/.test(u.search); /* a plain link to this shell: we are already here, never open Wizard inside Wizard */ run((u.pathname === '/' || u.pathname === '/wizard/') && d.session ? { session: d.session } : d, src); return true; },
    get log() { return window.__deeplinkLog || []; },
  };
})();
