// howlong service worker — network-first for the app itself (HTML + app.js),
// cache-first for the static shell (manifest, icons)
const CACHE = "howlong-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Serve from the network and refresh the cache, falling back to the cache when
// offline. `cacheKey` is what the fresh copy gets stored under, and `fallback`
// is tried if the request itself has no cache entry.
function networkFirst(req, cacheKey, fallback) {
  return fetch(req)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(cacheKey, copy));
      return res;
    })
    .catch(() => caches.match(req).then((hit) => hit || caches.match(fallback)));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Network-first for the HTML document so a new deploy shows up on reload
  // (index.html holds the markup and the inline CSS). Falls back to cache when
  // offline, keeping the app usable without a connection.
  const isHTML =
    req.mode === "navigate" ||
    req.destination === "document" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    e.respondWith(networkFirst(req, "./index.html", "./index.html"));
    return;
  }

  // app.js is network-first for the same reason: it ships together with
  // index.html and the two must never drift apart. Serving it cache-first meant
  // a returning visitor ran the new markup against a stale script until CACHE
  // was bumped — that is how 1.2.0 shipped a pause button that did nothing.
  // Network-first removes the need to remember the bump when app.ts changes.
  if (new URL(req.url).pathname.endsWith("/app.js")) {
    e.respondWith(networkFirst(req, req, "./app.js"));
    return;
  }

  // Cache-first for the static shell (manifest, icons). These change rarely and
  // only ever alongside a CACHE bump, so serving them from cache is safe.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
    )
  );
});
