import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { shopCors } from '../cart/cors';
import { pathParam, readJson, str } from '../../middleware/errors';
import { requireAdmin } from '../../middleware/session';
import { NotFoundError } from '../../repo/errors';
import { currentDb, currentUser } from '../../app-env';
import { ProviderError } from './provider/scrub';
import { flutterwaveProvider, paystackProvider, paymentsEnv, providerCeilings, providerKeyPresence } from './config';
import { cancelIntent, chargedOf, createIntent, getIntent, applyIntentStatus } from './intents';
import type { ChargeSpec, PaymentIntentRow } from './intents';
import { BASE_CURRENCY, chargeBreakdown } from '../../../shared/commerce/fx';
import {
  chargeCurrencyFor,
  chargeRatesFor,
  publicCurrencyConfig,
  readFxState,
} from '../currency/state';
import { createRefund, listRefunds } from './refunds';
import { chooseProvider, providerFor, NoGatewayAvailableError, NoProviderForCurrencyError } from './routing';
import { readPaymentSettings, writePaymentSettings } from './settings';
import { PROVIDER_NAMES } from './schema';
import {
  chargeVerdict,
  completeCheckoutForIntent,
  drainPaymentEvents,
  processEvent,
  storeEvent,
} from './webhook';
import type { Context } from 'hono';
import type { AppEnv } from '../../app-env';
import { paymentsCallbackUrl } from './utils/callback-url';
import type { Db } from '../../db/client';
import type { PaymentsCheckoutPort } from './checkout';
import type { PaymentProvider } from './provider/types';
import type { ProviderFactories } from './routing';
import type { PaymentSettingsPatch } from './settings';
import type { ProviderName } from './schema';
import { storefrontOrigin } from '../storefront-url';

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

  /**
   * BOTH GATEWAYS, for ROUTING — `chooseProvider`/`providerFor` (`routing.ts`)
   * — and for the Flutterwave webhook's STATIC binding below. Defaults to
   * `{ paystack: () => resolveProvider(deps), flutterwave: flutterwaveProvider }`
   * (see `resolveFactories`), which is what keeps this field additive rather
   * than a second, competing way to inject a gateway: every existing caller
   * that supplies only `provider` — every test file written before this task
   * — keeps resolving that SAME handle through the new routing-aware paths,
   * because `factories.paystack()` reaches it too.
   *
   * NEITHER FACTORY IS CALLED HERE, ONLY REFERENCED, for the identical reason
   * `provider` above is never called at construction: a deployment with no
   * Flutterwave configured must still boot and still take Paystack payments.
   * `flutterwaveProvider` (`config.ts`) only throws once something actually
   * asks it for a charge.
   */
  factories?: ProviderFactories;
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
    /*
     * REJECTS TOO, THE SAME AS ITS SIBLINGS ABOVE, RATHER THAN THE `null` A
     * CONFIGURED PORT WOULD ANSWER. `destination`'s contract elsewhere is
     * "never throw, degrade to domestic routing" — but that promise is about a
     * checkout the port can actually see, not about a deployment that forgot
     * to wire the port at all. Answering `null` here would let a missing
     * composition root look like an ordinary checkout with no address yet,
     * which is exactly the failure mode this stand-in exists to make loud.
     */
    destination() {
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
    /*
     * THE CURRENCY HANDSHAKE (1140), all three optional — an old storefront
     * sends none of them and gets exactly today's naira payment.
     *
     * `country` is where the storefront says the shopper is (Cloudflare's
     * country, or the owner's dev override). A spoofed one only changes which
     * currency is paid in, at the published multiplier: NOTHING HERE IS AN
     * AMOUNT OR A MULTIPLIER, and neither is ever accepted from a request.
     * `currency` and `ratesRevision` are what the storefront DISPLAYED; they
     * are compared, never used.
     */
    country: str().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase()).optional(),
    currency: str().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()).optional(),
    ratesRevision: z.number().int().min(0).optional(),
  })
  .strict();

/** Vercel's own geolocation header, when it names a real country. */
function headerCountry(value: string | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

const CreateRefundBody = z
  .object({
    /** Minor units. Partial refunds are supported and must sum-check (§6). */
    amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reason: str().max(500).optional(),
    idempotencyKey: str().min(8).max(200),
  })
  .strict();

/**
 * The `PATCH /shop/admin/payments/settings` body. `.strict()`, carries
 * `revision`, every other field optional.
 *
 * `currencies` IS ITS OWN `.strict()` OBJECT WITH BOTH GATEWAYS OPTIONAL,
 * NOT `z.record(...)` — the shape is `Partial<Record<ProviderName,
 * string[]>>` exactly, and there are only ever two keys, so naming both
 * explicitly reads the same way `settings.ts`'s own `PaymentSettingsPatch`
 * type does rather than through a more general map type nothing else here
 * needs.
 *
 * EACH ELEMENT IS AN ISO 4217 CODE, EXACTLY THREE UPPERCASE LETTERS — the
 * same shape `shop_payment_settings_paystack_ccy_ck`/`..._flutterwave_ccy_ck`
 * (migration 1100) enforce over the joined array. `str().min(1).max(10)`
 * used to be the only bound here, which let a hand-crafted `PATCH` carrying
 * `['ABCD']` pass zod AND `normalizeCurrencyCodes` (`settings.ts`, which
 * only rejects an EMPTY list) and reach that CHECK constraint as an
 * unlabelled 500 instead of a named 400. `readPaymentSettings`/every real
 * response already returns codes uppercase (`settings.ts`: "Never empty for
 * either gateway"), so the one real caller (`SettingsPayments.tsx`, which
 * only ever round-trips what it was given) is unaffected.
 */
const CurrencyList = z.array(str().regex(/^[A-Z]{3}$/, 'ISO 4217 code')).optional();

const PatchPaymentSettingsBody = z
  .object({
    activeProvider: z.enum(PROVIDER_NAMES).optional(),
    /** `null` clears the country rule; absent (the default) leaves it alone. */
    internationalProvider: z.enum(PROVIDER_NAMES).nullable().optional(),
    currencies: z
      .object({
        paystack: CurrencyList,
        flutterwave: CurrencyList,
      })
      .strict()
      .optional(),
    revision: z.number().int().positive(),
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
 * `deps.factories`, or the real default — built lazily, and built the SAME
 * way every time this is called (once per router construction; see the two
 * call sites below).
 *
 * `paystack` ROUTES THROUGH `resolveProvider(deps)` RATHER THAN
 * `paystackProvider()` DIRECTLY, and that indirection is what makes this
 * field additive. `deps.provider` is the existing, single-gateway seam every
 * test file in this subsystem already injects a `FakeProvider` through; a
 * default that ignored it and always built a real `PaystackProvider` would
 * leave every one of those tests reaching the network the moment a route
 * switched from `resolveProvider(deps)` to `providerFor('paystack',
 * factories)` for the identical intent. Going through `resolveProvider`
 * keeps the two spellings resolving to the one handle.
 *
 * `flutterwave` IS `flutterwaveProvider` ITSELF, NOT A WRAPPING ARROW
 * FUNCTION — it already has the right shape, `() => PaymentProvider`, and
 * writing `() => flutterwaveProvider()` would only add a frame that does
 * nothing.
 */
function resolveFactories(deps: PaymentDeps): ProviderFactories {
  return (
    deps.factories ?? {
      paystack: () => resolveProvider(deps),
      flutterwave: flutterwaveProvider,
    }
  );
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
 * THE WEBHOOK HANDLER BODY — factored out so BOTH gateways' URLs share ONE
 * implementation and neither can drift, per Task 10. `provider` and
 * `providerName` arrive ALREADY RESOLVED, as a pair, from the caller below;
 * this function never chooses between gateways and never reads `deps.provider`
 * or `deps.factories` itself, so there is no path through which the wrong URL
 * could end up verifying with the wrong key.
 *
 * `providerName` IS A PLAIN PARAMETER, NEVER DERIVED FROM `provider.name`.
 * That handle is wrapped by `scrubbedProvider` (`provider/scrub.ts`), and
 * depending on a wrapper to keep preserving a field it happens to preserve
 * today is exactly how this breaks silently later — the identical argument
 * `intents.ts`'s `createIntent` makes for its own `providerName` parameter.
 *
 * EVERY PROPERTY OF THE ORIGINAL SINGLE-ROUTE HANDLER IS KEPT: the raw-bytes
 * read (not `c.req.text()` — a re-decode substitutes U+FFFD and destroys the
 * bytes a signature covers), `MAX_WEBHOOK_BYTES`, verify-before-parse, the
 * 401-on-bad-signature (never 500, which a gateway retries for days, and
 * never 200, which tells a forger their body was accepted), `storeEvent`
 * BEFORE processing, and `afterResponse` for the post-ack work.
 */
async function handleProviderWebhook(
  c: Context<AppEnv>,
  deps: PaymentDeps,
  provider: PaymentProvider,
  providerName: ProviderName,
): Promise<Response> {
  const db = currentDb(c);

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
     * A 500 would be retried by the gateway every few minutes and then for
     * days, so a single forged request would become a sustained one. A 200
     * would tell a forger their body was accepted. 401 is terminal and says
     * nothing about why.
     *
     * NOTHING FROM `err` IS RETURNED OR LOGGED HERE beyond its enumerated
     * code: a signature failure is attacker-controlled input by definition.
     */
    const code = err instanceof ProviderError ? err.code : 'unknown';
    return c.json({ error: code === 'signature_invalid' ? 'invalid_signature' : 'bad_request' }, 401);
  }

  /*
   * DURABLE FIRST. Everything after this line can fail without losing the
   * event.
   *
   * `providerName` IS THE CALLER'S FIXED ARGUMENT, NEVER GUESSED. Each of the
   * two routes below binds this function to exactly one gateway, so there is
   * no branch here that could attribute a Flutterwave event to Paystack (or
   * the reverse) — see this function's own header for why `provider.name` is
   * not used for this instead.
   */
  const stored = await storeEvent(db, event, providerName);

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
    const origin = storefrontOrigin();
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
         * unlucky Orders sweep into a redelivery storm for an event we had
         * already recorded correctly.
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
}

/**
 * THE WEBHOOKS. The highest-severity routes in the commerce system.
 *
 * THEY MUST BYPASS `originGuard`, AND THE EXEMPTION IS THIS SEPARATE ROUTER
 * RATHER THAN AN ACCIDENT. `server/middleware/origin.ts` refuses any unsafe
 * method with no `Origin` header, and it is right to: "treating absence as
 * permission is the hole a `SameSite=Lax` cookie plus a top-level form POST
 * walks straight through." But a payment gateway is a server, not a browser;
 * it sends no `Origin`, so mounted behind that guard these endpoints answer
 * 403 to every genuine event and the gateway retries each one for days.
 *
 * The exemption is SAFE HERE AND NOWHERE ELSE, for a reason that has nothing to
 * do with origins: CSRF is an attack that borrows the victim's AMBIENT
 * AUTHORITY — their cookie. Neither route reads a cookie, resolves a session
 * or trusts anything about the caller. Their authority comes entirely from a
 * signature (Paystack's HMAC-SHA512) or a constant-time hash comparison
 * (Flutterwave's `verif-hash`) over the request, which a cross-origin form
 * post cannot produce. Dropping the origin check costs nothing an attacker
 * could use and buys the endpoint working at all.
 *
 * `server/index.ts` is Catalog's file (contract §3), so the mount is
 * AMENDMENTS A-001 and the lines are written out there.
 *
 * THE FLUTTERWAVE ROUTE IS STATICALLY BOUND — never resolved dynamically,
 * never guessing which key to verify with. `factories.flutterwave()` is a
 * fixed reference decided once, at router construction, never re-chosen per
 * request the way `chooseProvider` (`routing.ts`) picks a gateway for a NEW
 * payment. `shop_payment_settings.active_provider` — the admin switch — has
 * no bearing on which key either webhook verifies against: Paystack's own
 * URL is equally fixed to `factories.paystack()`, which is what makes it safe
 * for the SAME `/shop/payments/webhook` URL registered in Paystack's
 * dashboard today to keep working exactly as it does now.
 */
export function createWebhookRoutes(deps: PaymentDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const factories = resolveFactories(deps);

  // THE EXISTING URL. Registered in Paystack's dashboard and live — this
  // keeps answering exactly as it always has.
  app.post('/shop/payments/webhook', (c) =>
    handleProviderWebhook(c, deps, factories.paystack(), 'paystack'),
  );

  // THE NEW URL. Never shared with the Paystack route above, and never
  // resolved through `chooseProvider`/`readPaymentSettings` — see this
  // function's own header.
  app.post('/shop/payments/webhook/flutterwave', (c) => {
    /*
     * 503, NOT AN UNCAUGHT THROW. This route exists and is reachable by any
     * unauthenticated caller the moment it is deployed, whether or not
     * Flutterwave itself is configured on this deployment — and today it is
     * not (CLAUDE.md: built but inert until the owner sets
     * `FLUTTERWAVE_SECRET_KEY`/`FLUTTERWAVE_WEBHOOK_HASH`). `factories.flutterwave()`
     * throws in exactly that state (`config.ts`'s `flutterwaveEnv()`), and
     * calling it inline as `handleProviderWebhook`'s argument — as this line
     * used to — throws BEFORE a single byte of the body is read, so every
     * caller gets the generic unmapped `{ error: 'internal' }` 500 and the
     * 401-on-bad-signature path never even runs.
     *
     * Constructed here, wrapped, so that failure is a NAMED, EXPECTED
     * response instead: a 5xx (this deployment cannot take a Flutterwave
     * payment right now, which is true and not the caller's fault) but a
     * distinct code from an unmapped crash, and nothing about WHY beyond
     * that — never the caught error, matching `config.ts`'s own names-only
     * discipline for this exact throw.
     */
    let provider: PaymentProvider;
    try {
      provider = factories.flutterwave();
    } catch {
      return c.json({ error: 'gateway_not_configured' }, 503);
    }
    // THE CONFIGURED CASE IS UNCHANGED: `handleProviderWebhook` still reads
    // the raw body, verifies it, and answers 401 on a bad signature exactly
    // as it always has.
    return handleProviderWebhook(c, deps, provider, 'flutterwave');
  });

  return app;
}

export function createPaymentRoutes(deps: PaymentDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const checkout = deps.checkout ?? unwiredCheckoutPort();
  const factories = resolveFactories(deps);

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
   *
   * ROUTES THE PAYMENT (Task 10): `checkout.destination(...)`, then
   * `chooseProvider(...)`, then the CHOSEN name and handle go into
   * `createIntent`'s six-argument form — never the legacy five-argument
   * overload, which silently defaults to `'paystack'` and is exactly the
   * hazard this task exists to remove.
   */
  app.post('/shop/payments/intents', async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, CreateIntentBody);

    /*
     * THE CURRENCY, FROM STORAGE. `chooseProvider` needs it before an intent
     * can exist to read it from, so this reads the SAME frozen total
     * `createIntent` reads again a few lines down — a second cheap SELECT,
     * never a recomputation (`CheckoutPort.totals`'s own contract: "reads
     * storage, never recomputes"), and not something to optimise away at the
     * cost of routing on a stale or absent figure.
     */
    const totals = await checkout.totals(db, body.checkoutId);

    /*
     * BARE — NO TRY/CATCH. This reverses an instinct that would otherwise
     * feel obviously safer, and it is a deliberate ruling (Task 10):
     * `unwiredCheckoutPort().destination()` rejects like its siblings, so a
     * composition-root wiring gap is NAMED. A defensive catch here would
     * swallow exactly that and silently recreate the failure class this
     * codebase has shipped twice (CLAUDE.md §2) — `createIntent` already
     * calls `checkout.totals()` bare, immediately above, for the same reason.
     */
    const destination = await checkout.destination(db, body.checkoutId);

    /*
     * ═══ THE CURRENCY HANDSHAKE (1140) ═══
     *
     * Naira is the only real price. A non-naira amount becomes real money HERE
     * and nowhere else: the country the storefront says the shopper is in maps
     * to a currency, and the frozen NAIRA totals are converted component by
     * component (`chargeBreakdown`) at the published multipliers.
     *
     * AN OLD STOREFRONT sends none of the three fields and gets exactly today's
     * behaviour, in naira — so this admin and the storefront can deploy in
     * either order. The `x-vercel-ip-country` fallback applies only once the
     * storefront has joined the handshake at all.
     *
     * THE SYNC CHECK IS NOT A LOCK. If what the storefront displayed — the
     * currency, or the revision of the numbers it multiplied by — is not what
     * this would charge, nothing is created: 409 `rates_changed` carries the
     * current config, the storefront re-renders, and the shopper presses pay
     * again. Both sides stay on one set of numbers; nothing is held.
     */
    const handshake =
      body.country !== undefined || body.currency !== undefined || body.ratesRevision !== undefined;
    let charge: ChargeSpec | undefined;
    let routeCurrency = totals.grandTotal.currency;
    let routeCountry = destination?.country ?? null;
    if (handshake) {
      const state = await readFxState(db);
      const country = body.country ?? headerCountry(c.req.header('x-vercel-ip-country'));
      const currency = chargeCurrencyFor(state, country);
      if (
        (body.currency !== undefined && body.currency !== currency) ||
        (body.ratesRevision !== undefined && body.ratesRevision !== state.revision)
      ) {
        return c.json({ error: 'rates_changed', config: publicCurrencyConfig(state) }, 409);
      }
      /*
       * A NAIRA CHARGE KEEPS TODAY'S PATH — same amount, same routing on the
       * delivery country — with the handshake recorded beside it. So does a
       * frozen total that is not naira at all (a cart minted by the
       * per-currency branch): converting it would read cedis as naira.
       */
      if (currency === totals.grandTotal.currency || totals.grandTotal.currency !== BASE_CURRENCY) {
        charge = {
          currency: totals.grandTotal.currency,
          amount: totals.grandTotal.amount,
          ratesRevision: state.revision,
          country,
          breakdown: null,
        };
      } else {
        const breakdown = chargeBreakdown(totals, chargeRatesFor(state, currency));
        if (breakdown.amount <= 0) return c.json({ error: 'charge_too_small' }, 400);
        charge = { currency, amount: breakdown.amount, ratesRevision: state.revision, country, breakdown };
        routeCurrency = currency;
        routeCountry = country;
      }
    }

    let chosen: { name: ProviderName; provider: PaymentProvider };
    try {
      chosen = await chooseProvider(db, { currency: routeCurrency, country: routeCountry }, factories);
    } catch (err) {
      /*
       * A CLEAN REFUSAL, NOT A 500. `NoProviderForCurrencyError` means every
       * gateway this account has switched on for this currency is either not
       * switched on at all or cannot charge it — a configuration state, not a
       * bug, so the caller gets a named, permanent 400 rather than an
       * unmapped exception falling through to `{ error: 'internal' }`.
       */
      if (err instanceof NoProviderForCurrencyError) {
        return c.json({ error: 'no_provider_for_currency' }, 400);
      }
      /*
       * NOT A CLEAN REFUSAL — AN OUTAGE, AND IT MUST READ AS ONE.
       * `NoGatewayAvailableError` means every gateway the settings row
       * pointed at for this currency could not even be constructed (see its
       * own comment in `routing.ts`) — most likely a missing or malformed
       * secret key on the gateway taking live money. A 400 here would read
       * as a deliberate, permanent configuration state exactly like the one
       * above, and it is the opposite: transient from the caller's point of
       * view and something an operator needs paged for. 503, not 500,
       * because the cause is named and specific (this deployment cannot
       * reach a payment gateway right now) rather than unmapped — the same
       * choice item 9's webhook route makes for the same reason.
       */
      if (err instanceof NoGatewayAvailableError) {
        return c.json({ error: 'no_gateway_available' }, 503);
      }
      throw err;
    }

    const result = await createIntent(db, chosen.provider, chosen.name, checkout, {
      checkoutId: body.checkoutId,
      email: body.email,
      idempotencyKey: body.idempotencyKey,
      /*
       * THE ORIGIN IS READ HERE AND NOWHERE ELSE IN THE SHOP. This request was
       * made by the customer's own browser, on the storefront they are buying
       * from, so its `Origin` is the only honest answer to "which of our two
       * storefronts must Paystack return this person to" — and getting it wrong
       * sends a dev test payment home to the live shop, where `/confirm` 404s
       * against a database that has never seen the intent.
       *
       * It is a KEY into `STOREFRONT_ORIGINS`, never a value: an origin that is
       * not one of the two hostnames we publish is discarded and production
       * stands. `storefrontOrigin` enforces that, and `originGuard` has already
       * refused this POST outright if the header is absent or unknown to
       * `APP_ORIGINS`.
       */
      callbackUrl: deps.callbackUrl ?? safeCallbackUrl(c.req.header('Origin')),
      charge,
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

    /*
     * `providerFor(intent.provider, factories)`, NEVER `resolveProvider(deps)`
     * — a single fixed handle. This is the guarantee the whole project rests
     * on: money already taken must resolve to the gateway that took it,
     * forever, whatever the admin switch says now. `providerFor` takes no
     * `db` and reads no settings row for exactly this reason (`routing.ts`).
     */
    const truth = await providerFor(intent.provider, factories).fetchIntent(intent.providerIntentId);
    if (truth.status === 'requires_payment') return c.json(publicIntent(intent));

    /*
     * A SYNTHETIC EVENT ROW, so the confirm path and the webhook path share one
     * application mechanism instead of having two that can disagree. It is
     * recorded in the same append-only log with `type = 'verify:…'`, so the
     * dispute record shows that this state change came from us asking rather
     * than from the provider telling.
     *
     * `intent.provider`, NOT a fixed literal — unlike the webhook route above,
     * this one already has the ONE intent this event is about in hand, so the
     * gateway that actually took its money is a plain field read rather than a
     * guess. This is exactly the "resolve per intent" property `refunds.ts`
     * documents: the row's own recorded gateway, never a global setting.
     */
    const stored = await storeEvent(
      db,
      {
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
      },
      intent.provider,
    );

    /*
     * THE SAME CHECK AS THE WEBHOOK (1140): money counts only in the charged
     * currency and at least the charged amount. A payment that does not is
     * written down on its event row and applied nowhere — the shopper sees an
     * unpaid intent, and the operator a named anomaly to reconcile.
     */
    const verdict =
      truth.status === 'captured' || truth.status === 'authorized'
        ? chargeVerdict(intent, truth.amount, truth.currency)
        : null;
    if (verdict) {
      if (!stored.duplicate) {
        await currentDb(c).execute(sql`
          UPDATE shop_payment_events SET processed_at = ${Date.now()}, anomaly = ${verdict}
           WHERE id = ${stored.rowId} AND processed_at IS NULL`);
      }
      // eslint-disable-next-line no-console -- a payment that does not count is an operator's to reconcile
      console.error('[payments] refused a capture', JSON.stringify({ intentId: intent.id, verdict }));
      return c.json(publicIntent(intent));
    }

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
      await deps.sweepEvents?.(db, storefrontOrigin()).catch(() => undefined);
    }

    const current = await getIntent(db, intent.id);
    return c.json(publicIntent(current ?? intent));
  });

  // ------------------------------------------------------------------ admin

  const admin = requireAdmin();

  /** Full detail, refunds included. Owner only. */
  app.get('/shop/admin/payments/intents/:id', admin, async (c) => {
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
   *
   * RESOLVES THE GATEWAY PER INTENT. `getIntent` is read FIRST, purely to
   * learn `intent.provider` — the row's own recorded gateway — before
   * `createRefund` is ever called, because `refunds.ts`'s own header is
   * explicit that the caller must resolve this from THIS intent's stored
   * gateway and never from `shop_payment_settings.active_provider`, which an
   * owner can flip at any time after the original payment went through the
   * OTHER one.
   */
  app.post('/shop/admin/payments/intents/:id/refunds', admin, async (c) => {
    const db = currentDb(c);
    const body = await readJson(c, CreateRefundBody);
    const intentId = pathParam(c, 'id');
    const intent = await getIntent(db, intentId);
    if (!intent) throw new NotFoundError(intentId);
    const result = await createRefund(db, providerFor(intent.provider, factories), {
      intentId,
      amount: body.amount,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
      createdBy: currentUser(c).id,
    });
    return c.json({ refund: result.refund }, result.created ? 201 : 200);
  });

  /**
   * Cancel a checkout that was never paid.
   *
   * NO GATEWAY IS RESOLVED HERE, AND THAT IS NOT AN OMISSION —
   * `cancelIntent` (`intents.ts`) takes no provider at all: both adapters
   * declare `capabilities.remoteCancel: false` (`provider/paystack.ts`,
   * `provider/flutterwave.ts`), so cancelling an uncompleted charge is
   * ALWAYS a local state change with nothing sent to either gateway. There is
   * therefore no `resolveProvider(deps)` call here to switch to
   * `providerFor(...)` — confirmed by reading `cancelIntent`'s own signature
   * and both adapters' capabilities before concluding this, rather than
   * assuming it.
   */
  app.post('/shop/admin/payments/intents/:id/cancel', admin, async (c) =>
    c.json(publicIntent(await cancelIntent(currentDb(c), pathParam(c, 'id')))),
  );

  /**
   * Drain stored-but-unprocessed webhook events. Owner only, and for a cron.
   *
   * The safety net under "acknowledge then process" — anything the
   * post-response work did not finish because the function was frozen.
   */
  app.post('/shop/admin/payments/events/drain', admin, async (c) =>
    c.json({
      processed: await drainPaymentEvents(currentDb(c), 50, Date.now(), { checkout }),
    }),
  );

  /**
   * The gateway switch. Owner and developer only (`requireAdmin()`) — the
   * `payments` domain gate in `server/middleware/permissions.ts` already
   * covers everything under `/api/shop/admin/payments`, so no change there
   * was needed for this pair.
   *
   * THE RESPONSE SHAPE IS FIXED: the admin card is built against it in a
   * parallel dispatch, so `GET` and `PATCH` both answer through
   * `paymentSettingsResponse` and must keep matching it exactly.
   */
  app.get('/shop/admin/payments/settings', admin, async (c) => {
    const settings = await readPaymentSettings(currentDb(c));
    return c.json(paymentSettingsResponse(settings));
  });

  /**
   * `.strict()`, carries `revision`, 409 on `StaleWriteError` — the last of
   * those falls out of the generic mapping in `middleware/errors.ts` and
   * needs no special handling here.
   *
   * ⚠ THE TRAP: `writePaymentSettings` distinguishes "leave alone" from
   * "clear" with `'internationalProvider' in patch` — a KEY-PRESENCE test on
   * the object passed to it (`settings.ts`'s own header explains why
   * `COALESCE`/`??`/`!== undefined` cannot substitute). Building the patch as
   * `{ internationalProvider: body.internationalProvider }` unconditionally
   * would pass `undefined` whenever the caller omits the field, and
   * `undefined` under a literal key still reads as PRESENT — silently
   * clearing the country rule on every ordinary save that does not mention
   * it. So the patch below copies each key ONLY when the parsed body
   * actually carries it. (Verified separately: this exact Zod schema already
   * drops an absent optional key from `safeParse`'s result rather than
   * setting it to `undefined`, so checking `in` on `body` here is sufficient
   * — this loop is what keeps a future edit from reaching for a spread and
   * reopening the trap regardless.)
   */
  app.patch('/shop/admin/payments/settings', admin, async (c) => {
    const body = await readJson(c, PatchPaymentSettingsBody);
    const patch: PaymentSettingsPatch = {};
    if ('activeProvider' in body) patch.activeProvider = body.activeProvider;
    if ('internationalProvider' in body) patch.internationalProvider = body.internationalProvider;
    if ('currencies' in body) patch.currencies = body.currencies;

    const settings = await writePaymentSettings(
      currentDb(c),
      patch,
      body.revision,
      currentUser(c).id,
    );
    return c.json(paymentSettingsResponse(settings));
  });

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
function publicIntent(intent: PaymentIntentRow) {
  return {
    id: intent.id,
    checkoutId: intent.checkoutId,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    authorizationUrl: intent.authorizationUrl,
    refundedTotal: intent.refundedTotal,
    /*
     * EXACTLY WHAT THE GATEWAY WILL ASK FOR (1140), so the storefront can show
     * it. `amount`/`currency` above stay the naira grand total; `breakdown` is
     * null for a naira charge and for every intent from before the handshake.
     */
    charged: { ...chargedOf(intent), breakdown: intent.chargeBreakdown },
  };
}

/**
 * `GET`/`PATCH /shop/admin/payments/settings`'s response — THE FROZEN SHAPE
 * the admin card is built against in a parallel dispatch, so it must match
 * exactly:
 *
 * ```ts
 * interface PaymentSettingsResponse {
 *   activeProvider: ProviderName;
 *   internationalProvider: ProviderName | null;
 *   revision: number;
 *   gateways: Record<ProviderName, {
 *     hasKey: boolean;      // a BOOLEAN. Never the key, never a prefix, never a length.
 *     currencies: string[]; // switched on for this account (the settings row)
 *     canCharge: string[];  // the adapter's ceiling (capabilities.currencies)
 *   }>;
 * }
 * ```
 *
 * `hasKey` COMES FROM `providerKeyPresence()` AND `canCharge` FROM
 * `providerCeilings()` — READ FRESH ON EVERY CALL, NEVER CACHED ON THIS
 * MODULE. Both are cheap (`providerKeyPresence` reads `process.env` directly;
 * `providerCeilings` constructs a throwaway, credential-free instance purely
 * to read a static property — see each function's own header in
 * `config.ts`), and a deployment's configured keys can change between two
 * requests to a long-lived process without either being a reason to hold a
 * stale answer.
 */
function paymentSettingsResponse(settings: {
  activeProvider: ProviderName;
  internationalProvider: ProviderName | null;
  currencies: Record<ProviderName, string[]>;
  revision: number;
}) {
  const hasKey = providerKeyPresence();
  const canCharge = providerCeilings();
  const gateways = {} as Record<
    ProviderName,
    { hasKey: boolean; currencies: string[]; canCharge: string[] }
  >;
  for (const name of PROVIDER_NAMES) {
    gateways[name] = {
      hasKey: hasKey[name],
      currencies: settings.currencies[name],
      canCharge: [...canCharge[name]],
    };
  }
  return {
    activeProvider: settings.activeProvider,
    internationalProvider: settings.internationalProvider,
    revision: settings.revision,
    gateways,
  };
}

/**
 * The configured callback URL, or nothing.
 *
 * WRAPPED so that a deployment with no `PAYMENTS_CALLBACK_URL` — or with no
 * payments environment at all — does not turn creating an intent into a 500
 * raised by config parsing. The callback is a convenience; the webhook and
 * `/confirm` are the mechanisms.
 *
 * @param requestOrigin the intent-creation request's `Origin` header, which
 * decides WHICH storefront the customer is returned to. Omitting it is safe and
 * yields production — but on the dev deployment it is the difference between a
 * test payment coming home and one landing on the live shop as a 404. See
 * `utils/callback-url.ts` for the account of that bug.
 */
function safeCallbackUrl(requestOrigin?: string): string | undefined {
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
    // `||`, DELIBERATELY NOT `??` (admin#30 review). `PAYMENTS_CALLBACK_URL`
    // is `z.string().optional()` with no `.min(1)`, so an empty-string env var
    // parses to `''` rather than `undefined` — `??` would pass that `''`
    // straight through, `paystack.ts` would omit `callback_url` entirely, and
    // the customer would land on Paystack's generic page, which is the exact
    // regression this fallback exists to prevent.
    return paymentsEnv().PAYMENTS_CALLBACK_URL || paymentsCallbackUrl(requestOrigin);
  } catch {
    return paymentsCallbackUrl(requestOrigin);
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
