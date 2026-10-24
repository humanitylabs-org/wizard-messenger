'use strict';
// Gateway must serve this at the configured app SW path; do not broaden scope.
// Parent replaces this constant only at build time for its exact trusted mount.
const APP_PATH = '/apps/messenger/';
const APP_URL = new URL(APP_PATH, self.location.origin).href;

self.addEventListener('push', event => {
  // Payload cannot control text, URLs, icons, or executable content.
  let data;
  try { data = event.data.json(); } catch (_) { return; }
  if (!data || data.v !== 1 || typeof data.tag !== 'string' || !/^[a-f0-9]{64}$/.test(data.tag)) return;
  event.waitUntil(self.registration.showNotification('Messenger', {
    body: 'You have a new message.', tag: 'messenger-' + data.tag,
    renotify: false, data: {url: APP_URL}
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  // Ignore notification.data entirely; only open/focus the fixed app destination.
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin === self.location.origin && url.pathname === APP_PATH && !url.search && !url.hash) {
        return client.focus();
      }
    }
    return self.clients.openWindow(APP_URL);
  })());
});
