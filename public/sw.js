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

  /*
   * NEITHER IS THE API REFERENCE, AND IT IS A DIFFERENT DOCUMENT ALTOGETHER.
   *
   * `vite.config.ts`'s copy-api-docs plugin drops `docs/api` into the build,
   * so the reference ships from this origin as its own static page — its HTML
   * opens `<html lang="en" data-theme="dark">` and boots none of this app.
   * Reading it is an ordinary same-origin navigation, so without this line the
   * branch below answers it and then writes it under `'./'`: one visit to the
   * API reference, and the next cold boot with no network serves the reference
   * where the admin should be, until some later navigation happens to overwrite
   * it.
   *
   * Latent rather than harmless, and only latent because nothing registered
   * this worker: `index.html` has booted `src/v2` since the cutover, and its
   * `register` call was only added back now, so this handler has not run
   * against the site's current layout at all — the layout `/docs/api` is part
   * of. Reviving the worker is what puts it back in the path.
   *
   * The whole-segment comparison is deliberate. A bare `startsWith('/docs')`
   * would also swallow a future app route whose name merely begins with those
   * letters, leaving it with no offline fallback and nothing saying why.
   */
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return;

  /*
   * BRAND ART AND THE MANIFEST ARE REPLACED IN PLACE, SO THEY MUST NOT GO
   * CACHE-FIRST.
   *
   * `CACHE` is a hand-maintained constant that no build step bumps, and the
   * asset branch at the bottom never revalidates what it stored. Everything
   * same-origin that is NOT content-hashed therefore freezes on its first
   * fetch for the life of the cache — which would quietly break the promise
   * `src/brand.ts` opens with, that swapping a PNG "needs no rebuild knowledge
   * and no code change — replace the file and reload". The new logo would be
   * fetched once, by whoever had never opened the app before, and never again
   * by anybody who had.
   *
   * Network first with the cached copy as the offline fallback, so both halves
   * hold: a replaced file shows up on the next load, and an offline cold boot
   * still draws the logo it saw last time rather than a broken image.
   *
   * Above the navigate branch for the same reason `/api` is: opening one of
   * these files directly makes it a navigation, and the branch below would
   * write a PNG in as the app shell.
   */
  if (url.pathname.startsWith('/brand/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error())),
    );
    return;
  }

  // Navigations: network first so a new build is picked up, cache as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          /*
           * ONLY A RESPONSE THAT ACTUALLY SUCCEEDED MAY BECOME THE SHELL.
           *
           * This branch used to store whatever came back. A 404, or one of
           * Vercel's own 500 pages, is HTML with a body that clones and stores
           * exactly like the real document — so a single bad answer became the
           * page every later cold boot was served, and stayed there until some
           * successful navigation happened to replace it. The asset branch
           * below has always had this guard; the shell, which matters more,
           * did not.
           *
           * `ok` also covers the case a navigation makes possible and a
           * subresource does not: a navigation request carries `redirect:
           * 'manual'`, so a 301 comes back as an `opaqueredirect` with status
           * 0 and no body at all, which has to be handed to the browser to
           * follow and must never be cached as the document.
           */
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./', copy));
          }
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

/*
 * A TAPPED NOTIFICATION LANDS ON THE THING IT IS ABOUT.
 *
 * There is no `push` listener here and that is deliberate: Web Push needs
 * VAPID keys nobody has set, so a `push` handler could never fire, and a
 * handler that can never fire is one nobody maintains and everybody trusts.
 * The notifications this answers are raised by the PAGE while the admin is
 * open. What the page cannot do is answer the tap — on a phone the tab is
 * usually in the background by then, and the worker is the only part of us
 * still running.
 *
 * FOCUS A WINDOW THAT IS ALREADY OPEN rather than open a second one. Someone
 * with the admin open on Products who taps "New order" has to end up on that
 * order in the window they already had, not in a duplicate that re-signs-in,
 * reloads the bundle and refetches everything — and not with two admins open,
 * one of them stale. `navigate` is attempted after the focus, never instead of
 * it, and its failure is swallowed: it rejects for a client this worker does
 * not yet control, and by then the window is at least in front of them.
 *
 * `self.clients`, not a bare `clients`. `src/sw.test.ts` evaluates this file
 * inside a scriptable global that injects exactly self, caches, fetch,
 * Response and URL by name, so any other worker global read at MODULE scope
 * throws ReferenceError before a single listener registers. Inside a handler
 * is a different matter, but `self.` costs nothing and keeps the rule simple.
 */
self.addEventListener('notificationclick', (event) => {
  /* Closed before anything async. A notification still sitting there while the
     window is being found reads as a tap that did not register, and gets
     tapped again. */
  event.notification.close();

  const data = event.notification.data;
  const url = (data && data.url) || '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const open = windows.find((client) => typeof client.focus === 'function');
        if (!open) return self.clients.openWindow(url);
        return Promise.resolve(open.focus()).then(() => {
          if (typeof open.navigate !== 'function') return undefined;
          return Promise.resolve(open.navigate(url)).catch(() => undefined);
        });
      }),
  );
});
