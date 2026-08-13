import { Hono } from 'hono';
import { toResponse } from '../middleware/errors';
import { MailNotConfiguredError } from '../mail/port';
import { routes as bannerRoutes } from './banners/routes';
import { routes as discountRoutes } from './discounts/routes';
import { routes as ledgerRoutes } from './ledger/routes';
import { createNotifyRoutes } from './notify/routes';
import { routes as programRoutes } from './programs/routes';
import { routes as returnRoutes } from './returns/routes';
import { routes as settingsRoutes } from './settings/routes';
import {
  AlreadyAwardedError,
  BelowMinimumError,
  DuplicateCodeError,
  DuplicateProgramKeyError,
  InsufficientBalanceError,
  InvalidTransitionError,
  ProgramPausedError,
  ProgramTypeMismatchError,
  RedemptionDisabledError,
  ReturnAlreadyOpenError,
  StaleMarketingWriteError,
} from './errors';
import type { AppEnv } from '../app-env';
import type { Mailer } from '../mail/port';

/**
 * The marketing sub-app — everything under `/api/marketing` (spec §Frozen API
 * contract).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE MOUNT IN `server/index.ts`, AND EACH SUBSYSTEM ADDS EXACTLY TWO LINES
 * HERE: one import, one `marketing.route(...)`. The `server/shop/app.ts`
 * arrangement, for the same reason — five task-agents build programs, returns,
 * ledger, banners and discounts against one seam instead of five edits to the
 * composition root, and none of them has to touch a file another stream owns.
 *
 * Programs / Returns / Ledger / Banners / Discounts: append your two lines at
 * the marker below.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const MARKETING_PREFIX = '/marketing';

export interface MarketingAppDeps {
  /**
   * Outbound mail, for `POST /api/marketing/sweep` (spec D6).
   *
   * INJECTED RATHER THAN IMPORTED, the seam `server/mail/port.ts` argues for: a
   * route that delivers a message to a customer's address cannot be tested by
   * having it hand the message back, so the suite drives the real route with a
   * recorder. It is the SAME transport `createApp` gives the auth routes and the
   * email broadcasts, so a deployment has one mailer rather than three and a
   * suite that injects a recorder sees every message this application sends.
   *
   * Optional, and "no transport" is a defined state rather than a crash —
   * whether it arrives absent or arrives as a `resendMailer()` with no API key
   * behind it. Either way the sweep answers `501 mail_not_configured` and the
   * queued intents stay queued, which is the persistent ops banner Stream B
   * renders (spec D6), never a retry loop.
   *
   * Nothing else in this subsystem needs it. The intent rows are written by the
   * transitions that owe them, with their subject and body ALREADY RENDERED from
   * the labels of that instant, so an unconfigured deployment can still inspect
   * a return and award the points — it just has mail waiting.
   */
  mailer?: Mailer;
}

/** What a marketing error becomes on the wire, before the requestId is added. */
interface Rendered {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Spec §Error catalogue, as a function — the eleven marketing rows plus the one
 * shared error whose global rendering is wrong for this subsystem.
 *
 * THE CODES AND THE PAYLOAD KEYS ARE A FROZEN CONTRACT, not a convention. Every
 * row here has a UI treatment written against it in the spec: `invalid_transition`
 * re-renders the true stage out of `request` and keeps a half-typed form alive
 * behind a notice; `return_already_open` links to `existingId` instead of
 * dead-ending; `below_minimum` interpolates `min` into copy built from the
 * program's own labels. A key dropped here is a screen that silently degrades to
 * "something went wrong", so `app.test.ts` asserts each body by EQUALITY rather
 * than by containment — an added key fails just as loudly as a missing one.
 *
 * NOTHING ELSE IS RENDERED HERE. `unauthenticated`, `forbidden`, `gone`,
 * `bad_request`, `stale_write` (the shared shape), `rate_limited` and `internal`
 * fall through to `toResponse`, which is the one implementation the whole
 * application shares — so a marketing route cannot grow its own dialect of the
 * rows every other route already answers. `rate_limited` in particular MUST fall
 * through: `toResponse` is where the `Retry-After` HEADER is set, and the public
 * intake's countdown reads it.
 */
function render(err: unknown): Rendered | null {
  /*
   * 400, not 409. Nothing about the stored state refused this — the number in
   * the box is too small and a bigger one would be accepted. `min` travels
   * because the copy is interpolated from the PROGRAM's labels ("at least 4
   * canisters") and the client cannot know the minimum of a program it has not
   * fetched.
   */
  if (err instanceof BelowMinimumError) {
    return { status: 400, body: { error: 'below_minimum', detail: err.detail, min: err.min } };
  }

  /*
   * THE SIGNATURE 409. `request` is the re-read row, which is what lets the UI
   * auto-heal: it re-renders the true stage from the payload, says so in a
   * toast, and preserves mid-edit inputs behind a `.notice` rather than wiping
   * them to refetch (spec D7). Without the payload every conflict costs a second
   * round trip AND shows a third state — the one true at the time of that second
   * read — as though it were what the write lost to.
   */
  if (err instanceof InvalidTransitionError) {
    return {
      status: 409,
      body: {
        error: 'invalid_transition',
        status: err.status,
        action: err.action,
        request: err.request,
      },
    };
  }

  /*
   * The shared `stale_write` shape with the entity under its own name —
   * `program`, `settings`, `request`, `banner` or `discount` — because marketing
   * has five revisioned entities and none of them is a `post`. Same arrangement
   * as `StaleProductWriteError` in `server/shop/app.ts`, one entity wider.
   */
  if (err instanceof StaleMarketingWriteError) {
    return {
      status: 409,
      body: {
        error: 'stale_write',
        expected: err.expected,
        actual: err.actual,
        [err.entity]: err.current,
      },
    };
  }

  /*
   * A SUCCESS THE CLIENT MUST NOT MISREAD AS A FAILURE (spec D5). An inspection
   * replayed after a flaky connection answers this, and the screen refetches and
   * toasts "already recorded" — which is what makes retrying an inspection safe
   * to offer at all. `entryId` gives the success path the ledger row to link to.
   */
  if (err instanceof AlreadyAwardedError) {
    return { status: 409, body: { error: 'already_awarded', entryId: err.entryId } };
  }

  if (err instanceof ReturnAlreadyOpenError) {
    return {
      status: 409,
      body: { error: 'return_already_open', existingId: err.existingId, status: err.status },
    };
  }

  /* No payload, deliberately: the public storefront learns nothing about which
   * programs exist or why one is closed, and the admin's treatment is one link
   * to the status toggle regardless of which program refused. */
  if (err instanceof ProgramPausedError) {
    return { status: 409, body: { error: 'program_paused' } };
  }

  /* Reachable only by a race, and the wire carries no message BY DESIGN — spec
   * §Error catalogue makes the copy the client's, keyed on the code. */
  if (err instanceof ProgramTypeMismatchError) {
    return { status: 409, body: { error: 'program_type_mismatch' } };
  }

  if (err instanceof InsufficientBalanceError) {
    return { status: 409, body: { error: 'insufficient_balance', balance: err.balance } };
  }

  if (err instanceof RedemptionDisabledError) {
    return { status: 409, body: { error: 'redemption_disabled' } };
  }

  /*
   * 409 AND NOT THE 400 THE BASE CLASS WOULD GIVE. "That key is taken" is a
   * conflict with state; "that key has a capital letter in it" is a malformed
   * field. Collapsed into one answer the form can only say "the key was
   * refused", which sends somebody to inspect characters in a key whose sole
   * problem is that it exists — the defect `DuplicateSkuError` was raised for.
   *
   * NO `detail` KEY, unlike the shop's rendering of the same shape: the
   * catalogue freezes the extras as `key` alone and the client keys its inline
   * error off the CODE. An extra field here is a contract drift that no test on
   * the frontend would notice.
   */
  if (err instanceof DuplicateProgramKeyError) {
    return { status: 409, body: { error: 'duplicate_program_key', key: err.key } };
  }

  if (err instanceof DuplicateCodeError) {
    return { status: 409, body: { error: 'duplicate_code', code: err.code } };
  }

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * THE ONE SHARED ERROR THIS SUBSYSTEM RE-RENDERS, and it is re-rendered
   * because the global answer is wrong HERE specifically.
   *
   * `server/middleware/errors.ts` maps `MailNotConfiguredError` to
   * `501 {error:'not_implemented', feature:'mail-delivery'}`. That is right for
   * the password-reset route, where an unconfigured mailer means the FEATURE is
   * unavailable and the caller can do nothing. It is wrong for the sweep, where
   * an unconfigured mailer means the deployment has queued mail it cannot
   * deliver yet and the admin has a setup step to perform — spec D6 makes that a
   * persistent ops banner ("email transport not configured — N notifications
   * queued"), never a retry loop, and Stream B keys that banner on
   * `mail_not_configured`.
   *
   * The `feature` key is dropped with it: A7's test pins the body as exactly
   * `{error:'mail_not_configured', requestId}`, because a second field naming
   * the same condition is a second thing to keep in step.
   *
   * The status stays 501. It is a configuration problem rather than a caller
   * problem, and it is permanent for this request — so the client's retry policy
   * stops, which is the whole point of not being a 500.
   * ═════════════════════════════════════════════════════════════════════════
   */
  if (err instanceof MailNotConfiguredError) {
    return { status: 501, body: { error: 'mail_not_configured' } };
  }

  return null;
}

export function marketingApp(deps: MarketingAppDeps = {}): Hono<AppEnv> {
  const marketing = new Hono<AppEnv>();

  /**
   * Marketing's own conflict rendering — the `server/shop/app.ts` idiom.
   *
   * A LOCAL HANDLER RATHER THAN AN EDIT TO `server/middleware/errors.ts`, which
   * is not this subsystem's file and which every other router in the application
   * shares. Adding eleven marketing codes to the global table would put this
   * feature's vocabulary in front of routes that will never raise it, and would
   * be an edit to a shared file in a window where two other sessions are
   * building against it.
   *
   * IT IS SAFE TO ESCAPE. Every class `render` recognises subclasses a shared
   * one (`server/marketing/errors.ts` sets out which and why), so a marketing
   * error that reaches the global handler instead — a repo function called
   * outside this app, a route mounted somewhere else later — is still a
   * retry-stopping 4xx with the right status, just a blunter code. Nothing here
   * can turn into a 500 by being mounted differently.
   *
   * ANYTHING ELSE FALLS THROUGH to `toResponse` untouched, so 401, 403, 404,
   * 400, 422, 429 and 500 are answered by the one implementation the whole
   * application shares — including the `Retry-After` header on a 429, which is
   * set there and would be lost by a body-only re-render here.
   */
  marketing.onError((err, c) => {
    const requestId = c.get('requestId') ?? '';
    const rendered = render(err);

    if (!rendered) return toResponse(err, requestId);

    return new Response(JSON.stringify({ ...rendered.body, requestId }), {
      status: rendered.status,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-request-id': requestId,
      },
    });
  });

  /*
   * ==========================================================================
   * THE MOUNT MARKER. Two lines per subsystem, as at the top of this file.
   *
   * AN UNROUTED `/api/marketing/anything` IS STILL A 404 `gone` from the
   * application's own `notFound`, and `app.test.ts` pins it. It is worth
   * pinning because the obvious shortcut for a subsystem where nearly every
   * route needs a session is `marketing.use('*', requireAuth())`, and that
   * turns every unrouted path under this prefix into a 401: the guard runs,
   * finds no session, and refuses a request that had no handler to reach.
   * `server/shop/catalog/routes.ts` records the same defect on the blog side.
   * Auth is attached PER ROUTE in this subsystem for that reason.
   *
   * `deps` is consumed at this marker too: the sweep route takes `deps.mailer`,
   * exactly as `server/shop/app.ts` hands `catalogPort` to the cart router at
   * its own mount line. The composition root is where the halves of a seam are
   * joined, and this is marketing's.
   * ==========================================================================
   */

  /*
   * PROGRAMS — contract #1-3. The rewards programs themselves: every word a
   * customer reads, and the two numbers that decide what a return is worth.
   * Reading the list is `requireAuth`; both writes are `requireOwner`.
   */
  marketing.route('/', programRoutes);

  /*
   * SETTINGS — contract #19-20. The cross-program layer: the words for the
   * surfaces that span every program, the redemption economics, and which
   * program the intake defaults to.
   *
   * THE ORDER OF THESE TWO DOES NOT MATTER, because they claim disjoint paths
   * (`/programs*` and `/settings`). Recorded because the next router along will
   * not be so lucky: returns owns `/returns/request` AND `/returns/:id`, and
   * Hono resolves two routers claiming one path by registration order — the
   * public intake must register before the parameterised route or it is
   * swallowed by it (spec §Risks; A5 pins the order with its own test).
   */
  marketing.route('/', settingsRoutes);

  /*
   * RETURNS — contract #4-14. The lifecycle, the queue that drives it, and the
   * one PUBLIC route this sub-app has.
   *
   * IT MOUNTS AFTER THE OTHER TWO AND THE ORDER STILL DOES NOT MATTER, for the
   * reason above: `/returns*` is disjoint from `/programs*` and `/settings`.
   * What DOES matter is the order INSIDE that router, and it is settled there:
   * `POST /returns/request` — the customer intake, the only unauthenticated
   * route under this prefix — registers above every `/returns/:id` pattern, so
   * a later `POST /returns/:id` cannot swallow it. `returns/routes.ts` pins it.
   */
  marketing.route('/', returnRoutes);

  /*
   * LEDGER — contract #15-18. The customer directory, one customer's balance and
   * history, and the manual adjustment that is the only way points are created
   * or destroyed without a return.
   *
   * THE ORDER DOES NOT MATTER HERE EITHER: `/customers*` and `/adjustments` are
   * disjoint from every path above. What this router does share with returns is
   * the discipline that made the order matter there — `/customers` is registered
   * above `/customers/:email` inside it, so a fixed segment can never be
   * swallowed by a parameterised one.
   */
  marketing.route('/', ledgerRoutes);

  /*
   * NOTIFY — contract #27. The outbox's only caller: the sweep the admin's own
   * inspection fires, because nothing schedules one (spec D6).
   *
   * THIS IS WHERE `deps.mailer` IS FINALLY READ, at the composition point the
   * comment on `MarketingAppDeps` promised — the seam declared in A2 and filled
   * here, so the line that supplies a transport stays in `server/index.ts` and
   * no later task has to edit it. A deployment with none answers 501
   * `mail_not_configured` and leaves the queue intact.
   *
   * `/sweep` is disjoint from every path above, so the order does not matter
   * here either.
   */
  marketing.route('/', createNotifyRoutes({ mailer: deps.mailer }));

  /*
   * BANNERS — contract #21-23. The admin half of the only thing in this
   * subsystem the public internet reads.
   *
   * `/banners*` is disjoint from every path above, so the order does not matter
   * here either. What is worth saying instead is where the OTHER half is:
   * `GET /api/public/marketing/banners` is not in this sub-app at all. It is in
   * `./public.ts`, mounted above `sessionMiddleware` so it cannot read a cookie
   * — the two surfaces share `banners/repo.ts` and nothing else, and the
   * read-time schedule predicate lives there so both of them mean the same
   * thing by "live" (spec D8).
   */
  marketing.route('/', bannerRoutes);

  /*
   * DISCOUNTS — contract #24-26. The model, landing ahead of the surface that
   * will redeem it: `computeTotals` never sees one of these rows in v1 and the
   * Discounts screen is an honest placeholder (spec D1).
   *
   * MOUNTED ANYWAY, rather than held back until something redeems a code,
   * because the routes are what make the model real: an unreachable table is a
   * migration nobody can check, while a mounted CRUD surface is one an owner can
   * fill with the season's codes today and one `server/nul-bytes.test.ts` walks
   * with everything else. `/discounts*` is disjoint from every path above, so
   * the order does not matter here either.
   */
  marketing.route('/', discountRoutes);

  return marketing;
}

/**
 * The public reading surface — re-exported so `server/index.ts` keeps ONE import
 * from this file and needs no edit as the subsystem grows.
 *
 * IT LIVES IN `./public.ts` because of what it is rather than where it is
 * imported from: a cookieless, cacheable router mounted ABOVE
 * `sessionMiddleware` beside `createPublicRoutes`, with a different security
 * posture from every route in the sub-app above. Keeping the two in one file
 * would put "may be stored by a shared cache and handed to another reader" and
 * "resolves a session" in one route table. The long argument, the cache TTLs and
 * the clock seam are all in that file.
 */
export { createMarketingPublicRoutes } from './public';
export type { MarketingPublicDeps } from './public';
