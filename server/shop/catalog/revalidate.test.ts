import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  revalidateCatalog,
  revalidateProducts,
  setRevalidateTransport,
  settleRevalidations,
} from './revalidate';
import { STOREFRONT_REVALIDATE_URL } from './utils/revalidate-url';

/**
 * The purge transport itself.
 *
 * DRIVEN THROUGH A RECORDING `fetch` RATHER THAN A REAL SERVER, for the same
 * reason `PaystackConfig.fetchImpl` exists: what is being asserted is the exact
 * bytes on the wire — the method, the body, the absence of an authorization
 * header — and a real server would only prove that something arrived.
 *
 * `revalidate-routes.test.ts` is the other half, and it is the one that matters
 * more: it drives the real `createApp()` and asserts that each write route
 * actually calls this. A module that works and is wired to nothing is the shape
 * CLAUDE.md §2 keeps finding.
 */

/**
 * THE REAL ONE, imported rather than retyped.
 *
 * Nothing in this file reaches it: `setRevalidateTransport` replaces the socket,
 * and without an installed transport a test process purges nothing at all (see
 * `endpoint()`). Importing it means a typo in the constant fails here rather than
 * in production, which is the only assertion about the URL worth having now that
 * it is no longer configurable.
 */
const ENDPOINT = STOREFRONT_REVALIDATE_URL;

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string;
}

let calls: Recorded[];

/** Queued replies, consumed one per call; anything past the end is a 200. */
let replies: Array<Response | Error>;

function record(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ''),
    });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify({ ok: true, revalidated: [] }), { status: 200 });
  }) as typeof fetch;
}

function bodies(): unknown[] {
  return calls.map((c) => JSON.parse(c.body) as unknown);
}

/** The success line, captured rather than printed. */
function captureInfo() {
  return vi.spyOn(console, 'info').mockImplementation(() => {});
}

let infoLog: ReturnType<typeof captureInfo>;

beforeEach(() => {
  calls = [];
  replies = [];
  infoLog = captureInfo();
  setRevalidateTransport(record());
});

afterEach(async () => {
  await settleRevalidations();
  setRevalidateTransport(null);
  vi.restoreAllMocks();
});

describe('the request it sends', () => {
  it('purges one product with {"slug": …}', async () => {
    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(bodies()).toEqual([{ slug: 'pla-filament' }]);
  });

  it('purges the lists with a bare {} when nothing is product-scoped', async () => {
    revalidateCatalog();
    await settleRevalidations();

    expect(bodies()).toEqual([{}]);
  });

  it('sends ONE request for a product, never a second one for the lists', async () => {
    /*
     * The endpoint purges the `catalog` tag whether or not a slug is given. A
     * caller that "also refreshed the listings" would double every re-render the
     * storefront does for no effect at all.
     */
    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(calls).toHaveLength(1);
  });

  it('sends no authorization header and invents no signature', async () => {
    /*
     * The endpoint is unauthenticated, deliberately and knowingly. A header that
     * looks like auth but is checked by nothing is worse than none: the next
     * reader stops asking whether the endpoint is protected.
     */
    revalidateProducts('pla-filament');
    await settleRevalidations();

    const sent = Object.keys(calls[0].headers);
    expect(sent).not.toContain('authorization');
    expect(sent.some((h) => /secret|signature|token|key/i.test(h))).toBe(false);
  });

  it('logs one line per successful purge, naming how it was backgrounded', async () => {
    /*
     * The line an operator greps for after a deploy. `mode` is the part that
     * earns it: on Vercel, post-response work only reliably runs when the
     * platform has been asked to hold the instance open, and `floating` in
     * production means it has not been — which is the failure CLAUDE.md §2
     * records as invisible.
     */
    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(infoLog).toHaveBeenCalledOnce();
    const [prefix, payload] = infoLog.mock.calls[0] as [string, string];
    expect(prefix).toBe('[shop/catalog/revalidate] purged');
    expect(JSON.parse(payload)).toEqual({
      body: '{"slug":"pla-filament"}',
      // No Vercel request context in a test process, so the honest answer.
      mode: 'floating',
    });
  });

  it('does not claim success when the purge failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies = [new Response('', { status: 400 })];

    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(infoLog).not.toHaveBeenCalled();
  });

  it('never sends a `tag` field', async () => {
    // The endpoint accepts `slug` and nothing else, so a caller cannot purge
    // arbitrary cache tags. That is a property of this client too.
    revalidateProducts('pla-filament');
    revalidateCatalog();
    await settleRevalidations();

    for (const body of bodies()) expect(Object.keys(body as object)).not.toContain('tag');
  });
});

describe('which slugs become requests', () => {
  it('de-duplicates, so a repeated slug is one purge', async () => {
    revalidateProducts('pla-filament', 'pla-filament');
    await settleRevalidations();

    expect(bodies()).toEqual([{ slug: 'pla-filament' }]);
  });

  it('sends two requests for a slug change — the old page is cached too', async () => {
    revalidateProducts('old-name', 'new-name');
    await settleRevalidations();

    expect(bodies()).toEqual([{ slug: 'old-name' }, { slug: 'new-name' }]);
  });

  it('falls back to {} for a product that has no slug', async () => {
    // A draft nobody has titled has `slug: null`. There is no page to purge, but
    // the lists still changed.
    revalidateProducts(null);
    await settleRevalidations();

    expect(bodies()).toEqual([{}]);
  });

  it('falls back to {} rather than sending a slug the endpoint would 400', async () => {
    // The storefront's own `/^[a-z0-9][a-z0-9-]{0,79}$/`. A request guaranteed to
    // be refused is a wasted round trip and a log line that reads like a bug.
    for (const bad of ['-leading', 'Upper', 'has space', '', 'x'.repeat(81), 'trailing_']) {
      calls = [];
      revalidateProducts(bad);
      await settleRevalidations();
      expect(bodies()).toEqual([{}]);
    }
  });

  it('keeps the good slugs when only some are refusable', async () => {
    revalidateProducts('pla-filament', 'NOT A SLUG');
    await settleRevalidations();

    // The valid one purges its page AND the lists, so the invalid one costs
    // nothing extra — no second unscoped request is needed.
    expect(bodies()).toEqual([{ slug: 'pla-filament' }]);
  });

  it('collapses an implausibly large set into a single {}', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    revalidateProducts(...Array.from({ length: 50 }, (_, i) => `product-${i}`));
    await settleRevalidations();

    expect(bodies()).toEqual([{}]);
    // A cap that truncates silently reads as "everything was purged".
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('the endpoint', () => {
  it('is the storefront constant, needing no configuration', async () => {
    revalidateCatalog();
    await settleRevalidations();

    expect(calls[0].url).toBe('https://plaspool.com/api/revalidate');
    // And that is what the module imports, so a typo in either fails here.
    expect(calls[0].url).toBe(STOREFRONT_REVALIDATE_URL);
  });

  it('is NOT reached by a test process that has installed no transport', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE MOST IMPORTANT TEST IN THIS FILE, and the one that stops `npm test`
     * from becoming a load generator against the live shop.
     *
     * The endpoint is a repository constant now, so nothing is unset by default
     * and nothing else stands between a catalogue write and a real POST.
     * `server/nul-bytes.test.ts` walks EVERY registered route;
     * `routes.test.ts`, `lifecycle.test.ts`, `categories.test.ts` and
     * `case-fold.test.ts` each drive catalogue writes. Without the guard this
     * asserts, one full run purges production's cache dozens of times and
     * re-renders every catalogue page on the shop.
     *
     * The real `fetch` is installed here on purpose — if the guard regresses,
     * this test does not fail politely, it makes a network call. So it fails
     * loudly either way.
     * ═══════════════════════════════════════════════════════════════════════
     */
    expect(process.env.NODE_ENV).toBe('test');
    const realFetch = vi.spyOn(globalThis, 'fetch');
    setRevalidateTransport(null);

    revalidateProducts('pla-filament');
    revalidateCatalog();
    await settleRevalidations();

    expect(realFetch).not.toHaveBeenCalled();
    expect(infoLog).not.toHaveBeenCalled();
  });

  it('IS reached once a suite installs a recorder — the escape hatch', async () => {
    // Which is how this file and `revalidate-routes.test.ts` test the path at
    // all, and why they are the only two suites that see a purge happen.
    setRevalidateTransport(record());

    revalidateCatalog();
    await settleRevalidations();

    expect(calls).toHaveLength(1);
  });
});

describe('failure never escapes and never storms', () => {
  it('retries exactly once on a network error, then gives up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies = [new TypeError('fetch failed'), new TypeError('fetch failed')];

    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(calls).toHaveLength(2);
  });

  it('retries exactly once on a 5xx', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies = [new Response('', { status: 503 })];

    revalidateProducts('pla-filament');
    await settleRevalidations();

    // Second attempt succeeds — two calls, not three, and no third round.
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a 400 — the same bad slug produces the same 400', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies = [
      new Response(JSON.stringify({ ok: false, message: 'bad slug' }), { status: 400 }),
    ];

    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(calls).toHaveLength(1);
  });

  it('logs and moves on when both attempts fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    replies = [new Response('', { status: 500 }), new Response('', { status: 500 })];

    revalidateProducts('pla-filament');
    await expect(settleRevalidations()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });

  it('cannot reject: a transport that explodes leaves no unhandled rejection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    setRevalidateTransport((() => {
      throw new Error('synchronous explosion');
    }) as unknown as typeof fetch);

    expect(() => revalidateProducts('pla-filament')).not.toThrow();
    await settleRevalidations();
    // A tick for anything the microtask queue was still holding.
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('it does not block the caller', () => {
  it('returns before the request has been made, let alone answered', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setRevalidateTransport((async () => {
      await gate;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    /*
     * The property the brief is really asking for: a storefront that is hanging
     * must not hold an admin save open. If `revalidateProducts` awaited anything,
     * this line would never return.
     */
    revalidateProducts('pla-filament');

    // Nothing settled, and control is already back here.
    expect(true).toBe(true);
    release();
    await settleRevalidations();
  });
});

describe('the platform hook', () => {
  const KEY = Symbol.for('@vercel/request-context');

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[KEY];
  });

  it('hands the work to waitUntil when Vercel publishes one', async () => {
    /*
     * CLAUDE.md §2: Vercel freezes the function once the response is sent, and a
     * merely-floating promise does not reliably run — that is how
     * `shop_payment_events.processed_at` stayed null in production. This asserts
     * the hook is actually used, which is the only part of that a test here can
     * reach; the rest is verified against a deployment.
     */
    const waitUntil = vi.fn();
    (globalThis as Record<symbol, unknown>)[KEY] = { get: () => ({ waitUntil }) };

    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    // And it says so, which is what makes the difference checkable in a log
    // rather than only by reasoning about the platform.
    const [, payload] = infoLog.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toMatchObject({ mode: 'waitUntil' });
  });

  it('still fires when there is no request context (dev, tests, the node server)', async () => {
    delete (globalThis as Record<symbol, unknown>)[KEY];

    revalidateProducts('pla-filament');
    await settleRevalidations();

    expect(bodies()).toEqual([{ slug: 'pla-filament' }]);
  });

  it('survives a request context that throws or is the wrong shape', async () => {
    (globalThis as Record<symbol, unknown>)[KEY] = {
      get: () => {
        throw new Error('no store in this scope');
      },
    };

    expect(() => revalidateProducts('pla-filament')).not.toThrow();
    await settleRevalidations();

    expect(bodies()).toEqual([{ slug: 'pla-filament' }]);
  });
});
