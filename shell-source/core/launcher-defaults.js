/* DELETE after launcher-seed-v1 is installed everywhere. Compatibility with older Agent Services
 * only; the atomic shared-store migration uses these exact pre-refactor values once. Not a
 * device-local migration. Keep all optional launcher defaults here, never in shell adapters. */
(() => {
  'use strict';
  window.WizLauncherDefaults = {
    nativeLinks: [
      { id: 'maps', name: 'Maps', icon: '📍', colors: ['#34a853', '#4285f4'], href: 'https://www.google.com/maps', desc: 'Google Maps' },
      { id: 'camera', name: 'Camera', icon: '📷', colors: ['#4a4f63', '#1b1e2b'], href: 'intent:#Intent;action=android.media.action.STILL_IMAGE_CAMERA;end', desc: 'Camera' },
      { id: 'phone', name: 'Phone', icon: '📞', colors: ['#4ff0b0', '#13805a'], href: 'tel:', desc: 'Dialer' },
      { id: 'messages', name: 'Messages', icon: '💬', colors: ['#3f8cff', '#1b4ab8'], href: 'sms:', desc: 'SMS' },
      { id: 'spotify', name: 'Spotify', icon: '🎧', colors: ['#1ed760', '#0b5c2b'], href: 'intent://#Intent;package=com.spotify.music;end', desc: 'Music' },
      { id: 'telegram', name: 'Telegram', icon: '✈', colors: ['#2aabee', '#1868a8'], href: 'intent://#Intent;package=org.telegram.messenger;end', desc: 'Telegram' },
      { id: 'line', name: 'LINE', icon: 'L', colors: ['#06c755', '#04773a'], href: 'intent://#Intent;package=jp.naver.line.android;end', desc: 'LINE' },
      { id: 'grab', name: 'Grab', icon: 'G', colors: ['#00b14f', '#0a5c32'], href: 'intent://#Intent;package=com.grabtaxi.passenger;end', desc: 'Rides and food' },
      { id: 'chrome', name: 'Chrome', icon: '◍', colors: ['#fbbc05', '#ea4335'], href: 'https://www.google.com/', desc: 'Browser' },
      { id: 'settings', name: 'Settings', icon: '⚙', colors: ['#6a7088', '#2a2f42'], href: 'intent:#Intent;action=android.settings.SETTINGS;end', desc: 'Android settings' },
    ],
    recents: ['wizard', 'wizard-signal', 'wisdom', 'shopping'],
    desktopQuick: ['wizard', 'wizard-signal', 'wisdom', 'shopping', 'mizel', 'files', 'console', 'legacy-wizard', 'app-store'],
    autoOpen: ['topics', 'mizel'],
    hostedThreadApps: ['wizard-manager', 'wisdom'],
    // Registry has the long desk name; the owner's shortcut name stays unchanged.
    displayNames: { 'wizard-signal': 'Signal' },
  };
})();
