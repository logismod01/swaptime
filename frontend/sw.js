// ============================================================
// СВАПТАЙМ — service worker (PWA)
// ============================================================
// Стратегии:
//   • навигация (HTML)  — сеть, при офлайне из кеша;
//   • статика (/static) — stale-while-revalidate;
//   • API и WebSocket   — только сеть (никакого кеша: приватные данные).
// ============================================================

const VERSION = "swaptime-v11";
const SHELL = [
  "/",
  "/static/style.css?v=10",
  "/static/script.js?v=10",
  "/static/servers.js?v=10",
  "/static/channels.js?v=10",
  "/static/calls.js?v=10",
  "/static/favicon.svg",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png",
  "/manifest.webmanifest",
  "/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // HTML — сначала сеть (нужна свежая версия интерфейса)
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/", copy)).catch(() => {});
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit || caches.match("/offline.html") || caches.match("/"))
        )
    );
    return;
  }

  // статика — из кеша, параллельно обновляем
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
