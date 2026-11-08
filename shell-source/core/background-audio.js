/* Shared background audio. Live registry grant + exact installed frame/document
 * are authority; the old message envelope and native token are compatibility only. */
(() => {
  'use strict';
  const TYPE = 'wizard:background-audio:v1', pending = new Map(), states = new Map();
  const METHODS = new Set(['capabilities','attach','state','load','play','pause','seek','next','previous','jump','enqueueNext','removeCurrent','removeUpcoming','volume','detach','stop']);
  let registry = () => ({}), admit = () => false, seq = 0, boundPort, owner = null;
  const granted = (id, app) => !!app && (app.provides?.includes('background-audio') || window.WizBackgroundAudioLegacy?.granted(id, app));
  function frameApp(win, origin = location.origin) {
    if (!win || win === window || origin !== location.origin) return null;
    const f = [...document.querySelectorAll('iframe.appframe')].find(f => f.contentWindow === win);
    if (!f?.isConnected || !admit(f) || f.hasAttribute('srcdoc')) return null;
    try {
      const src = new URL(f.getAttribute('src'), location.href), live = new URL(win.location.href);
      if (!win.document.documentElement || /%(?:2f|5c|2e|25)/i.test(live.pathname + src.pathname)) return null;
      for (const [id, app] of Object.entries(registry())) {
        if (!app?.url || !granted(id, app)) continue;
        const expected = new URL(app.url, location.href);
        // Preserve the pilot's exact-document boundary (not arbitrary sibling pages).
        if ([src, live, expected].every(u => u.origin === location.origin && u.pathname === expected.pathname)) return id;
      }
    } catch (_) {}
    return null;
  }
  const frameOk = (win, origin) => !!frameApp(win, origin);
  function port() { return window.wizardAudioPort?.postMessage ? window.wizardAudioPort : null; }
  const nativeId = appId => window.WizBackgroundAudioLegacy?.nativeAppId(appId) || appId;
  function listen(pt) {
    if (pt === boundPort) return;
    boundPort = pt;
    pt.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok && m.result) { states.set(p.appId, m.result); window.WizBackgroundAudio.lastState = m.result; }
      p.complete(m);
    };
  }
  function send(appId, method, params = {}) {
    const pt = port();
    if (!pt) return Promise.reject(new Error('Background audio unavailable'));
    if (!METHODS.has(method) || pending.size >= 16) return Promise.reject(new Error('Audio request refused'));
    listen(pt);
    return new Promise((resolve, reject) => {
      const id = 'audio-' + (++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Audio request timed out')); }, 20000);
      pending.set(id, {appId, timer, complete:m => m.ok ? resolve(m.result || {}) : reject(new Error(m.error || 'Audio request failed'))});
      try { pt.postMessage(JSON.stringify({...params,id,v:1,appId:nativeId(appId),method})); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  function request(win, method, params = {}) {
    const appId = frameApp(win);
    if (!appId) return Promise.reject(new Error('Audio request refused'));
    const doc = win.document;
    if (['attach','load','play'].includes(method)) owner = appId;
    return send(appId, method, params).then(result => {
      if (!frameOk(win) || win.document !== doc) throw new Error('App frame is no longer authorized');
      return result;
    });
  }
  // Existing installed apps can use their old envelope until they adopt WizardApp.device.
  window.addEventListener('message', e => {
    const d = e.data;
    if (d?.type !== TYPE || !frameOk(e.source,e.origin)) return;
    const win=e.source, doc=win.document, id=String(d.id || '').slice(0,80);
    const reply = data => { if (frameOk(win) && win.document === doc) win.postMessage({type:TYPE,id,...data},location.origin); };
    request(win,d.method,d.params).then(result=>reply({ok:true,result}),error=>reply({ok:false,error:error.message}));
  });
  // Explicit window/desk close, not reload/detach: keep queue and position, clear play intention.
  function closeApp(appId) {
    if (!granted(appId,registry()[appId]) || !port() || (owner && owner !== appId)) return Promise.resolve();
    const state=states.get(appId) || (!owner || owner === appId ? window.WizBackgroundAudio.lastState : null);
    const pause = state => send(appId,'pause',{sessionId:state.sessionId});
    return state?.sessionId ? pause(state) : send(appId,'state').then(pause);
  }
  // Shell-owned short-sound ducking (voice notes), independent of the provider app.
  // Serialize callers and restore the owner volume only after the last release.
  // Release restores only while the volume is still the one we set: a volume the owner chose meanwhile wins.
  const DUCK = 0.25, duckers = new Set(); let restoreTo = null, duckedTo = null, duckChain = Promise.resolve(false);
  function shellSend(method, params = {}) {
    const apps = registry(), appId = owner || Object.keys(apps).find(id => granted(id, apps[id]));
    return appId && granted(appId, apps[appId]) ? send(appId, method, params) : Promise.reject(new Error('Background audio unavailable'));
  }
  function duck(owner, on) {
    if (on) duckers.add(owner); else if (!duckers.delete(owner)) return Promise.resolve(false);
    duckChain = duckChain.catch(() => false).then(async () => {
      if (!port()) return false;
      if (duckers.size && restoreTo == null) {
        const state = await shellSend('state');
        // Buffering music the owner wants playing counts as playing (it would resume at full volume mid-note).
        if (!(state.playing || state.wantPlaying) || !state.sessionId) return false;
        restoreTo = typeof state.volume === 'number' ? state.volume : 1; duckedTo = Math.min(restoreTo, DUCK);
        await shellSend('volume', {sessionId: state.sessionId, value: duckedTo}); return true;
      }
      if (!duckers.size && restoreTo != null) {
        const value = restoreTo, ours = duckedTo; restoreTo = duckedTo = null;
        const state = await shellSend('state');
        const untouched = typeof state.volume !== 'number' || Math.abs(state.volume - ours) < 0.005;
        if (state.sessionId && untouched) await shellSend('volume', {sessionId: state.sessionId, value}); return true;
      }
      return restoreTo != null;
    });
    return duckChain.catch(() => false);
  }
  window.WizBackgroundAudio = {init:(fn, grant) => {registry=fn;admit=grant;}, frameOk, request, canAttach:win => !!port() && frameOk(win), closeApp, duck, lastState:null};
})();
