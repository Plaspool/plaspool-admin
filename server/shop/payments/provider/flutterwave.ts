/**
 * The Flutterwave adapter — the charging half (task 6 of the flutterwave-
 * gateway plan). `createIntent`, `fetchIntent`, `capture` and `cancel` are
 * real now. `refund` and `parseWebhook` still throw the placeholder `Error`
 * task 5 left them with — task 7 replaces those two bodies, and nothing here
 * should be read as settled behaviour for either of them.
 *
 * MIRRORS `./paystack.ts` ON PURPOSE: the same `#request` helper shape, the
 * same network/timeout/auth/rate-limit/5xx classification, the same
 * `asRecord`/`str` guards, and the same rule that a gateway's own message is
 * matched against and never carried onto an error. Where this provider
 * genuinely differs from Paystack, it is named below rather than smoothed
 * over.
 *
 * ⚠ THE AMOUNT CONVERSION IS THE MOST DANGEROUS LINE IN THIS FILE. Every
 * amount elsewhere in this system is MINOR units — 100 per naira, so ₦3,000
 * is `300000`. Paystack's subunit already matches that 1:1, so its adapter
 * sends the number unchanged. **FLUTTERWAVE'S `/v3/payments` TAKES MAJOR
 * UNITS** — it wants `3000` where we hold `300000`. `toMajorUnits` (outgoing)
 * and `toMinorUnits` (incoming) below are the ONLY two places this file
 * multiplies or divides by 100, and every call site that touches an amount
 * goes through one of them — one line per direction to check against the
 * live sandbox before real money moves (see each function's own comment for
 * why a non-multiple-of-100 is refused rather than rounded).
 *
 * WHAT ELSE IS DIFFERENT FROM PAYSTACK:
 *
 * - **`tx_ref` is ours**, exactly like Paystack's `reference`: supplied by
 *   the caller, never minted here — that is what makes a retry safe, and it
 *   is why `fetchIntent` reports `providerIntentId` back as the reference we
 *   gave it (`data.tx_ref`), never Flutterwave's own numeric id.
 * - **Flutterwave DOES hand back a numeric charge id** (`data.id`), which
 *   Paystack has no equivalent of. `POST /v3/payments` (`createIntent`) has
 *   no id yet — only a redirect link — so its result carries
 *   `providerChargeId: null`; `GET /v3/transactions/verify_by_reference`
 *   (`fetchIntent`) does return one, and it is carried forward as a STRING
 *   because task 7's refund call (`POST /v3/transactions/{id}/refund`) needs
 *   it and nothing here ever does arithmetic on it.
 * - **No authorize/capture split, same as Paystack.** `capture()` and
 *   `cancel()` stay `unsupported`: a Flutterwave charge succeeds or fails
 *   outright, with no held authorization to take later.
 */
import { ProviderError } from './scrub';
import type {
  CreateIntentRequest,
  PaymentProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderFailureReason,
  ProviderIntent,
  ProviderIntentStatus,
  ProviderRefund,
  RefundRequest,
} from './types';

/**
 * Flutterwave's v3 REST API. Overridden only by tests (and, per the
 * constructor shape below, by `FLUTTERWAVE_BASE_URL` — see `config.ts`,
 * "never set in a deployment").
 */
const BASE_URL = 'https://api.flutterwave.com/v3';

/**
 * Mirrors Paystack's default. Nothing observed about Flutterwave's own
 * retry/timeout semantics argues for a different value yet.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FlutterwaveConfig {
  /** `FLWSECK-…` live, `FLWSECK_TEST-…` test. Also the value `config.ts` refuses to log. NEVER logged here either. */
  secretKey: string;
  /**
   * The dashboard's webhook secret hash — verifies `verif-hash` on incoming
   * webhooks. INDEPENDENT of `secretKey`: unlike Paystack's single value that
   * is both API credential and signing key, Flutterwave's two rotate apart.
   *
   * Not read anywhere in this file yet — `parseWebhook` is task 7's — but the
   * constructor shape is fixed (task 5's ruling) and stores it now so task 7
   * needs no constructor change.
   */
  webhookHash: string;
  /** Overridden by tests to point at a local server. */
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Injected so tests need no network and no global patching. Named `fetch`,
   * not `fetchImpl` like `PaystackConfig` — a standing ruling for this
   * adapter (task 5). Do not rename it back to match Paystack.
   */
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

/**
 * Flutterwave's transaction states → ours.
 *
 * CASE-SENSITIVE, matching `paystack.ts`'s own `mapIntentStatus`: the
 * provider's documented values are already lowercase, and guessing at other
 * casings it has never been observed to send would be inventing behaviour
 * rather than mirroring it.
 */
function mapIntentStatus(status: string): ProviderIntentStatus {
  switch (status) {
    case 'successful':
      return 'captured';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      // pending — and anything Flutterwave adds that this adapter does not
      // yet know about. NEVER `captured` for an unrecognised value.
      return 'requires_payment';
  }
}

/**
 * `ProviderIntent.failureReason` is documented as meaningful only when
 * `status` is `failed`, so this returns non-null in exactly that one case —
 * the same coupling `paystack.ts`'s three-armed version has, where `failed`,
 * `abandoned` and `reversed` all map to overall status `failed` too.
 */
function mapFailureReason(status: string): ProviderFailureReason | null {
  return status === 'failed' ? 'declined' : null;
}

interface FlutterwaveEnvelope {
  status?: unknown;
  message?: unknown;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * OURS (minor units, ×100) → Flutterwave's `/v3/payments` `amount`, which
 * wants MAJOR units: `3000` where we hold `300000`. See this file's header —
 * this is one of the two lines the whole conversion goes through.
 *
 * REFUSES RATHER THAN ROUNDING. `CreateIntentRequest.amount` arrives from
 * `CheckoutPort` as a whole number of the major unit already (₦3,000, never
 * ₦30.005), so a minor amount that is not an exact multiple of 100 is not a
 * fraction of a naira to round away — it is evidence the number reaching this
 * adapter is not what it claims to be. Letting `Number` round it away is
 * exactly the silent failure mode the amount-conversion rule warns against,
 * so this throws a permanent, non-retryable error instead of guessing.
 */
function toMajorUnits(minor: number): number {
  if (!Number.isSafeInteger(minor) || minor % 100 !== 0) {
    throw new ProviderError({
      code: 'invalid_request',
      provider: 'flutterwave',
      operation: 'createIntent',
    });
  }
  return minor / 100;
}

/**
 * Flutterwave's amount (MAJOR units, as `fetchIntent` reads it back) → ours
 * (minor, ×100). The read-side mirror of `toMajorUnits`, and the other of the
 * two lines the whole conversion goes through.
 *
 * GUARDED LIKE `paystack.ts`'s `minorUnits`: a value that is not a genuine
 * finite number — missing, a string that fails to parse, `null` — comes back
 * `null` rather than `NaN` or `0`, so a caller cannot mistake "we don't know"
 * for "zero". Unlike `minorUnits`, the safe-integer check runs AFTER
 * multiplying by 100 rather than before: the value in hand here is
 * Flutterwave's major unit, not ours, and it is the ×100 RESULT that must be
 * a safe integer minor-unit figure. Every amount this adapter ever sends is
 * already a whole major unit (`toMajorUnits` guarantees that on the way out),
 * so a genuine response reflecting one back always clears this.
 */
function toMinorUnits(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const minor = n * 100;
  return Number.isSafeInteger(minor) ? minor : null;
}

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

  /**
   * The one place this adapter touches the network. Mirrors `paystack.ts`'s
   * `#request` exactly in shape: every failure leaves here as a
   * `ProviderError` and nothing else — the body is read only to classify it,
   * never carried onto the thrown error. `scrubbedProvider()` (`config.ts`)
   * wraps every public method as a second layer, so a bug in this method
   * cannot leak either.
   */
  async #request(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          // The one place the key is used. Never interpolated into a URL,
          // where it would reach a proxy log and this application's own
          // traces.
          authorization: `Bearer ${this.#secretKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      /*
       * The ONLY inspection of a thrown value anywhere in this file, and it
       * reads a `name` — never a message. `TimeoutError` and `AbortError` are
       * INDETERMINATE (contract §5): the request may well have been
       * executed. Classifying one as a plain failure is how a charge gets
       * made twice.
       */
      const name = err instanceof Error ? err.name : '';
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      throw new ProviderError({ code, provider: this.name, operation });
    }

    let envelope: FlutterwaveEnvelope | null = null;
    try {
      envelope = (await response.json()) as FlutterwaveEnvelope;
    } catch {
      envelope = null;
    }

    /*
     * Flutterwave's envelope reports `status: 'success' | 'error'` — a
     * STRING, unlike Paystack's boolean — so the check goes through the same
     * `str()` guard used everywhere else in this file, which fails closed:
     * anything that is not a genuine non-empty string compares unequal to
     * `'success'` rather than needing its own separate null-check.
     */
    if (!response.ok || str(envelope?.status) !== 'success') {
      throw new ProviderError({
        code: this.#classify(response.status),
        provider: this.name,
        operation,
        status: response.status,
      });
    }

    const data = asRecord(envelope?.data);
    if (!data) {
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation,
        status: response.status,
      });
    }
    return data;
  }

  /**
   * An HTTP status → an enumerated code.
   *
   * NARROWER THAN PAYSTACK'S `#classify` ON PURPOSE: it does not match on
   * `message` text. Paystack's does, for the one case worth a distinct code
   * (`duplicate_reference`), because its exact wording
   * ("Duplicate Transaction Reference") is documented and confirmed. This
   * task has no live sandbox access (see this file's header) and therefore
   * no confirmed Flutterwave wording to match without guessing — a wrong
   * guess would silently misclassify a real failure. Add a message-matched
   * case here once the sandbox shows what Flutterwave actually sends for a
   * repeated `tx_ref`.
   */
  #classify(status: number) {
    if (status === 401 || status === 403) return 'auth' as const;
    if (status === 429) return 'rate_limited' as const;
    if (status >= 500) return 'provider_unavailable' as const;
    if (status >= 400) return 'invalid_request' as const;
    // A 2xx whose envelope said `status: 'error'` — the request was
    // understood and refused. Permanent, so the client must not retry it.
    return 'invalid_request' as const;
  }

  /**
   * Turns a `verify_by_reference` response into our shape. The only place
   * `providerChargeId` is populated with a real value — `createIntent`'s own
   * response has no id yet (see below).
   */
  #toIntent(data: Record<string, unknown>, fallbackReference: string): ProviderIntent {
    const status = str(data.status) ?? '';
    const rawId = data.id;
    const providerChargeId =
      typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : str(rawId);
    return {
      providerIntentId: str(data.tx_ref) ?? fallbackReference,
      status: mapIntentStatus(status),
      amount: toMinorUnits(data.amount) ?? 0,
      currency: str(data.currency) ?? '',
      authorizationUrl: str(data.link),
      failureReason: mapFailureReason(status),
      providerChargeId,
    };
  }

  async createIntent(req: CreateIntentRequest): Promise<ProviderIntent> {
    /*
     * `tx_ref` IS OUR REFERENCE, NEVER MINTED HERE — the whole retry-safety
     * story depends on it. `amount` is the ONE conversion (see
     * `toMajorUnits` and this file's header); `currency` and
     * `customer.email` pass through unchanged; `redirect_url` is sent only
     * when the caller gave a callback, exactly like Paystack's optional
     * `callback_url`.
     *
     * `req.metadata` IS NOT FORWARDED. Unlike Paystack's adapter, which
     * passes `metadata` through as a JSON string, this endpoint's accepted
     * shape here is exactly the fields below — that is the parent task's
     * explicit enumeration, not an oversight. Add a `meta` object only once
     * Flutterwave's accepted shape for it is confirmed against the sandbox
     * rather than guessed.
     */
    const data = await this.#request('createIntent', 'POST', '/payments', {
      tx_ref: req.reference,
      amount: toMajorUnits(req.amount),
      currency: req.currency,
      customer: { email: req.email },
      ...(req.callbackUrl ? { redirect_url: req.callbackUrl } : {}),
    });

    /*
     * `POST /v3/payments` returns only `data.link` — no status, no amount, no
     * charge id, because nothing has happened at the gateway besides minting
     * a checkout page. So those are reported from the REQUEST, the same way
     * Paystack's `createIntent` reports an unpaid transaction rather than
     * echoing back a confirmation the provider never gave.
     */
    return {
      providerIntentId: req.reference,
      status: 'requires_payment',
      amount: req.amount,
      currency: req.currency,
      authorizationUrl: str(data.link),
      failureReason: null,
      providerChargeId: null,
    };
  }

  /**
   * Flutterwave has no two-step capture either: a charge succeeds or fails
   * outright. Refusing is the honest answer.
   */
  capture(providerIntentId: string, key: string): Promise<ProviderIntent> {
    void providerIntentId;
    void key;
    return Promise.reject(
      new ProviderError({ code: 'unsupported', provider: this.name, operation: 'capture' }),
    );
  }

  /**
   * Nor a remote cancel: an uncompleted charge is abandoned, not cancelled at
   * the gateway.
   */
  cancel(providerIntentId: string, key: string): Promise<ProviderIntent> {
    void providerIntentId;
    void key;
    return Promise.reject(
      new ProviderError({ code: 'unsupported', provider: this.name, operation: 'cancel' }),
    );
  }

  /**
   * Reads a charge back BY OUR OWN REFERENCE — `tx_ref`, the query parameter
   * `verify_by_reference` takes — never by Flutterwave's numeric id, which we
   * may not even have yet if the customer has not returned from checkout.
   */
  async fetchIntent(providerIntentId: string): Promise<ProviderIntent> {
    const data = await this.#request(
      'fetchIntent',
      'GET',
      `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(providerIntentId)}`,
    );
    return this.#toIntent(data, providerIntentId);
  }

  /** Not implemented — task 7. */
  refund(req: RefundRequest, key: string): Promise<ProviderRefund> {
    void req;
    void key;
    return Promise.reject(
      new Error('FlutterwaveProvider.refund is not implemented yet'),
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
