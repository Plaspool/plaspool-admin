import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { SEED_PASSWORD, freshDb } from '../../test/harness';
import { httpClient } from '../../test/http';
import type { TestCtx } from '../../test/harness';
import type { HttpClient } from '../../test/http';
import type { AuthUser } from '../../../shared/types';
import { createCustomer, createCustomerSession } from '../cart/identity/customers';
import { SHOP_SESSION_COOKIE } from '../cart/identity/cookies';
import { givePurchase } from './test/purchases';

/**
 * THE PURCHASE GATE, driven over real HTTP through the REAL composition root
 * (brief §2–§5).
 *
 * NOT A TEST APP. `httpClient` builds `server/index.ts`'s `createApp()`, which
 * is the only place `resolveShopCustomer` is wired into the reviews routes. A
 * suite that registered its own resolver would pass with the composition root
 * broken — the exact failure CLAUDE.md §2 records twice, once for orders and
 * once for the webhook. Everything here goes through the wiring that ships.
 */

let ctx: TestCtx;
let owner: HttpClient;
let anon: HttpClient;

const SUBMIT = '/api/shop/reviews/submit';
const ADMIN = '/api/shop/reviews';
const ELIGIBILITY = '/api/shop/reviews/eligibility';
const PUBLIC_LIST = '/api/public/reviews';

async function login(user: AuthUser): Promise<HttpClient> {
  const client = httpClient(ctx.db);
  const res = await client.post('/api/auth/login', { email: user.email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return client;
}

let ips = 0;
function headersFor(cookie?: string): { headers: Record<string, string> } {
  ips += 1;
  const headers: Record<string, string> = { 'x-real-ip': `198.51.100.${(ips % 250) + 1}` };
  if (cookie) headers.cookie = cookie;
  return { headers };
}

let accounts = 0;
async function customer(email?: string): Promise<{ id: string; email: string; cookie: string }> {
  accounts += 1;
  const address = email ?? `shopper-${accounts}@example.com`;
  const row = await createCustomer(ctx.db, { email: address, displayName: null });
  const session = await createCustomerSession(ctx.db, row.id);
  return { id: row.id, email: address, cookie: `${SHOP_SESSION_COOKIE}=${session.token}` };
}

function body(over: Record<string, unknown> = {}) {
  return {
    productSlug: 'gate-product',
    rating: 5,
    body: 'Genuinely good, arrived quickly and works exactly as described.',
    authorName: 'Buyer',
    ...over,
  };
}

beforeAll(async () => {
  ctx = await freshDb();
  owner = await login(ctx.users.owner);
  anon = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

describe('submitting a review requires having bought the product', () => {
  it('REFUSES a signed-in customer who has bought nothing, and says why', async () => {
    const shopper = await customer();
    const res = await anon.post(SUBMIT, body({ productSlug: 'never-bought' }), headersFor(shopper.cookie));

    expect(res.status).toBe(403);
    /*
     * The `reason` is the whole point of the refusal. Without it the storefront
     * cannot tell this from "sign in" and falls through to generic copy, which
     * is the outcome the feature exists to prevent — somebody typing six
     * paragraphs and being told only that something went wrong.
     *
     * `toMatchObject` rather than `toEqual` because every error body also
     * carries the `requestId` that ties it to its log line.
     */
    expect(await res.json()).toMatchObject({ error: 'forbidden', reason: 'purchase_required' });
  });

  it('still 401s with no session at all — the session gate comes FIRST', async () => {
    /* Ordering matters: a 403 here would tell an anonymous caller that the
       product exists and that they merely have not bought it. */
    const res = await anon.post(SUBMIT, body(), headersFor());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('ACCEPTS a buyer, and records the order that proved it', async () => {
    const shopper = await customer();
    const purchase = await givePurchase(ctx.db, { slug: 'gate-product', customerId: shopper.id });

    const res = await anon.post(SUBMIT, body(), headersFor(shopper.cookie));
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };

    const read = await ctx.db.execute(sql`
      SELECT order_id, customer_id FROM shop_reviews WHERE id = ${reviewId}`);
    /* The proof is STORED, not merely checked — so "prove this reviewer bought
       it" is answerable later without re-running a query against orders that
       have since moved. */
    expect(String(read.rows[0]!.order_id)).toBe(purchase.orderId);
    expect(String(read.rows[0]!.customer_id)).toBe(shopper.id);
  });

  it('counts a GUEST order matched by email, which is the common real case', async () => {
    /*
     * `shop_orders.customer_id` is NULL for a guest checkout and guest checkout
     * is the DEFAULT path through this shop. An account-only rule would tell
     * most real buyers they had never bought anything.
     */
    const shopper = await customer('guest-buyer@example.com');
    await givePurchase(ctx.db, {
      slug: 'guest-bought',
      customerId: null,
      email: 'guest-buyer@example.com',
    });

    const res = await anon.post(
      SUBMIT,
      body({ productSlug: 'guest-bought' }),
      headersFor(shopper.cookie),
    );
    expect(res.status).toBe(201);
  });

  it('matches that email case-INSENSITIVELY', async () => {
    /* Checkout takes the address somebody types and sign-up takes the address
       they type on another day. One mailbox, two capitalisations. */
    const shopper = await customer('mixed-case@example.com');
    await givePurchase(ctx.db, {
      slug: 'case-folded',
      customerId: null,
      email: 'Mixed-Case@Example.COM',
    });

    const res = await anon.post(
      SUBMIT,
      body({ productSlug: 'case-folded' }),
      headersFor(shopper.cookie),
    );
    expect(res.status).toBe(201);
  });

  it('counts a REFUNDED order and refuses a pending or cancelled one', async () => {
    const refunded = await customer();
    await givePurchase(ctx.db, {
      slug: 'refunded-item',
      customerId: refunded.id,
      status: 'refunded',
    });
    /*
     * The rule that reads wrong for a second and is right on reflection: the
     * customer received the product and formed an opinion, and the refund is
     * often the very thing they have something to say about.
     */
    expect(
      (
        await anon.post(
          SUBMIT,
          body({ productSlug: 'refunded-item' }),
          headersFor(refunded.cookie),
        )
      ).status,
    ).toBe(201);

    for (const status of ['pending', 'cancelled']) {
      const shopper = await customer();
      await givePurchase(ctx.db, { slug: `unpaid-${status}`, customerId: shopper.id, status });
      const res = await anon.post(
        SUBMIT,
        body({ productSlug: `unpaid-${status}` }),
        headersFor(shopper.cookie),
      );
      expect(res.status, `${status} must not count as a purchase`).toBe(403);
    }
  });

  it('accepts ANY variant of the product, not the one SKU that was bought', async () => {
    const shopper = await customer();
    /* Two variants of one product; the order contains the second. Buying the
       5kg tub earns the right to review the product, not that SKU. */
    const first = await givePurchase(ctx.db, { slug: 'many-variants', customerId: shopper.id });
    await givePurchase(ctx.db, {
      slug: 'many-variants',
      customerId: shopper.id,
      productId: first.productId,
    });

    const res = await anon.post(
      SUBMIT,
      body({ productSlug: 'many-variants' }),
      headersFor(shopper.cookie),
    );
    expect(res.status).toBe(201);
  });

  it('refuses a SECOND review of the same product, with its own reason', async () => {
    const shopper = await customer();
    await givePurchase(ctx.db, { slug: 'reviewed-twice', customerId: shopper.id });

    const first = await anon.post(
      SUBMIT,
      body({ productSlug: 'reviewed-twice' }),
      headersFor(shopper.cookie),
    );
    expect(first.status).toBe(201);

    const second = await anon.post(
      SUBMIT,
      body({ productSlug: 'reviewed-twice' }),
      headersFor(shopper.cookie),
    );
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: 'forbidden', reason: 'already_reviewed' });
  });
});

describe('the eligibility read', () => {
  it('answers for EVERY requested slug, bought or not', async () => {
    const shopper = await customer();
    await givePurchase(ctx.db, { slug: 'owned-one', customerId: shopper.id });

    const res = await anon.get(`${ELIGIBILITY}?products=owned-one,not-owned`, headersFor(shopper.cookie));
    expect(res.status).toBe(200);
    /* An omission would make every caller write the same "missing means false"
       branch the aggregates route already spared them. */
    expect(await res.json()).toEqual({
      eligible: {
        'owned-one': { canReview: true, hasReviewed: false },
        'not-owned': { canReview: false, hasReviewed: false },
      },
    });
  });

  it('flips hasReviewed once they have written one — while it is still PENDING', async () => {
    const shopper = await customer();
    await givePurchase(ctx.db, { slug: 'pending-review', customerId: shopper.id });
    await anon.post(SUBMIT, body({ productSlug: 'pending-review' }), headersFor(shopper.cookie));

    const res = await anon.get(`${ELIGIBILITY}?products=pending-review`, headersFor(shopper.cookie));
    const { eligible } = (await res.json()) as Record<string, Record<string, unknown>>;
    /* Pending counts, because the point of the field is to stop the page
       offering a form whose submission would be refused as a duplicate. */
    expect(eligible['pending-review']).toEqual({ canReview: true, hasReviewed: true });
  });

  it('answers an EMPTY object with no session, rather than refusing', async () => {
    /* A logged-out shopper reading a product page is not an error. The
       storefront renders the sign-in prompt; it does not handle a 401 on a
       read it makes on every page load. */
    const res = await anon.get(`${ELIGIBILITY}?products=anything`, headersFor());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: {} });
  });

  it('bounds the list and names a malformed slug rather than truncating', async () => {
    const shopper = await customer();
    const many = Array.from({ length: 61 }, (_, i) => `slug-${i}`).join(',');
    expect((await anon.get(`${ELIGIBILITY}?products=${many}`, headersFor(shopper.cookie))).status).toBe(400);
    expect((await anon.get(`${ELIGIBILITY}?products=`, headersFor(shopper.cookie))).status).toBe(400);
    expect(
      (await anon.get(`${ELIGIBILITY}?products=Bad_Slug`, headersFor(shopper.cookie))).status,
    ).toBe(400);
  });

  it('is NOT on the cacheable public router — it must never carry a shared cache header', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE T6 ASSERTION, and it is a HEADER assertion on purpose.
     *
     * The public reviews router answers with `Cache-Control: public` from above
     * `sessionMiddleware`, so a shared cache may hand one reader's copy to
     * another. This response is per-viewer. If a later change moved this route
     * onto that router — a one-line change that looks like saving a round trip
     * — this is what fails, and nothing about the BEHAVIOUR would have.
     * CLAUDE.md §2: tests for cache and CORS assert on headers, not behaviour.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const shopper = await customer();
    const res = await anon.get(`${ELIGIBILITY}?products=anything`, headersFor(shopper.cookie));
    expect(res.headers.get('cache-control') ?? '').not.toContain('public');
  });
});

describe('replies and reactions are gated by the REVIEWED product', () => {
  /** An approved review of `slug`, written by somebody who bought it. */
  async function approvedReview(slug: string): Promise<string> {
    const author = await customer();
    await givePurchase(ctx.db, { slug, customerId: author.id });
    const res = await anon.post(SUBMIT, body({ productSlug: slug }), headersFor(author.cookie));
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };
    expect((await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' })).status).toBe(200);
    return reviewId;
  }

  it('refuses a reply from somebody who has not bought the reviewed product', async () => {
    const reviewId = await approvedReview('reply-gated');
    const stranger = await customer();

    const res = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { body: 'I have opinions about a product I never bought.', authorName: 'Stranger' },
      headersFor(stranger.cookie),
    );
    expect(res.status).toBe(403);
    /* `toMatchObject`, not `toEqual`: every error body also carries the
     `requestId` that ties it to the log line. */
    expect(await res.json()).toMatchObject({ error: 'forbidden', reason: 'purchase_required' });
  });

  it('lets ANOTHER buyer of the same product reply', async () => {
    const reviewId = await approvedReview('reply-allowed');
    const buyer = await customer();
    await givePurchase(ctx.db, { slug: 'reply-allowed', customerId: buyer.id });

    const res = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { body: 'Agreed — mine arrived in the same condition.', authorName: 'Second Buyer' },
      headersFor(buyer.cookie),
    );
    expect(res.status).toBe(201);
  });

  it('does NOT let a purchase of one product unlock reviews of another', async () => {
    /* The gate is judged against the product the REVIEW is about, never against
       anything the caller sends — otherwise one purchase unlocks the shop. */
    const reviewId = await approvedReview('product-a');
    const buyer = await customer();
    await givePurchase(ctx.db, { slug: 'product-b', customerId: buyer.id });

    const res = await anon.post(
      `${ADMIN}/${reviewId}/replies`,
      { body: 'My purchase of an unrelated product entitles me to this.', authorName: 'B' },
      headersFor(buyer.cookie),
    );
    expect(res.status).toBe(403);
  });

  it('gates the helpful vote, and gates CLEARING it too', async () => {
    const reviewId = await approvedReview('reaction-gated');
    const stranger = await customer();

    const set = await anon.put(
      `${ADMIN}/${reviewId}/reactions`,
      { kind: 'helpful' },
      headersFor(stranger.cookie),
    );
    expect(set.status).toBe(403);

    /*
     * CLEARING IS GATED TOO. A button that works in one direction reads as a
     * bug from the outside, and an ineligible caller has no vote to clear
     * anyway — so the asymmetry would buy nothing and cost a bug report.
     */
    const clear = await anon.put(
      `${ADMIN}/${reviewId}/reactions`,
      { kind: null },
      headersFor(stranger.cookie),
    );
    expect(clear.status).toBe(403);
  });

  it('lets a buyer vote, and counts it', async () => {
    const reviewId = await approvedReview('reaction-allowed');
    const buyer = await customer();
    await givePurchase(ctx.db, { slug: 'reaction-allowed', customerId: buyer.id });

    const res = await anon.put(
      `${ADMIN}/${reviewId}/reactions`,
      { kind: 'helpful' },
      headersFor(buyer.cookie),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ viewerReaction: 'helpful', helpfulCount: 1 });
  });

  it('answers 404, not 403, for a review that does not exist', async () => {
    /* "Gone" is the honest answer, and a 403 would confirm the id was real to
       somebody who is not allowed to know. */
    const stranger = await customer();
    const res = await anon.post(
      `${ADMIN}/rev_nope/replies`,
      { body: 'Into the void goes this reply.', authorName: 'Nobody' },
      headersFor(stranger.cookie),
    );
    expect(res.status).toBe(404);
  });
});

describe('the verified badge', () => {
  it('is TRUE on a gated review and FALSE on one written before the gate', async () => {
    const shopper = await customer();
    await givePurchase(ctx.db, { slug: 'badged', customerId: shopper.id });
    const res = await anon.post(SUBMIT, body({ productSlug: 'badged' }), headersFor(shopper.cookie));
    const { reviewId } = (await res.json()) as { reviewId: string };
    await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' });

    /* A legacy row: approved, but no order ever proved it. This is what three
       of the reviews in production look like. */
    await ctx.db.execute(sql`
      INSERT INTO shop_reviews
        (id, product_slug, rating, body, author_name, author_email, status,
         sentiment_label, sentiment_score, created_at, updated_at)
      VALUES ('rev_legacy0000001', 'badged', 4, 'Written before any of this existed.',
              'Old Timer', 'old@example.com', 'approved', 'positive', 1,
              ${1_600_000_000_000}, ${1_600_000_000_000})`);

    const list = await anon.get(`${PUBLIC_LIST}?product=badged`);
    const { items } = (await list.json()) as Record<string, unknown>[] &
      { items: Record<string, unknown>[] };
    const byId = new Map(items.map((r) => [String(r.id), r]));

    expect(byId.get(reviewId)!.verifiedPurchase).toBe(true);
    expect(byId.get('rev_legacy0000001')!.verifiedPurchase).toBe(false);
    /* The BOOLEAN, never the evidence: which order somebody placed is nobody
       else's business, and this is the cacheable public read. */
    expect('orderId' in byId.get(reviewId)!).toBe(false);
    expect('order_id' in byId.get(reviewId)!).toBe(false);
  });
});

describe('approving a review tells its author, through the REAL wiring', () => {
  const intentsFor = async (reviewId: string) => {
    const res = await ctx.db.execute(sql`
      SELECT to_email, kind FROM shop_order_email_intents
       WHERE dedupe_key = ${`review_approved:${reviewId}`}`);
    return res.rows;
  };

  /** Submit as a buyer and return the id plus the address it was written under. */
  async function pending(slug: string): Promise<{ reviewId: string; email: string }> {
    const shopper = await customer();
    await givePurchase(ctx.db, { slug, customerId: shopper.id });
    const res = await anon.post(SUBMIT, body({ productSlug: slug }), headersFor(shopper.cookie));
    expect(res.status).toBe(201);
    const { reviewId } = (await res.json()) as { reviewId: string };
    return { reviewId, email: shopper.email };
  }

  it('queues the message on the edge into approved, addressed to the reviewer', async () => {
    const { reviewId, email } = await pending('approval-mail');
    /* Nothing owed while it is still pending — the message is about being
       published, and a pending review is not. */
    expect(await intentsFor(reviewId)).toHaveLength(0);

    expect((await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' })).status).toBe(200);

    const rows = await intentsFor(reviewId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.to_email)).toBe(email);
    expect(String(rows[0]!.kind)).toBe('review_approved');
  });

  it('does NOT send again when a moderator flips the status back and forth', async () => {
    const { reviewId } = await pending('approval-twice');
    await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' });
    await owner.patch(`${ADMIN}/${reviewId}`, { status: 'pending' });
    await owner.patch(`${ADMIN}/${reviewId}`, { status: 'approved' });

    /* Somebody making up their mind is not three pieces of news. */
    expect(await intentsFor(reviewId)).toHaveLength(1);
  });

  it('sends nothing for a rejection, and nothing for a legacy review with no order', async () => {
    const { reviewId } = await pending('approval-rejected');
    await owner.patch(`${ADMIN}/${reviewId}`, { status: 'rejected' });
    expect(await intentsFor(reviewId)).toHaveLength(0);

    /*
     * A review written before the purchase gate has a NULL `order_id`, and the
     * outbox this rides requires one. Approving it must still WORK — a hole in
     * the mail is not a reason to refuse a moderator — it just mails nobody.
     * Migration 0640's header records this rather than leaving it to be
     * rediscovered.
     */
    await ctx.db.execute(sql`
      INSERT INTO shop_reviews
        (id, product_slug, rating, body, author_name, author_email, status,
         sentiment_label, sentiment_score, created_at, updated_at)
      VALUES ('rev_legacy0000002', 'approval-legacy', 5, 'From before any of this existed.',
              'Old Timer', 'old-timer@example.com', 'pending', 'positive', 1,
              ${1_600_000_000_000}, ${1_600_000_000_000})`);

    const res = await owner.patch(`${ADMIN}/rev_legacy0000002`, { status: 'approved' });
    expect(res.status).toBe(200);
    expect(await intentsFor('rev_legacy0000002')).toHaveLength(0);
  });
});
