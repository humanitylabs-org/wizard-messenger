// Issue 484: ask for the first open's answers (web.py /api/view/boot: trusted-owner, session, status, identity and the
// chat lists) while the rest of Messenger is still downloading. app.js takes this answer once (preloadBoot) and hands
// each part out as that call's own response; when it is missing, refused or late, app.js asks by itself.
// A launch link (#ticket=) is left to app.js, which must redeem it first.
(() => {
  try {
    if (window.__messengerBoot !== undefined || location.hash.startsWith('#ticket=') || typeof fetch !== 'function') return;
    window.__messengerBoot = fetch('api/view/boot', {method: 'GET', headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store'})
      .then(async response => response.ok ? {answers: (await response.json())?.result?.answers, at: Date.now()} : null)
      .catch(() => null);
  } catch { /* app.js asks by itself */ }
})();
