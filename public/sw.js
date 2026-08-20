// Minimal service worker: precaches the app shell's static assets and falls
// back to a simple offline page for navigations when there's no connection.
// This app is server-rendered with live data, so it is not a full offline-first
// SPA — the honest offline story here is "the app installs like an app, static
// assets load instantly, and a dropped connection gets a clear offline screen
// instead of a browser error." In-progress diary answers are additionally
// autosaved to localStorage (see diary_form.ejs) so a flaky connection during
// a submit doesn't lose what a respondent already typed.

const CACHE_NAME = "inicio-shell-v1";
const PRECACHE_URLS = [
  "/public/tailwind.css",
  "/public/manifest.json",
  "/public/icons/icon-192.png",
  "/public/icons/icon-512.png",
  "/public/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Static assets under /public: cache-first.
  if (req.url.includes("/public/")) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Page navigations: network-first, offline fallback on failure.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/public/offline.html"))
    );
  }
});
