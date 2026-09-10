import { z } from 'zod';
import { FlutterwaveProvider } from './provider/flutterwave';
import { PaystackProvider } from './provider/paystack';
import { scrubbedProvider } from './provider/scrub';
import type { ProviderName } from './schema';
import type { PaymentProvider } from './provider/types';

/**
 * Payments' own environment, read lazily and validated here rather than in
 * `server/env.ts`.
 *
 * TWO REASONS, and the second is the one that matters:
 *
 * 1. `server/env.ts` is not this subsystem's file (contract §2 R1). Adding a
 *    key to it would be an amendment, and this needs no amendment to avoid.
 * 2. `getEnv()` throws when ANY declared variable is missing, and it is called
 *    on the boot path of the whole application. A deployment that has not set
 *    up payments must still serve the blog — the R2 keys are defaulted to `''`
 *    in that file for exactly this reason, which is the same problem solved by
 *    weakening the schema instead of by scoping it. Scoping it is better: here,
 *    the variable is required, and it is required *at the moment a payment is
 *    attempted*, so a missing key is a loud failure on the payment path and no
 *    failure at all anywhere else.
 *
 * THE SAME SCOPING APPLIES BETWEEN GATEWAYS, NOT ONLY BETWEEN THIS FILE AND
 * `server/env.ts`. `Schema` below covers what is genuinely shared
 * (`PAYMENTS_CALLBACK_URL`) or Paystack's own. Flutterwave's three variables
 * live in their own `FlutterwaveSchema`, with their own cache and their own
 * `safeParse`, further down this file — see that schema's comment for why a
 * single shared schema was the wrong shape once a second gateway existed.
 *
 * `PAYSTACK_SECRET_KEY` IS BOTH THE API CREDENTIAL AND THE WEBHOOK SIGNING KEY.
 * Paystack has no separate signing secret: `x-paystack-signature` is an
 * HMAC-SHA512 under this same value. Two consequences worth knowing before
 * rotating it: a new key takes effect for signature verification the instant it
 * is deployed, and any redelivery still in Paystack's 72-hour retry window that
 * was signed under the old key will fail to verify and be refused.
 */
const Schema = z.object({
  /**
   * `sk_test_…` in test mode, `sk_live_…` in production.
   *
   * The prefix is CHECKED, and the check is worth its weight: Paystack's public
   * key (`pk_…`) is the one that appears in frontend snippets, and pasting it
   * here produces a 401 on the first charge and a signature that never verifies
   * — at 3am, with the provider blamed. `min(1)` would accept it.
   */
  PAYSTACK_SECRET_KEY: z
    .string()
    .min(20)
    .regex(/^sk_(test|live)_/, 'must be a Paystack SECRET key'),
  /** Overridden only by tests. Never set in a deployment. */
  PAYSTACK_BASE_URL: z.string().optional(),
  /**
   * Where the customer lands after paying. A UI hint ONLY (`03-payments.md`
   * §8): the browser arriving here is not evidence of anything, and the route
   * it lands on re-asks the provider through `fetchIntent`.
   */
  PAYMENTS_CALLBACK_URL: z.string().optional(),
});

export type PaymentsEnv = z.infer<typeof Schema>;

let cached: PaymentsEnv | null = null;

export function paymentsEnv(): PaymentsEnv {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    /*
     * NAMES ONLY — never `parsed.error.message`, and never the value.
     *
     * Zod quotes the offending input for several issue codes, and the offending
     * input here is a live secret key. `server/env.ts` makes the same choice for
     * the same reason and `middleware/errors.ts` documents it at length: an
     * error message is the shortest path from a secret to a log.
     */
    throw new Error(
      `Invalid payments environment: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
    );
  }
  return (cached = parsed.data);
}

/**
 * Flutterwave's own environment — its OWN schema, its OWN cache and its OWN
 * `safeParse`, entirely separate from `Schema`/`paymentsEnv()` above.
 *
 * THIS SEPARATION IS THE FIX FOR A REAL INCIDENT SHAPE, NOT A STYLE CHOICE.
 * Before this, Flutterwave's three variables lived inside the same
 * `z.object()` that `paystackProvider()` also parses, so ONE malformed
 * Flutterwave value — someone pasting the public `FLWPUBK…` key where the
 * secret belongs, which is exactly what the prefix regex below exists to
 * catch — failed `safeParse` for the *whole* schema and made `paymentsEnv()`
 * throw for every caller, Paystack included. A typo in the gateway being
 * added would have disabled the gateway that is currently taking this shop's
 * live payments. Each gateway gets its own schema, cache and parse so that
 * can never happen again: a broken key disables only the gateway it belongs
 * to.
 *
 * REQUIRED HERE, NOT `.optional()` WITH A HAND-ROLLED CHECK AFTERWARDS. That
 * was the previous shape (see git history) and it is unnecessary now: nothing
 * calls this function except `flutterwaveProvider()`, and reaching
 * `flutterwaveProvider()` at all already means a Flutterwave payment is being
 * attempted, so there is no "not configured yet, and that's fine" case left
 * for this parse to be lenient about. `providerKeyPresence()` below answers
 * "is it configured" without ever calling this function, which is what keeps
 * a deployment with no Flutterwave configured bootable.
 */
const FlutterwaveSchema = z.object({
  /**
   * `FLWSECK_TEST-…` in test mode, `FLWSECK-…` in live.
   *
   * The prefix is CHECKED for the same reason `PAYSTACK_SECRET_KEY`'s is: the
   * PUBLIC key (`FLWPUBK…`) is the one that appears in frontend snippets, and
   * pasting it here produces a 401 on the first charge with the gateway blamed.
   */
  FLUTTERWAVE_SECRET_KEY: z
    .string()
    .min(20)
    .regex(/^FLWSECK[-_]/, 'must be a Flutterwave SECRET key'),
  /**
   * The dashboard's secret hash. UNLIKE PAYSTACK, THIS IS A SECOND, SEPARATE
   * VALUE — `PAYSTACK_SECRET_KEY` is both API credential and signing key;
   * Flutterwave's two are independent and rotate independently.
   */
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(8),
  /** Overridden only by tests. Never set in a deployment. */
  FLUTTERWAVE_BASE_URL: z.string().optional(),
});

export type FlutterwaveEnv = z.infer<typeof FlutterwaveSchema>;

let flutterwaveCached: FlutterwaveEnv | null = null;

/** Parsed lazily — only when `flutterwaveProvider()` is actually called. */
function flutterwaveEnv(): FlutterwaveEnv {
  if (flutterwaveCached) return flutterwaveCached;
  const parsed = FlutterwaveSchema.safeParse(process.env);
  if (!parsed.success) {
    // NAMES ONLY — never `parsed.error.message`, never the value. Same reason
    // `paymentsEnv()` gives above: the offending input here is a live secret.
    throw new Error(
      `Invalid payments environment: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
    );
  }
  return (flutterwaveCached = parsed.data);
}

/** Test-only: drop the memoised environment for BOTH gateways between cases. */
export function resetPaymentsEnv(): void {
  cached = null;
  flutterwaveCached = null;
}

/**
 * The production provider, wrapped in the scrub.
 *
 * `scrubbedProvider()` IS APPLIED HERE AND NOWHERE ELSE, which is what makes it
 * unskippable: this is the only function that constructs a real adapter, so
 * there is no path to a `PaystackProvider` that has not been wrapped. The same
 * shape as `getDb()` wrapping every handle in `guardDb` — a guard that call
 * sites have to remember to apply is a guard that is one forgotten call site
 * from being absent.
 */
export function paystackProvider(): PaymentProvider {
  const env = paymentsEnv();
  return scrubbedProvider(
    new PaystackProvider({
      secretKey: env.PAYSTACK_SECRET_KEY,
      baseUrl: env.PAYSTACK_BASE_URL,
    }),
  );
}

/**
 * The Flutterwave provider, wrapped in the same scrub.
 *
 * READS `flutterwaveEnv()`, NEVER `paymentsEnv()` — see `FlutterwaveSchema`'s
 * own comment for why the two must not share a parse. Both
 * `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_WEBHOOK_HASH` are required inside
 * that schema now rather than `.optional()` with a hand-rolled "both present"
 * check afterwards (the previous shape): calling this function at all already
 * means a Flutterwave payment is being attempted, so there is nothing left to
 * be lenient about here. A deployment with no Flutterwave configured simply
 * never calls this function, and `paystackProvider()` is unaffected either
 * way — including when Flutterwave's configuration is present but broken.
 */
export function flutterwaveProvider(): PaymentProvider {
  const env = flutterwaveEnv();
  return scrubbedProvider(
    new FlutterwaveProvider({
      secretKey: env.FLUTTERWAVE_SECRET_KEY,
      webhookHash: env.FLUTTERWAVE_WEBHOOK_HASH,
      baseUrl: env.FLUTTERWAVE_BASE_URL,
    }),
  );
}

/**
 * Which gateways this deployment can authenticate to. A BOOLEAN PER GATEWAY —
 * never the key, never a prefix, never a length. Feeds the admin card's
 * warning, so the owner cannot switch onto a gateway that will 401.
 *
 * READS `process.env` DIRECTLY RATHER THAN `paymentsEnv()`, because that
 * function THROWS when the schema does not parse — and "the key is malformed"
 * is exactly a case this must be able to report rather than crash on. A
 * presence check that cannot run when something is wrong is useless precisely
 * when it is needed.
 */
export function providerKeyPresence(): Record<ProviderName, boolean> {
  return {
    paystack: Boolean(process.env.PAYSTACK_SECRET_KEY),
    flutterwave: Boolean(
      process.env.FLUTTERWAVE_SECRET_KEY && process.env.FLUTTERWAVE_WEBHOOK_HASH,
    ),
  };
}
