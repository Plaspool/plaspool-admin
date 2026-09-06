import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestCtx } from '../../test/harness';
import { httpClient, TEST_ORIGIN, type HttpClient } from '../../test/http';
import { SHOP_SESSION_COOKIE, CART_COOKIE } from './identity/cookies';

/**
 * Cross-site cart access: the preflight, the credentialed headers, and the
 * cookie attributes that make them mean anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS ACTUALLY GUARDING.
 *
 * The storefront is deployed on a different REGISTRABLE DOMAIN from this API,
 * so a cart request from it is cross-SITE, not merely cross-origin. Three
 * separate things have to hold or the cart silently does not work in a browser
 * while passing every same-origin test in this suite:
 *
 *   1. the preflight is answered (or the browser never sends the POST at all)
 *   2. the response permits credentials AND names the origin exactly — a
 *      wildcard with credentials is refused by every browser
 *   3. the cookies are `SameSite=None`, or the browser withholds them on the
 *      way out and the cart mints a fresh empty basket every request
 *
 * (3) is the one with no visible failure: no error, no refusal, just a basket
 * that empties itself. It is asserted here because nothing else would catch it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

let ctx: TestCtx;
let http: HttpClient;

const FOREIGN = 'https://evil.example';

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

const preflight = (origin?: string) =>
  http.request('/api/shop/cart', {
    method: 'OPTIONS',
    headers: {
      ...(origin ? { Origin: origin } : {}),
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

describe('the preflight', () => {
  /* Without this the browser refuses before it ever sends the real request —
   * which is exactly what production did: OPTIONS /api/shop/cart answered 404. */
  it('is answered for a permitted origin, naming methods and headers', async () => {
    const res = await preflight(TEST_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('is answered on the checkout paths too, not only the cart ones', async () => {
    const res = await http.request('/api/shop/checkout/start', {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });

  it('covers the add-on choice route with credentials', async () => {
    const res = await http.request('/api/shop/checkout/add-ons/ado_x', {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
  });

  /* Not a 403 — a 204 with no permission headers. The browser does the refusing,
   * and there is nothing useful to say in a body no page will read. */
  it('grants nothing to an origin outside the allow-list', async () => {
    const res = await preflight(FOREIGN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  /* The "no Origin" case is not reachable through this client — `test/http.ts`
   * sets `TEST_ORIGIN` on every request by construction, because every unsafe
   * method is refused without one. `allowedOrigin` returns null for an absent
   * header by the same branch a foreign one takes, and the case above covers
   * that branch. */
});

describe('the credentialed response headers', () => {
  it('are on a real request, not only the preflight', async () => {
    const res = await http.post('/api/shop/cart', undefined, {
      headers: { Origin: TEST_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  /*
   * ⚠️  A KNOWN LIMITATION, PINNED SO IT IS NOT MISTAKEN FOR A BUG LATER.
   *
   * `originGuard` is installed by `createApp` on `/api/*`, ABOVE the shop app,
   * so its 403 short-circuits before the cart router — and therefore before
   * `shopCors`. A disallowed origin gets a 403 carrying no CORS headers at all,
   * which a browser surfaces as an opaque network failure rather than as a
   * readable status.
   *
   * That is only reachable while `APP_ORIGINS` is misconfigured: once the
   * storefront's origin is on the list there is no 403 to read. Fixing it would
   * mean adding CORS to shared error middleware every other subsystem also
   * uses, which is a wide change for a transient diagnostic — so it is recorded
   * rather than made.
   */
  it('are absent on the guard’s own 403, which short-circuits above this router', async () => {
    const res = await http.post('/api/shop/cart', undefined, {
      headers: { Origin: FOREIGN },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  /* A shared cache must not hand one origin's approval to another. */
  it('vary on Origin even when nothing is granted', async () => {
    const res = await http.get('/api/shop/cart', { headers: { Origin: FOREIGN } });
    expect(res.headers.get('vary')).toContain('Origin');
  });

  /* ONE writer. The preflight handler used to set `vary` as well as the
     middleware, which produced a literal `Vary: Origin, Origin` in production —
     correct to a cache, which reads the field as a set, and wrong to anybody
     reading a response header. */
  it('names Origin exactly once in Vary, including on the preflight', async () => {
    const pre = await preflight(TEST_ORIGIN);
    expect(pre.headers.get('vary')).toBe('Origin');
    const res = await http.get('/api/shop/cart', { headers: { Origin: TEST_ORIGIN } });
    expect(res.headers.get('vary')).toBe('Origin');
  });

  /* With credentials, `*` is refused outright by every browser — so this is a
   * functional requirement, not only a security one. */
  it('never answers with a wildcard', async () => {
    const res = await http.get('/api/shop/cart', { headers: { Origin: TEST_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('the cookies the browser has to be willing to send', () => {
  /*
   * THE FAILURE WITH NO SYMPTOM. `SameSite=Lax` is not sent on a cross-site
   * `fetch`, so the cart cookie never arrives, every request mints a new
   * anonymous cart, and the basket empties itself with no error anywhere.
   */
  it('are SameSite=None and Secure, or the basket silently empties itself', async () => {
    /* A fresh jar: an earlier test in this file already created a cart on the
       shared client, and a second create with that cookie is a 200 returning the
       existing basket rather than a 201 setting a new cookie. */
    http.clearCookies();
    const res = await http.post('/api/shop/cart', undefined, {
      headers: { Origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(201);

    const setCookies = res.headers.getSetCookie?.() ?? [];
    const cart = setCookies.find((c) => c.startsWith(CART_COOKIE));
    expect(cart, 'the cart cookie must be set on create').toBeTruthy();
    expect(cart).toMatch(/SameSite=None/i);
    // `None` without `Secure` is rejected by the browser outright.
    expect(cart).toMatch(/Secure/i);
    // `__Host-` still requires Path=/ and no Domain; SameSite is orthogonal to it.
    expect(cart).toMatch(/Path=\//i);
    expect(cart).not.toMatch(/Domain=/i);
  });

  it('names the two customer cookies, so this test fails if either is renamed', () => {
    expect(CART_COOKIE.startsWith('__Host-')).toBe(true);
    expect(SHOP_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });
});
