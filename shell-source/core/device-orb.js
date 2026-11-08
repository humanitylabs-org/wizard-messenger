/* The floating orb in the Wizard Shell Android app (android/shell), over window.wizardDevicePort v1 (device.orb).
 *
 * Optional: when this APK offers device.orb, Settings → Phone → Wizard Everywhere (core/settings.js) is its one switch;
 * elsewhere this file does nothing. The
 * orb itself is native (it floats over other apps); its look is this Wizard's web/assist/everywhere.html. Its voice
 * is a device.recording take marked `send`: core/device-recording.js sends those when it next runs (at once while
 * this page is alive in the background, otherwise when the app is opened).
 */
(() => {
  'use strict';
  if (window.WosDeviceOrb) return;
  const CAP = 'device.orb';
  let ready = false, state = { on: false, permitted: false, visible: false }, busy = false, watch = 0;
  const call = (m, p) => window.WosDevicePort.call(CAP + '.' + m, p || {}, 15000);

  async function refresh() {
    try { state = await call('status') || state; } catch (_) { return; }
    window.WosSettings?.refresh?.();
    clearInterval(watch); watch = 0;
    // While the orb is on, collect its takes promptly even with the app in the background.
    if (state.on) watch = setInterval(() => window.WosDeviceRecording?.collect?.('orb'), 2500);
  }
  async function toggle() {
    if (busy) return; busy = true;
    try { state = await call(state.on ? 'disable' : 'enable') || state; }
    catch (e) { window.__wos?.toast?.('!', 'Could not change the floating orb', 2400); }
    finally { busy = false; refresh(); }
  }

  async function discover() {
    if (!window.WosDevicePort?.present || window.WizardOSDevice) return;
    const c = await window.WosDevicePort.capability(CAP, 1);
    if (!c || !['status', 'enable', 'disable'].every(m => c.methods?.includes(CAP + '.' + m))) return;
    ready = true;
    await refresh(); // re-renders Settings: its Everywhere switch now drives this orb
  }
  // Back from Android's "Display over other apps" screen: the app turns the orb on; show it.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ready) refresh(); });

  window.WosDeviceOrb = { get ready() { return ready; }, get state() { return { ...state }; }, toggle, refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', discover, { once: true }); else discover();
})();
