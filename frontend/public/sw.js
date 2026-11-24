// Plain JS, unprocessed by Vite — served as-is from the site root so its
// scope covers the whole app. Registered lazily from utils/webPush.ts only
// when a user actually turns on a push toggle in Settings > Notifications,
// never eagerly at app load.

self.addEventListener('push', (event) => {
  let payload = { title: 'HaiVE', body: '' };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // Non-JSON push payload — fall back to the default above rather than
    // dropping the notification entirely.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/haive-logo.png',
      badge: '/haive-logo.png',
      // Where a tap goes (Haive's briefings: /dashboard?haive=<slot>); none = the app as it is.
      data: { url: typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if (!('focus' in client)) continue;
        await client.focus();
        // An open HaiVE tab goes to the notification's page; if it can't be steered, a new tab opens there.
        if (url) {
          try {
            await client.navigate(url);
          } catch {
            if (self.clients.openWindow) await self.clients.openWindow(url);
          }
        }
        return;
      }
      if (self.clients.openWindow) return self.clients.openWindow(url || '/');
    }),
  );
});
