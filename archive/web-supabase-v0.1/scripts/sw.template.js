// YG POS service worker (generated — edit scripts/sw.template.js).
// Stores every file of this build on the device at install time, then serves the app from
// that copy. Only the app itself is cached here; business data goes through IndexedDB + sync.
const CACHE = "ygpos-__VERSION__";
const ASSETS = __ASSETS__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Small batches: a few hundred parallel requests can fail on weak connections.
      for (let i = 0; i < ASSETS.length; i += 20) {
        await cache.addAll(ASSETS.slice(i, i + 20).map((u) => new Request(u, { cache: "reload" })));
      }
    }),
  );
  // No skipWaiting here: a new version takes over only when the page asks (see below) or
  // all tabs are closed, so a bill in progress is never interrupted by an update.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ygpos-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function cacheKey(url) {
  let p = url.pathname;
  if (p.endsWith("/")) p += "index.html";
  else if (!/\.[a-z0-9]+$/i.test(p)) p += "/index.html";
  return p;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase and anything else: straight to the network
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(cacheKey(url));
      if (hit) return hit;
      try {
        return await fetch(req);
      } catch (err) {
        if (req.mode === "navigate") return (await cache.match("/404.html")) ?? Response.error();
        throw err;
      }
    }),
  );
});
