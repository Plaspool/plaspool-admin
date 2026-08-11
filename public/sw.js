/**
 * Minimal offline shell.
 *
 * The data layer was always local, but a cold load with no network still
 * needed the server to hand over the HTML/JS/CSS — so "works offline" was only
 * half true. This caches the app shell on install and serves it from cache
 * when the network is unavailable.
 *
 * Deliberately small: no runtime cache of anything but same-origin GETs, and
 * a versioned cache name so a new build evicts the old one. There is nothing
 * user-generated in here — posts live in IndexedDB and never touch this cache.
 */
const CACHE = 'studio-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.add('./')));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network first so a new build is picked up, cache as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./').then((r) => r || Response.error())),
    );
    return;
  }

  // Assets are content-hashed, so cache first is safe and fast.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
