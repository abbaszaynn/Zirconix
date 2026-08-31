// Zirconix — Web Push service worker.
//
// Runs even when no Zirconix tab is open: this is what makes "notified
// irrespective of whether the tab is open" possible on the web at all. Kept
// deliberately minimal — its only jobs are showing a push as an OS
// notification and, when tapped, focusing an existing tab (or opening one) at
// the page the notification is about.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Zirconix', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Zirconix';
  const options = {
    body: data.body || '',
    tag: data.kind || 'zirconix',
    // Same kind of update (e.g. two "vote recorded" pushes in quick
    // succession) replaces the old banner instead of stacking — a director
    // does not need to see every intermediate vote count separately.
    renotify: true,
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
