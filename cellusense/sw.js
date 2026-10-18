// Offline-first service worker: the whole app is cached on first visit so a
// live demo never depends on Wi-Fi.
const VERSION = "cellusense-v1.1.0";
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/styles.css",
  "js/app.js",
  "js/analysis.js",
  "js/camera.js",
  "js/chart.js",
  "js/demo.js",
  "js/fhir.js",
  "js/store.js",
  "js/worker.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for same-origin GETs: instant from cache, refreshed
// in the background when online.
self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then(response => {
          if (response.ok && response.type === "basic") cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const fresh = await network;
      if (fresh) return fresh;
      if (request.mode === "navigate") return cache.match("index.html");
      return new Response("Offline", { status: 503, statusText: "Offline" });
    }),
  );
});
