import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { shopCors } from '../cart/cors';
import {
  ForbiddenError,
  UnauthenticatedError,
  pathParam,
  readJson,
  readQuery,
  str,
} from '../../middleware/errors';
import { BadRequestError } from '../../repo/errors';
import { clientIp, limit } from '../../middleware/ratelimit';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import {
  createReview,
  destroyReview,
  getReview,
  listReviewsAdmin,
  moderateReview,
} from './repo';
import type { AppEnv } from '../../app-env';

/**
 * Reviews — the staff surface and the one public mutation (issue #4).
 *
 * Mounted into the shop app (`/api/shop`), below `originGuard` and
 * `sessionMiddleware`, exactly like the returns desk: the staff routes take
 * `auth`, and the customer intake takes a CUSTOMER session — not a staff one.
 * It is not `requireAuth()`; it is `resolveCustomer` plus a 401, because the
 * two are different populations signing in through different tables.
 */

/** The narrow shape this subsystem needs from a resolved customer. */
export interface ReviewsCustomer {
  id: string;
  email: string | null;
  displayName: string | null;
}

/**
 * Resolve the shop customer session, or null. **NEVER 401s by itself** — the
 * intake route decides what an absent customer means, exactly as
 * `CustomerResolver` does for Orders (`server/shop/orders/ports.ts`).
 *
 * TAKEN BY INJECTION, NOT IMPORTED FROM CART DIRECTLY: `resolveShopCustomer`
 * lives in `server/shop/cart/identity/customers.ts`, and reading it from here
 * would couple this subsystem to Cart's implementation instead of to a port —
 * the same seam `server/shop/orders/ports.ts` draws for the identical reason.
 * The composition root (`server/shop/app.ts`, at the reviews mount) is the one
 * place that is allowed to know both halves and wires the real resolver in.
 */
export type ReviewsCustomerResolver = (c: Context<AppEnv>) => Promise<ReviewsCustomer | null>;

/**
 * The default: nobody is signed in.
 *
 * ITS CONSEQUENCE REVERSED WHEN THE INTAKE STARTED REQUIRING A SESSION. This
 * used to mean "degrade to the guest path"; it now means "401 every
 * submission", because the route refuses an unresolved customer. That is the
 * right direction for an auth check — a deployment that forgets to wire the
 * resolver takes reviews down loudly instead of quietly writing rows with
 * nobody attached — but it is a louder failure than the old default implied,
 * and `server/shop/app.ts` is still the only caller that wires the real one.
 */
const NO_CUSTOMER: ReviewsCustomerResolver = () => Promise.resolve(null);

export interface ReviewsDeps {
  customer?: ReviewsCustomerResolver;
}

const auth = requireAuth();

// -------------------------------------------------------------------- budgets

/** Intake, per IP: enough for a household behind one NAT writing a few
 *  reviews in an evening, nowhere near enough to fill a moderation queue. */
const INTAKE_IP_LIMIT = 10;
/** Per (IP, email): the second review "from" the same address is plausible
 *  (a correction, a second product); the fourth is a script. */
const INTAKE_EMAIL_LIMIT = 3;
const INTAKE_WINDOW_MS = 15 * 60 * 1000;

// -------------------------------------------------------------------- schemas

const SubmitBody = z.object({
  productSlug: str().regex(/^[a-z0-9-]+$/, 'a product slug').max(120),
  rating: z.number().int().min(1).max(5),
  title: str().trim().max(200).optional(),
  /** Ten characters is not quality control, it is "the field was not left
   *  holding a single character by accident". Moderation is quality control. */
  body: str().trim().min(10).max(5000),
  /**
   * THE BYLINE, AND THE ONLY THING ABOUT THE AUTHOR THE BODY MAY STILL SAY.
   *
   * OPTIONAL, because the session's `displayName` supplies it whenever the
   * account has one. It stays accepted at all because `shop_customers.display_name`
   * is NULLABLE while `shop_reviews.author_name` is NOT NULL — measured
   * 2026-08-26, THREE OF FOUR customers in production have no display name, so
   * a session-only rule would refuse most of the shop.
   *
   * It is not identity and cannot be forged into anything: `customer_id` and
   * `author_email` both come from the token now, so the worst a caller can do
   * with this field is choose how they are credited on their own review.
   *
   * DERIVING IT FROM THE EMAIL WAS THE OTHER OPTION AND IS REFUSED:
   * `author_name` is rendered publicly (`listReviewsPublic` selects it), so
   * "nathaniel" out of "nathaniel@…" would publish half of an address the
   * projection deliberately never returns.
   */
  authorName: str().trim().min(1).max(120).optional(),
});

/*
 * `authorEmail` IS GONE FROM THIS SCHEMA ON PURPOSE — it is not optional, it is
 * not accepted. The address written to the row and used as the rate-limit key
 * comes from the session and from nowhere else.
 *
 * The schema is NOT `.strict()`, which makes the change safe to deploy ahead of
 * the storefront: a client still sending `authorEmail` has it silently stripped
 * by Zod rather than refused, so the two repositories do not have to ship in the
 * same minute. That leniency is deliberate here and is not a licence to relax
 * the query schemas, which are strict so a mistyped FILTER is a refusal.
 */

const ModerateBody = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'flagged']),
});

const AdminListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'flagged']).optional(),
  product: str().max(120).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  cursor: str().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

// ------------------------------------------------------------------ CORS, once

/**
 * The intake is called by a BROWSER ON ANOTHER ORIGIN — the storefront — and
 * a cross-origin `POST` with a JSON body preflights. Nothing else in this
 * app answers a preflight, because nothing else needs one here: the cacheable
 * public routers are GET-only (simple requests). The customer returns intake
 * (`/me/returns`, `server/marketing/returns/customer.ts`) needed the identical
 * treatment once its own storefront caller arrived, and answers its preflight
 * the same hand-rolled way this route does, for the same reason.
 *
 * NOW THE SHARED `shopCors()` / `shopPreflight()` FROM `server/shop/cart/cors.ts`
 * (admin#26), NOT A HAND-ROLLED COPY. The hand-rolled `corsHeaders()` this
 * used to be existed because, at the time, `shopCors()` was wired into Cart's
 * own router via `built.use('*', ...)` — reachable only as a blanket
 * middleware over EVERY cart path, with no way for a sibling mount like this
 * one to take just the shape without also taking a dependency on Cart's own
 * registration order.
 *
 * That reason is gone. Fixing admin#26 (Orders and Payments returning no
 * `access-control-allow-credentials` on their real responses) made `shopCors()`
 * generic and callable as a scoped, per-route `.use()` on ANY sibling router's
 * own `Hono<AppEnv>` — exactly the shape this file always wanted and could not
 * have. Registering it below is therefore not a new dependency on Cart's
 * mount, only on Cart's `cors.ts` module, same as the type import Reviews
 * already trusted for the reasoning.
 *
 * SCOPED TO `/reviews/submit` ONLY, not the whole router — `shopCors()` would
 * be equally wrong to apply blanket here as it would to lift to `shopApp()`
 * (see the note on Orders): `/reviews`, `/reviews/:id` (GET, PATCH, DELETE)
 * are staff routes behind `requireAuth()`, called from this app's own admin
 * UI, same-origin, and have never been reviewed for a credentialed
 * cross-origin surface. Matches the "decision per mount, not a side effect"
 * principle admin#26 applies to Orders and Payments.
 */

/**
 * The router factory. **Injected**, exactly as `cartShopRoutes` in
 * `server/shop/cart/routes/deps.ts` is: a deployment that forgets to pass
 * `customer` gets `NO_CUSTOMER` and every review submits as a guest, never a
 * 500. `server/shop/app.ts` is the composition root and the only caller that
 * wires the real `resolveShopCustomer`.
 */
export function createReviewRoutes(deps: ReviewsDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const resolveCustomer = deps.customer ?? NO_CUSTOMER;

  /*
   * SCOPED TO THIS ONE PATH, AND BEFORE THE PREFLIGHT HANDLER SO IT ALSO
   * COVERS THE `OPTIONS` RESPONSE — `shopCors()` appends `Vary: Origin` and,
   * for an allowed origin, `access-control-allow-origin` /
   * `-allow-credentials`, on the way out of whatever the preflight or the
   * POST handler below produces. That is the actual duplication this file
   * used to carry: deciding whether an origin may see credentials at all.
   * See the long note above for why it is the shared helper now.
   *
   * `shopPreflight` ITSELF IS NOT REUSED, ON PURPOSE. It answers for every
   * cart path with the same fixed method list (`GET, POST, PATCH, PUT,
   * DELETE`); this route only ever accepts `POST`, and advertising the other
   * four would be an inaccurate answer to "what may you send here" for a
   * route that 404s on all of them. So the method/headers/max-age half of
   * the preflight — the part that is genuinely specific to this one route —
   * stays local, and only the origin-permission half is shared.
   */
  routes.use('/reviews/submit', shopCors<AppEnv>());
  routes.options('/reviews/submit', (c) =>
    c.body(null, 204, {
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    }),
  );

  // ----------------------------------------------------------------- intake

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE PUBLIC MUTATION, REGISTERED ABOVE EVERY `/:id` ROUTE ON PURPOSE — Hono
   * resolves by registration order and `submit` is a legal `:id` value, so this
   * ordering is what keeps a later `POST /reviews/:id` from silently swallowing
   * every storefront submission. The same argument, and the same shape, as the
   * returns desk's intake.
   *
   * NOT `auth`, WHICH IS THE STAFF GUARD — a CUSTOMER session, resolved through
   * `resolveCustomer` and refused with a 401 when absent. Two different
   * populations sign in through two different tables, and `requireAuth()` here
   * would demand an admin account from a shopper.
   *
   * IT USED TO ACCEPT GUESTS, and the identity came from the request body. The
   * security half was already right — a resolved session overrode the body, so
   * nobody could review as somebody else — but the body still had to CARRY a
   * name and an email, which meant the storefront asked every signed-in
   * customer for two things this handler then discarded. That is the wrongness
   * being fixed: identity is read from the token and the body no longer
   * mentions an address at all.
   *
   * `originGuard` above this mount still applies (a cross-origin POST from an
   * origin outside `APP_ORIGINS` is a 403 before this handler runs — DEPLOY
   * NOTE: the storefront's origin must be in `APP_ORIGINS` or every customer
   * sees one), as do both rate budgets and the fact that the row is written
   * `pending` and appears nowhere public until a human approves it.
   * ═══════════════════════════════════════════════════════════════════════
   */
  routes.post('/reviews/submit', async (c) => {
    const ip = clientIp(c);
    /* The IP bucket before the body is read: a limiter cannot bound work that
       runs after it. */
    await limit(c, `revsub:${ip}`, INTAKE_IP_LIMIT, INTAKE_WINDOW_MS);

    const body = await readJson(c, SubmitBody);
    const customer = await resolveCustomer(c);

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * A SESSION IS NOW REQUIRED, AND THIS IS THE ONLY PLACE IDENTITY IS DECIDED.
     *
     * It used to fall back to the body when no session resolved, so a guest
     * could review under any address they typed. The security half was already
     * right — a signed-in customer's session overrode the body — but the body
     * still HAD to carry a name and an email, so the storefront asked every
     * signed-in customer for two things the server then threw away.
     *
     * FAIL-CLOSED, AND THAT REVERSES THE `NO_CUSTOMER` DEFAULT'S INTENT. A
     * deployment that forgets to wire `customer` now 401s every submission
     * instead of accepting everything as a guest. That is the right direction
     * for an auth check — a wiring mistake takes the feature down loudly rather
     * than quietly writing unattributed rows — but it IS a behaviour change for
     * that misconfiguration, and `server/shop/app.ts` is still the only caller
     * that wires the real resolver.
     * ═══════════════════════════════════════════════════════════════════════
     */
    if (!customer) throw new UnauthenticatedError();

    /*
     * The address is the SESSION'S, always. Nullable on `shop_customers` and
     * NOT NULL on `shop_reviews`, so the impossible case is refused here rather
     * than as a 23502 from the driver. Zero of four production customers are in
     * this state today; the guard exists because the column permits it.
     */
    const authorEmail = customer.email;
    if (!authorEmail) {
      throw new BadRequestError('account_email');
    }

    /* The byline: the account's display name when it has one, else what the
       reviewer typed. Three of four customers have no display name, so the
       body's value is a real path and not a legacy branch. */
    const authorName = customer.displayName ?? body.authorName;
    if (!authorName) throw new BadRequestError('authorName');

    /* The narrow bucket cannot move above the parse — it keys on the email
       actually being written. STRONGER THAN IT WAS: the address is now always
       the session's, so varying the body cannot buy a fresh budget at all,
       where before a guest could simply type a different one. */
    await limit(c, `revsub:${ip}|${authorEmail}`, INTAKE_EMAIL_LIMIT, INTAKE_WINDOW_MS);

    const review = await createReview(currentDb(c), {
      productSlug: body.productSlug,
      rating: body.rating,
      title: body.title?.length ? body.title : null,
      body: body.body,
      authorName,
      authorEmail,
      customerId: customer?.id ?? null,
      now: Date.now(),
    });

    /*
     * A NARROW ANSWER: the id (so the storefront can say "we have it"), the
     * status (so it can say "it appears after moderation" honestly), and the
     * sentiment label the pipeline attached — which is also the end-to-end
     * proof the pipeline ran. Not the row: the email would travel back over
     * a cross-origin response for no reason.
     */
    return c.json(
      {
        reviewId: review.id,
        status: review.status,
        sentiment: review.sentimentLabel,
      },
      201,
    );
  });

  // ------------------------------------------------------------------ staff

  routes.get('/reviews', auth, async (c) => {
    const q = readQuery(c, AdminListQuery);
    const page = await listReviewsAdmin(currentDb(c), {
      status: q.status,
      productSlug: q.product,
      sentiment: q.sentiment,
      cursor: q.cursor,
      limit: q.limit,
    });
    return c.json(page);
  });

  routes.get('/reviews/:id', auth, async (c) => {
    const id = pathParam(c, 'id');
    const review = await getReview(currentDb(c), id);
    if (!review) return c.json({ error: 'not_found' }, 404);
    return c.json({ review });
  });

  /**
   * Moderation is open to every authenticated member of the team, mirroring
   * the app's own read/write philosophy: this is one shared shop with an
   * invite-only staff list, and a review queue only two people may touch is a
   * queue that backs up on their day off.
   */
  routes.patch('/reviews/:id', auth, async (c) => {
    const id = pathParam(c, 'id');
    const body = await readJson(c, ModerateBody);
    const review = await moderateReview(
      currentDb(c),
      id,
      body.status,
      currentUser(c).id,
      Date.now(),
    );
    return c.json({ review });
  });

  /**
   * Owner-only, like every other irreversible action in this codebase: a
   * rejected review is already invisible everywhere, so deletion buys nothing
   * a writer needs — it exists for legal removal requests, and those are the
   * owner's to act on.
   */
  routes.delete('/reviews/:id', auth, async (c) => {
    if (currentUser(c).role !== 'owner') throw new ForbiddenError();
    const id = pathParam(c, 'id');
    await destroyReview(currentDb(c), id);
    return c.json({ ok: true });
  });

  return routes;
}
