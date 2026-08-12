/**
 * Minimal offline shell.
 *
 * The data layer was always local, but a cold load with no network still
 * needed the server to hand over the HTML/JS/CSS — so "works offline" was only
 * half true. This caches the app shell on install and serves it from cache
 * when the network is unavailable.
 *
 * Deliberately small: no runtime cache of anything but same-origin GETs, and
 * a versioned cache name so a new build evicts the old one.
 *
 * THE SENTENCE THAT USED TO BE HERE — "there is nothing user-generated in here
 * — posts live in IndexedDB and never touch this cache" — STOPPED BEING TRUE
 * AT THE CUTOVER. Posts now arrive over `/api`, as same-origin `basic` GETs
 * with 200 responses: exactly what the asset branch below stores. One writer's
 * `/api/posts` would sit in a shared cache on a shared machine and be served
 * to the next person from it, with no session check anywhere in the path,
 * because a service worker answers before the request leaves the browser.
 *
 * Two changes are needed and NEITHER IS SUFFICIENT ALONE:
 *
 *  1. the `/api` skip in `fetch` below, which stops new responses going in;
 *  2. **this version bump**, which gets the ones already in there out.
 *     `activate` deletes only caches whose NAME differs from `CACHE`, so an
 *     already-installed worker updated to a v1-named cache keeps every
 *     `/api` response it collected before the fix shipped — the skip would
 *     protect only browsers that had never run the old worker.
 */
const CACHE = 'studio-shell-v2';

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
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  /*
   * THE API IS NOT THE SHELL, AND THIS RETURN IS BEFORE THE NAVIGATE BRANCH
   * ON PURPOSE.
   *
   * Returning without calling `respondWith` hands the request back to the
   * browser untouched, which is the only correct answer for a cookie-scoped
   * endpoint: nothing is stored, nothing is replayed, and the session cookie
   * decides every response as the server intended.
   *
   * The ordering is load-bearing rather than tidy. `req.mode === 'navigate'`
   * is a property of the REQUEST, not of the path, so a `/api/...` URL opened
   * or restored as a top-level document is a navigation — and the branch below
   * would answer it out of the shell cache and, worse, `put('./', copy)` that
   * response as the app shell. Placing this check after it would leave the one
   * case where an `/api` response is written under the key every future cold
   * boot reads.
   */
  if (url.pathname.startsWith('/api')) return;

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
