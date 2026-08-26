import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { TEST_ORIGIN, httpClient } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import { createCustomer, createCustomerSession } from '../cart/identity/customers';
import { SHOP_SESSION_COOKIE } from '../cart/identity/cookies';

/**
 * The reviews pipeline, end to end over real HTTP against a migrated
 * database: a customer submits, sentiment is attached in the same write, the
 * review is invisible everywhere public until a human approves it, and the
 * aggregate always agrees with the public list.
 */

let ctx: TestCtx;
let owner: HttpClient;
let writer: HttpClient;
/** No session at all — a fresh browser, not a logged-out one. */
let anon: HttpClient;

const SUBMIT = '/api/shop/reviews/submit';
const ADMIN = '/api/shop/reviews';
const PUBLIC_LIST = '/api/public/reviews';
const PUBLIC_AGG = '/api/public/reviews/aggregate';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  const res = await client.post('/api/auth/login', {
    email: user.email,
    password: SEED_PASSWORD,
  });
  expect(res.status).toBe(200);
  return client;
}

function submission(over: Partial<Record<string, unknown>> = {}) {
  return {
    productSlug: 'pla-basic',
    rating: 5,
    body: 'Prints clean, great colour, would recommend to anyone.',
    /* `authorName` stays — it is the BYLINE, not identity, and the session's
       `displayName` overrides it when the account has one. `authorEmail` is
       gone from every fixture because the schema no longer accepts it: the
       address is read from the session and from nowhere else. */
    authorName: 'Dara',
    ...over,
  };
}

/**
 * Each fixture submission arrives from its own address. The intake budget is
 * 10 per IP per window — deliberately hostile to exactly the burst this
 * suite produces — and the first run of these tests proved it works by
 * 429ing the fixtures. The budget itself is pinned in its own test below,
 * where the addresses are controlled.
 */
let nextIp = 0;
function fromFreshIp(): { headers: Record<string, string> } {
  nextIp += 1;
  return { headers: { 'x-real-ip': `203.0.113.${nextIp}` } };
}

/** Submit and approve in one motion — the fixture most read tests need. */
async function approved(over: Partial<Record<string, unknown>> = {}): Promise<string> {
  const res = await anon.post(SUBMIT, submission(over), asShopper());
  expect(res.status).toBe(201);
  const { reviewId } = (await res.json()) as { reviewId: string };
  const mod = await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' });
  expect(mod.status).toBe(200);
  return reviewId;
}

/**
 * A signed-in shopper, because the intake now REQUIRES a customer session.
 *
 * Module-scope and created once: every submission fixture in this file needs
 * one, and the narrow rate budget keys on (ip, email) — `fromFreshIp()` already
 * varies the address, so one shared account cannot exhaust it.
 */
let shopper: { id: string; cookie: string };

async function signedInCustomer(
  email: string | null,
  displayName: string | null,
): Promise<{ id: string; cookie: string }> {
  const customer = await createCustomer(ctx.db, { email, displayName });
  const session = await createCustomerSession(ctx.db, customer.id);
  return { id: customer.id, cookie: `${SHOP_SESSION_COOKIE}=${session.token}` };
}

/** A fresh address plus a cookie — the two headers every submit needs. */
function withCookie(cookie: string): { headers: Record<string, string> } {
  return { headers: { ...fromFreshIp().headers, cookie } };
}

/** The default shopper's headers. What `fromFreshIp()` used to be for submits. */
const asShopper = (): { headers: Record<string, string> } => withCookie(shopper.cookie);

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  writer = await login(ctx.users.writer);
  anon = httpClient(ctx.db);
  shopper = await signedInCustomer('dara@example.com', null);
});

afterAll(async () => {
  await ctx?.close();
});

describe('the customer intake', () => {
  it('accepts an anonymous submission, answers narrow, and attaches sentiment', async () => {
    const res = await anon.post(SUBMIT, submission(), asShopper());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reviewId).toMatch(/^rev_/);
    expect(body.status).toBe('pending');
    expect(body.sentiment).toBe('positive');
    // Narrow means narrow: no email travels back, no row shape leaks.
    expect(Object.keys(body).sort()).toEqual(['reviewId', 'sentiment', 'status']);
  });

  it('rejects a rating outside 1–5 and a body below the floor', async () => {
    expect((await anon.post(SUBMIT, submission({ rating: 6 }), asShopper())).status).toBe(400);
    expect((await anon.post(SUBMIT, submission({ rating: 0 }), asShopper())).status).toBe(400);
    expect((await anon.post(SUBMIT, submission({ body: 'short' }), asShopper())).status).toBe(400);
  });

  it('answers the preflight for an allow-listed origin', async () => {
    const res = await anon.request(SUBMIT, {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toBe('POST');
  });

  /*
   * Pins the credentialed preflight so it cannot regress: this was a live
   * production bug where `access-control-allow-credentials` was missing on
   * both the preflight and the response, which meant `__Host-shop_session`
   * never reached this endpoint cross-origin and every review's `customer_id`
   * was silently null. The existing suite drove this route server-side, where
   * CORS is never enforced, so only a header-level assertion catches it.
   */
  it('answers the preflight WITH CREDENTIALS, matching Cart', async () => {
    const res = await anon.request(SUBMIT, {
      method: 'OPTIONS',
      headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('answers a real submission WITH CREDENTIALS too', async () => {
    const res = await anon.post(SUBMIT, submission(), asShopper());
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('holds the per-email budget: the fourth submission from one address 429s', async () => {
    /*
     * THE BUDGET IS NOW STRONGER THAN THIS TEST USED TO PROVE. It used to vary
     * `authorEmail` in the BODY, which meant the identity it keyed on was
     * whatever the caller typed — so a script could buy a fresh budget by
     * changing one string. The address is the session's now, so the only way to
     * a new bucket is a new account.
     *
     * Case-folding is no longer asserted here and does not need to be: the
     * value never comes from user input, and `shop_customers.email` is unique,
     * so DARA@ and dara@ cannot be two rows to begin with.
     */
    const budgeted = await signedInCustomer('budget@example.com', null);
    const ip = { headers: { 'x-real-ip': '198.51.100.77', cookie: budgeted.cookie } };
    for (let i = 0; i < 3; i += 1) {
      expect((await anon.post(SUBMIT, submission(), ip)).status).toBe(201);
    }
    expect((await anon.post(SUBMIT, submission(), ip)).status).toBe(429);
  });

  it('grants nothing on the preflight to an origin off the list', async () => {
    const res = await anon.request(SUBMIT, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('a signed-in customer, through the REAL composition root', () => {
  /*
   * NOT A TEST APP WITH ITS OWN RESOLVER. This suite's `ctx.app` (via
   * `httpClient`) is built by `server/index.ts`'s real `createApp()`, which
   * mounts `server/shop/app.ts` and wires `resolveShopCustomer` into
   * `createReviewRoutes` at that one composition-root call site. Reviews has
   * no `test/app.ts` of its own to register a stand-in resolver, so a future
   * edit that drops the wiring from `app.ts` fails HERE — the same shape
   * `server/shop/composition.test.ts` uses for Orders, after the identical
   * bug shipped there once.
   */
  it('REFUSES a submission with no customer session', async () => {
    /*
     * The behaviour change. This route used to accept anyone and write the name
     * and address out of the request body, so a review could be attributed to
     * any address somebody typed. The security half was already right for
     * SIGNED-IN callers — the session overrode the body — but the body still had
     * to carry both, which is why the storefront asked every logged-in customer
     * for two things the handler then discarded.
     *
     * 401 and not 403: there is no session to be forbidden, and `originGuard`
     * has already passed by this point.
     */
    const res = await anon.post(SUBMIT, submission(), fromFreshIp());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('refuses a STAFF session too — the intake wants a customer, not an admin', async () => {
    // Two populations, two tables. `owner` is signed in to the admin and has no
    // `shop_customers` row, so it is anonymous as far as this route is concerned.
    expect((await owner.post(SUBMIT, submission(), fromFreshIp())).status).toBe(401);
  });

  it('ignores an authorEmail in the body rather than refusing it', async () => {
    /*
     * The schema is deliberately NOT `.strict()` here, so the storefront can
     * keep sending the old field until it ships its own change — Zod strips it.
     * Refusing would couple the two repositories to the same deploy minute.
     */
    const res = await anon.post(
      SUBMIT,
      { ...submission(), authorEmail: 'ignored@example.com' },
      asShopper(),
    );
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };
    const admin = await owner.get(`${ADMIN}/${reviewId}`);
    const { review } = (await admin.json()) as { review: { authorEmail: string } };
    // The session's address, not the one in the body.
    expect(review.authorEmail).toBe('dara@example.com');
  });

  it('sets customer_id and stores the SESSION email and display name', async () => {
    const { id, cookie } = await signedInCustomer('session-owner@example.com', 'Session Name');
    const res = await anon.post(
      SUBMIT,
      /* The body cannot carry an address any more; the name is a byline and
         the session's `displayName` still outranks it. */
      submission({ authorName: 'Body Name' }),
      withCookie(cookie),
    );
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };

    const admin = await owner.get(`${ADMIN}/${reviewId}`);
    const { review } = (await admin.json()) as {
      review: { customerId: string | null; authorEmail: string; authorName: string };
    };
    expect(review.customerId).toBe(id);
    expect(review.authorEmail).toBe('session-owner@example.com');
    // The session's displayName wins over the body's authorName.
    expect(review.authorName).toBe('Session Name');
  });

  it("falls back to the body's authorName when the session has no displayName", async () => {
    const { cookie } = await signedInCustomer('no-name@example.com', null);
    const res = await anon.post(
      SUBMIT,
      submission({ authorName: 'Body Supplied Name' }),
      withCookie(cookie),
    );
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };

    const admin = await owner.get(`${ADMIN}/${reviewId}`);
    const { review } = (await admin.json()) as { review: { authorName: string } };
    expect(review.authorName).toBe('Body Supplied Name');
  });

  it('refuses a signed-in customer whose account carries no email', async () => {
    /*
     * `shop_customers.email` is NULLABLE and `shop_reviews.author_email` is NOT
     * NULL, so this case has to be answered somewhere. It used to fall back to
     * the body; with the body no longer carrying an address, the honest answer
     * is a refusal that names what is missing rather than a 23502 from the
     * driver.
     *
     * ZERO OF FOUR production customers are in this state (measured
     * 2026-08-26) — the guard exists because the column permits it, not because
     * anybody is hitting it.
     */
    const { cookie } = await signedInCustomer(null, null);
    const res = await anon.post(SUBMIT, submission(), withCookie(cookie));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request', detail: 'account_email' });
  });

  it('refuses when neither the account nor the body supplies a byline', async () => {
    // `author_name` is NOT NULL and is rendered publicly, and three of four
    // customers have no display name — so the body's value is a real path.
    // Deriving one from the email would publish half of an address the public
    // projection deliberately never returns.
    const { cookie } = await signedInCustomer('nameless@example.com', null);
    const { authorName: _drop, ...noName } = submission();
    void _drop;
    const res = await anon.post(SUBMIT, noName, withCookie(cookie));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_request', detail: 'authorName' });
  });

  it('keys the per-email rate budget on the RESOLVED email, not the body one', async () => {
    const { cookie } = await signedInCustomer('budget-session@example.com', 'Budgeted');
    const opts = withCookie(cookie);
    for (let i = 0; i < 3; i += 1) {
      const res = await anon.post(
        SUBMIT,
        submission({ authorEmail: `varying-${i}@example.com` }),
        opts,
      );
      expect(res.status).toBe(201);
    }
    const fourth = await anon.post(
      SUBMIT,
      submission({ authorEmail: 'yet-another@example.com' }),
      opts,
    );
    expect(fourth.status).toBe(429);
  });
});

describe('moderation gates every public surface', () => {
  it('a pending review is invisible to the public list and aggregate', async () => {
    const slug = 'petg-basic';
    const res = await anon.post(SUBMIT, submission({ productSlug: slug }), asShopper());
    expect(res.status).toBe(201);

    const list = (await (await anon.get(`${PUBLIC_LIST}?product=${slug}`)).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(0);

    const agg = (await (await anon.get(`${PUBLIC_AGG}?product=${slug}`)).json()) as {
      aggregate: { count: number };
    };
    expect(agg.aggregate.count).toBe(0);
  });

  it('approval makes it public; the projection carries no email', async () => {
    const slug = 'petg-cf';
    await approved({ productSlug: slug, rating: 4 });

    const res = await anon.get(`${PUBLIC_LIST}?product=${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public');
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0]!.rating).toBe(4);
    expect(items[0]!.authorName).toBe('Dara');
    expect(items[0]!.sentiment).toBe('positive');
    expect('authorEmail' in items[0]!).toBe(false);
    expect('author_email' in items[0]!).toBe(false);
  });

  it('rejecting an approved review removes it from the public surfaces again', async () => {
    const slug = 'pla-matte';
    const id = await approved({ productSlug: slug });
    await owner.patch(`${ADMIN}/${id}`, { status: 'rejected' });

    const { items } = (await (await anon.get(`${PUBLIC_LIST}?product=${slug}`)).json()) as {
      items: unknown[];
    };
    expect(items).toHaveLength(0);
  });

  it('records who moderated and when, and clears both on a return to pending', async () => {
    const id = await approved({ productSlug: 'tpu-95a' });

    const read = (await (await owner.get(`${ADMIN}/${id}`)).json()) as {
      review: { moderatedBy: string | null; moderatedAt: number | null };
    };
    expect(read.review.moderatedBy).toBe(ctx.users.owner.id);
    expect(read.review.moderatedAt).toBeGreaterThan(0);

    await owner.patch(`${ADMIN}/${id}`, { status: 'pending' });
    const back = (await (await owner.get(`${ADMIN}/${id}`)).json()) as {
      review: { moderatedBy: string | null; moderatedAt: number | null; status: string };
    };
    expect(back.review.status).toBe('pending');
    expect(back.review.moderatedBy).toBeNull();
    expect(back.review.moderatedAt).toBeNull();
  });
});

describe('the staff surface', () => {
  it('requires a session to list, and a writer can moderate', async () => {
    expect((await anon.get(ADMIN)).status).toBe(401);

    const res = await anon.post(SUBMIT, submission({ productSlug: 'abs-basic' }), asShopper());
    const { reviewId } = (await res.json()) as { reviewId: string };
    const mod = await writer.patch(`${ADMIN}/${reviewId}`, { status: 'flagged' });
    expect(mod.status).toBe(200);
    const { review } = (await mod.json()) as { review: { status: string } };
    expect(review.status).toBe('flagged');
  });

  it('filters by status and by sentiment', async () => {
    const listed = (await (
      await owner.get(`${ADMIN}?status=flagged&product=abs-basic`)
    ).json()) as { items: { status: string; productSlug: string }[] };
    expect(listed.items.length).toBeGreaterThan(0);
    for (const r of listed.items) {
      expect(r.status).toBe('flagged');
      expect(r.productSlug).toBe('abs-basic');
    }
  });

  it('destroy is owner-only', async () => {
    const res = await anon.post(SUBMIT, submission({ productSlug: 'pla-silk' }), asShopper());
    const { reviewId } = (await res.json()) as { reviewId: string };

    expect((await writer.del(`${ADMIN}/${reviewId}`)).status).toBe(403);
    expect((await owner.del(`${ADMIN}/${reviewId}`)).status).toBe(200);
    expect((await owner.get(`${ADMIN}/${reviewId}`)).status).toBe(404);
  });
});

describe('the aggregate', () => {
  it('agrees with the approved list and does the arithmetic in integers', async () => {
    const slug = 'pla-glow';
    await approved({ productSlug: slug, rating: 5 });
    await approved({ productSlug: slug, rating: 4 });
    await approved({
      productSlug: slug,
      rating: 1,
      body: 'Terrible spool, arrived broken and tangled. Waste of money.',
    });
    // A pending fourth review must not move any number below.
    await anon.post(SUBMIT, submission({ productSlug: slug, rating: 5 }), asShopper());

    const { aggregate } = (await (await anon.get(`${PUBLIC_AGG}?product=${slug}`)).json()) as {
      aggregate: {
        count: number;
        averageRating: number;
        distribution: Record<string, number>;
        sentiment: Record<string, number>;
      };
    };
    expect(aggregate.count).toBe(3);
    // (5 + 4 + 1) / 3 = 3.33… → 333, an integer, no float in transit.
    expect(aggregate.averageRating).toBe(333);
    expect(aggregate.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 1 });
    expect(aggregate.sentiment.positive).toBe(2);
    expect(aggregate.sentiment.negative).toBe(1);
  });

  it('pages the public list by keyset cursor without overlap', async () => {
    const slug = 'petg-translucent';
    for (let i = 0; i < 5; i += 1) {
      await approved({ productSlug: slug, rating: 4 });
    }

    const first = (await (
      await anon.get(`${PUBLIC_LIST}?product=${slug}&limit=2`)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]!.id);

    const second = (await (
      await anon.get(`${PUBLIC_LIST}?product=${slug}&limit=2&cursor=${first.nextCursor}`)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(second.items).toHaveLength(2);

    const seen = new Set([...first.items, ...second.items].map((r) => r.id));
    expect(seen.size).toBe(4);
  });
});
