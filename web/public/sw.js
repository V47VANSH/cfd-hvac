/**
 * HVAC CFD — Service Worker (PWA / offline)
 *
 * Strategy:
 *   - Static assets (chunks, css, ico, png, woff2): cache-first
 *   - HTML / index: network-first with cache fallback
 *   - calibration.json: stale-while-revalidate (so updates land on
 *     the next sim restart but offline still works)
 *
 * Bumping CACHE_VERSION purges all old caches on activate. Do this on
 * every release that ships modified static assets — Next.js content
 * hashing makes the chunks themselves immutable, so we mainly need to
 * bump for new HTML revisions.
 */

const CACHE_VERSION = "cfd-v1";
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const HTML_CACHE    = `${CACHE_VERSION}-html`;

self.addEventListener("install", (event) => {
  // Skip waiting so a freshly installed SW activates immediately on next load
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML / index — network first, cache fallback
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(HTML_CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response("<h1>Offline</h1><p>This page hasn't been cached yet.</p>", {
          status: 503, headers: { "Content-Type": "text/html" },
        });
      }
    })());
    return;
  }

  // Static — cache first
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok && (
        url.pathname.startsWith("/_next/static/") ||
        /\.(?:js|css|png|jpg|jpeg|svg|webp|woff2?|ttf|ico|json)$/.test(url.pathname)
      )) {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return new Response("Offline", { status: 503 });
    }
  })());
});
