import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { shopCors } from '../cart/cors';
import { ForbiddenError, pathParam, readJson, readQuery, str } from '../../middleware/errors';
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
 * `auth`, the customer intake takes none — a customer session is optional,
 * and its absence still leaves the guest path exactly as it always worked.
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
 * The default: nobody is signed in. A deployment that forgets to wire the
 * real resolver degrades to today's guest-only behaviour rather than 500ing —
 * the same choice Orders makes with `NO_CUSTOMER`.
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
  authorName: str().trim().min(1).max(120),
  authorEmail: str().trim().toLowerCase().email().max(254),
});

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
 * app answers a preflight, because nothing else needed one: the cacheable
 * public routers are GET-only (simple requests), and the returns intake has
 * no storefront caller yet. This is where that stops being deferrable.
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
   * NO `auth`, still, but not because accounts don't exist — they do. A
   * customer session is OPTIONAL here the same way it is on the storefront's
   * checkout: `originGuard` above this mount (a cross-origin POST from an
   * origin outside `APP_ORIGINS` is a 403 before this handler runs — DEPLOY
   * NOTE: the storefront's origin must be in `APP_ORIGINS` or every customer
   * sees one), the two rate budgets, and the fact that the row this writes is
   * `pending` are what stand in place of a hard auth requirement — it grants
   * nothing and appears nowhere public until a human approves it.
   *
   * WHEN A SESSION RESOLVES, THE SESSION WINS. `customer_id` is set, and the
   * stored email is the session's — never the body's — so a signed-in
   * customer cannot attribute a review to somebody else's address by editing
   * the request. The session's `displayName` wins over the body's
   * `authorName` when it has one. A customer whose own `email` is null (a
   * guest row that never claimed an address) falls back to the body's email,
   * so a signed-in guest can still review.
   * ═══════════════════════════════════════════════════════════════════════
   */
  routes.post('/reviews/submit', async (c) => {
    const ip = clientIp(c);
    /* The IP bucket before the body is read: a limiter cannot bound work that
       runs after it. */
    await limit(c, `revsub:${ip}`, INTAKE_IP_LIMIT, INTAKE_WINDOW_MS);

    const body = await readJson(c, SubmitBody);
    const customer = await resolveCustomer(c);

    /* The session's email, when it has one, is what gets written and what the
       rate limit keys on — never the body's, once a session resolves. A
       customer whose row has no email (a guest who never claimed one) still
       falls back to the body, or a signed-in guest could never review. */
    const authorEmail = customer?.email ?? body.authorEmail;
    const authorName = customer?.displayName ?? body.authorName;

    /* The narrow bucket cannot move above the parse — it keys on the email
       actually being written, so a signed-in customer cannot get a fresh
       budget by varying the body. Already lower-cased by the schema when it
       comes from the body; the session's is normalised at write time. */
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
