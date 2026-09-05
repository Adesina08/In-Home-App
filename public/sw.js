// Inicio Diary respondents now use the native Android APK, not the old
// browser-installed PWA. This retirement worker removes the previous root-scope
// service worker and its caches so /join and /invite links stay in the browser
// onboarding flow instead of being captured by an obsolete web-app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url))))
  );
});

self.addEventListener("fetch", () => {
  // Deliberately no interception. Network navigation belongs to the normal
  // browser; the installed Android APK is the only respondent app surface.
});
