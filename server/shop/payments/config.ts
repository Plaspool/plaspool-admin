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
  /**
   * `FLWSECK_TEST-…` in test mode, `FLWSECK-…` in live.
   *
   * The prefix is CHECKED for the same reason `PAYSTACK_SECRET_KEY`'s is: the
   * PUBLIC key (`FLWPUBK…`) is the one that appears in frontend snippets, and
   * pasting it here produces a 401 on the first charge with the gateway blamed.
   *
   * OPTIONAL AT THE SCHEMA LEVEL, REQUIRED AT USE. A deployment that has not
   * set up Flutterwave must still take Paystack payments and still boot.
   */
  FLUTTERWAVE_SECRET_KEY: z
    .string()
    .min(20)
    .regex(/^FLWSECK[-_]/, 'must be a Flutterwave SECRET key')
    .optional(),
  /**
   * The dashboard's secret hash. UNLIKE PAYSTACK, THIS IS A SECOND, SEPARATE
   * VALUE — `PAYSTACK_SECRET_KEY` is both API credential and signing key;
   * Flutterwave's two are independent and rotate independently.
   */
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(8).optional(),
  /** Overridden only by tests. Never set in a deployment. */
  FLUTTERWAVE_BASE_URL: z.string().optional(),
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

/** Test-only: drop the memoised environment between cases. */
export function resetPaymentsEnv(): void {
  cached = null;
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
 * REQUIRED AT USE, NOT AT THE SCHEMA — see the fields' own comments. Both
 * `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_WEBHOOK_HASH` are `.optional()` in
 * the schema so that a deployment with no Flutterwave configured still parses
 * `paymentsEnv()` and still takes Paystack payments; the requirement that
 * BOTH be present is enforced here instead, at the moment a Flutterwave
 * payment is actually attempted.
 */
export function flutterwaveProvider(): PaymentProvider {
  const env = paymentsEnv();
  if (!env.FLUTTERWAVE_SECRET_KEY || !env.FLUTTERWAVE_WEBHOOK_HASH) {
    // NAMES ONLY. Never the value, and never zod's own message, which quotes
    // the offending input for several issue codes.
    throw new Error(
      'Invalid payments environment: FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_WEBHOOK_HASH',
    );
  }
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
