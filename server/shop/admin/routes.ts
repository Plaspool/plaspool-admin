import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { BadRequestError } from '../../repo/errors';
import { listAudit } from './audit';
import { listShopTags } from './tags';
import { listBuyers } from './customers';
import { listInventory } from './inventory';
import { basketFor, listProspects, type ProspectTab } from './prospects';
import { shopStats } from './stats';
import { ANALYTICS_RANGES, shopAnalytics } from './analytics';

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
 * `requireAuth()` AND NOT `requireOwner()`, ON ALL FOUR. It matches the admin
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

/**
 * One variant's history, one product's, or the whole shop's.
 *
 * `.strict()` like every other query here: a mistyped `?variant=` that is
 * silently ignored would show the WHOLE shop's history under a heading naming
 * one variant, which on an audit surface is the worst kind of wrong.
 */
const AuditQueryParams = PageQueryParams.extend({
  kind: z.enum(['stock', 'price']).optional(),
  variantId: str().max(64).optional(),
  productId: str().max(64).optional(),
}).strict();

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
 * The four tabs `prospects.ts` knows, plus the search box every tab shares.
 *
 * `tab` IS OPTIONAL HERE AND REQUIRED ON `ProspectQuery` — the route below
 * supplies the default, so an absent `?tab=` reads as "show me the baskets"
 * rather than a 400 demanding a caller name one.
 */
const DEFAULT_PROSPECT_TAB: ProspectTab = 'basket';

const ProspectQueryParams = PageQueryParams.extend({
  tab: z.enum(['basket', 'account', 'subscriber', 'all']).optional(),
  query: str().max(200).optional(),
}).strict();

/**
 * No parameters at all, and the empty schema is what says so.
 *
 * `readQuery` against `.strict()` makes `?limit=10` on this route a 400 rather
 * than a page-sized subset of a list that does not paginate. The category list is
 * bounded by how many distinct values a shop has typed, which is tens.
 */
const NoQueryParams = z.object({}).strict();

/**
 * `days` is an enum of the ranges the picker offers, not a free integer —
 * every value is a scan bound (`server/shop/admin/analytics.ts`).
 */
const AnalyticsQueryParams = z
  .object({ days: z.enum(ANALYTICS_RANGES).optional() })
  .strict();

shopAdminRoutes.get('/admin/analytics', auth, async (c) => {
  const q = readQuery(c, AnalyticsQueryParams);
  return c.json(
    await shopAnalytics(currentDb(c), { now: Date.now(), days: Number(q.days ?? '30') }),
  );
});

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

/**
 * WHO HAS NOT BOUGHT YET, tab by tab, and one person's basket — `prospects.ts`
 * carries the whole shape of both: why the tabs are disjoint, why the address
 * is folded the way it is, and why a basket is quoted live rather than frozen.
 *
 * NESTED UNDER `/admin/customers` ON PURPOSE. `server/middleware/permissions.ts`
 * carries `{ prefix: '/api/shop/admin/customers', domain: 'customers' }`, so
 * these two routes are gated by the existing rule and no permission change was
 * needed. Sending to these people is a separate surface on `/api/admin/email/`,
 * domain `marketing` — each route on the domain its API is in, the way Spools
 * split its four screens.
 *
 * REGISTERED ABOVE ANY `/admin/customers/:id` THAT IS EVER ADDED. A fixed
 * segment must never sit below a dynamic one — the same ordering discipline
 * the marketing app's own header records — and today there is no such route to
 * collide with, so this is a note for whoever adds one next.
 */
shopAdminRoutes.get('/admin/customers/prospects', auth, async (c) => {
  const q = readQuery(c, ProspectQueryParams);
  return c.json(await listProspects(currentDb(c), { ...q, tab: q.tab ?? DEFAULT_PROSPECT_TAB }));
});

/**
 * One person's basket, read the same way the broadcast drain reads it
 * (`basketFor`'s own header explains why one statement serves both).
 *
 * `pathParam`, NOT A BARE `c.req.param` — the boundary `server/nul-bytes.test.ts`
 * walks every route to enforce, so a NUL in the segment is a 400 rather than a
 * 500 that never should have reached the driver. `basketFor` folds and rejects
 * a NUL of its own further in; the check here is only for the segment being
 * BLANK — whitespace that folds to nothing — which would otherwise read back as
 * an honest 200 null basket rather than the caller having named nobody at all.
 */
shopAdminRoutes.get('/admin/customers/prospects/:email', auth, async (c) => {
  const email = pathParam(c, 'email');
  if (email.trim() === '') throw new BadRequestError('email');
  return c.json({ basket: await basketFor(currentDb(c), email) });
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

/**
 * WHAT CHANGED, WHO CHANGED IT, AND WHY — over two sources that were already
 * durable and had no reader. See `audit.ts` for why this adds no table.
 *
 * `requireAuth` and not `requireOwner`, matching the rest of this directory: it
 * is a projection of rows a writer can already see on the product form, and an
 * audit trail only the owner may read is one nobody consults.
 */
shopAdminRoutes.get('/admin/audit', auth, async (c) => {
  const q = readQuery(c, AuditQueryParams);
  return c.json(await listAudit(currentDb(c), q));
});

/*
 * `GET /admin/categories` MOVED TO `server/shop/catalog/routes.ts` (migration
 * 0200). It now returns the UNION of the managed `shop_categories` table and the
 * values still in use as free text, which is a superset of the `{name, count}`
 * this route used to serve — the product filter reads the same two fields and is
 * unaffected.
 *
 * It moved rather than gaining a sibling because two endpoints answering "what
 * categories are there?" with different rules is the confusion the managed table
 * exists to end. It lives with the category WRITES, which cannot live here: this
 * directory's header states that nothing in it writes anything, and its blanket
 * `requireAuth()` decision is derived from that.
 */

/** The tag box's vocabulary — the no-params rule, and the reason for it. */
shopAdminRoutes.get('/admin/tags', auth, async (c) => {
  readQuery(c, NoQueryParams);
  return c.json({ items: await listShopTags(currentDb(c)) });
});
