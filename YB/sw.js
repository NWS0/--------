const CACHE_NAME = "night-space-v1";
const CORE_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.svg",
  "./icon-512.svg"
];
const CORE_URLS = new Set(
  CORE_FILES.map((file) => new URL(file, self.registration.scope).href)
);
const INDEX_URL = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("night-space-") && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isNavigation = request.mode === "navigate";
  if (!isNavigation && !CORE_URLS.has(requestUrl.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const response = await fetch(request, { cache: "no-cache" });
      if (response.ok) {
        const cacheUrl = isNavigation ? INDEX_URL : requestUrl.href;
        await cache.put(cacheUrl, response.clone());
      }
      return response;
    } catch (error) {
      const cachedResponse = await cache.match(isNavigation ? INDEX_URL : request);
      if (cachedResponse) return cachedResponse;
      throw error;
    }
  })());
});
