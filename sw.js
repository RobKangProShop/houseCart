/*
 * HouseCart service worker
 * Strategy:
 *   - HTML (the app shell, index.html): network-first, falling back to cache.
 *     Keeps the app fresh when online; usable when offline.
 *   - Everything else from this origin (css/js/icons/manifest): cache-first,
 *     network-revalidate. Fast paint, eventual consistency.
 *
 * Bump CACHE_VERSION on each release so old caches get cleaned up.
 */
const CACHE_VERSION = "housecart-v26";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GETs from our own origin. Pass everything else through.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isHTML =
    req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    // Network-first for the app shell so updates ship promptly.
    // Use a short timeout so a flaky cellular connection doesn't hang the
    // page launch for 30 seconds before the browser gives up on its own.
    event.respondWith(
      (async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 3000);
        try {
          const res = await fetch(req, { signal: ctl.signal });
          clearTimeout(timer);
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          return res;
        } catch (_e) {
          clearTimeout(timer);
          const cached = await caches.match(req);
          return cached || (await caches.match("./index.html"));
        }
      })(),
    );
    return;
  }

  // Cache-first for static assets, revalidate in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});

// Allow the page to force-activate a new SW without a manual reload.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
