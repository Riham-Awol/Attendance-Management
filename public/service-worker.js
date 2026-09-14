/**
 * Offline shell for the PWA.
 *
 * Only the static shell is cached. Attendance data is never served from cache:
 * a stale "you are checked in" screen would be worse than an honest error, and
 * a check-in must reach the server to count.
 */

const CACHE = "attendance-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/main.js",
  "/js/api.js",
  "/js/ui.js",
  "/js/geo.js",
  "/js/views/employee.js",
  "/js/views/admin.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always live

  // Navigations fall back to the cached shell so the app opens offline.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/index.html")));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
