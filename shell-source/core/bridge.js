/* Wizard UX core: native bridge v0 (spec: humanitylabs-org/wizard-os spec/NATIVE_BRIDGE.md).
 *
 * Native shells (Wizard for Mac, the Android app) drive the UX with DOM events on window instead of
 * clicking CSS selectors. Each Wizard UX shell registers what those events mean for it:
 *
 *   WizCore.bridge.handle({ orb, open, dictation, back })
 *
 *   wizard:orb        {action:'toggle'}  → orb(detail) returns 'voice' | 'sent' | 'busy' | 'none'
 *                                          the answer goes back as wizard:orb-state {state}
 *   wizard:open       {path}             → open(path): /wizard/, /apps, /files, /meetings, ?session=<id>, any app URL
 *   wizard:dictation  {text}             → dictation(text): insert at the composer cursor
 *   wizard:back                          → back(): one in-app step; never exits at the root
 *
 * Contract additions (v0.1, both optional for shells):
 *   - The UX announces itself once ready: window event wizard:ready {shell, version, events}
 *     and window.wizardUX = {shell, version, events}, so a shell can skip its selector fallback.
 *   - wizard:orb also accepts {action:'start'|'send'|'cancel'} for push-to-talk style shells.
 *   - wizard:open also accepts {app:'<id or name>'} or {thread:'<session id>'}.
 *
 * Page → native calls (app.info, meeting.*) go through WizCore.bridge.call(method, params).
 */
(() => {
  'use strict';
  const H = {};
  const VERSION = 'wux-bridge-0.1';
  const EVENTS = ['wizard:orb', 'wizard:open', 'wizard:dictation', 'wizard:back'];
  const answer = state => window.dispatchEvent(new CustomEvent('wizard:orb-state', { detail: { state } }));
  const detail = e => {
    const d = e.detail;
    if (typeof d === 'string') { try { return JSON.parse(d); } catch (err) { return { path: d, text: d }; } }
    return d || {};
  };
  window.addEventListener('wizard:orb', async e => {
    if (!H.orb) return answer('none');
    let st = 'none';
    try { st = (await H.orb(detail(e))) || 'none'; } catch (err) { console.error(err); st = 'none'; }
    answer(st);
  });
  window.addEventListener('wizard:open', e => { const d = detail(e); try { H.open && H.open(d.path || '', d); } catch (err) { console.error(err); } });
  window.addEventListener('wizard:dictation', e => { const d = detail(e); try { H.dictation && H.dictation(String(d.text || '')); } catch (err) { console.error(err); } });
  window.addEventListener('wizard:back', () => { try { H.back && H.back(); } catch (err) { console.error(err); } });

  /* page → native */
  let seq = 0; const waiting = new Map();
  const prevReply = window.wizardNativeReply;
  window.wizardNativeReply = msg => {
    const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
    const w = waiting.get(m && m.id);
    if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.result); return; }
    if (typeof prevReply === 'function') prevReply(msg);
  };
  let deviceListening = null;
  function deviceReply(ev) {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.v !== 1 || typeof m.id !== 'string') return;
    const w = waiting.get(m.id); if (!w) return;
    waiting.delete(m.id); m.ok ? w.resolve(m.result) : w.reject(new Error(m.error || 'native error'));
  }
  function call(method, params = {}) {
    const mac = window.webkit?.messageHandlers?.wizardNative, droid = window.WizardNative;
    const deviceMethod = method.startsWith('device.') || ['identity.info', 'identity.setup', 'identity.sign', 'identity.nip44_encrypt', 'identity.nip44_decrypt', 'view.capture'].includes(method);
    const port = deviceMethod && window.wizardDevicePort;
    if (!mac && !droid && !port) return Promise.reject(new Error('no native shell'));
    const id = 'wux-' + (++seq);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      // Native has a three-minute expiry. A biometric/PIN or backup flow is not a 15-second RPC.
      const timeout = ['identity.setup', 'identity.sign', 'identity.nip44_encrypt', 'identity.nip44_decrypt'].includes(method) ? 185000 : 15000;
      const timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error('native timeout')); }, timeout);
      waiting.set(id, { resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } });
      try {
        if (port) {
          if (deviceListening !== port) {
            if (typeof port.addEventListener === 'function') port.addEventListener('message', deviceReply); else port.onmessage = deviceReply;
            deviceListening = port;
          }
          port.postMessage(JSON.stringify({ v: 1, id, method, params }));
        } else if (mac) mac.postMessage({ id, method, params }); else droid.postMessage(JSON.stringify({ id, method, params }));
      } catch (e) { waiting.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  const native = () => (window.webkit?.messageHandlers?.wizardNative ? 'mac' : window.WizardNative || window.WizardOSNative ? 'android' : '');

  // Fingerprint vault uses the same device envelope and pending map as other native adapters.
  // Sharing correlation also permits Wizard ID's listener to receive a vault reply (and vice versa).
  let vaultListening = null;
  function vaultCall(method, params = {}) {
    const port = window.wizardDevicePort;
    if (!port?.postMessage) return Promise.reject(new Error('unavailable'));
    const id = 'vault-' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error('timeout')); }, 120000);
      waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try {
        if (vaultListening !== port) {
          const previous = port.onmessage;
          const receive = ev => {
            let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
            if (msg?.v !== 1 || typeof msg.id !== 'string') return;
            const pending = waiting.get(msg.id);
            if (!pending) { if (typeof previous === 'function') previous.call(port, ev); return; }
            waiting.delete(msg.id); msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error || 'failed'));
          };
          if (typeof port.addEventListener === 'function') port.addEventListener('message', receive); else port.onmessage = receive;
          vaultListening = port;
        }
        port.postMessage(JSON.stringify({ v: 1, id, method, params }));
      } catch (error) { waiting.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  window.WizCore = window.WizCore || {};
  window.WizCore.bridge = {
    VERSION, EVENTS, call: (method, params) => method.startsWith('vault.') ? vaultCall(method, params) : call(method, params), native,
    handle(h) {
      Object.assign(H, h);
      window.wizardUX = { shell: window.WIZ_SHELL || '', version: VERSION, events: EVENTS };
      window.dispatchEvent(new CustomEvent('wizard:ready', { detail: window.wizardUX }));
    },
  };
})();
