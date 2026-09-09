/**
 * The Flutterwave adapter — STUB (task 5 of the flutterwave-gateway plan).
 *
 * THIS FILE DOES NOT TALK TO FLUTTERWAVE YET. It exists so that
 * `server/shop/payments/config.ts` has a real class to construct — with the
 * constructor shape fixed by that task's brief — while every method body is
 * left throwing. Tasks 6 and 7 replace those bodies (the intent ladder and
 * the refund/webhook halves respectively); nothing here should be read as
 * settled protocol behaviour.
 *
 * THE CONSTRUCTOR SHAPE IS FIXED AND MUST NOT DRIFT:
 *
 * ```ts
 * new FlutterwaveProvider({
 *   secretKey: string;
 *   webhookHash: string;
 *   baseUrl?: string;
 *   timeoutMs?: number;
 *   fetch?: typeof fetch;
 * })
 * ```
 *
 * It mirrors `PaystackConfig` (`./paystack.ts`) with one addition and one
 * rename: `webhookHash` exists because Flutterwave — UNLIKE PAYSTACK — has a
 * webhook secret that is independent of the API credential (see
 * `config.ts`'s `FLUTTERWAVE_WEBHOOK_HASH` comment); and the injected fetch
 * is named `fetch`, not `fetchImpl`, by a standing ruling on this task. Do
 * not "fix" that back to match Paystack — task 6 builds directly on this
 * exact signature.
 *
 * STUBBED METHODS THROW RATHER THAN FAKE A RESULT ON PURPOSE. A payment
 * adapter that returned a plausible-looking success before it could really
 * reach the gateway would be indistinguishable from a real one to every
 * caller up the stack — the intent ladder, the webhook receiver, an admin
 * screen — which is a worse failure mode than a loud, immediate throw.
 */
import type {
  CreateIntentRequest,
  PaymentProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderIntent,
  ProviderRefund,
  RefundRequest,
} from './types';

/**
 * Flutterwave's v3 REST API. Overridden only by tests (and, per the
 * constructor shape above, by `FLUTTERWAVE_BASE_URL` — see `config.ts`,
 * "never set in a deployment").
 */
const BASE_URL = 'https://api.flutterwave.com/v3';

/** Mirrors Paystack's default. Task 6 may revisit once Flutterwave's own retry/timeout semantics are known. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FlutterwaveConfig {
  /** `FLWSECK-…` live, `FLWSECK_TEST-…` test. Also the value `config.ts` refuses to log. NEVER logged here either. */
  secretKey: string;
  /**
   * The dashboard's webhook secret hash — verifies `verif-hash` on incoming
   * webhooks. INDEPENDENT of `secretKey`: unlike Paystack's single value that
   * is both API credential and signing key, Flutterwave's two rotate apart.
   */
  webhookHash: string;
  /** Overridden by tests to point at a local server. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected so tests need no network and no global patching. */
  fetch?: typeof fetch;
}

const CAPABILITIES: ProviderCapabilities = {
  // Same shape as Paystack: a Flutterwave card charge succeeds or fails in
  // one step, so there is no held authorization for a later `capture()`.
  separateCapture: false,
  // Same reason as Paystack's `remoteCancel: false`: an uncompleted charge is
  // abandoned, not cancelled at the gateway.
  remoteCancel: false,
  partialRefunds: true,
  /**
   * THE GATEWAY'S DOCUMENTED MAXIMUM — every currency Flutterwave's API can
   * charge — NOT what this merchant's account has switched on. That is data,
   * not code: `shop_payment_settings`' `flutterwave_currencies` column (see
   * `settings.ts`). `routing.ts`'s intersection rule already depends on this
   * distinction for Paystack (`provider/types.ts`'s `currencies` doc); the
   * same applies here. Conflating the two would let the admin screen believe
   * a currency is chargeable that this account has never enabled, or refuse
   * one the API would happily take.
   */
  currencies: [
    'NGN',
    'USD',
    'GBP',
    'EUR',
    'GHS',
    'KES',
    'ZAR',
    'UGX',
    'TZS',
    'XOF',
    'XAF',
    'RWF',
    'ZMW',
    'EGP',
  ],
};

export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave';
  readonly capabilities = CAPABILITIES;

  readonly #secretKey: string;
  readonly #webhookHash: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: FlutterwaveConfig) {
    this.#secretKey = config.secretKey;
    this.#webhookHash = config.webhookHash;
    this.#baseUrl = config.baseUrl ?? BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = config.fetch ?? fetch;
  }

  /** Not implemented — task 6. Throws rather than faking an intent. */
  createIntent(req: CreateIntentRequest): Promise<ProviderIntent> {
    void req;
    return Promise.reject(
      new Error('FlutterwaveProvider.createIntent is not implemented yet'),
    );
  }

  /** Not implemented — task 6. `capabilities.separateCapture` is false, so this may end up a permanent refusal like Paystack's, but that is task 6's call, not this stub's. */
  capture(providerIntentId: string, key: string): Promise<ProviderIntent> {
    void providerIntentId;
    void key;
    return Promise.reject(
      new Error('FlutterwaveProvider.capture is not implemented yet'),
    );
  }

  /** Not implemented — task 6. See `capture`'s note; same reasoning applies to `capabilities.remoteCancel`. */
  cancel(providerIntentId: string, key: string): Promise<ProviderIntent> {
    void providerIntentId;
    void key;
    return Promise.reject(
      new Error('FlutterwaveProvider.cancel is not implemented yet'),
    );
  }

  /** Not implemented — task 7. */
  refund(req: RefundRequest, key: string): Promise<ProviderRefund> {
    void req;
    void key;
    return Promise.reject(
      new Error('FlutterwaveProvider.refund is not implemented yet'),
    );
  }

  /** Not implemented — task 6. */
  fetchIntent(providerIntentId: string): Promise<ProviderIntent> {
    void providerIntentId;
    return Promise.reject(
      new Error('FlutterwaveProvider.fetchIntent is not implemented yet'),
    );
  }

  /** Not implemented — task 7. */
  parseWebhook(raw: Uint8Array, headers: Headers): Promise<ProviderEvent> {
    void raw;
    void headers;
    return Promise.reject(
      new Error('FlutterwaveProvider.parseWebhook is not implemented yet'),
    );
  }
}
