/**
 * TWO INDEPENDENT SESSIONS ON ONE REQUEST. This is the first test in this
 * subsystem and it was written before any of it existed.
 *
 * Contract §7 and brief §2 both name this as the seam, and GAUNTLET.md explains
 * why: every round of both prior gauntlets failed in a seam rather than in a
 * feature — a guard on one surface and not its twin, a mechanism wired to no
 * caller, two things that had to agree and did not. The shop owner browsing
 * their own store carries `__Host-studio_session` AND `__Host-shop_session` at
 * the same time. The two middlewares must be blind to each other.
 *
 * "Blind" is four separate properties and each one gets its own test, because a
 * single "both work" assertion passes on an implementation where the customer
 * middleware clears the writer's cookie on logout, or where one token type is
 * accepted by the other resolver.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, SEED_PASSWORD } from '../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../../../test/http';
import { SESSION_COOKIE } from '../../../middleware/session';
import { CART_COOKIE, SHOP_SESSION_COOKIE } from './cookies';
import { createCustomer, createCustomerSession } from './customers';
import { signAssertion } from './bridge';

import type { HttpClient } from '../../../test/http';
import type { TestCtx } from '../test/harness';
import type { Assertion } from './bridge';

/*
 * `server/shop/app.ts` reads its bridge secret from `getEnv()`, not from an
 * injectable dep — there is no `AppDeps` seam for it, unlike `catalog` and
 * `deliverMagicLink` before it. Mocking `getEnv()` here is the only way to
 * drive the real exchange route through the full stack (`httpClient`, origin
 * guard, session middleware, cookie jar) rather than through
 * `standaloneShop`, which would give up the very things this file tests.
 *
 * `vi.mock` factories are hoisted above every other top-level statement, so
 * the secret is inlined rather than referenced from a `const` declared below.
 */
vi.mock('../../../env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../env')>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      SHOP_AUTH_BRIDGE_SECRET: 'session-test-bridge-secret-32-chars',
    }),
  };
});

const BRIDGE_SECRET = 'session-test-bridge-secret-32-chars';

function assertionFor(email: string, over: Partial<Assertion> = {}): string {
  const now = Date.now();
  return signAssertion(BRIDGE_SECRET, {
    v: 1,
    sub: '11111111-2222-3333-4444-555555555555',
    email,
    iat: now,
    exp: now + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    ...over,
  });
}

let ctx: TestCtx;
let client: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
});
afterAll(() => ctx.close());

beforeEach(async () => {
  await ctx.db.execute(sql`TRUNCATE shop_customer_sessions, shop_customers CASCADE`);
  // NO explicit mount: `server/shop/app.ts` mounts the cart router and
  // `createApp()` mounts that, so `httpClient` already serves `/api/shop/...`.
  // Mounting a second one would not override it — Hono resolves two routers
  // claiming a path by registration order, not by refusing.
  client = httpClient(ctx.db);
});

/** Log in as the seeded owner, leaving `__Host-studio_session` in the jar. */
async function loginAsWriter(): Promise<void> {
  const res = await client.post('/api/auth/login', {
    email: 'owner@test.local',
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  expect(client.cookies().has(SESSION_COOKIE)).toBe(true);
}

/**
 * A customer session, minted through the real exchange route and planted in
 * the jar.
 *
 * Through the HTTP surface, deliberately, now that there is a real route to
 * drive: a signed assertion stands in for whatever Neon Auth would have
 * verified upstream, and `client.post` carries the resulting `Set-Cookie` into
 * the jar exactly as a browser would.
 */
async function loginAsCustomer(email: string): Promise<{ id: string }> {
  const res = await client.post('/api/shop/customer/session/exchange', {
    assertion: assertionFor(email),
  });
  expect(res.status).toBe(200);
  const body = await json<{ customer: { id: string } }>(res);
  return { id: body.customer.id };
}

describe('the writer session and the customer session do not interfere', () => {
  it('resolves BOTH on a single request carrying both cookies', async () => {
    await loginAsWriter();
    const customer = await loginAsCustomer('shopper@test.local');

    // One jar, two cookies, sent together on every request from here on.
    expect(client.cookies().has(SESSION_COOKIE)).toBe(true);
    expect(client.cookies().has(SHOP_SESSION_COOKIE)).toBe(true);

    const me = await client.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect((await json<{ user: { email: string } }>(me)).user.email).toBe('owner@test.local');

    const shopMe = await client.get('/api/shop/customer/me');
    expect(shopMe.status).toBe(200);
    expect((await json<{ customer: { id: string } }>(shopMe)).customer.id).toBe(customer.id);
  });

  it('a customer token is NOT accepted as a writer session', async () => {
    /*
     * Both ids are hex HMAC-SHA-256 digests under the same SESSION_SECRET, so
     * they are indistinguishable by shape. What keeps them apart is that they
     * are looked up in different tables — if either resolver ever queried a
     * union, or if the two ever shared a table, a customer token would be a
     * writer session and guest checkout would be privilege escalation.
     */
    const customer = await createCustomer(ctx.db, { email: 'shopper@test.local' });
    const session = await createCustomerSession(ctx.db, customer.id);

    const res = await client.get('/api/auth/me', {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(res.status).toBe(401);
  });

  it('a writer token is NOT accepted as a customer session', async () => {
    await loginAsWriter();
    const writerToken = client.cookies().get(SESSION_COOKIE);

    const res = await client.get('/api/shop/customer/me', {
      headers: { cookie: `${SHOP_SESSION_COOKIE}=${writerToken}` },
    });
    expect(res.status).toBe(200);
    expect((await json<{ customer: unknown }>(res)).customer).toBeNull();
  });

  it('customer logout leaves the writer session intact', async () => {
    await loginAsWriter();
    await loginAsCustomer('shopper@test.local');

    const out = await client.post('/api/shop/customer/logout');
    expect(out.status).toBe(200);

    expect(client.cookies().has(SHOP_SESSION_COOKIE)).toBe(false);
    expect(client.cookies().has(SESSION_COOKIE)).toBe(true);
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });

  it('writer logout leaves the customer session intact', async () => {
    await loginAsWriter();
    const customer = await loginAsCustomer('shopper@test.local');

    const out = await client.post('/api/auth/logout');
    expect(out.status).toBe(200);

    expect(client.cookies().has(SESSION_COOKIE)).toBe(false);
    expect(client.cookies().has(SHOP_SESSION_COOKIE)).toBe(true);
    const shopMe = await client.get('/api/shop/customer/me');
    expect((await json<{ customer: { id: string } }>(shopMe)).customer.id).toBe(customer.id);
  });

  it('destroying every customer session leaves the writer session working', async () => {
    await loginAsWriter();
    await loginAsCustomer('shopper@test.local');

    await ctx.db.execute(sql`DELETE FROM shop_customer_sessions`);

    expect((await json<{ customer: unknown }>(await client.get('/api/shop/customer/me'))).customer)
      .toBeNull();
    expect((await client.get('/api/auth/me')).status).toBe(200);
  });

  it('never 401s by itself — an anonymous caller gets `customer: null`, not a refusal', async () => {
    /*
     * The same "who is this" versus "must there be someone" split
     * `server/middleware/session.ts` documents. A shop middleware that 401'd
     * would make guest checkout — contract §7's default path — impossible, and
     * it would make customer logout fail on an expired session, which is the one
     * thing logout exists to prevent.
     */
    const res = await client.get('/api/shop/customer/me');
    expect(res.status).toBe(200);
    expect((await json<{ customer: unknown }>(res)).customer).toBeNull();
  });
});

describe('the customer cookie matches the writer cookie except on SameSite', () => {
  it('is __Host- prefixed, Secure, Path=/ and carries no Domain', async () => {
    /*
     * Copied from `setSessionCookie`, including the reasoning: `__Host-` is
     * enforced by the browser — a cookie whose name starts with it is rejected
     * unless it is Secure, has Path=/ and carries NO Domain. Without that last
     * one, any subdomain (a preview deployment, a marketing site) can set a
     * cookie the app treats as a session, which is fixation with no XSS at all.
     *
     * `SameSite` IS THE ONE ATTRIBUTE THAT NO LONGER MATCHES, and the case below
     * pins the divergence rather than leaving it to be noticed. `__Host-` says
     * nothing about `SameSite`, so every guarantee this case asserts is intact.
     */
    const res = await client.post('/api/shop/customer/session/exchange', {
      assertion: assertionFor('shopper@test.local'),
    });

    const header = res.headers.getSetCookie().find((h) => h.startsWith(SHOP_SESSION_COOKIE));
    expect(header).toBeDefined();
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Path=\//i);
    expect(header).not.toMatch(/Domain=/i);
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE DELIBERATE DIVERGENCE: CUSTOMER `None`, WRITER `Lax`.
   *
   * The storefront is on a different REGISTRABLE DOMAIN from this API, so its
   * requests are cross-SITE and a `Lax` cookie is not sent on them at all — the
   * cart would mint a fresh empty basket on every request, with no error
   * anywhere. `identity/cookies.ts` carries the full argument, including what
   * relying on `originGuard` alone for CSRF costs.
   *
   * The WRITER session is untouched, and that is the point of asserting both
   * here: the admin console is same-origin with its own API and has no reason to
   * give up the defence in depth. A future change that relaxes it too would be a
   * much wider decision than this one, and this case is what makes it deliberate
   * rather than incidental.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('is SameSite=None, while the writer cookie stays Lax', async () => {
    const res = await client.post('/api/shop/customer/session/exchange', {
      assertion: assertionFor('crosssite@test.local'),
    });

    const header = res.headers.getSetCookie().find((h) => h.startsWith(SHOP_SESSION_COOKIE));
    expect(header).toMatch(/SameSite=None/i);
    /* `None` without `Secure` is rejected by the browser outright, so the two
       attributes are one decision rather than two. */
    expect(header).toMatch(/Secure/i);

    const login = await client.post('/api/auth/login', {
      email: 'owner@test.local',
      password: SEED_PASSWORD,
    });
    const writer = login.headers.getSetCookie().find((h) => h.startsWith(SESSION_COOKIE));
    expect(writer, 'the writer cookie must still be set').toBeTruthy();
    expect(writer).toMatch(/SameSite=Lax/i);
  });

  it('uses a DIFFERENT name from the writer cookie, and from the cart cookie', () => {
    // Three distinct names, asserted rather than assumed: two of them colliding
    // would make one middleware silently overwrite the other's value.
    expect(new Set([SESSION_COOKIE, SHOP_SESSION_COOKIE, CART_COOKIE]).size).toBe(3);
    expect(SHOP_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(CART_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('sends the raw token to the browser and stores only its HMAC', async () => {
    const customer = await createCustomer(ctx.db, { email: 'shopper@test.local' });
    const session = await createCustomerSession(ctx.db, customer.id);

    const stored = await ctx.db.execute(sql`SELECT id FROM shop_customer_sessions`);
    expect(stored.rows).toHaveLength(1);
    // Never the raw token: a database dump must not be a set of live sessions.
    expect(String(stored.rows[0].id)).not.toBe(session.token);
    expect(String(stored.rows[0].id)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the customer session expires', () => {
  it('resolves to null once expired, and sweeps the row', async () => {
    const customer = await createCustomer(ctx.db, { email: 'shopper@test.local' });
    const session = await createCustomerSession(ctx.db, customer.id);
    await ctx.db.execute(
      sql`UPDATE shop_customer_sessions SET expires_at = ${Date.now() - 1}`,
    );

    const res = await client.get('/api/shop/customer/me', {
      headers: { cookie: `${SHOP_SESSION_COOKIE}=${session.token}` },
    });
    expect((await json<{ customer: unknown }>(res)).customer).toBeNull();

    const left = await ctx.db.execute(sql`SELECT id FROM shop_customer_sessions`);
    expect(left.rows).toHaveLength(0);
  });
});

describe('the origin guard covers the shop routes too', () => {
  it('refuses a cross-origin POST before any session is resolved', async () => {
    // The shop sub-app mounts UNDER `/api`, so `originGuard` — registered on
    // `/api/*` — already covers it. Asserted because a sub-app mounted at the
    // root instead would have quietly escaped it.
    const res = await client.post('/api/shop/customer/logout', undefined, {
      headers: { origin: 'https://evil.test' },
    });
    expect(res.status).toBe(403);
  });

  it('still allows the allow-listed origin', async () => {
    const res = await client.post('/api/shop/customer/logout', undefined, {
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.status).toBe(200);
  });
});
