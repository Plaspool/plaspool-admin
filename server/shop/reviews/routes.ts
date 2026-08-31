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
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { clientIp, limit } from '../../middleware/ratelimit';
import { requireAuth } from '../../middleware/session';
import { isAdminRole } from '../../../shared/roles';
import { currentDb, currentUser } from '../../app-env';
import {
  createReview,
  destroyReview,
  getReview,
  listReviewsAdmin,
  moderateReview,
} from './repo';
import {
  purchasedProduct,
  purchasedProducts,
  reviewProductSlug,
  reviewedProducts,
} from './eligibility';
import {
  OWNER_BYLINE,
  clearReaction,
  createReply,
  destroyReply,
  moderateReply,
  reactionCounts,
  reactionsOf,
  repliesForAdmin,
  setReaction,
} from './threads';
import type { AppEnv } from '../../app-env';
import type { Db } from '../../db/client';

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

/**
 * Queue the "your review is live" message. Returns whether one was written.
 *
 * A PORT, FOR THE REASON `ReviewsCustomerResolver` IS ONE, AND FOR A SECOND.
 * The implementation lives in `server/shop/orders/review-mail.ts` because
 * Orders owns the outbox, the renderer and every table involved — and because
 * `eligibility.ts` already spends the single cross-subsystem table read that
 * contract §2 R3 tolerates, with a comment promising the next crossing gets a
 * seam instead of a second exception. This is that seam.
 *
 * DEFAULTS TO A NO-OP, WHICH IS THE RIGHT DIRECTION HERE and the opposite of
 * the customer resolver's. An unwired resolver must take reviews DOWN, because
 * accepting unattributed reviews is worse than refusing everything. An unwired
 * mailer must not: nobody should be unable to approve a review because the
 * post-approval email is misconfigured.
 */
export type ReviewApprovedMailer = (
  db: Db,
  input: { reviewId: string; orderId: string; to: string },
) => Promise<boolean>;

const NO_MAIL: ReviewApprovedMailer = () => Promise.resolve(false);

export interface ReviewsDeps {
  customer?: ReviewsCustomerResolver;
  reviewApprovedMailer?: ReviewApprovedMailer;
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
/** Replies are cheaper to write than reviews and a thread is a conversation,
 *  so the budget is looser — but still a budget. */
const REPLY_IP_LIMIT = 30;
const REPLY_CUSTOMER_LIMIT = 10;
/** A reaction is one click. The ceiling is here to bound a script, not a
 *  shopper working down a product page. */
const REACTION_IP_LIMIT = 120;

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

/** A customer's reply (migration 0620). Identity is NOT in here — see below. */
const ReplyBody = z.object({
  /** Absent or null replies to the REVIEW; an id replies to that reply. */
  parentId: str().max(100).nullish(),
  body: str().trim().min(2).max(2000),
  /** The byline, on the same terms as a review's: the account's display name
   *  wins, and this is the fallback for an account that has none. */
  authorName: str().trim().min(1).max(120).optional(),
});

/** The owner's reply. No byline field at all — the shop replies as the shop. */
const StaffReplyBody = z.object({
  parentId: str().max(100).nullish(),
  body: str().trim().min(2).max(2000),
});

/** `null` clears the reaction. There is no `kind: 'none'` state to store. */
const ReactionBody = z.object({
  kind: z.enum(['helpful', 'unhelpful']).nullable(),
});

const MineQuery = z.object({ reviews: str().max(4000) }).strict();
/** The page size the storefront lists, with room to spare. */
const MAX_BULK_REVIEWS = 100;

/**
 * The eligibility read's query. Slug grammar and ceiling copied from the public
 * aggregates route DELIBERATELY — a page asks both about the same list of
 * products in the same page load, and two different limits would make one of
 * the two calls fail for a grid the other one served.
 */
const MAX_BULK_PRODUCTS = 60;
const EligibilityQuery = z.object({ products: str().max(MAX_BULK_PRODUCTS * 121) }).strict();

/**
 * The two refusals a review mutation can now carry, and the only two.
 *
 * NAMED CONSTANTS BECAUSE THE STOREFRONT BRANCHES ON THEM. These strings are a
 * wire contract, not log text: a typo here is a storefront that falls through
 * to its generic failure copy, which is the one outcome this whole feature is
 * meant to prevent.
 */
export const PURCHASE_REQUIRED = 'purchase_required';
export const ALREADY_REVIEWED = 'already_reviewed';

/**
 * Turn a `createReply` refusal into the response it deserves.
 *
 * EACH REASON GETS ITS OWN ANSWER because each is a different thing to tell
 * somebody: the review is gone, the review is not public, you replied to a
 * reply that does not exist, you replied too deep. Collapsing them into one
 * 400 would make the storefront guess.
 */
function replyRefusal(reason: string): Error {
  switch (reason) {
    case 'review_missing':
    case 'review_not_approved':
      /* NOT FOUND for both, deliberately: answering differently would tell an
         anonymous caller which pending reviews exist. */
      return new NotFoundError('review');
    case 'parent_missing':
    case 'parent_mismatch':
      return new NotFoundError('parent');
    case 'too_deep':
      return new BadRequestError('parentId');
    default:
      return new BadRequestError('reply');
  }
}

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
/**
 * The gate the reply and reaction routes share: this customer must have bought
 * the product the review under discussion is about.
 *
 * `slug` IS TAKEN WHEN THE CALLER ALREADY HAS THE ROW. The reaction route reads
 * the review anyway to check it is approved; making it read again here would be
 * a second statement for a value already in hand. The reply route does not have
 * one, so this looks it up — and a review that has vanished between the two is
 * a 404, not a 403, because "gone" is the honest answer and a 403 would tell an
 * ineligible caller that the id was real.
 */
async function requirePurchaseFor(
  c: Context<AppEnv>,
  customer: ReviewsCustomer,
  reviewId: string,
  slug?: string,
): Promise<void> {
  const db = currentDb(c);
  const productSlug = slug ?? (await reviewProductSlug(db, reviewId));
  if (!productSlug) throw new NotFoundError(reviewId);
  const proof = await purchasedProduct(db, customer, productSlug);
  if (!proof) throw new ForbiddenError(PURCHASE_REQUIRED);
}

export function createReviewRoutes(deps: ReviewsDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const resolveCustomer = deps.customer ?? NO_CUSTOMER;
  const mailApproved = deps.reviewApprovedMailer ?? NO_MAIL;

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

    const db = currentDb(c);

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE PURCHASE GATE (brief §2). A session says WHO; this says WHETHER.
     *
     * AFTER the rate limits on purpose. Both budgets bound the work an
     * unauthenticated flood can cause, and moving a database read above them
     * would let a script make this route do two joins per request for free —
     * the limiter cannot bound work that runs before it.
     *
     * THE PROOF IS RECORDED, not just checked. `orderId` goes on the row, so
     * "prove this reviewer bought it" has an answer six months from now that
     * does not depend on re-running this query against orders that have since
     * been refunded, or against a product whose variants have been retired.
     * The column has been sitting on `shop_reviews` unused since the schema was
     * written, with a comment predicting exactly this use.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const proof = await purchasedProduct(db, customer, body.productSlug);
    if (!proof) throw new ForbiddenError(PURCHASE_REQUIRED);

    /* One review per customer per product. Checked HERE rather than by a unique
       index, because the two ways of owning a review (account, or the email on
       an older row) cannot both be expressed as one constraint — and a race
       between two submissions from one person is a duplicate in a moderation
       queue, not a corruption. */
    const already = await reviewedProducts(db, customer, [body.productSlug]);
    if (already.has(body.productSlug)) throw new ForbiddenError(ALREADY_REVIEWED);

    const review = await createReview(db, {
      productSlug: body.productSlug,
      rating: body.rating,
      title: body.title?.length ? body.title : null,
      body: body.body,
      authorName,
      authorEmail,
      customerId: customer.id,
      orderId: proof.orderId,
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

  /**
   * WHAT THIS SHOPPER MAY REVIEW — the read the product page gates on.
   *
   * BELOW `sessionMiddleware`, BESIDE `reactions/mine`, AND NOT ON THE PUBLIC
   * ROUTER. The answer is different for every reader, and the public reviews
   * router answers with `Cache-Control: public` from above the session
   * middleware — a per-viewer field there is one shopper's purchase history
   * handed to another by a shared cache (threat T6). This is the same argument
   * that put `reactions/mine` here, and adding `canReview` to the public
   * payload instead would be a one-line change that looks like saving a round
   * trip and is actually a leak. It is written down in the brief for the same
   * reason it is written down here.
   *
   * AN ABSENT SESSION IS AN EMPTY OBJECT, NOT A 401 — again like
   * `reactions/mine`. A logged-out shopper reading a product page is not an
   * error, and the storefront should render the sign-in prompt rather than
   * handle a refusal on a read.
   */
  routes.use('/reviews/eligibility', shopCors<AppEnv>());
  routes.get('/reviews/eligibility', async (c) => {
    const q = readQuery(c, EligibilityQuery);
    const slugs = q.products
      .split(',')
      .map((slug) => slug.trim())
      .filter((slug) => slug.length > 0);

    if (slugs.length === 0) throw new BadRequestError('products');
    if (slugs.length > MAX_BULK_PRODUCTS) throw new BadRequestError('products');
    /* Named individually so a refusal points at the offending slug rather than
       rejecting a list of sixty for one bad character in the middle of it —
       the aggregates route's rule, kept identical because a page sends the same
       list to both. */
    for (const slug of slugs) {
      if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 120) {
        throw new BadRequestError('products');
      }
    }

    const customer = await resolveCustomer(c);
    if (!customer) return c.json({ eligible: {} });

    const db = currentDb(c);
    const [bought, reviewed] = await Promise.all([
      purchasedProducts(db, customer, slugs),
      reviewedProducts(db, customer, slugs),
    ]);

    /* EVERY REQUESTED SLUG IS IN THE ANSWER, including ones with no claim on
       them, which come back as two falses. An omission would make every caller
       write the same "missing means false" branch — the promise the aggregates
       route already makes about the same list of products. */
    const eligible: Record<string, { canReview: boolean; hasReviewed: boolean }> = {};
    for (const slug of slugs) {
      eligible[slug] = {
        canReview: bought.has(slug),
        hasReviewed: reviewed.has(slug),
      };
    }

    /* The proving order id is NOT on the wire. The storefront has no use for
       it, and it is another customer-identifying value crossing an origin for
       nothing. */
    return c.json({ eligible });
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
    const before = await getReview(currentDb(c), id);
    const review = await moderateReview(
      currentDb(c),
      id,
      body.status,
      currentUser(c).id,
      Date.now(),
    );

    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE REVIEWER HEARS THAT THEIR REVIEW IS LIVE — but only on the EDGE into
     * `approved`, and only for a review that has a proving order.
     *
     * ON THE EDGE, NOT ON THE STATE. `before.status !== 'approved'` is what
     * makes re-approving an already-approved review silent: a moderator
     * flipping a status twice while making up their mind is not news to the
     * person who wrote it. (`queueReviewApprovedEmail` also dedupes on the
     * review id, so this is the second of two independent guards — the first
     * one that is wrong still cannot send a duplicate.)
     *
     * NO PROVING ORDER MEANS NO MESSAGE. Every review written before the
     * purchase gate shipped has a null `order_id`, and the outbox this rides
     * requires one. Those authors never expected a message; migration 0640's
     * header records the hole rather than leaving it to be rediscovered.
     *
     * IT DOES NOT FAIL THE APPROVAL. The moderator's action has committed by
     * the time this runs, and a mailer problem must not present itself as "the
     * approval did not work" — the outbox is drained by the sweep, and an
     * intent that is never written is a missing email, not a missing approval.
     * ═══════════════════════════════════════════════════════════════════════
     */
    if (review.status === 'approved' && before?.status !== 'approved' && review.orderId) {
      await mailApproved(currentDb(c), {
        reviewId: review.id,
        orderId: review.orderId,
        to: review.authorEmail,
      });
    }

    return c.json({ review });
  });

  /**
   * Owner-only, like every other irreversible action in this codebase: a
   * rejected review is already invisible everywhere, so deletion buys nothing
   * a writer needs — it exists for legal removal requests, and those are the
   * owner's to act on.
   */
  routes.delete('/reviews/:id', auth, async (c) => {
    if (!isAdminRole(currentUser(c).role)) throw new ForbiddenError();
    const id = pathParam(c, 'id');
    await destroyReview(currentDb(c), id);
    return c.json({ ok: true });
  });


  // ------------------------------------------------- replies + reactions (0620)

  /**
   * A CUSTOMER's reply, on a review or on another reply.
   *
   * SAME AUTH RULE AS THE INTAKE, AND FOR THE SAME REASONS: a customer session
   * is required, identity is read from it, and the row lands `pending` and is
   * invisible until a human approves it. The body says what was written and
   * where it hangs — never who wrote it.
   *
   * REGISTRATION ORDER IS NOT LOAD-BEARING HERE, unlike `submit`. That one had
   * to precede `/reviews/:id` because `submit` is a legal `:id` value and Hono
   * resolves by registration order. These paths carry three segments where the
   * staff routes carry two, so nothing above can swallow them and they sit at
   * the end of the file where they were added.
   *
   * The exception worth watching is `/reviews/reactions/mine`: `reactions` is a
   * legal `:id` too, so if anyone ever adds a two-segment `GET /reviews/:id/*`
   * wildcard above it, that ordering becomes load-bearing after all.
   *
   * SHARES `shopCors` WITH THE INTAKE. Same cross-origin browser, same
   * credentialed POST, so the same preflight and the same origin permission.
   */
  routes.use('/reviews/:id/replies', shopCors<AppEnv>());
  routes.options('/reviews/:id/replies', (c) =>
    c.body(null, 204, {
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    }),
  );

  routes.post('/reviews/:id/replies', async (c) => {
    const ip = clientIp(c);
    await limit(c, `rplsub:${ip}`, REPLY_IP_LIMIT, INTAKE_WINDOW_MS);

    const reviewId = pathParam(c, 'id');
    const body = await readJson(c, ReplyBody);
    const customer = await resolveCustomer(c);
    if (!customer) throw new UnauthenticatedError();

    /* The narrow budget keys on the customer, not on anything they can vary —
       the same strengthening the review intake got. */
    await limit(c, `rplsub:${ip}|${customer.id}`, REPLY_CUSTOMER_LIMIT, INTAKE_WINDOW_MS);

    /* Judged against the product the REVIEW is about — never against anything
       in the body, which would let one purchase unlock the whole shop. */
    await requirePurchaseFor(c, customer, reviewId);

    const authorName = customer.displayName ?? body.authorName;
    if (!authorName) throw new BadRequestError('authorName');

    const result = await createReply(currentDb(c), {
      reviewId,
      parentId: body.parentId ?? null,
      body: body.body,
      authorKind: 'customer',
      authorName,
      customerId: customer.id,
      staffUserId: null,
      now: Date.now(),
    });

    if (!result.ok) throw replyRefusal(result.reason);

    /*
     * NARROW, LIKE THE INTAKE'S ANSWER. The id and the status, so the
     * storefront can say "we have it, it appears after moderation" honestly.
     * Not the row — there is nothing on it a cross-origin caller needs, and
     * `customerId` travelling back would be pointless.
     */
    return c.json({ replyId: result.reply.id, status: result.reply.status }, 201);
  });

  /**
   * A CUSTOMER's reaction. `PUT`, not `POST`, because it is idempotent: the
   * body names the state you want, not an event to append. Sending `helpful`
   * twice leaves one helpful vote.
   *
   * THE TOGGLE IS THE CLIENT'S, NOT THE SERVER'S. "Clicking helpful twice
   * clears it" is a UI affordance, and a server that flipped state based on
   * what it found would make two clicks from two tabs land on whichever order
   * they arrived in. The client sends `null` to clear.
   */
  routes.use('/reviews/:id/reactions', shopCors<AppEnv>());
  routes.options('/reviews/:id/reactions', (c) =>
    c.body(null, 204, {
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    }),
  );

  routes.put('/reviews/:id/reactions', async (c) => {
    const ip = clientIp(c);
    await limit(c, `rct:${ip}`, REACTION_IP_LIMIT, INTAKE_WINDOW_MS);

    const reviewId = pathParam(c, 'id');
    const body = await readJson(c, ReactionBody);
    const customer = await resolveCustomer(c);
    if (!customer) throw new UnauthenticatedError();

    const db = currentDb(c);
    /* The review must exist AND be approved: reacting to a pending review is a
       way to learn that one exists, and there is nothing public to react to. */
    const review = await getReview(db, reviewId);
    if (!review || review.status !== 'approved') throw new NotFoundError(reviewId);

    /*
     * CLEARING A VOTE IS GATED TOO, and that is deliberate rather than an
     * oversight of the `kind === null` branch below. A shopper who could clear
     * but not set would have a button that works in one direction, which reads
     * as a bug from the outside; and the check is against the same product
     * either way, so an ineligible caller has no vote to clear in the first
     * place. The 404 above already ran, so this cannot be used to probe for
     * reviews.
     */
    await requirePurchaseFor(c, customer, reviewId, review.productSlug);

    if (body.kind === null) {
      await clearReaction(db, reviewId, customer.id);
    } else {
      await setReaction(db, reviewId, customer.id, body.kind, Date.now());
    }

    /* The new counts in the same answer, so a click needs no follow-up read.
       `helpful` only — the public never sees the dislike tally (0620). */
    const counts = await reactionCounts(db, [reviewId]);
    return c.json({
      reviewId,
      viewerReaction: body.kind,
      helpfulCount: counts.get(reviewId)?.helpful ?? 0,
    });
  });

  /**
   * WHICH REVIEWS THIS VIEWER HAS REACTED TO — the one piece of reaction state
   * that varies by reader.
   *
   * IT IS HERE AND NOT ON `/api/public/reviews`, AND THAT PLACEMENT IS THE
   * WHOLE REASON THIS ROUTE EXISTS. The public reviews router is mounted ABOVE
   * `sessionMiddleware` and every response there carries `Cache-Control:
   * public`, so a shared cache may hand one reader's copy to another. A
   * per-viewer field on such a response is threat T6 exactly — one shopper
   * seeing another's votes. Everything cacheable (the replies, the helpful
   * count) rides the public route; this, which cannot be cached, does not.
   *
   * An absent session is an EMPTY MAP rather than a 401: a logged-out shopper
   * reading a product page is not an error, and the storefront should render
   * unfilled buttons rather than handle a refusal on a read.
   */
  routes.use('/reviews/reactions/mine', shopCors<AppEnv>());
  routes.get('/reviews/reactions/mine', async (c) => {
    const q = readQuery(c, MineQuery);
    const ids = q.reviews
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length === 0 || ids.length > MAX_BULK_REVIEWS) throw new BadRequestError('reviews');

    const customer = await resolveCustomer(c);
    if (!customer) return c.json({ reactions: {} });

    const mine = await reactionsOf(currentDb(c), ids, customer.id);
    /* Only the ids that HAVE a reaction appear. An absent key is "no vote",
       which is what the storefront renders by default anyway. */
    return c.json({ reactions: Object.fromEntries(mine) });
  });

  // ------------------------------------------------------------ staff: replies

  /**
   * THE OWNER'S REPLY. Staff auth, and it is `approved` the moment it is
   * written — queueing staff writing for staff approval is theatre, and
   * `createReply` enforces that rather than this route.
   *
   * `authorName` IS NOT TAKEN FROM THE BODY. Publicly the shop replies as the
   * shop, so the byline is the constant `OWNER_BYLINE` and the storefront
   * renders the logomark beside it. WHO actually typed it is recorded in
   * `staff_user_id` and stays admin-only — "which of us answered this angry
   * review" is a question the owner will eventually ask, and a public name on
   * it is a staff member's name on a stranger's screen.
   */
  routes.post('/reviews/:id/staff-replies', auth, async (c) => {
    const reviewId = pathParam(c, 'id');
    const body = await readJson(c, StaffReplyBody);
    const result = await createReply(currentDb(c), {
      reviewId,
      parentId: body.parentId ?? null,
      body: body.body,
      authorKind: 'owner',
      authorName: OWNER_BYLINE,
      customerId: null,
      staffUserId: currentUser(c).id,
      now: Date.now(),
    });
    if (!result.ok) throw replyRefusal(result.reason);
    return c.json({ reply: result.reply }, 201);
  });

  /**
   * Every reply on one review whatever its status, PLUS both reaction counts —
   * the whole moderation panel in one read.
   *
   * `unhelpful` IS HERE AND IS NOWHERE PUBLIC. That asymmetry is the feature:
   * a public dislike tally is a scoreboard for brigading, and the owner still
   * wants to know a review is landing badly. This route is behind `auth`, so
   * this is the surface where the number belongs.
   */
  routes.get('/reviews/:id/replies', auth, async (c) => {
    const db = currentDb(c);
    const reviewId = pathParam(c, 'id');
    const [replies, counts] = await Promise.all([
      repliesForAdmin(db, reviewId),
      reactionCounts(db, [reviewId]),
    ]);
    return c.json({
      replies,
      reactions: counts.get(reviewId) ?? { helpful: 0, unhelpful: 0 },
    });
  });

  routes.patch('/replies/:id', auth, async (c) => {
    const id = pathParam(c, 'id');
    const body = await readJson(c, ModerateBody);
    const reply = await moderateReply(
      currentDb(c),
      id,
      body.status,
      currentUser(c),
      Date.now(),
    );
    if (!reply) throw new NotFoundError(id);
    return c.json({ reply });
  });

  /** Owner-only, matching review deletion: it is for removal requests. */
  routes.delete('/replies/:id', auth, async (c) => {
    if (!isAdminRole(currentUser(c).role)) throw new ForbiddenError();
    const id = pathParam(c, 'id');
    if (!(await destroyReply(currentDb(c), id))) throw new NotFoundError(id);
    return c.json({ ok: true });
  });

  return routes;
}
