import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
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
 * `auth`, the customer intake takes none — a customer has no session, and
 * that absence is the route.
 */

export const routes = new Hono<AppEnv>();

const auth = requireAuth();

// ------------------------------------------------------------------ budgets

/** Intake, per IP: enough for a household behind one NAT writing a few
 *  reviews in an evening, nowhere near enough to fill a moderation queue. */
const INTAKE_IP_LIMIT = 10;
/** Per (IP, email): the second review "from" the same address is plausible
 *  (a correction, a second product); the fourth is a script. */
const INTAKE_EMAIL_LIMIT = 3;
const INTAKE_WINDOW_MS = 15 * 60 * 1000;

// ------------------------------------------------------------------ schemas

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

// -------------------------------------------------------------- CORS, once

/**
 * The intake is called by a BROWSER ON ANOTHER ORIGIN — the storefront — and
 * a cross-origin `POST` with a JSON body preflights. Nothing else in this
 * app answers a preflight, because nothing else needed one: the cacheable
 * public routers are GET-only (simple requests), and the returns intake has
 * no storefront caller yet. This is where that stops being deferrable.
 *
 * The allow-list is `APP_ORIGINS`, via the same `c.get('origins')` the
 * origin guard publishes — ONE list decides both "may this origin write"
 * (the guard's 403) and "may this browser read the answer" (these headers).
 * The echo is the specific origin, never `*`: a wildcard cannot be scoped
 * down later without breaking callers, and `Vary: Origin` keeps any cache
 * from serving one origin's approval to another.
 */
function corsHeaders(c: Context<AppEnv>): Record<string, string> {
  const origin = c.req.header('Origin');
  const allowed = c.get('origins') ?? [];
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
  };
}

routes.options('/reviews/submit', (c) => {
  const cors = corsHeaders(c);
  if (!('access-control-allow-origin' in cors)) return c.body(null, 204);
  return c.body(null, 204, {
    ...cors,
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  });
});

// ------------------------------------------------------------------- intake

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PUBLIC MUTATION, REGISTERED ABOVE EVERY `/:id` ROUTE ON PURPOSE — Hono
 * resolves by registration order and `submit` is a legal `:id` value, so this
 * ordering is what keeps a later `POST /reviews/:id` from silently swallowing
 * every storefront submission. The same argument, and the same shape, as the
 * returns desk's intake.
 *
 * NO `auth`, stated rather than implied: customer accounts do not exist yet
 * (the auth bundle is sequenced after this). What stands in its place:
 * `originGuard` above this mount (a cross-origin POST from an origin outside
 * `APP_ORIGINS` is a 403 before this handler runs — DEPLOY NOTE: the
 * storefront's origin must be in `APP_ORIGINS` or every customer sees one),
 * the two rate budgets, and the fact that the row this writes is `pending` —
 * it grants nothing and appears nowhere public until a human approves it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
routes.post('/reviews/submit', async (c) => {
  const ip = clientIp(c);
  /* The IP bucket before the body is read: a limiter cannot bound work that
     runs after it. */
  await limit(c, `revsub:${ip}`, INTAKE_IP_LIMIT, INTAKE_WINDOW_MS);

  const body = await readJson(c, SubmitBody);

  /* The narrow bucket cannot move above the parse — the email it keys on is
     in the body. Already lower-cased by the schema, so `Dara@x` and `dara@x`
     share one budget. */
  await limit(c, `revsub:${ip}|${body.authorEmail}`, INTAKE_EMAIL_LIMIT, INTAKE_WINDOW_MS);

  const review = await createReview(currentDb(c), {
    productSlug: body.productSlug,
    rating: body.rating,
    title: body.title?.length ? body.title : null,
    body: body.body,
    authorName: body.authorName,
    authorEmail: body.authorEmail,
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
    corsHeaders(c),
  );
});

// -------------------------------------------------------------------- staff

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
