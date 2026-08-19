import { Hono } from 'hono';
import { z } from 'zod';
import { shopCors } from '../cart/cors';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireOwner } from '../../middleware/session';
import { NotFoundError } from '../../repo/errors';
import { currentDb, currentUser } from '../../app-env';
import { ProviderError } from './provider/scrub';
import { paystackProvider, paymentsEnv } from './config';
import { cancelIntent, createIntent, getIntent, applyIntentStatus } from './intents';
import { createRefund, listRefunds } from './refunds';
import { completeCheckoutForIntent, drainPaymentEvents, processEvent, storeEvent } from './webhook';
import type { Context } from 'hono';
import type { AppEnv } from '../../app-env';
import { DEFAULT_PAYMENTS_CALLBACK_URL } from './utils/callback-url';
import type { Db } from '../../db/client';
import type { PaymentsCheckoutPort } from './checkout';
import type { PaymentProvider } from './provider/types';

/**
 * The HTTP surface (contract §10: everything under `/api/shop`, admin routes
 * under `/api/shop/admin/*`).
 *
 * TWO ROUTERS, AND THE SPLIT IS A SECURITY BOUNDARY RATHER THAN TIDINESS.
 * The webhook router must be mounted BEFORE `originGuard`; `routes` must be
 * mounted after it, like everything else. See the long note on
 * `createWebhookRoutes` — and AMENDMENTS A-001, because the mount itself is in
 * `server/index.ts`, which this subsystem does not own.
 *
 * DEPENDENCIES ARE INJECTED, NEVER IMPORTED AT MODULE SCOPE. `createApp` in
 * `server/index.ts` documents what happens otherwise: a module-scope
 * `getDb()` turned an anonymous 401 and a forged-origin 403 into 500s on a
 * deployment whose environment was wrong. A module-scope `paystackProvider()`
 * would be the same defect with a worse blast radius — importing the shop would
 * demand `PAYSTACK_SECRET_KEY`, so a deployment that has not set up payments
 * could not serve its catalog.
 */

export interface PaymentDeps {
  /** The handle, or a factory. Defaulted to the real, scrubbed Paystack adapter. */
  provider?: PaymentProvider | (() => PaymentProvider);
  /** Cart's port. Required — see `checkout.ts` for why it is not imported. */
  checkout?: PaymentsCheckoutPort;
  /** Where the customer lands after paying. A UI hint only. */
  callbackUrl?: string;

  /**
   * DRAIN `commerce_events` OPPORTUNISTICALLY AFTER A CAPTURE (admin#29).
   *
   * Orders reacts to the outbox and nothing was draining it: every row in
   * production sat `processed_at = NULL, attempts = 0`. The scheduled backstop
   * now runs inside the cart-maintenance cron — `vercel.json` is at the Hobby
   * ceiling of two crons, so a third was not available — but a Hobby cron runs
   * DAILY with up to an hour of jitter, and a customer waiting a day to learn
   * their order exists is not an order pipeline. So the capture path drains a
   * few rows itself and the cron becomes the backstop for parked and failed
   * events rather than the primary path.
   *
   * INJECTED RATHER THAN IMPORTED: Payments reaches Orders through the outbox
   * and nowhere else (contract §2 R4), so the sweep arrives from the composition
   * root exactly as `checkout` does. Absent means no inline drain — correct for
   * every test that cares only about the status ladder, and the cron still runs.
   */
  sweepEvents?: (db: Db, origin: string | null) => Promise<unknown>;
}

/**
 * The default `CheckoutPort` while Cart is still being built.
 *
 * IT THROWS RATHER THAN RETURNING `null`. `null` means "no such checkout", which
 * a route turns into a 404 — so an unwired port would make every checkout in
 * the store report as missing, which looks like a data problem and is not one.
 * A named failure says the actual thing.
 */
function unwiredCheckoutPort(): PaymentsCheckoutPort {
  const unwired = () =>
    new Error(
      'CheckoutPort is not wired: pass `checkout` to createPaymentRoutes(). ' +
        'Cart owns the real implementation (contract §5).',
    );
  return {
    totals() {
      return Promise.reject(unwired());
    },
    /*
     * IT REJECTS, AND THE CAPTURE PATH SWALLOWS THAT. Returning
     * `'already-completed'` here would be the worst possible default: it says
     * "somebody else has the order in hand" when nobody does, which is precisely
     * the silence admin#27 measured in production. A rejection is logged by
     * `completeCheckoutForIntent`, the payment is still recorded, and the outbox
     * still holds the capture for a later sweep.
     */
    complete() {
      return Promise.reject(unwired());
    },
    recordContact() {
      return Promise.reject(unwired());
    },
  };
}

const CreateIntentBody = z
  .object({
    checkoutId: str().min(1).max(200),
    /**
     * The customer's, for the provider's receipt.
     *
     * NOTE WHAT IS NOT IN THIS BODY: an amount. `03-payments.md` §8 — "never let
     * the storefront tell you the amount" — and it comes from `CheckoutPort`
     * inside `createIntent`. An email is not a money-relevant field: it decides
     * where a receipt goes, and a caller that lies about it defrauds nobody but
     * themselves.
     */
    email: str().min(3).max(320),
    idempotencyKey: str().min(8).max(200),
  })
  .strict();

const CreateRefundBody = z
  .object({
    /** Minor units. Partial refunds are supported and must sum-check (§6). */
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: str().max(500).optional(),
    idempotencyKey: str().min(8).max(200),
  })
  .strict();

/**
 * A Paystack payload is a few kilobytes. Vercel Functions accept request bodies
 * up to 100 MB, and this endpoint is public and unauthenticated by session — so
 * without a cap, anyone can make the process buffer 100 MB and HMAC it before
 * the signature can possibly fail. The cap is applied to the bytes actually
 * read, not to `content-length`, because a header is a claim.
 */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function resolveProvider(deps: PaymentDeps): PaymentProvider {
  const p = deps.provider;
  if (typeof p === 'function') return p();
  return p ?? paystackProvider();
}

/**
 * Schedule work that must not delay the response.
 *
 * `waitUntil` where the runtime offers it (Vercel Fluid Compute does), and a
 * detached promise where it does not. Neither is a durability guarantee and
 * neither is relied on as one: the event row is already committed before this
 * is called, and `drainPaymentEvents` re-drives anything left with
 * `processed_at IS NULL`. That is what makes acknowledging early honest on a
 * runtime that may freeze the instant the response is written.
 */
function afterResponse(c: Context<AppEnv>, work: () => Promise<unknown>): void {
  const swallow = (promise: Promise<unknown>) =>
    promise.catch((err: unknown) => {
      // eslint-disable-next-line no-console -- the only record of post-ack failure
      console.error(
        '[payments] post-ack processing failed',
        JSON.stringify({
          requestId: c.get('requestId') ?? '',
          // The enumerated code and nothing else. A message here is how a
          // provider response body reaches a log (`03-payments.md` §8).
          code: err instanceof ProviderError ? err.code : 'unknown',
        }),
      );
    });
  try {
    c.executionCtx.waitUntil(swallow(work()));
  } catch {
    void swallow(work());
  }
}

/**
 * THE WEBHOOK. The highest-severity route in the commerce system.
 *
 * IT MUST BYPASS `originGuard`, AND THE EXEMPTION IS THIS SEPARATE ROUTER
 * RATHER THAN AN ACCIDENT. `server/middleware/origin.ts` refuses any unsafe
 * method with no `Origin` header, and it is right to: "treating absence as
 * permission is the hole a `SameSite=Lax` cookie plus a top-level form POST
 * walks straight through." But Paystack is a server, not a browser; it sends no
 * `Origin`, so mounted behind that guard this endpoint answers 403 to every
 * genuine event and Paystack retries each one for 72 hours.
 *
 * The exemption is SAFE HERE AND NOWHERE ELSE, for a reason that has nothing to
 * do with origins: CSRF is an attack that borrows the victim's AMBIENT
 * AUTHORITY — their cookie. This route reads no cookie, resolves no session and
 * trusts nothing about the caller. Its authority comes entirely from an
 * HMAC-SHA512 signature over the request body, which a cross-origin form post
 * cannot produce. Dropping the origin check costs nothing an attacker could use
 * and buys the endpoint working at all.
 *
 * `server/index.ts` is Catalog's file (contract §3), so the mount is
 * AMENDMENTS A-001 and the two lines are written out there.
 */
export function createWebhookRoutes(deps: PaymentDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/shop/payments/webhook', async (c) => {
    const db = currentDb(c);
    const provider = resolveProvider(deps);

    /*
     * RAW BYTES. Not `c.req.json()`, not `c.req.text()`.
     *
     * `03-payments.md` §4: verify the signature "on the raw bytes… not the
     * JSON-round-tripped body — signature schemes sign bytes, and a
     * re-serialise changes them." `text()` would already have decoded; a body
     * that is not valid UTF-8 comes back with U+FFFD substituted and the bytes
     * that were signed are gone before the verifier sees them.
     */
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > MAX_WEBHOOK_BYTES) {
      return c.json({ error: 'payload_too_large' }, 413);
    }
    const raw = new Uint8Array(buffer);

    let event;
    try {
      // VERIFY BEFORE PARSING. `parseWebhook` throws rather than returning a
      // flag, so there is no way to reach the body having forgotten to check.
      event = await provider.parseWebhook(raw, c.req.raw.headers);
    } catch (err) {
      /*
       * 401, NOT 500 AND NOT 200.
       *
       * A 500 would be retried by Paystack every 3 minutes and then hourly for
       * 72 hours, so a single forged request would become a sustained one. A
       * 200 would tell a forger their body was accepted. 401 is terminal and
       * says nothing about why.
       *
       * NOTHING FROM `err` IS RETURNED OR LOGGED HERE beyond its enumerated
       * code: a signature failure is attacker-controlled input by definition.
       */
      const code = err instanceof ProviderError ? err.code : 'unknown';
      return c.json({ error: code === 'signature_invalid' ? 'invalid_signature' : 'bad_request' }, 401);
    }

    // DURABLE FIRST. Everything after this line can fail without losing the event.
    const stored = await storeEvent(db, event);

    /*
     * A REPEAT DELIVERY IS A 200 AND NOTHING ELSE. It is not an error — it is
     * the provider doing exactly what it promises — and processing it again is
     * prevented by the `processed_at IS NULL` gate rather than by this branch.
     */
    if (!stored.duplicate) {
      /*
       * `unwiredCheckoutPort()` RATHER THAN `undefined`, so a deployment that
       * forgot to inject Cart's port gets a logged rejection on every capture
       * instead of a pipeline that quietly never completes a checkout. That
       * silence is exactly what admin#27 was.
       */
      const captureDeps = { checkout: deps.checkout ?? unwiredCheckoutPort() };
      const origin = c.get('origins')?.[0] ?? null;
      afterResponse(c, () =>
        processEvent(db, stored.rowId, Date.now(), captureDeps)
          .then(() => drainPaymentEvents(db, 5, Date.now(), captureDeps))
          /*
           * THE INLINE OUTBOX DRAIN (admin#29), AND IT IS THE LAST THING AND THE
           * LEAST IMPORTANT THING.
           *
           * It runs after the capture is already committed, it is bounded to a
           * handful of rows — the events for one checkout, not a backlog — and
           * its failure is swallowed exactly the way `createCustomerSession`'s
           * opportunistic sweep and Cart's lazy `runCartMaintenance` swallow
           * theirs. A drain that could fail the webhook would turn a slow or
           * unlucky Orders sweep into a Paystack redelivery storm for an event
           * we had already recorded correctly.
           *
           * NOTHING IS LOST WHEN IT FAILS. It deletes nothing and claims
           * nothing: an event it did not reach is simply still in
           * `commerce_events` with no consumption row, which is the same state
           * it was in a moment ago, and the cart-maintenance cron drains it.
           */
          /*
           * `.catch` ON THE SWEEP ALONE, NOT ON THE WHOLE CHAIN.
           *
           * Wrapping the lot would swallow a `processEvent` or
           * `drainPaymentEvents` failure as well — and `afterResponse`'s
           * `swallow()` is the ONLY thing that logs a post-acknowledgement
           * failure anywhere. Recovery would be unaffected either way (the row
           * stays `processed_at IS NULL` and the next drain re-drives it), but a
           * stuck capture would produce no line at all, and invisibility is how
           * this entire class of bug reached production in the first place.
           */
          .then(() => deps.sweepEvents?.(db, origin)?.catch(() => undefined)),
      );
    }

    return c.json({ received: true, duplicate: stored.duplicate });
  });

  return app;
}

export function createPaymentRoutes(deps: PaymentDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const checkout = deps.checkout ?? unwiredCheckoutPort();

  /*
   * THE RESPONSE-SIDE CORS HEADER, ON THE PUBLIC `/shop/payments/*` ROUTES
   * ONLY — not `/shop/admin/payments/*`, which is `requireOwner()`-gated a few
   * lines below and mounted under the same router (admin#26).
   *
   * Same gap as Orders (see the long note in `orders/routes.ts` for the full
   * reasoning): the preflight already works — Cart's `built.options('/*',
   * shopPreflight)` catches every `OPTIONS` under `/api/shop/*`, this router
   * included — but `shopCors()` used to run only inside Cart's own router, so
   * `POST /api/shop/payments/intents` came back with no
   * `access-control-allow-credentials` on the real response. Measured against
   * production in the issue: checkout cannot create a payment intent from a
   * cross-site browser without it.
   *
   * NOT LIFTED TO `shopApp()`: that would also cover `/admin/*`, which has
   * never been reviewed for a credentialed cross-origin surface — the
   * writer's session cookie being `SameSite=Lax` today is not a reason to make
   * it load-bearing by accident. `/shop/payments/*` is scoped short of
   * `/shop/admin/payments/*` for exactly that reason.
   */
  app.use('/shop/payments/*', shopCors<AppEnv>());

  /**
   * Create (or recover) a payment intent for a checkout.
   *
   * PUBLIC, because guest checkout is the default path (contract §7) and a cart
   * exists before any identity does. The customer session middleware is Cart's
   * to build; when it lands, this route gains it as a *reader* of who the
   * customer is, never as a gate that would break guest checkout.
   */
  app.post('/shop/payments/intents', async (c) => {
    const body = await readJson(c, CreateIntentBody);
    const result = await createIntent(currentDb(c), resolveProvider(deps), checkout, {
      checkoutId: body.checkoutId,
      email: body.email,
      idempotencyKey: body.idempotencyKey,
      callbackUrl: deps.callbackUrl ?? safeCallbackUrl(),
    });
    /*
     * 200 ON A REPLAY, 201 ON A CREATE. The body is identical either way —
     * §5's "the second call with the same key returns the first call's result"
     * — and the status code is the only place the difference shows, which is
     * what lets a client tell a successful retry from a new charge.
     */
    return c.json(publicIntent(result.intent), result.created ? 201 : 200);
  });

  /** Poll a checkout's payment state. */
  app.get('/shop/payments/intents/:id', async (c) => {
    const intent = await getIntent(currentDb(c), pathParam(c, 'id'));
    if (!intent) throw new NotFoundError('intent');
    return c.json(publicIntent(intent));
  });

  /**
   * Reconcile after the customer returns from the provider's checkout page.
   *
   * THIS IS THE ROUTE THAT MAKES "NEVER MARK ANYTHING PAID FROM A CLIENT-SIDE
   * CALLBACK" (§8) SURVIVABLE. The browser arriving at `callback_url` is a UI
   * hint and carries no evidence — anyone can navigate to it. So this route
   * ignores everything the client says and ASKS THE PROVIDER, then applies the
   * answer through exactly the same `applyIntentStatus` the webhook uses, with
   * the same rank guard and the same outbox write.
   *
   * It exists because a webhook can be late: without it, a customer who has
   * genuinely paid stares at an unpaid order and has no way to resolve it.
   */
  app.post('/shop/payments/intents/:id/confirm', async (c) => {
    const db = currentDb(c);
    const intent = await getIntent(db, pathParam(c, 'id'));
    if (!intent?.providerIntentId) throw new NotFoundError('intent');

    const truth = await resolveProvider(deps).fetchIntent(intent.providerIntentId);
    if (truth.status === 'requires_payment') return c.json(publicIntent(intent));

    /*
     * A SYNTHETIC EVENT ROW, so the confirm path and the webhook path share one
     * application mechanism instead of having two that can disagree. It is
     * recorded in the same append-only log with `type = 'verify:…'`, so the
     * dispute record shows that this state change came from us asking rather
     * than from the provider telling.
     */
    const stored = await storeEvent(db, {
      providerEventId: `verify:${intent.providerIntentId}:${truth.status}`,
      type: `verify.${truth.status}`,
      providerIntentId: intent.providerIntentId,
      providerRefundId: null,
      intentStatus: truth.status,
      refundStatus: null,
      failureReason: truth.failureReason,
      amount: truth.amount,
      currency: truth.currency,
      payload: { source: 'fetchIntent', status: truth.status },
    });

    if (!stored.duplicate) {
      /*
       * THE SAME ORDER AS THE WEBHOOK, for the same reason. This route is a
       * genuine capture path — a customer returning from Paystack whose webhook
       * is late reaches `captured` here and nowhere else — so leaving the
       * completion out would have made the fix work only for the delivery that
       * happened to arrive first. `completeCheckoutForIntent` is a no-op for
       * every other status.
       */
      if (truth.status === 'captured') {
        await completeCheckoutForIntent(db, intent.id, { checkout });
      }
      await applyIntentStatus(db, {
        eventRowId: stored.rowId,
        intentId: intent.id,
        next: truth.status,
        providerIntentId: intent.providerIntentId,
        failureReason: truth.failureReason,
      });
      // Best-effort, bounded, and never able to fail the confirm — see the
      // webhook route's note.
      await deps.sweepEvents?.(db, c.get('origins')?.[0] ?? null).catch(() => undefined);
    }

    const current = await getIntent(db, intent.id);
    return c.json(publicIntent(current ?? intent));
  });

  // ------------------------------------------------------------------ admin

  const owner = requireOwner();

  /** Full detail, refunds included. Owner only. */
  app.get('/shop/admin/payments/intents/:id', owner, async (c) => {
    const db = currentDb(c);
    const id = pathParam(c, 'id');
    const intent = await getIntent(db, id);
    if (!intent) throw new NotFoundError('intent');
    return c.json({ intent, refunds: await listRefunds(db, id) });
  });

  /**
   * Refund, wholly or partly. ADMIN-INITIATED ONLY IN V1 (contract §13 — there
   * is no customer-initiated RMA flow), so `requireOwner()` and not
   * `requireAuth()`: a writer can publish posts and has no business moving
   * money.
   */
  app.post('/shop/admin/payments/intents/:id/refunds', owner, async (c) => {
    const body = await readJson(c, CreateRefundBody);
    const result = await createRefund(currentDb(c), resolveProvider(deps), {
      intentId: pathParam(c, 'id'),
      amount: body.amount,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
      createdBy: currentUser(c).id,
    });
    return c.json({ refund: result.refund }, result.created ? 201 : 200);
  });

  /** Cancel a checkout that was never paid. */
  app.post('/shop/admin/payments/intents/:id/cancel', owner, async (c) =>
    c.json(publicIntent(await cancelIntent(currentDb(c), pathParam(c, 'id')))),
  );

  /**
   * Drain stored-but-unprocessed webhook events. Owner only, and for a cron.
   *
   * The safety net under "acknowledge then process" — anything the
   * post-response work did not finish because the function was frozen.
   */
  app.post('/shop/admin/payments/events/drain', owner, async (c) =>
    c.json({
      processed: await drainPaymentEvents(currentDb(c), 50, Date.now(), { checkout }),
    }),
  );

  return app;
}

/**
 * What a public caller may see.
 *
 * PROJECTED, NEVER SPREAD. `idempotencyKey` is a caller-chosen string that may
 * encode an order number, and `lastError` names our provider and our failure
 * modes; neither belongs on an unauthenticated storefront response, and a
 * `{ ...intent }` would ship both the first time somebody stopped thinking
 * about it.
 */
function publicIntent(intent: {
  id: string;
  checkoutId: string;
  status: string;
  amount: number;
  currency: string;
  authorizationUrl: string | null;
  refundedTotal: number;
}) {
  return {
    id: intent.id,
    checkoutId: intent.checkoutId,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    authorizationUrl: intent.authorizationUrl,
    refundedTotal: intent.refundedTotal,
  };
}

/**
 * The configured callback URL, or nothing.
 *
 * WRAPPED so that a deployment with no `PAYMENTS_CALLBACK_URL` — or with no
 * payments environment at all — does not turn creating an intent into a 500
 * raised by config parsing. The callback is a convenience; the webhook and
 * `/confirm` are the mechanisms.
 */
function safeCallbackUrl(): string | undefined {
  try {
    /*
     * The environment still wins, so a preview can redirect somewhere else
     * without a code change. What changed is the FALLBACK: it used to be
     * `undefined`, which meant a deployment that had never set the variable
     * silently sent the customer nowhere and Paystack showed its own generic
     * "payment complete" page instead of ours. A URL that is public anyway is
     * better held in the repository than in a variable nobody remembers exists —
     * see `utils/callback-url.ts`.
     */
    return paymentsEnv().PAYMENTS_CALLBACK_URL || DEFAULT_PAYMENTS_CALLBACK_URL;
  } catch {
    return DEFAULT_PAYMENTS_CALLBACK_URL;
  }
}

/** For `server/index.ts`, once AMENDMENTS A-001 is resolved. */
export const routes: Hono<AppEnv> = createPaymentRoutes();

/*
 * THERE IS NO PRE-BUILT `webhookRoutes` EXPORT, AND ITS ABSENCE IS DELIBERATE.
 *
 * `export const webhookRoutes = createWebhookRoutes()` stood here, and it was
 * the whole of admin#27. `server/index.ts` mounted it, so the highest-severity
 * route in the commerce system ran with an UNWIRED `CheckoutPort`: a real
 * Paystack payment reached `captured`, `completeCheckout` was never called,
 * `shop_orders` stayed at 0, and the capture parked "awaiting predecessor:
 * checkout.completed" until it would have been abandoned.
 *
 * What made it survive is that NOTHING FAILED. Payments' own suites build their
 * own router and inject `fakeCheckoutPort`, so they stayed green; only
 * `server/shop/composition.test.ts` — added by that fix — can see it. A
 * ready-made, dependency-free export sitting beside a factory that needs two
 * dependencies is a trap for the next person mounting a route, and it is a trap
 * that costs a customer their order rather than a test its colour.
 *
 * `createWebhookRoutes({ checkout, sweepEvents })` is now the only way in. It is
 * a few words longer at the one call site that exists, and it cannot be wired
 * wrongly by accident.
 *
 * The `routes` export above is left alone: `createPaymentRoutes()` with no
 * dependencies answers every checkout as unpayable, LOUDLY — a bad deployment
 * rather than a silent one — and `server/index.ts` does not use it either, for
 * the reason written beside that mount.
 */

export type { Db };
