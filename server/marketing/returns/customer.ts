import { Hono } from 'hono';
import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { UnauthenticatedError, readJson, str } from '../../middleware/errors';
import { currentDb } from '../../app-env';
import { createRequest, readReturn } from './repo';
import { optionalText } from './routes';
import type { AppEnv } from '../../app-env';

/**
 * A SHOPPER ASKING FOR THEIR OWN RETURN, AND READING IT BACK.
 *
 * The sibling of `../ledger/customer.ts`, and everything its header argues
 * applies here unchanged: the routes in `./routes.ts` are OPERATOR routes,
 * `auth`-gated and keyed by an email in the path, which is exactly right for a
 * desk and exactly wrong for a shopper.
 *
 * THE ADDRESS IS NEVER AN INPUT. Not a path parameter, not a query parameter,
 * and — the part that distinguishes this from the reviews intake — not a body
 * field either. `Body` below is `.strict()`, so a request carrying `email` is a
 * 400 rather than a silently-ignored key. Spoofing is not a rule enforced here;
 * it is a sentence the wire format cannot express.
 *
 * THE RESOLVER IS A PORT (spec D9). `shop_customers` and the `__Host-shop_session`
 * cookie belong to Cart, marketing may not import `server/shop/**`, and a
 * type-only import is still an import — so this declares the narrowest thing it
 * needs and `server/index.ts` hands in Cart's `resolveShopCustomer`, which
 * satisfies it structurally.
 *
 * THE DEFAULT RESOLVES NOBODY, so a deployment that forgets the injection answers
 * 401 to everybody rather than inventing an identity.
 */
export type ReturnCustomerResolver = (
  c: Context<AppEnv>,
) => Promise<{ id: string; email: string | null } | null>;

export const NO_RETURN_CUSTOMER: ReturnCustomerResolver = () => Promise.resolve(null);

export interface CustomerReturnDeps {
  customer?: ReturnCustomerResolver;
  /** `shopCors()`, injected. See `../ledger/customer.ts` for why this may not be
   *  imported here and may not be applied at `marketingApp()`'s root. */
  cors?: MiddlewareHandler<AppEnv>;
}

/** `qty_declared` is `integer` (migration 0011); past this is SQLSTATE 22003,
 *  i.e. a 500 for a number somebody typed. The ceiling is the COLUMN's, not a
 *  business rule — `./routes.ts`'s `QTY` caps the two operator intakes the
 *  same way. */
const INT4_MAX = 2_147_483_647;

/**
 * `.strict()` IS THE SECURITY CONTROL, not a nicety. There is deliberately no
 * `email` and no `programId`: the address comes from the session, and the
 * programme is the shop's default. A shopper cannot choose which scheme to be
 * paid under.
 */
const Body = z
  .object({
    qtyDeclared: z.number().int().min(1).max(INT4_MAX),
    phone: str().trim().min(1).max(200),
    pickupAddress: str().trim().min(1).max(1000),
    serviceAreaId: str().trim().min(1).max(200),
    /* `optionalText(200)`, NOT a bare `.optional()` — a blank `name` is what an
       untouched optional field on a plain HTML form posts, and refusing it
       would be hostile to the one client that matters here. `./routes.ts`
       carries the full argument; this reuses its `optionalText` rather than a
       second copy. */
    name: optionalText(200),
  })
  .strict();

export function createCustomerReturnRoutes(deps: CustomerReturnDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const resolver = deps.customer ?? NO_RETURN_CUSTOMER;

  /* Both routes, including their errors — a 401 with no CORS header is a network
     error with no status to the calling JavaScript, so the storefront cannot tell
     "sign in" from "the server is down". `/me/returns/*` matches the bare
     `/me/returns` too; `../ledger/customer.ts` records that being measured. */
  if (deps.cors) routes.use('/me/returns/*', deps.cors);

  /*
   * THE PREFLIGHT ITSELF — a cross-origin `POST` with a JSON body, and
   * `credentials: 'include'`, mandates one, exactly as it does for the reviews
   * intake (`server/shop/reviews/routes.ts`, admin#26). BEFORE THIS, `OPTIONS
   * /me/returns` 404'd: no handler existed for it at all, so a 404 status, and
   * the absent `allow-methods`/`allow-headers` it carried, each independently
   * failed the preflight and the browser refused the `POST` before sending it.
   *
   * HAND-ROLLED, NOT `shopPreflight` — mirroring the reviews intake's own
   * choice, for the same reason stated there: `shopPreflight` answers every
   * cart path with the identical fixed method list (`GET, POST, PATCH, PUT,
   * DELETE`), and this route only ever accepts `GET` and `POST`, so reusing it
   * would advertise three methods that 404 here. It is also the shape spec D9
   * leaves open: `shopPreflight` lives in `server/shop/cart/cors.ts`, which
   * this subsystem may not import — `deps.cors` above is already the injected
   * substitute for the response half, and a second injected dependency for
   * four lines of `c.body` is more seam than the reuse is worth.
   *
   * THE ORIGIN/CREDENTIALS HALF IS NOT HERE. `deps.cors`, registered above,
   * runs on every method under `/me/returns/*` including this one — matched
   * the same way `/me/returns/*` matches the bare `/me/returns` for the real
   * routes below — and appends `access-control-allow-origin` /
   * `-allow-credentials` after this handler's 204 comes back through it.
   */
  routes.options('/me/returns', (c) =>
    c.body(null, 204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    }),
  );

  /** Whoever is asking, or a 401. A customer with no email is treated as no
   *  customer: returns are keyed by address and there is nothing to file against. */
  async function requireCustomer(c: Context<AppEnv>): Promise<{ id: string; email: string }> {
    const customer = await resolver(c);
    if (!customer?.email) throw new UnauthenticatedError();
    return { id: customer.id, email: customer.email };
  }

  routes.post('/me/returns', async (c) => {
    const who = await requireCustomer(c);
    const body = await readJson(c, Body);
    const db = currentDb(c);

    const row = await createRequest(db, {
      email: who.email,
      customerId: who.id,
      qtyDeclared: body.qtyDeclared,
      customerName: body.name,
      customerPhone: body.phone,
      pickupAddress: body.pickupAddress,
      serviceAreaId: body.serviceAreaId,
      source: 'customer',
      now: Date.now(),
    });

    const read = await readReturn(db, row.id);
    if (!read) throw new Error('marketing: the return was created and cannot be read back');
    const { program } = read;

    /* The narrow, label-complete answer — never the admin detail. The storefront
       renders its confirmation entirely out of this, so every word it needs
       travels and nothing else does. */
    return c.json(
      {
        requestId: row.id,
        qtyDeclared: row.qtyDeclared,
        program: {
          name: program.name,
          pointsLabelSingular: program.pointsLabelSingular,
          pointsLabelPlural: program.pointsLabelPlural,
          unitLabelSingular: program.unitLabelSingular,
          unitLabelPlural: program.unitLabelPlural,
          pointsPerUnit: program.pointsPerUnit ?? row.pointsPerUnitSnapshot,
          minUnitsPerReturn: program.minUnitsPerReturn ?? row.qtyDeclared,
        },
      },
      201,
    );
  });

  /**
   * Their own returns, newest first, THE MOST RECENT 20 AND NO CURSOR.
   *
   * The absent cursor is a decision. `marketing_return_requests_open_uq` caps a
   * customer at one OPEN return, so this list grows only as fast as somebody
   * actually sends units back — twenty is years of history, and a cursor would
   * be paging machinery on both sides for a list with one screen in it. The
   * ledger next door pages because a ledger genuinely grows without bound; this
   * does not.
   *
   * `customer_name`, `customer_phone`, `pickup_address` AND `service_area_id`
   * ARE IN THE PROJECTION, so the storefront can prefill its return form from a
   * shopper's most recent request instead of asking them to retype it. This is
   * the shopper's OWN data, returning to the shopper who supplied it, over a
   * route that already derives identity from `who.email` below and can only
   * ever answer that identity's rows — a different question from a third
   * party's contact details, and the answer here is different too.
   *
   * NOT `driver_phone` AND NOT `revision`, and that line has not moved: a
   * shopper is told who is coming, not how to ring them directly, and a
   * revision is a concurrency token for a screen that can write. Those stay
   * withheld regardless of whose data the rest of the row is.
   */
  routes.get('/me/returns', async (c) => {
    const who = await requireCustomer(c);
    const res = await currentDb(c).execute(sql`
      SELECT id, status, qty_declared, qty_accepted, points_awarded,
             pickup_scheduled_at, driver_name, created_at,
             customer_name, customer_phone, pickup_address, service_area_id
        FROM marketing_return_requests
       WHERE customer_email = ${who.email.trim().toLowerCase()}
       ORDER BY created_at DESC, id DESC
       LIMIT 20`);

    return c.json({
      items: res.rows.map((row) => ({
        id: String(row.id),
        status: String(row.status),
        qtyDeclared: Number(row.qty_declared),
        qtyAccepted: row.qty_accepted == null ? null : Number(row.qty_accepted),
        pointsAwarded: row.points_awarded == null ? null : Number(row.points_awarded),
        pickupScheduledAt:
          row.pickup_scheduled_at == null ? null : Number(row.pickup_scheduled_at),
        driverName: row.driver_name == null ? null : String(row.driver_name),
        createdAt: Number(row.created_at),
        customerName: row.customer_name == null ? null : String(row.customer_name),
        customerPhone: row.customer_phone == null ? null : String(row.customer_phone),
        pickupAddress: row.pickup_address == null ? null : String(row.pickup_address),
        serviceAreaId: row.service_area_id == null ? null : String(row.service_area_id),
      })),
    });
  });

  return routes;
}
