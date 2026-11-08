/* Delete after APK release A is installed: registry grants replace the pilot seed,
 * and native accepts the actual granted app id rather than one legacy token. */
(() => {
  'use strict';
  const pilot = 'wizard-music';
  window.WizBackgroundAudioLegacy = {
    granted(appId, app) {
      if (appId !== pilot || !app?.url) return false;
      try { const u=new URL(app.url,location.href); return u.origin===location.origin && u.pathname==='/'+pilot+'/'; }
      catch (_) { return false; }
    },
    nativeAppId: () => pilot,
  };
})();
