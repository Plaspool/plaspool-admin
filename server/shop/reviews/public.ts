import { Hono } from 'hono';
import { z } from 'zod';
import { readQuery, str } from '../../middleware/errors';
import { currentDb } from '../../app-env';
import { listReviewsPublic, productAggregate } from './repo';
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

export function createReviewPublicRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Approved reviews for one product, newest first, keyset-paginated.
   * The projection (`listReviewsPublic`) never selects `author_email`, so
   * this surface cannot leak it — see the repo for why that is structural.
   */
  routes.get('/public/reviews', async (c) => {
    const q = readQuery(c, ListQuery);
    const page = await listReviewsPublic(currentDb(c), q.product, {
      cursor: q.cursor,
      limit: q.limit,
    });
    c.header('cache-control', CACHE);
    c.header(CORS_HEADER, CORS_VALUE);
    return c.json(page);
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

  return routes;
}
