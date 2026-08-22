import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { readQuery, toResponse } from '../middleware/errors';
import { currentDb } from '../app-env';
import { listPublicBanners } from './banners/repo';
import { publicAreas } from './areas/repo';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';

/**
 * The public reading surface — `/api/public/marketing/*` (spec D8, contract
 * #29-30).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SEPARATE ROUTER BECAUSE OF WHERE IT IS MOUNTED, not because of what it
 * contains. `server/index.ts` mounts this ABOVE `sessionMiddleware`, beside
 * `createPublicRoutes`, so `c.get('user')` is structurally `undefined` on every
 * request that reaches this file. That is what makes `Cache-Control: public`
 * safe by CONSTRUCTION rather than by review: a response a shared cache may
 * store and hand to a different reader cannot vary by cookie if the middleware
 * that would resolve one has not run and cannot be reached from inside.
 * `server/routes/public.ts` carries the long version of the argument (threat
 * T6), and `public.test.ts` proves it from the outside — the same bytes with a
 * session cookie as without, and no `Set-Cookie` on the way back.
 *
 * A FACTORY, matching `createPublicRoutes`, so the mount reads the same and so
 * the CLOCK arrives as an argument rather than as a `Date.now()` a suite cannot
 * replace. The schedule is evaluated at read time (there is no cron to flip a
 * status — both Hobby slots are spent), so "what is showing" is a pure function
 * of the rows and one instant, and a test that cannot name the instant can only
 * assert about the present.
 *
 * THE ONE PUBLIC MUTATION IS NOT HERE. `POST /api/marketing/returns/request` —
 * the customer asking for a pickup — lives in the session-mounted app under
 * `originGuard` and a rate budget (`returns/routes.ts`). A mutation inside a
 * cacheable router would put "may be stored by a shared cache" and "writes a
 * row" in one file, which is the confusion this split exists to prevent.
 *
 * NO RATE LIMITER, deliberately, and `server/routes/public.ts` states the rule:
 * the limiter writes a Postgres row per call, so putting one on a cheap,
 * edge-cacheable route makes that route the expensive one. Both queries here are
 * a single indexed read behind a 60-second edge cache. The limited routes over
 * there are the two that are neither (a full-text search and an R2 presign).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface MarketingPublicDeps {
  /**
   * Epoch-ms reader for the read-time schedule. Defaults to `Date.now`.
   *
   * INJECTED RATHER THAN CALLED IN THE HANDLER for the reason in the header: a
   * banner scheduled for tomorrow and a banner that ended yesterday are the two
   * rows most worth testing, and both are propositions about a clock.
   */
  now?: () => number;
}

// --------------------------------------------------------------------- CORS

/**
 * `Access-Control-Allow-Origin: *`, and NEVER `Allow-Credentials`.
 *
 * With `*` the credentials header is invalid anyway, and the combination is
 * exactly what turns a public read API into a session-riding one. It is never
 * set here, and the header a browser would need to send a cookie is therefore
 * never granted — which matters less than usual for this router, because the
 * mount above `sessionMiddleware` means a cookie that arrived would be read by
 * nothing.
 *
 * SCOPED TO `/public/marketing/*`, NOT `'*'`. `app.route(API_PREFIX, routes)`
 * flattens this router into the parent, so `routes.use('*')` would become
 * `/api/*` there and would put a wildcard CORS header on the AUTHENTICATED API
 * — the precise mistake `server/routes/posts.ts` documents for `requireAuth`.
 */
const CORS_HEADER = 'access-control-allow-origin';
const CORS_VALUE = '*';
const PREFIX = '/public/marketing';
const JSON_TYPE = 'application/json; charset=UTF-8';

/**
 * Spec D8's two TTLs, in one place rather than spelled at each call site.
 *
 * BANNERS ARE THE SHORT ONE because they are the surface an admin flips on and
 * then goes to look at: the empty-state copy on the Banners screen promises
 * "shows within a minute", and this is the number that promise is made of.
 * REWARDS COPY IS THE LONG ONE because it changes when somebody renames a
 * programme, which is a deliberate act on a config screen rather than a
 * scheduled event — and `stale-while-revalidate` means the storefront never
 * waits for either.
 *
 * NO `ETag`, AND NO CONDITIONAL HANDLING, unlike `server/routes/public.ts`. The
 * validators there are worth their machinery because feed readers and crawlers
 * revalidate a large body; these two answers are a few hundred bytes behind an
 * `s-maxage` that already collapses a storefront's traffic to one origin hit a
 * minute. Adding them here would also mean adding `Access-Control-Expose-Headers`
 * and an `OPTIONS` route — measured over there as the difference between a
 * validator a browser can use and one it silently cannot — for bytes the edge
 * is not sending anyway.
 */
export const MARKETING_CACHE = {
  banners: 'public, s-maxage=60, stale-while-revalidate=300',
  rewards: 'public, s-maxage=300, stale-while-revalidate=3600',
} as const;

/** A cacheable public body. One place, so the two routes cannot drift into
 *  different headers for the same guarantee. */
function send(body: unknown, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': JSON_TYPE,
      'cache-control': cacheControl,
      [CORS_HEADER]: CORS_VALUE,
    },
  });
}

// ------------------------------------------------------------------ rewards

/**
 * Contract #30 — the storefront's "send your empties back" page, as data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE NEVER-HARDCODE GUARANTEE, PUBLIC EDITION. Every noun on that page — what
 * the programme is called, what the points are called, what the thing being
 * sent back is called, how many of them make a request and what each accepted
 * one earns — is a column, so a rename in the admin is a rename on the
 * storefront within one cache TTL and no deploy. A storefront that hardcoded
 * any of it would be the one place spec D2's four rename mechanisms could not
 * reach.
 *
 * `null` IS A FIRST-CLASS ANSWER, and the WHERE clause is why it is honest: no
 * default programme, a paused one, or one of the wrong kind all resolve to "we
 * are not taking returns right now", which is the one sentence the storefront
 * can render without knowing anything else. The alternative — emitting a row
 * with `minUnitsPerReturn: null` — is a page that reads "return at least null
 * canisters" to a customer.
 *
 * THE FOUR `IS NOT NULL` TESTS ARE NOT REDUNDANT WITH `kind = 'unit_return'`,
 * even though `marketing_programs_kind_fields_ck` ties them together today.
 * They are what makes this query's TYPE true: a widened CHECK later degrades
 * this endpoint to `null` — the storefront hides a page — instead of shipping
 * nulls into copy. Cheap insurance on the one query an anonymous caller reaches.
 *
 * A READ-ONLY JOIN AND NO REPO MODULE OF ITS OWN. It is a PUBLIC PROJECTION —
 * a narrow shape plus a WHERE clause deciding what the internet may see — and
 * `server/repo/public.ts` is the house precedent for keeping those beside the
 * route that caches them rather than in the admin repository, where it would be
 * a function no admin route calls.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface PublicRewardsProgram {
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular: string;
  unitLabelPlural: string;
  minUnitsPerReturn: number;
  pointsPerUnit: number;
}

export async function readPublicRewards(db: Db): Promise<PublicRewardsProgram | null> {
  const res = await db.execute(sql`
    SELECT p.name, p.points_label_singular, p.points_label_plural,
           p.unit_label_singular, p.unit_label_plural,
           p.min_units_per_return, p.points_per_unit
      FROM marketing_settings s
      JOIN marketing_programs p ON p.id = s.default_return_program_id
     WHERE s.id = 'main'
       AND p.status = 'active'
       AND p.kind = 'unit_return'
       AND p.unit_label_singular IS NOT NULL
       AND p.unit_label_plural IS NOT NULL
       AND p.min_units_per_return IS NOT NULL
       AND p.points_per_unit IS NOT NULL`);

  const row = res.rows[0];
  if (!row) return null;

  return {
    name: String(row.name),
    pointsLabelSingular: String(row.points_label_singular),
    pointsLabelPlural: String(row.points_label_plural),
    unitLabelSingular: String(row.unit_label_singular),
    unitLabelPlural: String(row.unit_label_plural),
    minUnitsPerReturn: Number(row.min_units_per_return),
    pointsPerUnit: Number(row.points_per_unit),
  };
}

// ---------------------------------------------------------------- the router

/**
 * STRICT, so `?placment=popup` is a 400 rather than an answer for every
 * placement that looks like a working filter. There is exactly one parameter
 * here and no way to spell anything else.
 */
const BannersQuery = z.object({ placement: z.enum(['top_bar', 'popup', 'section']).optional() })
  .strict();

export function createMarketingPublicRoutes(deps: MarketingPublicDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const now = (): number => (deps.now ?? Date.now)();

  routes.use(`${PREFIX}/*`, async (c, next) => {
    await next();
    c.res.headers.set(CORS_HEADER, CORS_VALUE);
  });

  /**
   * The CORS header on ERROR responses too, which the middleware above cannot do.
   *
   * `toResponse` builds a FRESH `Response`, so it inherits nothing a handler or
   * a post-`next()` middleware set — and a thrown error skips the line above
   * entirely, because the rejection propagates out of `await next()`. Without
   * this, a browser client sees an opaque CORS failure instead of a readable
   * 400, which is a worse outcome than the error itself. `server/routes/public.ts`
   * and `server/shop/app.ts` both do exactly this; the BODY is still
   * `toResponse`'s, so this is not a fork of the error table.
   */
  routes.onError((err, c) => {
    const res = toResponse(err, c.get('requestId') ?? '');
    res.headers.set(CORS_HEADER, CORS_VALUE);
    return res;
  });

  /** Contract #29. */
  routes.get(`${PREFIX}/banners`, async (c) => {
    const { placement } = readQuery(c, BannersQuery);
    const banners = await listPublicBanners(currentDb(c), { now: now(), placement });
    return send({ banners }, MARKETING_CACHE.banners);
  });

  /** Contract #30. */
  routes.get(`${PREFIX}/rewards`, async (c) => {
    const program = await readPublicRewards(currentDb(c));
    return send({ program }, MARKETING_CACHE.rewards);
  });

  /**
   * The districts collection actually runs in — the district Select on the
   * storefront's return form, as data.
   *
   * IN THIS CACHEABLE ROUTER RATHER THAN BESIDE `/me/returns`, because it is a
   * cookieless read that every shopper gets the same answer to, and this router's
   * whole charter is exactly that. The MUTATION stays where a mutation belongs.
   *
   * ON THE REWARDS TTL, NOT THE BANNERS ONE. An area is switched on by somebody
   * on a config screen, which is the same kind of deliberate act as renaming a
   * programme — not a scheduled event an operator is waiting to see appear.
   */
  routes.get(`${PREFIX}/areas`, async (c) => {
    const areas = await publicAreas(currentDb(c));
    return send({ areas }, MARKETING_CACHE.rewards);
  });

  return routes;
}
