/* Chats view admission and lifecycle. In-document, owner-installed code, NOT a sandbox. */
(() => {
  'use strict';
  const VERSION = 'wizard.chats-view/1', DEFAULT = 'wizard-chats';
  const providers = new Map(), installed = new Map(), loads = new Map();
  let selected = DEFAULT;
  const fixture = (() => { try { return new URLSearchParams(location.search).get('chatsview') === 'fixture' || localStorage.getItem('wos.chatsview.fixture') === '1'; } catch (_) { return false; } })();
  function register(p) {
    if (!p || p.contract !== VERSION || !installed.has(p.id) || typeof p.mount !== 'function' || !p.name) throw Error('Not an installed Chats view');
    if (providers.has(p.id)) throw Error('Chats view already registered');
    providers.set(p.id, Object.freeze({ ...p }));
  }
  installed.set(DEFAULT, { id: DEFAULT, name: 'Chats' });
  register({ contract: VERSION, id: DEFAULT, name: 'Chats', mount: (_el, host) => ({ update: () => host.renderDefault(), unmount() {} }) });
  if (fixture) {
    installed.set('chats-fixture', { id: 'chats-fixture', name: 'Chats by subject (fixture)', module: new URL('chats-fixture-view.js', document.currentScript.src).href });
    installed.set('chats-throws', { id: 'chats-throws', name: 'Broken Chats (fixture)' });
    register({ contract: VERSION, id: 'chats-throws', name: 'Broken Chats (fixture)', mount() { throw Error('Intentional fixture failure'); } });
  }
  function moduleURL(a) {
    if (a.source !== 'apps.json' || !Array.isArray(a.provides) || !a.provides.includes('chats') || a.chats_view?.contract !== VERSION) return null;
    try {
      const base = new URL(a.url, location.origin), u = new URL(a.chats_view.module, base);
      if (/%(?:2f|5c|25)/i.test(u.pathname + base.pathname)) return null;
      const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
      if (base.origin !== location.origin || u.origin !== location.origin || prefix === '/' || !u.pathname.startsWith(prefix) || !u.pathname.endsWith('.js') || u.search || u.hash || u.username || u.password) return null;
      return u.href;
    } catch (_) { return null; }
  }
  // Only a fresh Agent Service registry response admits code. Launcher links and cache never do.
  function configure(snapshot) {
    window.WizAppExtensions?.configure(snapshot);
    const keep = new Set([DEFAULT, ...(fixture ? ['chats-fixture', 'chats-throws'] : [])]);
    for (const a of snapshot.apps || []) {
      const module = moduleURL(a);
      if (!module || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(a.id) || keep.has(a.id)) continue;
      keep.add(a.id);
      const previous = installed.get(a.id), name = String(a.name || a.id);
      if (!previous || previous.module !== module || previous.name !== name) {
        providers.delete(a.id); loads.delete(a.id); installed.set(a.id, { id: a.id, name, module });
      }
    }
    for (const id of installed.keys()) if (!keep.has(id)) { installed.delete(id); providers.delete(id); loads.delete(id); }
    const choice = snapshot.slots?.chats?.default || snapshot.parking?.find(r => r.slot === 'chats')?.active;
    selected = installed.has(choice) ? choice : DEFAULT;
    if (fixture) { try { const dev = localStorage.getItem('wos.chatsview.default'); if (installed.has(dev)) selected = dev; } catch (_) {} }
  }
  function ensure(id) {
    if (providers.has(id)) return Promise.resolve(providers.get(id));
    if (!installed.has(id)) return Promise.reject(Error('Chats view is not installed'));
    if (!loads.has(id)) {
      const entry = installed.get(id);
      loads.set(id, fetch(entry.module, { cache: 'no-store' }).then(async response => {
        if (!response.ok) throw Error('Chats view could not be read');
        lint(await response.text());
        return import(entry.module);
      }).then(m => {
        if (installed.get(id) !== entry || m.default?.id !== id) throw Error('Chats view registration changed');
        register(m.default); return providers.get(id);
      }));
    }
    return loads.get(id);
  }
  // Same deliberately strict package lint as skins; approved code, not a JS sandbox.
  function lint(source) {
    for (const token of ['addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch(', 'XMLHttpRequest', '__wos', '__wux', 'localStorage', 'sessionStorage', 'innerHTML', 'outerHTML', 'history.', 'document.cookie', 'eval(', 'new Function', 'import(', 'WebSocket']) {
      if (source.includes(token)) throw Error('Chats view uses a banned API: ' + token);
    }
    if (/\bimport\s*(?:[({*'\"]|[a-zA-Z_$])/.test(source)) throw Error('Chats views cannot import other modules');
  }
  function create(H) {
    window.WizAppExtensions?.attach(H);
    const regions = new Map(), bypass = new Set(), failed = new Set();
    let core;
    const owner = id => H.owner ? H.owner(id) : id;
    const providerFor = w => w?.agent ? DEFAULT : w?.chatsProvider || DEFAULT;
    function release(key) {
      const r = regions.get(key); if (!r) return;
      regions.delete(key);
      try { r.instance?.unmount(); } catch (_) { /* teardown must not strand a shell window */ }
      for (const off of r.offs) off();
    }
    function fallback(r) {
      if (regions.get(r.key) !== r) return;
      const name = installed.get(r.id)?.name || r.id;
      failed.add(r.id); release(r.key); r.el.replaceChildren();
      if (selected === r.id) selected = DEFAULT;
      H.toast('!', `${name} couldn’t open. Showing Chats instead.`, 6000);
      const w = H.win(owner(r.key)); if (w) { w.chatsProvider = DEFAULT; H.save(); }
      r.paint();
    }
    function render(w, el, paint, kind) {
      if (bypass.has(el)) return false;
      const key = w.id, ow = H.win(owner(key)) || w;
      let id = providerFor(ow); if (!installed.has(id) || failed.has(id)) id = DEFAULT;
      el.classList.toggle('chats-view', id !== DEFAULT);
      let r = regions.get(key);
      if (r && (r.id !== id || r.el !== el || r.entry !== installed.get(id))) { release(key); r = null; }
      if (!r) {
        r = { key, id, el, paint, w, kind, entry: installed.get(id), offs: new Set(), instance: null }; regions.set(key, r);
        const guard = fn => (...args) => { if (regions.get(key) !== r) return; try { return fn(...args); } catch (_) { fallback(r); } };
        const listen = (target, type, fn) => { const cb = guard(fn); target.addEventListener(type, cb); const off = () => target.removeEventListener(type, cb); r.offs.add(off); return off; };
        r.host = Object.freeze({
          contract: VERSION, windowId: owner(key), region: key === owner(key) ? 'main' : 'list',
          get thread() { return r.w.thread || null; },
          get threads() { return (window.WizLive?.sessions || []).filter(s => !s.hidden && (!ow.agent || window.WizLive.agentOf(s.id) === ow.agent)); },
          live: window.WizLive, outbox: window.WosOutbox,
          ready: () => window.WizLive?.groups(),
          isUnread: s => !!window.WizLive?.isNew(s),
          openThread: sid => core.openChat(owner(key), sid),
          openOnDesk: (sid, options) => H.openThread?.(sid, options),
          back: () => { const target = H.win(owner(key)); if (target?.thread) core.chatsBack(target); },
          send: (...args) => core.sendChat(owner(key), ...args),
          voice: () => H.recordReply?.(owner(key), H.win(owner(key))?.thread),
          renderDefault: () => { bypass.add(el); try { r.paint(); } finally { bypass.delete(el); } },
          element: tag => document.createElement(tag),
          listen: (type, fn) => listen(el, type, fn),
          subscribe: fn => { const off = window.WizLive?.onChange(guard(fn)) || (() => {}); r.offs.add(off); return off; },
          onAppearance: fn => { const observer = new MutationObserver(guard(fn)); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'style', 'class'] }); const off = () => observer.disconnect(); r.offs.add(off); return off; },
          toast: (...args) => H.toast(...args),
        });
        const mount = p => {
          if (regions.get(key) !== r || !el.isConnected) return;
          try {
            r.instance = p.mount(el, r.host);
            if (!r.instance || typeof r.instance.update !== 'function' || typeof r.instance.unmount !== 'function') throw Error('Chats view needs update and unmount');
            r.instance.update();
          } catch (_) { fallback(r); }
        };
        if (providers.has(id)) mount(providers.get(id));
        else { r.host.renderDefault(); ensure(id).then(mount, () => fallback(r)); }
      } else {
        r.paint = paint; r.w = w; r.kind = kind;
        try { if (r.instance) r.instance.update(); else r.host.renderDefault(); } catch (_) { fallback(r); }
      }
      return true;
    }
    core = window.WizCore.chats({ ...H, renderView: render });
    const forget = core.forget;
    core.forget = id => { release(id); release(id + '::list'); return forget(id); };
    core.views = Object.freeze({ providerFor, defaultId: () => selected, name: id => installed.get(id)?.name || 'Chats' });
    return core;
  }
  // EXTEND the shared Chats host for shells without an orb recorder. Capture,
  // microphone arbitration, durability and delivery stay in their existing owners.
  function replyRecorder({ appId, chats, repaint, toast }) {
    const owner = 'wizard-chats';
    let take = null, pending = null, work = null;
    const paint = () => repaint?.();
    async function send(row, wid, sid) {
      if (!row.blob?.size) throw Error('Recording recovery is incomplete · original kept');
      const outbox = window.WosOutbox, custody = 'hosted-' + row.id;
      if (!outbox) throw Error('Recording kept · shared outbox unavailable');
      // Recover durable receipts before capture can write this id. Sent tombstones
      // remain owned even after their audio/kind is compacted out of the store.
      await outbox.load();
      if (!outbox.recoveryComplete || outbox.quarantined(custody)) throw Error('Recording kept · device recovery incomplete');
      // Lost capture acknowledgements must not seal another draft or send twice.
      if (!outbox.handedOff(custody)) {
        const held = await outbox.capture(row.blob, custody);
        if (!held?.durable || held.storageError) throw Error('Recording kept · device save failed');
        const it = await chats().sendVoiceTo(wid, sid, row.blob, [], true, row.meta.route, null, custody, row.meta.runId);
        if (!it?.durable || it.storageError) throw Error('Recording kept · retry this voice reply');
      }
      await window.WizAppCapture.ack(owner, row.id); pending = null;
    }
    function recordReply(wid, sid) {
      if (work || !sid || sid === '__new__') return 'busy';
      if (take && (take.sid !== sid || take.wid !== wid)) { toast?.('!', 'Finish the recording in its original thread'); return 'busy'; }
      const stopping = take;
      if (!stopping) take = {wid, sid, session:null};
      paint(); // same-frame feedback, before permission/disk/route work
      work = (async () => {
        if (stopping) {
          pending = await stopping.session.stop(); take = null; paint();
          await send(pending, wid, sid); return 'sent';
        }
        const resource = window.WizAppCapture;
        if (!resource) throw Error('Shared microphone unavailable');
        if (pending && (pending.meta?.appId !== appId || pending.meta?.sessionId !== sid)) throw Error('A recording is kept in its original thread');
        if (pending && !pending.blob?.size) pending = null; // retain original in the capture store
        const saved = pending || (await resource.pending(owner)).find(r => r.meta?.appId === appId && r.meta?.sessionId === sid && r.blob?.size);
        if (saved) {
          const confirmed = pending === saved;
          pending = saved; take = null;
          if (!confirmed) { toast?.('◉', 'Recording kept · tap again to send to this thread'); return 'kept'; }
          await send(saved, wid, sid); return 'sent';
        }
        const route = chats().modelRoute(wid, sid), session = window.WizLive?.session(sid);
        take.session = await resource.start(owner, {kind:'audio', meta:{appId, sessionId:sid, route, runId:chats().isWorking(session) ? session.runId || '' : ''}});
        return 'started';
      })().catch(e => {
        if (!take?.session) take = null;
        toast?.('!', String(e.message || 'Recording kept · try again')); return 'failed';
      }).finally(() => { work = null; paint(); });
      return work;
    }
    function back() {
      if (work) return true;
      if (!take) return false;
      const held = take;
      work = held.session.stop().then(row => { pending = row; take = null; toast?.('◉', 'Recording kept · tap the thread microphone to send'); })
        .catch(e => toast?.('!', String(e.message || 'Recording kept · retry Stop'))).finally(() => { work = null; paint(); });
      return true;
    }
    return {recordReply, recordingFor:() => take?.sid || pending?.meta?.sessionId || '', busy:() => !!(take || work), back};
  }
  window.WizChatsHost = Object.freeze({ contract: VERSION, register, configure, create, moduleURL, lint, replyRecorder,
    defaultId: () => selected, installed: () => [...installed.values()].map(a => ({ ...a })),
    tiles: () => [...installed.values()].filter(a => a.id !== DEFAULT || installed.size > 1).map(a => ({ id: a.id, name: a.id === DEFAULT ? 'Chats (standard)' : a.name, kind: 'chats', chatsProvider: a.id, icon: '✦', g: ['var(--violet-2)', 'var(--violet-2)'], desc: 'Chats view · same conversations' })),
  });
})();

/* Owner-installed Ready extensions are trusted same-origin code, not a sandbox.
 * Registry admission and content-addressed app resources control their lifecycle. */
(() => {
  'use strict';
  const CONTRACT = 'wizard.ready-extension/1', entries = new Map();
  let host = null, generation = 0;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function moduleURL(a) {
    if (a?.source !== 'apps.json' || !Array.isArray(a.provides) || !a.provides.includes('ready-extension')) return null;
    try {
      const base = new URL(a.url, location.origin);
      if (base.origin !== location.origin || base.username || base.password || base.search || base.hash || /%(?:2f|5c|2e|25)/i.test(base.pathname)) return null;
      const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
      return prefix !== '/' ? new URL(prefix + 'ready.json', location.origin) : null;
    } catch (_) { return null; }
  }
  function frameFor(source, entry) {
    try {
      const f = [...host.root().querySelectorAll('iframe')].find(f => f.contentWindow === source);
      const w = f?.closest('[data-win]'), win = w && host.win(w.dataset.win);
      const current = new URL(source.location.href), launch = new URL(f.src, location.href);
      return !!f?.isConnected && !f.hasAttribute?.('srcdoc') && win?.app === 'frame' && win.appId === entry.id && source.document === f.contentDocument
        && [current,launch].every(u => u.origin === location.origin && !/%(?:2f|5c|2e|25)/i.test(u.pathname) && u.pathname.startsWith(entry.prefix));
    } catch (_) { return false; }
  }
  const installed = e => entries.get(e.id) === e;
  function html() { return [...entries.values()].filter(e => e.instance).map(e => {
    try { const value = e.instance.html(); return typeof value === 'string' ? `<div data-app-ready="${esc(e.id)}">${value}</div>` : ''; }
    catch (_) { return ''; }
  }).join(''); }
  function repaint() {
    if (!host?.root?.()) return;
    for (const slot of host.root().querySelectorAll('[data-slot="ready-top"]')) {
      for (const old of slot.parentNode.querySelectorAll(':scope > [data-app-ready]')) old.remove();
      slot.insertAdjacentHTML('afterend', html());
    }
  }
  function dispose(e) { try { e.instance?.dispose(); } catch (_) {} finally { e.style?.remove(); } }
  async function start(entry) {
    if (!host || entry.instance || entry.loading) return;
    entry.loading = true;
    try {
      const m = await import(entry.module.href);
      if (!installed(entry)) return;
      if (m.contract !== CONTRACT || typeof m.default !== 'function') throw Error('Invalid Ready extension');
      const api = Object.freeze({installed: () => installed(entry), authorize: source => installed(entry) && frameFor(source, entry),
        changed: () => { if (installed(entry)) repaint(); },
        open: target => installed(entry) && (host.openApp ? host.openApp(entry.id, target) : window.WizOpenApp?.(entry.id)),
        toast: (...args) => host.toast(...args)});
      const instance = m.default(api);
      if (!instance || !['html','write','poll','handle','dispose'].every(k => typeof instance[k] === 'function')) { instance?.dispose?.(); throw Error('Invalid Ready extension'); }
      entry.instance = instance;
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = entry.css.href;
      document.head.appendChild(link); entry.style = link;
      instance.poll(); repaint();
    } catch (_) { if (installed(entry)) { dispose(entry); entry.instance = null; repaint(); } }
    finally { entry.loading = false; }
  }
  async function configure(snapshot) {
    const epoch = ++generation, wanted = new Map();
    for (const a of Array.isArray(snapshot?.apps) ? snapshot.apps : []) {
      const descriptor = moduleURL(a);
      if (descriptor && /^[a-z0-9][a-z0-9-]{0,63}$/.test(a.id) && !wanted.has(a.id)) wanted.set(a.id, descriptor);
    }
    // Revoke removed grants before any descriptor I/O. A pending import cannot resurrect one.
    for (const [id,e] of entries) if (!wanted.has(id) || wanted.get(id).href !== e.descriptor) { entries.delete(id); dispose(e); }
    repaint();
    await Promise.all([...wanted].map(async ([id, url]) => {
      try {
        const r = await fetch(url.href, {cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(12000)});
        if (!r.ok) throw Error('Ready declaration unavailable');
        const d = await r.json();
        if (epoch !== generation) return;
        if (d.contract !== CONTRACT || !/^[a-f0-9]{64}$/.test(d.module_sha256) || !/^[a-f0-9]{64}$/.test(d.style_sha256)) throw Error('Invalid Ready declaration');
        const module = new URL('shell.js?sha256=' + d.module_sha256, url), css = new URL('shell.css?sha256=' + d.style_sha256, url);
        let e = entries.get(id);
        if (e && (e.module.href !== module.href || e.css.href !== css.href)) {
          if (e.instance?.busy?.()) return; // app-owned pending writes retain custody until settlement
          entries.delete(id); dispose(e); e = null;
        }
        if (!e) { e = {id,module,css,descriptor:url.href,prefix:url.pathname.slice(0,url.pathname.lastIndexOf('/')+1)}; entries.set(id,e); }
        await start(e);
      } catch (_) { /* Keep an admitted running extension on transient metadata failure, not a new grant. */ }
    }));
  }
  // Only browser-supplied message provenance admits a write; callers cannot pass
  // another app's WindowProxy to a public synchronous dispatch function.
  window.addEventListener?.('message', async e => {
    const d = e.data;
    if (!(e instanceof MessageEvent) || !e.isTrusted || e.origin !== location.origin || d?.type !== 'wizard:app:request' || d.version !== 1 || d.op !== 'ready.write' || typeof d.id !== 'string' || d.id.length > 96) return;
    const entry = [...entries.values()].find(x => x.instance && frameFor(e.source,x));
    if (!entry) return;
    entry.requests ||= new Set();
    if (entry.requests.size >= 32 || entry.requests.has(d.id)) return;
    entry.requests.add(d.id);
    const doc = e.source.document;
    const reply = payload => { if (installed(entry) && frameFor(e.source,entry) && e.source.document === doc) e.source.postMessage({version:1,id:d.id,...payload},location.origin); };
    try {
      const task = entry.instance.write(e.source,d.args?.kind,d.args?.input,d.args?.before);
      reply({type:'wizard:app:admitted'}); // custody exists before the caller may Back; never await the backend
      const value = await task;
      reply({type:'wizard:app:reply',value});
    } catch (error) {
      const details = {};
      for (const [key,value] of Object.entries(error || {})) if (!['__proto__','prototype','constructor'].includes(key)) details[key] = value;
      reply({type:'wizard:app:reply',error:String(error?.message || error).slice(0,200),details});
    } finally { entry.requests.delete(d.id); }
  });
  window.WizAppExtensions = Object.freeze({contract:CONTRACT,moduleURL,configure,html,
    attach(H) { host = H; for (const e of entries.values()) start(e); },
    poll() { for (const e of entries.values()) { try { Promise.resolve(e.instance?.poll()).catch(() => {}); } catch (_) {} } },
    handle(event) { try { return entries.get(event.target.closest('[data-app-ready]')?.dataset.appReady)?.instance?.handle(event) || false; } catch (_) { return false; } },

  });
})();
