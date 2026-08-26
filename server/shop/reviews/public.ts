import { Hono } from 'hono';
import { z } from 'zod';
import { readQuery, str } from '../../middleware/errors';
import { BadRequestError } from '../../repo/errors';
import { currentDb } from '../../app-env';
import { listReviewsPublic, productAggregate, productAggregates } from './repo';
import { reactionCounts, repliesFor } from './threads';
import type { AppEnv } from '../../app-env';

/**
 * The public review reads — what a product page renders (issue #4).
 *
 * A SEPARATE ROUTER BECAUSE OF WHERE IT IS MOUNTED, following the marketing
 * public router's precedent to the word: `server/index.ts` mounts this ABOVE
 * `sessionMiddleware`, beside `createPublicRoutes`, so `c.get('user')` is
 * structurally `undefined` on every request that reaches this file. That is
 * what makes `Cache-Control: public` safe by CONSTRUCTION rather than by
 * review — a response a shared cache may store and hand to a different
 * reader cannot vary by cookie if the middleware that would resolve one has
 * not run. `server/routes/public.ts` carries the long form of the argument
 * (threat T6).
 *
 * THE ONE PUBLIC MUTATION IS NOT IN IT. `POST /api/shop/reviews/submit`
 * lives in `routes.ts`, under `originGuard` and two rate budgets — a
 * mutation inside a cacheable router puts "may be stored by a shared cache"
 * and "writes a row" in one file, which is the confusion this split exists
 * to prevent.
 *
 * A SHORT TTL, BECAUSE MODERATION IS THE WRITE PATH. An approval should
 * reach product pages in about a minute; the storefront's own ISR sits in
 * front of this anyway, so the effective staleness is the sum of the two
 * windows and both are deliberately small.
 */

const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';
const CORS_HEADER = 'access-control-allow-origin';
const CORS_VALUE = '*';

const ListQuery = z.object({
  product: str().regex(/^[a-z0-9-]+$/, 'a product slug').max(120),
  cursor: str().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const AggregateQuery = z.object({
  product: str().regex(/^[a-z0-9-]+$/, 'a product slug').max(120),
});

/**
 * How many slugs one bulk request may name.
 *
 * BOUNDED, AND EXCEEDING IT IS A 400 RATHER THAN A SILENT TRUNCATION. The
 * singular route caps `limit` at 50 for the same reason: a caller that asks for
 * more than the contract allows should be told, not quietly given a prefix it
 * will then render as though it were the whole answer — a grid showing ratings
 * on the first sixty cards and blanks after is worse than a refusal.
 *
 * Sixty is comfortably above any listing this store will render on one page,
 * and low enough that the `= ANY` stays a cheap index scan.
 */
const MAX_BULK_PRODUCTS = 60;

const AggregatesQuery = z.object({
  /**
   * Comma-separated slugs. A repeated slug costs one row — the repo
   * deduplicates before it queries.
   *
   * The shape is checked AFTER splitting rather than with one regex over the
   * whole string, so a 400 can name the malformed slug instead of rejecting a
   * list of sixty for one bad character in the middle of it.
   */
  products: str().max(MAX_BULK_PRODUCTS * 121),
});

export function createReviewPublicRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Approved reviews for one product, newest first, keyset-paginated.
   * The projection (`listReviewsPublic`) never selects `author_email`, so
   * this surface cannot leak it — see the repo for why that is structural.
   */
  routes.get('/public/reviews', async (c) => {
    const q = readQuery(c, ListQuery);
    const db = currentDb(c);
    const page = await listReviewsPublic(db, q.product, {
      cursor: q.cursor,
      limit: q.limit,
    });

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * REPLIES AND THE HELPFUL COUNT RIDE ALONG; `viewerReaction` DOES NOT, AND
     * THAT OMISSION IS THE POINT.
     *
     * This router is mounted ABOVE `sessionMiddleware` and every response
     * carries `Cache-Control: public` — see the header of this file. A shared
     * cache may therefore store one of these and hand it to a different reader.
     * Both fields added here are the same for everybody: the approved replies
     * on a review, and how many people found it helpful. Neither varies by who
     * is asking, so neither can leak across readers.
     *
     * "Did I vote on this" DOES vary by reader, and putting it here would make
     * a cacheable response reader-specific — threat T6, exactly. It lives on
     * `GET /api/shop/reviews/reactions` instead, below `sessionMiddleware`,
     * uncached, in the shop app where a cookie is legal.
     *
     * `unhelpful` is not selected AT ALL. A public dislike tally is a
     * scoreboard for brigading (0620's header); the count exists in the admin.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const ids = page.items.map((r) => r.id);
    /* Two statements, batched across the page rather than per review — a reply
       query per row is the N+1 `listVariantsForProducts` exists to avoid. */
    const [replies, counts] = await Promise.all([repliesFor(db, ids), reactionCounts(db, ids)]);

    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json({
      ...page,
      items: page.items.map((review) => ({
        ...review,
        replies: replies.get(review.id) ?? [],
        helpfulCount: counts.get(review.id)?.helpful ?? 0,
      })),
    });
  });

  /**
   * The numbers a product page shows before anyone reads a single review:
   * count, mean (×100, integer), star distribution, sentiment breakdown.
   * Approved only, so this always agrees with the list above.
   */
  routes.get('/public/reviews/aggregate', async (c) => {
    const q = readQuery(c, AggregateQuery);
    const aggregate = await productAggregate(currentDb(c), q.product);
    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json({ aggregate });
  });

  /**
   * The same numbers for MANY products, in one request and one statement.
   *
   * WHAT IT UNBLOCKS. A listing needs a rating for every card on it, and asking
   * per card is a subrequest per card — on Cloudflare Workers that is a
   * grid-size ceiling rather than a slow path. Until this existed, the
   * storefront kept its card rating line and its "Best rated" sort switched off
   * rather than show invented numbers.
   *
   * EVERY REQUESTED SLUG IS IN THE ANSWER, including ones with no approved
   * reviews, which come back as a zero aggregate. An omission would make every
   * caller write the same "missing means empty" branch.
   *
   * Same cache headers and same CORS as its singular sibling, and mounted in
   * the same router — so the argument at the top of this file about
   * `Cache-Control: public` being safe BY CONSTRUCTION covers this too:
   * `sessionMiddleware` has not run, so no response here can vary by cookie.
   */
  routes.get('/public/reviews/aggregates', async (c) => {
    const q = readQuery(c, AggregatesQuery);
    const slugs = q.products
      .split(',')
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0);

    if (slugs.length === 0) throw new BadRequestError('products');
    if (slugs.length > MAX_BULK_PRODUCTS) throw new BadRequestError('products');
    /* Named individually so the refusal points at the offending slug rather
       than at the whole list. */
    for (const slug of slugs) {
      if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 120) {
        throw new BadRequestError('products');
      }
    }

    const aggregates = await productAggregates(currentDb(c), slugs);
    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    /* An object keyed by slug rather than an array: every consumer looks these
       up by product, and an array would make each one build this map itself. */
    return c.json({ aggregates: Object.fromEntries(aggregates) });
  });

  return routes;
}
