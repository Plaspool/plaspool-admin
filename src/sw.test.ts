import { describe, expect, it, vi } from 'vitest';
// `?raw` rather than `node:fs`: `tsconfig.app.json` declares `types:
// ["vite/client"]` and nothing else, deliberately, so that browser code cannot
// reach for `process` or `Buffer` by accident. Vite's own client types declare
// this form, so the file is read without widening the app's globals.
import SW_SOURCE from '../public/sw.js?raw';

/**
 * `public/sw.js` — the two properties that make it safe to keep after the
 * cutover, asserted by RUNNING it rather than by reading it.
 *
 * A service worker is the one piece of this app that answers a request before
 * it leaves the browser, so a mistake in it is invisible from every other
 * surface: no server log, no network tab entry, no session check. Before the
 * cutover the file was harmless because nothing user-generated crossed the
 * network at all. Now `/api/posts` is a same-origin `basic` GET with a 200
 * body, which is precisely the shape the asset branch stores — and a shared
 * cache on a shared machine would serve one writer's library to the next.
 *
 * Two guards close that, and each fails in a different, silent way:
 *
 *  - the `/api` skip must sit BEFORE the navigate branch, because
 *    `mode === 'navigate'` is a property of the request and not of the path;
 *  - the cache NAME must have changed, because `activate` deletes only caches
 *    it does not recognise, so a worker already installed on a machine keeps
 *    whatever it collected under the old name.
 *
 * Reviving the worker from `src/v2/main.tsx` put two more properties within
 * reach, both latent rather than absent while nothing registered it: the shell
 * key `'./'` may only ever hold the ADMIN — not the separately deployed API
 * reference under `/docs`, and not a 404 or a 500 body — and the files a
 * re-brand replaces in place must not freeze in a cache no build step bumps.
 *
 * The file is not a module and cannot be imported, so it is evaluated inside a
 * fake worker global with `new Function`. That is what makes these tests behave
 * like assertions about behaviour instead of about source text: a regex for
 * `startsWith('/api')` would still pass with the check in the wrong place.
 */

const ORIGIN = 'https://studio.test';

interface FakeNotification {
  close: ReturnType<typeof vi.fn>;
  data?: { url?: string };
}

/** A window the browser already has open, as `clients.matchAll` reports it. */
interface FakeWindowClient {
  focus: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
}

interface FakeEvent {
  request?: unknown;
  /** `notificationclick`'s payload. Optional because the fetch and lifecycle
   *  fixtures carry a request instead: one Map of listeners, so one event
   *  shape has to serve every type the worker registers. */
  notification?: FakeNotification;
  respondWith: ReturnType<typeof vi.fn>;
  waitUntil: (p: unknown) => void;
}

/**
 * The worker, evaluated against a scriptable `self`.
 *
 * `caches` is a recording double rather than a stub returning `undefined`: two
 * of the tests below are about which cache NAME is opened and which are
 * deleted, so those calls are the observation, not plumbing.
 *
 * `self.clients` carries `matchAll` and `openWindow` alongside `claim` for the
 * same reason: which of those two the notification handler reaches for IS the
 * behaviour — focus what is open, or open something new — and `openWindows` is
 * how a test says which world the tap happened in.
 */
function loadWorker(existingCacheNames: string[] = [], openWindows: FakeWindowClient[] = []) {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const put = vi.fn(async () => undefined);
  const add = vi.fn(async () => undefined);
  const open = vi.fn(async () => ({ put, add }));
  const del = vi.fn(async () => true);
  const match = vi.fn(async (): Promise<unknown> => undefined);
  const fetchSpy = vi.fn(async (): Promise<unknown> => new Response('hi', { status: 200 }));
  const matchAll = vi.fn(async () => openWindows);
  const openWindow = vi.fn(async () => undefined);
  const showNotification = vi.fn(async () => undefined);

  const self = {
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined), matchAll, openWindow },
    /* The push handler's only outward move. ADDITIVE to the double and never a
       change to an assertion: every test above still passes without it, and the
       push tests below have something to observe with it. */
    registration: { showNotification },
  };
  const caches = {
    open,
    keys: async () => existingCacheNames,
    delete: del,
    match,
  };

  /*
   * `new Function` over a FIRST-PARTY FILE FROM THIS REPO, never over input.
   * The alternative — regexes over the source text — cannot tell the `/api`
   * check's position from its presence, and position is the property that
   * matters most here.
   */
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', 'URL', SW_SOURCE)(
    self,
    caches,
    fetchSpy,
    Response,
    URL,
  );

  return {
    listeners,
    open,
    add,
    put,
    del,
    match,
    fetchSpy,
    self,
    matchAll,
    openWindow,
    showNotification,
  };
}

function fetchEvent(url: string, mode = 'cors'): FakeEvent {
  const settled: unknown[] = [];
  return {
    request: { url, method: 'GET', mode },
    respondWith: vi.fn((p: unknown) => settled.push(p)),
    waitUntil: (p: unknown) => settled.push(p),
  };
}

/**
 * A response as the NETWORK hands one back, which a constructed one cannot
 * impersonate.
 *
 * Both cache-writing branches guard on `res.ok && res.type === 'basic'`, and
 * `new Response(...)` reports its type as `'default'` — only a response that
 * really came off the wire is `'basic'`. A test built on a constructed one
 * would therefore watch nothing be written and call that a pass, whichever way
 * the guard was spelled. This double carries the three members the worker
 * touches and nothing else, and its `clone()` returns an identity the
 * assertions below can name.
 */
function networkResponse(copy: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, type: 'basic', clone: () => copy };
}

/**
 * Let every pending microtask run.
 *
 * The cache writes asserted below happen inside `caches.open(...).then(...)`,
 * a tick after the handler has already returned its response. A test that
 * asserts straight after driving the event is asserting against a cache
 * nothing has been written to yet, and passes for the wrong reason.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A tapped notification.
 *
 * `waited` is exposed where `fetchEvent` swallows its equivalent, because
 * everything this handler does — asking for the open windows, focusing one,
 * opening another — happens inside `waitUntil`. A test that does not await it
 * asserts against a handler that has not run yet, and passes for the wrong
 * reason.
 */
interface FakeNotificationEvent extends FakeEvent {
  notification: FakeNotification;
  waited: unknown[];
}

function notificationClickEvent(url?: string): FakeNotificationEvent {
  const waited: unknown[] = [];
  return {
    // `undefined` rather than `{}` when no URL is given: that is what a
    // notification raised without a `data` bag really looks like, and the
    // handler has to survive reading through it.
    notification: { close: vi.fn(), data: url === undefined ? undefined : { url } },
    respondWith: vi.fn(),
    waitUntil: (p: unknown) => waited.push(p),
    waited,
  };
}

function openWindowClient(): FakeWindowClient {
  return { focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined) };
}

describe('public/sw.js keeps what is not the shell out of the shell cache', () => {
  it('hands an /api GET straight back to the browser', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/api/posts?status=all`);
    listeners.get('fetch')!(event);
    // Not calling `respondWith` is the whole answer: the browser makes the
    // request itself, with the cookie, and nothing is stored.
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('skips /api even when the request is a navigation', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/api/export`, 'navigate');
    listeners.get('fetch')!(event);
    /*
     * THE ORDERING TEST. With the `/api` check placed after the navigate
     * branch this is the case that survives: the branch answers from the shell
     * cache and writes the response back under `'./'`, so an export — every
     * post the account can read — becomes the document every later cold boot
     * is served.
     */
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('still answers an ordinary navigation, so the fixture reaches the branch', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/`, 'navigate');
    listeners.get('fetch')!(event);
    // Without this the two tests above would pass against a handler that
    // returned early for everything, which is not the property being claimed.
    expect(event.respondWith).toHaveBeenCalled();
  });

  it('still caches a same-origin asset', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/assets/index-a1b2c3.js`);
    listeners.get('fetch')!(event);
    expect(event.respondWith).toHaveBeenCalled();
  });

  it('ignores another origin entirely', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent('https://elsewhere.test/api/posts');
    listeners.get('fetch')!(event);
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('hands the API reference back to the browser rather than storing it', () => {
    const { listeners, fetchSpy } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/docs/api/`, 'navigate');
    listeners.get('fetch')!(event);
    /*
     * `docs/api` is copied into the build by `vite.config.ts` and is a
     * different document altogether — its own dark-themed page, booting none
     * of this app. Answered by the navigate branch it would be written under
     * `'./'`, so one visit to the API reference and the next cold boot with no
     * network serves the reference where the admin should be.
     */
    expect(event.respondWith).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still answers a path that merely begins with those letters', () => {
    const { listeners } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/docsomething`, 'navigate');
    listeners.get('fetch')!(event);
    // The skip compares the whole segment. A bare `startsWith('/docs')` would
    // also swallow a future app route whose name happens to begin with it, and
    // that route would then have no offline fallback and no test saying why.
    expect(event.respondWith).toHaveBeenCalled();
  });

  it('does not write a failed navigation in as the app shell', async () => {
    const { listeners, fetchSpy, put } = loadWorker();
    fetchSpy.mockResolvedValue(networkResponse('a 500 page', 500));
    const event = fetchEvent(`${ORIGIN}/`, 'navigate');
    listeners.get('fetch')!(event);
    await flush();
    /*
     * A 404, or one of Vercel's own 500 pages, is HTML that clones and stores
     * exactly like the real document. Written under `'./'` it becomes the page
     * every later cold boot is served, and stays there until some successful
     * navigation happens to overwrite it.
     */
    expect(put).not.toHaveBeenCalled();
  });

  it('still writes a successful navigation in as the app shell', async () => {
    const { listeners, fetchSpy, put } = loadWorker();
    const shell = { body: 'the admin' };
    fetchSpy.mockResolvedValue(networkResponse(shell));
    const event = fetchEvent(`${ORIGIN}/`, 'navigate');
    listeners.get('fetch')!(event);
    await flush();
    // The positive half. Without it the guard above could be tightened until
    // nothing was ever cached, every other test here would still pass, and the
    // app would have no offline shell at all — which is the whole point of the
    // file.
    expect(put).toHaveBeenCalledWith('./', shell);
  });
});

/**
 * The files a re-brand replaces.
 *
 * `src/brand.ts` opens by promising that swapping a PNG in `public/brand/`
 * "needs no rebuild knowledge and no code change — replace the file and
 * reload". The asset branch below is cache-first and never revalidates, and
 * `CACHE` is a constant no build step bumps, so everything same-origin that is
 * NOT content-hashed would otherwise freeze on its first fetch for the life of
 * the cache. The new logo would reach whoever had never opened the app, and
 * nobody who had — with no error anywhere, on machines the person who swapped
 * the file does not have.
 */
describe('public/sw.js keeps the files a re-brand replaces fresh', () => {
  it('goes to the network for brand art instead of consulting the cache', () => {
    const { listeners, match, fetchSpy } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/brand/logo-light.png`);
    listeners.get('fetch')!(event);
    // Asserted synchronously, because the ordering IS the claim: the branch
    // calls `fetch` first and only reaches for a stored copy if that rejects.
    expect(fetchSpy).toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });

  it('goes to the network for the manifest too', () => {
    const { listeners, match, fetchSpy } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/manifest.webmanifest`);
    listeners.get('fetch')!(event);
    // The manifest names the installed app and points at its launcher icons.
    // A frozen copy is a rename that nobody who already installed the app ever
    // sees.
    expect(fetchSpy).toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
  });

  it('still serves a hashed asset from the cache first', () => {
    const { listeners, match, fetchSpy } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/assets/index-a1b2c3.js`);
    listeners.get('fetch')!(event);
    // The control. A hashed filename changes with every build, so cache-first
    // costs nothing there — and if these went to the network too, an offline
    // cold boot would have no JavaScript to run.
    expect(match).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the copy it has when the network is gone', async () => {
    const { listeners, match, fetchSpy } = loadWorker();
    const cached = new Response('last logo');
    fetchSpy.mockRejectedValue(new Error('offline'));
    match.mockResolvedValue(cached);
    const event = fetchEvent(`${ORIGIN}/brand/logo-light.png`);
    listeners.get('fetch')!(event);
    // Freshness must not cost the offline shell its logo: the network first,
    // the stored copy second, a broken image never.
    await expect(event.respondWith.mock.calls[0][0]).resolves.toBe(cached);
  });
});

describe('public/sw.js evicts the pre-cutover cache', () => {
  it('installs into studio-shell-v2', async () => {
    const { listeners, open } = loadWorker();
    const event = fetchEvent(`${ORIGIN}/`);
    listeners.get('install')!(event);
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith('studio-shell-v2');
  });

  it('deletes a v1 cache on activate, which is what the name bump buys', async () => {
    const { listeners, del } = loadWorker(['studio-shell-v1', 'studio-shell-v2']);
    const event = fetchEvent(`${ORIGIN}/`);
    listeners.get('activate')!(event);
    // `activate` filters on `k !== CACHE`, so a worker whose constant still
    // said v1 would leave the v1 cache — and every `/api` response already in
    // it — in place on every machine that had run the old worker.
    await vi.waitFor(() => expect(del).toHaveBeenCalledWith('studio-shell-v1'));
    expect(del).not.toHaveBeenCalledWith('studio-shell-v2');
  });
});

/**
 * The tap on an order notification.
 *
 * This is the one path in the app that runs when nothing else of ours is
 * running: the page raised the notification, the phone was locked or the tab
 * swapped out, and by the time somebody taps it the worker is all that is
 * left. There is no screen to look at when it goes wrong — a second admin
 * window, or a focused window still sitting on whatever page it was on, is the
 * whole symptom — so the branch is asserted rather than read.
 */
describe('public/sw.js answers a tapped notification', () => {
  const ORDER = '/#/orders/o_1234';

  it('focuses the window that is already open instead of opening a second one', async () => {
    const already = openWindowClient();
    const { listeners, openWindow } = loadWorker([], [already]);
    const event = notificationClickEvent(ORDER);
    listeners.get('notificationclick')!(event);
    await Promise.all(event.waited);
    expect(already.focus).toHaveBeenCalled();
    // A second admin window is the failure this prevents: it signs in again,
    // reloads the bundle, refetches everything, and leaves two admins open
    // with one of them stale.
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('sends that window to the URL the notification carried', async () => {
    const already = openWindowClient();
    const { listeners } = loadWorker([], [already]);
    const event = notificationClickEvent(ORDER);
    listeners.get('notificationclick')!(event);
    await Promise.all(event.waited);
    // Focus alone would leave somebody on Products wondering which order it
    // was about.
    expect(already.navigate).toHaveBeenCalledWith(ORDER);
  });

  it('opens a window at that URL when nothing is open', async () => {
    const { listeners, openWindow } = loadWorker();
    const event = notificationClickEvent(ORDER);
    listeners.get('notificationclick')!(event);
    await Promise.all(event.waited);
    expect(openWindow).toHaveBeenCalledWith(ORDER);
  });

  it('falls back to the app root when the notification carried no URL', async () => {
    const { listeners, openWindow } = loadWorker();
    const event = notificationClickEvent();
    listeners.get('notificationclick')!(event);
    await Promise.all(event.waited);
    // Reading `.url` straight off a missing `data` bag would throw here, and a
    // throw inside `notificationclick` is a tap that does nothing at all.
    expect(openWindow).toHaveBeenCalledWith('/');
  });

  it('closes the notification either way, before it goes looking for a window', async () => {
    const withWindow = notificationClickEvent(ORDER);
    const withNone = notificationClickEvent(ORDER);
    loadWorker([], [openWindowClient()]).listeners.get('notificationclick')!(withWindow);
    loadWorker().listeners.get('notificationclick')!(withNone);
    // Synchronously, before either `waited` promise is awaited: a notification
    // still on screen while the window is being found reads as a tap that did
    // not register, and gets tapped again.
    expect(withWindow.notification.close).toHaveBeenCalled();
    expect(withNone.notification.close).toHaveBeenCalled();
    await Promise.all([...withWindow.waited, ...withNone.waited]);
  });
});

describe('a push arrives with no page running', () => {
  /** A `push` event, whose payload is whatever the shop sent. `data` is absent
   *  entirely for the "no payload at all" case a push service may deliver. */
  function pushEvent(payload?: unknown): FakeEvent {
    const settled: unknown[] = [];
    return {
      data: payload === undefined ? undefined : { json: () => payload },
      respondWith: vi.fn((p: unknown) => settled.push(p)),
      waitUntil: (p: unknown) => settled.push(p),
    } as unknown as FakeEvent;
  }

  const order = {
    title: 'New order 2026-000002-U',
    body: '32600.00 NGN — buyer@example.test paid. Nothing sent out yet.',
    url: 'https://admin.plaspool.com/#/orders/ord_1',
    tag: 'order-ord_1',
  };

  it('shows what the shop sent, and carries the URL for the tap', async () => {
    const w = loadWorker();
    w.listeners.get('push')!(pushEvent(order));
    await flush();

    expect(w.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = w.showNotification.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(title).toBe('New order 2026-000002-U');
    expect(options.body).toBe(order.body);
    // The notificationclick handler reads exactly this.
    expect(options.data).toEqual({ url: order.url });
    // One row per order, replaced rather than stacked on a redelivery.
    expect(options.tag).toBe('order-ord_1');
  });

  it('STILL SHOWS SOMETHING when the payload is missing or unreadable', async () => {
    /*
     * THE BARGAIN THE BROWSERS ENFORCE. A push that resolves without calling
     * showNotification spends the permission silently, and Chrome and Firefox
     * answer by showing their own "this site was updated in the background"
     * notice and, after enough of them, revoking the subscription outright. A
     * vague notification is recoverable; a revoked subscription is not, and it
     * fails closed on the one channel that works with the app shut.
     */
    for (const bad of [undefined, null, 'not json at all']) {
      const w = loadWorker();
      const event =
        bad === 'not json at all'
          ? ({
              data: {
                json: () => {
                  throw new SyntaxError('Unexpected token');
                },
              },
              respondWith: vi.fn(),
              waitUntil: () => {},
            } as unknown as FakeEvent)
          : pushEvent(bad === null ? null : undefined);

      w.listeners.get('push')!(event);
      await flush();

      expect(w.showNotification).toHaveBeenCalledTimes(1);
      const [title, options] = w.showNotification.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(title).toBe('PlaSpool');
      expect(String(options.body).length).toBeGreaterThan(0);
    }
  });

  it('registers push as its OWN listener, leaving fetch alone', () => {
    /*
     * The test double keeps ONE handler per event type in a Map, so a second
     * `fetch` registration would silently replace the first and every caching
     * test above would then be exercising a handler it was not written for.
     * Real browsers run both, which is what makes this invisible outside a
     * test — so it is asserted here rather than trusted.
     */
    const w = loadWorker();
    expect([...w.listeners.keys()].sort()).toEqual([
      'activate',
      'fetch',
      'install',
      'notificationclick',
      'push',
    ]);
  });
});

describe('a push that is hard to miss', () => {
  function pushEvent(payload: unknown): FakeEvent {
    return {
      data: { json: () => payload },
      respondWith: vi.fn(),
      waitUntil: () => {},
    } as unknown as FakeEvent;
  }

  it('stays on screen until it is dealt with, and buzzes a phone', async () => {
    /*
     * WITHOUT `requireInteraction` A DESKTOP NOTIFICATION FADES after a few
     * seconds, so an order arriving while the packer is making tea is one
     * nobody ever sees — it technically arrived and did no work at all.
     *
     * `vibrate` is the ONLY loudness the web offers. There is no sound
     * parameter in the Notifications API, in any browser, so the tone belongs
     * to the operating system; a vibration pattern is the one thing a page can
     * ask for, and it is what gets noticed in a pocket.
     */
    const w = loadWorker();
    w.listeners.get('push')!(pushEvent({ title: 'New order', body: 'x', url: '/', tag: 't' }));
    await flush();

    const [, options] = w.showNotification.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(options.requireInteraction).toBe(true);
    expect(Array.isArray(options.vibrate)).toBe(true);
    expect((options.vibrate as number[]).length).toBeGreaterThan(1);
  });

  it('keeps those on the fallback notification too, when the payload is junk', async () => {
    /* The degraded message is the one most likely to matter — something went
       wrong AND an order may be sitting there. It must not be the quiet one. */
    const w = loadWorker();
    w.listeners.get('push')!(pushEvent(null));
    await flush();

    const [, options] = w.showNotification.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(options.requireInteraction).toBe(true);
    expect(Array.isArray(options.vibrate)).toBe(true);
  });
});
