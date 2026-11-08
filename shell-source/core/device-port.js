/* window.wizardDevicePort v1 client, shared by the Wizard Shell's optional device capabilities (core/device-*.js).
 * Envelope: {v:1, id, method, params} → {v:1, id, ok, result | error} (docs/android-device-message-port.md).
 * No port (browser, PWA, older APK) → call() rejects and capability() resolves null: callers keep their web path. */
(() => {
  'use strict';
  if (window.WosDevicePort) return;
  const pending = new Map();
  let seq = 0, bound = null, caps = null;
  const port = () => window.wizardDevicePort;
  function onReply(ev) {
    let m; try { m = JSON.parse(typeof ev === 'string' ? ev : ev?.data); } catch (_) { return; }
    const w = m && pending.get(m.id); if (!w || m.v !== 1) return;
    pending.delete(m.id); clearTimeout(w.t);
    if (m.ok) w.resolve(m.result); else w.reject(new Error(String(m.error || 'Device error')));
  }
  function bind(p) {
    if (bound === p) return;
    bound = p;
    if (typeof p.addEventListener === 'function') p.addEventListener('message', onReply); else p.onmessage = onReply;
  }
  function call(method, params = {}, timeout = 150000) {
    const p = port(); if (!p) return Promise.reject(new Error('no device port'));
    bind(p);
    const id = 'wd-' + (++seq) + '-' + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('Device did not answer')); }, timeout);
      pending.set(id, { resolve, reject, t });
      try { p.postMessage(JSON.stringify({ v: 1, id, method, params })); }
      catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
    });
  }
  /** The named capability's discovery entry when this APK offers exactly version v, else null. */
  function capability(name, v = 1) {
    if (!port()) return Promise.resolve(null);
    caps ||= call('device.capabilities', {}, 8000).then(r => r?.capabilities || {}, () => { caps = null; return {}; });
    return caps.then(c => (c[name]?.v === v ? c[name] : null));
  }
  window.WosDevicePort = { call, capability, get present() { return !!port(); } };
})();
