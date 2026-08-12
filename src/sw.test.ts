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
 * The file is not a module and cannot be imported, so it is evaluated inside a
 * fake worker global with `new Function`. That is what makes these tests behave
 * like assertions about behaviour instead of about source text: a regex for
 * `startsWith('/api')` would still pass with the check in the wrong place.
 */

const ORIGIN = 'https://studio.test';

interface FakeEvent {
  request?: unknown;
  respondWith: ReturnType<typeof vi.fn>;
  waitUntil: (p: unknown) => void;
}

/**
 * The worker, evaluated against a scriptable `self`.
 *
 * `caches` is a recording double rather than a stub returning `undefined`: two
 * of the tests below are about which cache NAME is opened and which are
 * deleted, so those calls are the observation, not plumbing.
 */
function loadWorker(existingCacheNames: string[] = []) {
  const listeners = new Map<string, (event: FakeEvent) => void>();
  const put = vi.fn(async () => undefined);
  const add = vi.fn(async () => undefined);
  const open = vi.fn(async () => ({ put, add }));
  const del = vi.fn(async () => true);
  const match = vi.fn(async () => undefined);
  const fetchSpy = vi.fn(async () => new Response('hi', { status: 200 }));

  const self = {
    addEventListener: (type: string, fn: (event: FakeEvent) => void) => listeners.set(type, fn),
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
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

  return { listeners, open, add, put, del, match, fetchSpy, self };
}

function fetchEvent(url: string, mode = 'cors'): FakeEvent {
  const settled: unknown[] = [];
  return {
    request: { url, method: 'GET', mode },
    respondWith: vi.fn((p: unknown) => settled.push(p)),
    waitUntil: (p: unknown) => settled.push(p),
  };
}

describe('public/sw.js keeps /api out of the shell cache', () => {
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
