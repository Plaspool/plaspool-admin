import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestCtx } from '../../test/harness';
import { httpClient, json, type HttpClient } from '../../test/http';
import { createReview, moderateReview, productAggregates } from './repo';
import type { ProductAggregate } from './repo';

/**
 * Bulk review aggregates (issue #12).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREE PROPERTIES THAT MATTER, AND WHY.
 *
 *   1. **Every requested slug comes back**, including ones with no approved
 *      reviews. A `GROUP BY` only emits rows for slugs that HAVE reviews, so
 *      the zeroes are filled in deliberately — an omission would make every
 *      caller write the same "missing means empty" branch, and the one that
 *      forgets renders a blank where a card should say "no reviews yet".
 *
 *   2. **No product gets another's numbers.** `= ANY` returns every matching
 *      row in one result set, so a wrong `GROUP BY` hands one product another's
 *      rating. One product cannot detect that; two with different ratings can.
 *
 *   3. **It agrees with the singular route.** A card and the product page it
 *      links to must not show different star counts, and they are computed by
 *      two different queries.
 * ═══════════════════════════════════════════════════════════════════════════
 */

let ctx: TestCtx;
let http: HttpClient;

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * A FIXED CLOCK, passed in rather than read inside.
 *
 * `createReview` and `moderateReview` both take `now` as a parameter — the
 * codebase's one-clock-reading rule — so a test that let them read the real one
 * would be a test whose fixtures move while it runs. Nothing here asserts on a
 * timestamp, but the ids are time-prefixed and double as the pagination cursor.
 */
const NOW = 1_787_000_000_000;

/** An approved review, which is the only kind any public read counts. */
async function approved(productSlug: string, rating: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const review = await createReview(ctx.db, {
    productSlug,
    rating,
    title: null,
    body: 'A perfectly ordinary spool of filament, delivered on time.',
    authorName: 'A Customer',
    authorEmail: 'customer@test.local',
    now: NOW,
  });
  await moderateReview(ctx.db, review.id, 'approved', ctx.users.owner.id, NOW);
}

const fetchAggregates = async (products: string): Promise<Record<string, ProductAggregate>> =>
  (
    await json<{ aggregates: Record<string, ProductAggregate> }>(
      await http.get(`/api/public/reviews/aggregates?products=${products}`),
    )
  ).aggregates;

describe('the bulk route', () => {
  it('needs no session — a card rating is public', async () => {
    const res = await http.get('/api/public/reviews/aggregates?products=anything');
    expect(res.status).toBe(200);
  });

  it('returns a zero aggregate for a product with no reviews, not an omission', async () => {
    const out = await fetchAggregates('never-reviewed');
    expect(out['never-reviewed']).toEqual({
      productSlug: 'never-reviewed',
      count: 0,
      averageRating: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      sentiment: { positive: 0, neutral: 0, negative: 0 },
    });
  });

  /*
   * THE FAILURE A BATCHED QUERY ACTUALLY PRODUCES. Two products with DIFFERENT
   * ratings is the only arrangement that catches a wrong group-by — with equal
   * ratings a leak is invisible.
   */
  it('does not hand one product another’s rating', async () => {
    await approved('bulk-a', 5);
    await approved('bulk-a', 5);
    await approved('bulk-b', 1);

    const out = await fetchAggregates('bulk-a,bulk-b');
    expect(out['bulk-a'].count).toBe(2);
    expect(out['bulk-a'].averageRating).toBe(500);
    expect(out['bulk-b'].count).toBe(1);
    expect(out['bulk-b'].averageRating).toBe(100);
  });

  /* A card and the page it links to must not show different stars. */
  it('agrees with the singular route about the same product', async () => {
    await approved('agreeing', 4);
    await approved('agreeing', 3);

    const bulk = (await fetchAggregates('agreeing'))['agreeing'];
    const single = (
      await json<{ aggregate: ProductAggregate }>(
        await http.get('/api/public/reviews/aggregate?product=agreeing'),
      )
    ).aggregate;
    expect(bulk).toEqual(single);
  });

  /* `433` is 4.33 stars. Integers travel better than floats through JSON, and
   * the storefront's `starsFromAggregate` divides by 100. */
  it('keeps averageRating as an integer ×100', async () => {
    await approved('rounding', 4);
    await approved('rounding', 5);
    expect((await fetchAggregates('rounding'))['rounding'].averageRating).toBe(450);
  });

  /* Approved only, or a card says "12 reviews" over a page showing nine. */
  it('counts approved reviews only', async () => {
    await approved('moderated', 5);
    await createReview(ctx.db, {
      productSlug: 'moderated',
      rating: 1,
      title: null,
      body: 'This one is still waiting on a decision from a human being.',
      authorName: 'Pending Person',
      authorEmail: 'pending@test.local',
      now: NOW,
    });

    const out = (await fetchAggregates('moderated'))['moderated'];
    expect(out.count).toBe(1);
    expect(out.averageRating).toBe(500);
  });

  it('is cacheable by a shared cache and readable cross-origin', async () => {
    const res = await http.get('/api/public/reviews/aggregates?products=anything');
    expect(res.headers.get('cache-control')).toContain('public');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('the bounds', () => {
  /* Refused rather than truncated: a grid showing ratings on the first sixty
   * cards and blanks after is worse than a refusal that names the field. */
  it('refuses more slugs than the contract allows', async () => {
    const many = Array.from({ length: 61 }, (_, i) => `product-${i}`).join(',');
    expect((await http.get(`/api/public/reviews/aggregates?products=${many}`)).status).toBe(400);
  });

  it('accepts exactly the maximum', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `product-${i}`).join(',');
    expect((await http.get(`/api/public/reviews/aggregates?products=${many}`)).status).toBe(200);
  });

  it('refuses an empty list and a malformed slug', async () => {
    expect((await http.get('/api/public/reviews/aggregates?products=')).status).toBe(400);
    expect((await http.get('/api/public/reviews/aggregates?products=Ok,NOT OK')).status).toBe(400);
  });

  it('refuses a missing parameter rather than answering for everything', async () => {
    expect((await http.get('/api/public/reviews/aggregates')).status).toBe(400);
  });
});

describe('the repo function', () => {
  /* Callers pass an empty list whenever a listing came back empty, and that
   * should not cost a round trip. */
  it('answers an empty map for no slugs', async () => {
    expect((await productAggregates(ctx.db, [])).size).toBe(0);
  });

  /* A caller repeating a slug should cost one row, not two identical ones. */
  it('deduplicates repeated slugs', async () => {
    await approved('deduped', 5);
    const out = await productAggregates(ctx.db, ['deduped', 'deduped', 'deduped']);
    expect(out.size).toBe(1);
    expect(out.get('deduped')?.count).toBe(1);
  });
});
