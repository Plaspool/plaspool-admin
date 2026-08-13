import { Hono } from 'hono';
import { requireAuth } from '../../middleware/session';
import { resendMailer } from '../../mail/resend';
import { currentDb } from '../../app-env';
import { sweepMarketingEmailIntents } from './sweep';
import type { AppEnv } from '../../app-env';
import type { Mailer } from '../../mail/port';

/**
 * `POST /api/marketing/sweep` — contract #27, the only caller the outbox has.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING SCHEDULES THIS, AND THAT IS A DECISION RATHER THAN AN OMISSION. Both
 * of the deployment's daily cron slots are spent (spec D6), so the sweep that
 * sends a customer's award letter is the one the admin's own inspection fires,
 * fire-and-forget, from the screen that awarded the points. Latency is bounded
 * by that; anything still queued is counted on the Overview
 * (`pendingEmailIntents`), so a dropped sweep is visible rather than silent. The
 * named escape hatch is a future composite daily drain taking over the
 * `/api/admin/email/drain` slot.
 *
 * `requireAuth`, NOT `requireOwner` — a DELIBERATE, DOCUMENTED DEVIATION from
 * the shop's owner-only `POST /api/shop/admin/sweep`. There, sweeping also
 * drains the commerce event outbox, which turns captures into paid orders: it
 * moves money-adjacent state. Here every body being delivered was frozen by a
 * transition that was itself guard-checked, and sweeping is pure delivery — it
 * writes `sent_at`, `attempts` and `last_error` and touches nothing a customer
 * owns. Owner-only would mean a writer's inspection queues a letter that only
 * the owner can release, which is a customer waiting for the owner to log in.
 *
 * ATTACHED PER ROUTE, NEVER `routes.use('*', …)` — the long version is in
 * `../programs/routes.ts`; a blanket guard turns every unrouted path under
 * `/api/marketing` into a 401 instead of a 404.
 *
 * NO BODY IS READ. Contract #27 sends `{}` and the batch size is a constant in
 * `sweep.ts`. An endpoint that took a `limit` would be an endpoint somebody can
 * point at the whole queue from a phone, and the one thing worth tuning here is
 * how often it is called, not how much it does per call. The shop's sweep route
 * takes no body for the same reason.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface NotifyRoutesDeps {
  /** Optional; the factory defaults to the real transport, which is lazy. */
  mailer?: Mailer;
}

export function createNotifyRoutes(deps: NotifyRoutesDeps = {}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /*
   * `deps.mailer ?? resendMailer()`, exactly as `createEmailRoutes` and
   * `createAuthRoutes` resolve theirs, so a deployment has ONE transport and a
   * suite that injects a recorder sees every message this application sends.
   * `resendMailer()` reads nothing at construction — building the app still
   * demands no mail configuration.
   */
  const mailer = deps.mailer ?? resendMailer();

  routes.post('/sweep', requireAuth(), async (c) => {
    /*
     * ASKED BEFORE ANYTHING IS CLAIMED, and this is the whole reason the port
     * has `assertConfigured` at all (`server/mail/port.ts`). Left to `send` to
     * discover, an unconfigured deployment would spend one of every intent's
     * eight attempts per sweep and record a provider error against a customer's
     * letter — so the queue would degrade, permanently, because of a missing
     * environment variable. Asked first, the queue is untouched and the answer
     * is a setup instruction.
     *
     * It becomes `501 {error:'mail_not_configured', requestId}` through
     * marketing's own `onError` — NOT the global table's `not_implemented`,
     * which is right for the password-reset route and wrong here (`../app.ts`
     * carries the argument; `sweep.test.ts` pins the body). Spec D6 makes it a
     * persistent ops banner counting the queue, never a retry loop.
     */
    mailer.assertConfigured?.();

    /* `Date.now()` at the route, like every other write in this subsystem: the
     * repository takes the instant as an argument so a test can name it. */
    const summary = await sweepMarketingEmailIntents(currentDb(c), mailer, Date.now());
    return c.json(summary);
  });

  return routes;
}
