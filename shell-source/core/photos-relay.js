/* Photos relay: the shell's narrow door between the optional Photos app (a hosted frame at /photos/) and the
 * Wizard OS Android backup worker. Photos is its own app; the shell draws no Photos UI and Settings has no Photos row.
 *
 * Native gives the SHELL (main frame, private origin) one message port, window.wizardPhotosPort, protocol v1:
 *   shell → {v:1, id, method, params}; native → {v:1, id, ok, result|error}; native push → {v:1, type:'status', status}.
 * Older apps (before v1) understand only the word 'open', which opens their native backup screen.
 *
 * This relay accepts {type:'wizard-os:photos', id, method, params} only from a frame that is (1) one of the shell's own
 * app iframes (phone .appframe or desktop [data-own-app]), (2) same origin, (3) at /photos/, and only for the allowlisted methods. Answers go back to that frame as
 * {type:'wizard-os:photos', id, ok, result|error}; native pushes go to every Photos frame as
 * {type:'wizard-os:photos-push', push}. Without the port (a browser, the desktop shell) every call answers
 * {ok:false, error:'no-bridge'} so the app can say where backup works. Keys and sign-in state never cross this relay:
 * native reports a fixed set of status fields (PhotosBridgePolicy.status). */
(() => {
  'use strict';
  const T = 'wizard-os:photos', PUSH = 'wizard-os:photos-push', V = 1;
  // Mirrors PhotosBridgePolicy.METHODS, plus 'open' (the legacy word for apps that predate v1).
  const METHODS = new Set(['status', 'setEnabled', 'setOption', 'connect', 'runNow', 'permissions', 'albums', 'setAlbums', 'disconnect', 'open']);
  const PATH = /^\/photos(\/|$)/;
  const pending = new Map(); // native id → {win, id, timer}
  let seq = 0, listening = false;
  const log = m => { window.__photosRelayLog = (window.__photosRelayLog || []).concat(m).slice(-40); };
  const port = () => window.wizardPhotosPort && typeof window.wizardPhotosPort.postMessage === 'function' ? window.wizardPhotosPort : null;

  // Phone shell app frames carry .appframe; desktop windows carry [data-own-app].
  const SHELL_FRAMES = 'iframe.appframe, iframe[data-own-app]';
  function frameOk(win, origin) {
    if (!win || win === window || origin !== location.origin) return false;
    const f = [...document.querySelectorAll(SHELL_FRAMES)].find(x => x.contentWindow === win);
    if (!f) return false;
    try { return PATH.test(win.location.pathname); } catch (e) { return false; }
  }
  function frames() {
    return [...document.querySelectorAll(SHELL_FRAMES)].map(f => f.contentWindow).filter(w => { try { return w && PATH.test(w.location.pathname); } catch (e) { return false; } });
  }
  const send = (win, msg) => { try { win.postMessage(msg, location.origin); } catch (e) {} };
  const reply = (win, id, ok, x) => send(win, ok ? { type: T, id, ok: true, result: x } : { type: T, id, ok: false, error: x });
  const pushAll = push => frames().forEach(w => send(w, { type: PUSH, push }));

  function onNative(ev) {
    let m; try { m = JSON.parse(typeof ev === 'string' ? ev : ev?.data); } catch (e) { return; }
    if (!m || m.v !== V) return;
    if (m.type === 'status' && m.status && typeof m.status === 'object') { pushAll({ type: 'status', status: m.status }); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    reply(p.win, p.id, !!m.ok, m.ok ? m.result : String(m.error || 'failed'));
  }
  function listen(pt) {
    if (listening) return;
    listening = true;
    if (typeof pt.addEventListener === 'function') pt.addEventListener('message', onNative); else pt.onmessage = onNative;
  }

  window.addEventListener('message', ev => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.type !== T) return;
    if (!frameOk(ev.source, ev.origin)) { log('refused:frame'); return; }
    const id = String(d.id || '').slice(0, 64);
    if (!METHODS.has(d.method)) { log('refused:method:' + d.method); return reply(ev.source, id, false, 'unknown method'); }
    const pt = port();
    if (!pt) { log('no-bridge:' + d.method); return reply(ev.source, id, false, 'no-bridge'); }
    listen(pt);
    if (d.method === 'open') { try { pt.postMessage('open'); reply(ev.source, id, true, { opened: true }); } catch (e) { reply(ev.source, id, false, 'no-bridge'); } return; }
    const nid = 'pr' + (++seq);
    const timer = setTimeout(() => { if (pending.delete(nid)) reply(ev.source, id, false, 'timeout'); }, 15000);
    pending.set(nid, { win: ev.source, id, timer });
    const params = d.params && typeof d.params === 'object' && !Array.isArray(d.params) ? d.params : {};
    log('call:' + d.method);
    try { pt.postMessage(JSON.stringify({ v: V, id: nid, method: d.method, params })); }
    catch (e) { clearTimeout(timer); pending.delete(nid); reply(ev.source, id, false, 'no-bridge'); }
  });
  // Coming back from Android's permission sheet or Wizard Sign-in: let the app refresh its status.
  window.addEventListener('wos-native-resume', () => pushAll({ type: 'resume' }));
  window.WizPhotosRelay = { METHODS, frameOk, available: () => !!port() };
})();
