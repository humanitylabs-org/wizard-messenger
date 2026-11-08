/* Wizard UX core: pick the shell for this device, before anything else loads.
 *
 * Two shells share one core (web/core/*):
 *   phone    index.html    orb, desks, swipes, sheets (the mobile Wizard UX)
 *   desktop  desktop.html  workspaces, tiled windows, launcher, keyboard and voice keys
 * Each page loads only its own shell's code, so the phone never downloads the desktop shell and vice versa.
 *
 * The shell follows the device, not the window width: a narrow Mac window stays the desktop shell.
 *   Phone/tablet (touch-first, coarse pointer, no hover) → phone. Anything with a mouse or trackpad → desktop.
 *   Native shells say what they are: the Android app is always the phone; Wizard for Mac always the desktop.
 *   Override (sticky on this device): ?shell=phone | ?shell=desktop, and ?shell=auto to clear it.
 */
(() => {
  'use strict';
  const KEY = 'wux.shell';
  const single = window.WizHomeScreenPolicy?.mode;
  const q = single ? null : new URLSearchParams(location.search).get('shell');
  try {
    if (q === 'phone' || q === 'desktop') localStorage.setItem(KEY, q);
    else if (q === 'auto') localStorage.removeItem(KEY);
  } catch (e) {}
  const forced = (() => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } })();
  const ua = navigator.userAgent || '';
  const android = !!window.WizardOSNative || /WizardOS-Android\//.test(ua);
  const mac = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wizardNative);
  // Set before first paint so the desktop bar never draws under the Mac window buttons.
  if (mac) document.documentElement.dataset.nativeChrome = 'mac';
  const mq = s => { try { return matchMedia(s).matches; } catch (e) { return false; } };
  const touchFirst = mq('(pointer: coarse)') && !mq('(any-pointer: fine)') && !mq('(hover: hover)');
  const mobileUA = /Android.+Mobile|iPhone|iPod|Mobile Safari/i.test(ua);
  const want = single ? 'phone' : forced || (android ? 'phone' : mac ? 'desktop' : (touchFirst || mobileUA) ? 'phone' : 'desktop');
  const here = document.documentElement.dataset.shell || 'phone';
  window.WIZ_SHELL = want;
  if (want !== here) {
    const page = want === 'desktop' ? 'desktop.html' : './';
    const u = new URL(page, location.href);
    // Keep deep links (?session=, ?open=) but drop the override param itself.
    new URLSearchParams(location.search).forEach((v, k) => { if (k !== 'shell') u.searchParams.set(k, v); });
    u.hash = location.hash;
    // Stop this page here: no further scripts run (nothing boots, nothing gets marked read), then move.
    document.documentElement.dataset.leaving = '1';
    document.documentElement.style.visibility = 'hidden';
    try { window.stop(); } catch (e) {}
    location.replace(u.href);
  }
})();
