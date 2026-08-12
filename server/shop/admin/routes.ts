import { Hono } from 'hono';
import { z } from 'zod';
import { readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { listShopCategories } from './categories';
import { listBuyers } from './customers';
import { listInventory } from './inventory';
import { shopStats } from './stats';

/**
 * The shop dashboard's read surface (HANDOFF §2 A4).
 *
 * MOUNTED INTO `shopApp()` AT `'/'`, so the paths below are relative to
 * `/api/shop` and `/admin/stats` is `/api/shop/admin/stats` on the wire — the
 * same two-line convention every other subsystem uses there.
 *
 * `requireAuth()` IS ATTACHED PER ROUTE, NEVER AS `use('*', …)`. Measured on the
 * blog side and recorded in `server/routes/posts.ts`: `app.route(prefix, router)`
 * flattens a router into its parent, so a blanket `use` here becomes
 * `use('/api/shop/*')` and applies to paths this file has never heard of — an
 * unrouted `/api/shop/nothing-here` answered **401 instead of 404**. Per route it
 * cannot leak, and forgetting one fails that route's own "401 without a session"
 * case.
 *
 * `requireAuth()` AND NOT `requireOwner()`, ON ALL FIVE. It matches the admin
 * order list and the admin product list, which any writer may already read — and
 * every route here is a projection of rows those two already return. Owner-only
 * is what contract §HTTP reserves for money-adjacent WRITES (cancel, refund,
 * sweep), and nothing in this directory writes anything.
 *
 * ⚠️  RELATED, AND UNCHANGED BY THIS WORK: the catalog still has no owner-only
 *     route at all, so any writer can set a price and publish a product
 *     (HANDOFF §1.9). That is a real gap and it is deliberately not closed here —
 *     tightening a permission on routes another workstream is building against,
 *     inside a change that only adds read routes, is how a shop admin discovers
 *     at 5 p.m. that they cannot publish.
 *
 * EVERY QUERY SCHEMA IS `.strict()`. A mistyped filter that is silently ignored
 * is worse than a refusal: `?belowOnl=1` would quietly return the entire
 * inventory and look like a shop with no low stock, which is the one thing this
 * screen exists to show.
 */
export const shopAdminRoutes = new Hono<AppEnv>();

const auth = requireAuth();

/**
 * `z.coerce.number()` because a query string is text, `.int()` so `?threshold=2.5`
 * is a 400 rather than a silently truncated filter, and a ceiling so a caller
 * cannot ask for a threshold that means "every variant in the shop" by accident.
 *
 * The floor is 0 and not 1: `available <= 0` is the sold-out list, which is the
 * threshold an operator actually wants some mornings. Negative is refused because
 * `available` only goes below zero for a backorderable variant, and those are
 * already included at any threshold ≥ 0.
 */
const threshold = z.coerce.number().int().min(0).max(1_000_000).optional();

const StatsQueryParams = z.object({ threshold }).strict();

const PageQueryParams = z
  .object({
    cursor: str().optional(),
    /** `pageLimit` decides the range and answers 400 itself; this stops `?limit=abc` NaN-ing. */
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const InventoryQueryParams = PageQueryParams.extend({
  /**
   * SPELLED AS TWO LITERALS, not coerced from anything truthy. `?belowOnly=false`
   * is a string, and every truthiness test in JavaScript says it is true — a
   * filter that reads as applied, is not, and reports nothing. Two accepted
   * values means the third spelling is a 400 that names the field.
   */
  belowOnly: z.enum(['0', '1']).optional(),
  threshold,
}).strict();

/**
 * No parameters at all, and the empty schema is what says so.
 *
 * `readQuery` against `.strict()` makes `?limit=10` on this route a 400 rather
 * than a page-sized subset of a list that does not paginate. The category list is
 * bounded by how many distinct values a shop has typed, which is tens.
 */
const NoQueryParams = z.object({}).strict();

shopAdminRoutes.get('/admin/stats', auth, async (c) => {
  const q = readQuery(c, StatsQueryParams);
  /*
   * `Date.now()` IS READ HERE AND PASSED DOWN, rather than called inside each
   * aggregate. The three revenue windows have to be measured from ONE instant or
   * a slow query can put "last 24 hours" and "last 7 days" on different clocks —
   * and `generatedAt` in the response is that same number, so a reader can
   * reconstruct every boundary from the body alone.
   */
  return c.json(await shopStats(currentDb(c), { now: Date.now(), threshold: q.threshold }));
});

shopAdminRoutes.get('/admin/customers', auth, async (c) => {
  const q = readQuery(c, PageQueryParams);
  return c.json(await listBuyers(currentDb(c), q));
});

shopAdminRoutes.get('/admin/inventory', auth, async (c) => {
  const q = readQuery(c, InventoryQueryParams);
  return c.json(
    await listInventory(currentDb(c), {
      belowOnly: q.belowOnly === '1',
      threshold: q.threshold,
      cursor: q.cursor,
      limit: q.limit,
    }),
  );
});

shopAdminRoutes.get('/admin/categories', auth, async (c) => {
  readQuery(c, NoQueryParams);
  return c.json({ items: await listShopCategories(currentDb(c)) });
});
