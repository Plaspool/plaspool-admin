/**
 * The Flutterwave adapter — complete now (task 7 of the flutterwave-gateway
 * plan). `createIntent`, `fetchIntent`, `capture` and `cancel` were task 6's;
 * `refund` and `parseWebhook` are this task's, and the webhook is the one
 * piece of this whole file that cannot be proven by a test — see its own
 * doc comment before touching it.
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
 * why a kobo-bearing amount is ORDINARY here — bulk discounts and percent
 * discount codes both produce one — and never evidence of corruption).
 *
 * ⚠ THE WEBHOOK IS A TRIGGER, NEVER A SOURCE OF TRUTH — THE OTHER PROPERTY
 * THIS FILE EXISTS TO PROTECT. Flutterwave v3 does not sign the webhook
 * body: `verif-hash` is the dashboard's secret hash SENT BACK VERBATIM and
 * compared for equality, not an HMAC over anything, so it proves only that
 * the sender knows a static value — never that the body is unmodified.
 * Anyone who ever learns that value can replay it on a body claiming ANY
 * `tx_ref` was captured, under ANY event name, at ANY status, for ANY
 * amount. So `parseWebhook` below TRUSTS exactly one fact from the payload
 * (`data.tx_ref`) and asks `fetchIntent` for everything else — including
 * the STATUS half of the dedupe key (`flutterwaveEventIdOf`), never the
 * body's own claimed `data.status`, and the `type` it reports, which is
 * PATTERN-MATCHED against one known-safe literal (`safeEventType`) rather
 * than passed through verbatim. See that method's own comment, which is the
 * real documentation of this property; this paragraph is only the pointer
 * to it.
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
 *   because `refund`'s call to `POST /v3/transactions/{id}/refund` needs it
 *   and nothing here ever does arithmetic on it.
 * - **`refund` never has a charge id to start with.** `RefundRequest`
 *   carries our reference, not theirs — nothing upstream has ever needed
 *   Flutterwave's numeric id before this file. So `refund` resolves it
 *   itself, via the same `verify_by_reference` lookup `fetchIntent` already
 *   makes, before it can call the refund endpoint at all.
 * - **No authorize/capture split, same as Paystack.** `capture()` and
 *   `cancel()` stay `unsupported`: a Flutterwave charge succeeds or fails
 *   outright, with no held authorization to take later.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
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
  ProviderRefundStatus,
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
   * webhooks (`parseWebhook`, via `verifyFlutterwaveHash`). INDEPENDENT of
   * `secretKey`: unlike Paystack's single value that is both API credential
   * and signing key, Flutterwave's two rotate apart.
   *
   * NOT A SIGNATURE KEY — see `parseWebhook`'s own comment. This value is
   * compared for EQUALITY against what the webhook sends, not used to
   * compute an HMAC, because Flutterwave v3 does not sign the body at all.
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

/**
 * Flutterwave's refund states → our three, the same SAFE direction as
 * `paystack.ts`'s own `mapRefundStatus`: anything not positively known to
 * be finished stays `pending` rather than `failed`. A refund wrongly called
 * `failed` releases the amount it held against the intent, and a second
 * attempt could then refund the same money twice.
 */
function mapRefundStatus(status: string): ProviderRefundStatus {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      // pending / processing — and anything Flutterwave adds that this
      // adapter does not yet recognise.
      return 'pending';
  }
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
 * VALIDATES ONLY THAT THE INPUT IS A SAFE, POSITIVE INTEGER, then divides by
 * 100 UNCONDITIONALLY — no remainder check. That division is exact for every
 * realistic amount (it is a divide by a power of ten of an integer minor-unit
 * figure, not a decimal operation that can go wrong), and `JSON.stringify`
 * emits the shortest round-trippable decimal for the result — `127015 / 100`
 * serialises as `1270.15` on the wire, not `1270.1499999999999`.
 *
 * THIS USED TO THROW WHENEVER `minor % 100 !== 0`, on the theory that a
 * non-whole-naira minor amount was evidence of corruption. THAT PREMISE IS
 * FALSE IN THIS CODEBASE. Kobo is the ORDINARY output of two features that
 * already ship: the bulk-discount ladder and percent-based discount codes.
 * Both go through `scale()` in `server/shop/cart/totals/compute.ts` — the
 * bulk tier (`effectiveUnit = scale(unit, BPS - bulkPercentBps, BPS, …)`,
 * ~line 316) and the discount-code percent arm (`scale(line.lineTotal,
 * discount.percentBps, BPS, …)`, ~line 360) — and `CheckoutPort` freezes
 * whatever they compute. A whole-naira catalogue price of ₦1,337.00
 * (`133700`) at a 5% bulk tier becomes `133700 * 9500 / 10000 = 127015`
 * minor units, i.e. ₦1,270.15 — exact arithmetic, not a rounding accident,
 * and `127015 % 100 === 15`. Refusing that meant refusing to charge exactly
 * the discounted carts this shop most wants to take: any cart whose discount
 * did not coincidentally land on a whole hundred naira failed here, before a
 * single network call was made.
 */
function toMajorUnits(minor: number): number {
  if (!Number.isSafeInteger(minor) || minor <= 0) {
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
 * `Math.round(n * 100)` — THE STANDARD WAY EVERY MAJOR/MINOR CURRENCY
 * CONVERSION HAS TO WORK, because IEEE-754 binary floating point does not
 * represent most decimal fractions exactly. `19.99 * 100 === 1998.9999999999998`,
 * not `1999` — that is not a malformed response, it is what multiplying an
 * entirely ordinary decimal by 100 does in floating point. THIS USED TO
 * DEMAND THE RAW PRODUCT ALREADY BE A SAFE INTEGER, which rejects ordinary
 * values like `19.99` outright and returns `null` for them — and the caller
 * (`#toIntent`) used to default a rejected amount to `0`, so a perfectly
 * normal Flutterwave response silently reported a paid order as worth
 * nothing. Rounding after multiplying is the fix.
 *
 * STILL GUARDED LIKE `paystack.ts`'s `minorUnits`: a value that is not a
 * genuine finite number — missing, a string that fails to parse, `null` —
 * comes back `null` rather than `NaN` or `0`, so a caller cannot mistake "we
 * don't know" for "zero". That guard is correct and stays; only the demand
 * that the multiplied result be bit-exact is gone.
 */
function toMinorUnits(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const minor = Math.round(n * 100);
  /*
   * THE UPPER BOUND THIS FUNCTION LOST WHEN BIT-EXACTNESS WAS REMOVED,
   * RESTORED — but on the OUTPUT, not the input, which is the distinction
   * that matters. The bit-exactness demand this function used to make on
   * `n * 100` rejected perfectly ordinary values (`19.99 * 100 !==
   * 1998.9999999999998`'s rounded `1999`) and is gone for good — see the
   * comment above. This check is a different thing: a SAFE-INTEGER ceiling
   * on the result, restraining how large an amount `fetchIntent` will ever
   * report rather than how it was computed. `Math.round` still runs
   * unconditionally; only a result that overflows `Number.MAX_SAFE_INTEGER`
   * (2^53 - 1, ≈ ₦90 trillion in minor units) is refused, through the same
   * `null` this function already returns for a non-numeric `value` — the
   * caller (`#toIntent`) already turns that into `malformed_response`
   * rather than defaulting the amount to zero.
   */
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * A stable, unique identity for a webhook event — the same problem
 * `providerEventIdOf` solves for Paystack, and for the same reason:
 * Flutterwave's envelope carries no event id of its own, either in the body
 * or in a header.
 *
 * NAMESPACED ON EVERY BRANCH, INCLUDING THE FALLBACK.
 * `shop_payment_events.provider_event_id` is ONE globally unique column
 * shared by every gateway (`03-payments.md` §4); prefixing `flutterwave:`
 * unconditionally is what makes this adapter's keys structurally unable to
 * collide with another gateway's, rather than merely unlikely to.
 *
 * THE COMPOSITE IS `tx_ref` PLUS THE TRUSTED STATUS `fetchIntent` RESOLVED —
 * NEVER THE BODY'S `event` FIELD, AND NEVER THE BODY'S CLAIMED `data.status`.
 * This function used to take `event` as its discriminant
 * (`flutterwave:${event}:${txRef}`), and that was wrong in a way a stub
 * proved directly: Flutterwave sends ONE constant event name —
 * `charge.completed` — across a charge's entire lifecycle, so `event`
 * contributed no variability at all and the key reduced to `tx_ref` alone.
 * A webhook delivered while a charge is still pending and a second once it
 * clears then produced the SAME key; the second collided on
 * `ON CONFLICT (provider_event_id) DO NOTHING` (`webhook.ts`'s
 * `storeEvent`), came back `duplicate: true`, and `processEvent` was never
 * called for it — the success was silently swallowed, with no automatic
 * recovery for a delayed method (bank transfer, USSD) whose customer has
 * already closed the tab.
 *
 * SWITCHING THE DISCRIMINANT TO THE BODY'S CLAIMED `data.status` WOULD BE
 * THE WRONG FIX, NOT A SMALLER VERSION OF THE RIGHT ONE. `verif-hash` is a
 * static shared secret sent back for equality, not an HMAC over the bytes
 * (see this file's header) — so anyone who has ever learned it can vary
 * `data.status` freely and mint unlimited distinct keys for one real
 * reference, defeating dedupe entirely and spamming `shop_payment_events`
 * with rows this adapter would then treat as all genuinely new.
 *
 * So `status` below is the CALLER's resolved `ProviderIntentStatus` —
 * `fetchIntent`'s answer, fetched fresh over TLS with the secret key on
 * every call, which is the one channel a webhook replay cannot forge. A
 * genuine identical redelivery (same reference, same fetched status) still
 * produces the same key; a pending-then-successful pair for the same
 * reference now produces two different ones, because the status actually
 * changed at the gateway between the two lookups.
 *
 * Reading `tx_ref` out of the body here is not a breach of `parseWebhook`'s
 * "trust nothing but `tx_ref`" rule — it IS that field — and a forged
 * `tx_ref` can only ever resolve to SOME real charge's own trusted status
 * (or fail to resolve at all, throwing before this is ever called), never to
 * a status the caller invented. A body with no usable `tx_ref` falls back to
 * a digest of the raw bytes, so a redelivery (identical bytes) still
 * dedupes and two different malformed bodies do not collide.
 */
export function flutterwaveEventIdOf(
  status: ProviderIntentStatus,
  data: Record<string, unknown> | null,
  raw: Uint8Array,
): string {
  const bodyDigest = () => `flutterwave:body:${createHash('sha256').update(raw).digest('hex')}`;
  const txRef = data ? str(data.tx_ref) : null;
  return txRef ? `flutterwave:${txRef}:${status}` : bodyDigest();
}

/**
 * Constant-time compare of `verif-hash` against the dashboard's webhook
 * secret. Mirrors `verifyPaystackSignature`'s shape exactly — a boolean,
 * leaving the `throw` to `parseWebhook`, where the `ProviderError`'s
 * `provider`/`operation` fields are already in scope — but proves a much
 * weaker thing than an HMAC does. See this file's header and
 * `parseWebhook`'s own comment for what that gap means and why the rest of
 * this file is built around it.
 *
 * `timingSafeEqual` THROWS on a length mismatch, which would itself leak a
 * bit — whether the attacker's guess happened to be the right length.
 * Compare lengths first and fail identically on both paths, exactly like
 * `paystack.ts`'s `verifyPaystackSignature` does for its own HMAC digest.
 */
export function verifyFlutterwaveHash(headers: Headers, expected: string): boolean {
  const got = headers.get('verif-hash');
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * THE ONLY EVENT NAME THIS ADAPTER RECOGNISES BY STRING — see this file's
 * header. Flutterwave uses one constant event name across a charge's whole
 * lifecycle; the state that actually changes lives in `data.status`, read
 * (trusted) via `fetchIntent`, never here. Matching this exact literal is
 * safe precisely because a match never CARRIES the attacker's own bytes
 * anywhere — `safeEventType` below returns this hardcoded constant on a
 * match, not the `event` variable.
 */
const CHARGE_EVENT = 'charge.completed';

/**
 * THE SENTINEL FOR EVERY `event` STRING THIS ADAPTER DOES NOT RECOGNISE.
 *
 * `event` is read from the UNVERIFIED body: `verif-hash` proves only that
 * the sender knows a static secret, never that the body is unmodified (this
 * file's header). Paystack's `parseWebhook` returns its own `event` field
 * verbatim as `ProviderEvent.type`, and that is safe there ONLY because
 * Paystack HMACs the whole body before this application ever sees it —
 * there is no equivalent guarantee here. `storeEvent` (`webhook.ts`)
 * persists `type` with no allow-list of its own, and `processEvent` then
 * branches on it: `row.type.startsWith('refund.')` reads a refund's id and
 * status STRAIGHT OUT OF THE UNVERIFIED STORED PAYLOAD, and
 * `row.type === 'charge.success'` marks an intent captured. This adapter's
 * `parseWebhook` never populates a refund event — `providerRefundId` and
 * `refundStatus` are always `null` below, because this adapter has no
 * endpoint that reports a refund's own state by reference — so a `type`
 * that could ever satisfy either check would be a lie `processEvent` has no
 * way to catch: a forged `event: 'refund.completed'`, with nothing else
 * about the body verified, would mark a REAL refund succeeded on an
 * attacker's say-so, the moment a route mounts this adapter's webhook.
 *
 * So this value is deliberately inert against BOTH checks: it does not
 * start with `refund.`, and it is not equal to `charge.success` (Paystack's
 * spelling — this gateway's own recognised event is `charge.completed`,
 * `CHARGE_EVENT` above, which `webhook.ts`'s `processEvent` does not yet
 * recognise either; teaching it to dispatch on the fields `parseWebhook`
 * already computes, rather than re-deriving decisions from `type` plus the
 * raw stored payload, is Task 9's fix, not this file's).
 */
const UNRECOGNISED_EVENT_TYPE = 'flutterwave.unrecognized_event';

/**
 * Collapse the body's `event` field to one of exactly two hardcoded string
 * literals. NEVER returns the `event` argument itself — even a
 * byte-for-byte correct `'charge.completed'` comes back as the
 * `CHARGE_EVENT` constant, not the variable that held it — so nothing
 * downstream ever receives a `ProviderEvent.type` this adapter did not
 * choose.
 */
function safeEventType(event: string): string {
  return event === CHARGE_EVENT ? CHARGE_EVENT : UNRECOGNISED_EVENT_TYPE;
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
    /*
     * NO `?? 0` HERE — this diverges from `paystack.ts`'s own `#toIntent`,
     * which does default a missing amount to zero. `toMinorUnits` now only
     * returns `null` for a genuinely malformed value (the field absent,
     * non-numeric, or non-finite); since `#request` above already guarantees
     * `data` itself is a real record, reaching `null` here can only mean a
     * 2xx envelope whose body is not the shape the contract promises — the
     * exact situation `malformed_response` exists for elsewhere in this file
     * (see `#request`'s own `data` check). `ProviderIntent.amount` is the
     * RECONCILIATION figure `POST …/confirm` and the sweep write onward into
     * `commerce_events`; reporting `0` for an amount the gateway actually
     * sent would poison that figure silently, which is worse than this one
     * lookup failing loudly and permanently (`malformed_response` is not in
     * the retryable set, so nothing keeps re-asking a response that will
     * never parse differently).
     */
    const amount = toMinorUnits(data.amount);
    if (amount === null) {
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation: 'fetchIntent',
      });
    }
    return {
      providerIntentId: str(data.tx_ref) ?? fallbackReference,
      status: mapIntentStatus(status),
      amount,
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

  /**
   * `req.providerIntentId` IS OUR REFERENCE (`tx_ref`), exactly like every
   * other method in this file — but `POST /v3/transactions/{id}/refund`
   * takes ONLY Flutterwave's own numeric transaction id, and
   * `RefundRequest` (the port's shared shape, `types.ts`) carries no such
   * field, because nothing upstream has ever needed one before this method.
   * So the id is resolved FIRST, via the exact `verify_by_reference` lookup
   * `fetchIntent` already makes — reused rather than duplicated, which is
   * also why a failure resolving the id surfaces tagged
   * `operation: 'fetchIntent'` rather than `'refund'`: that is genuinely
   * which network call failed, and preserving it costs nothing a caller
   * needs, since `code`/`retryable`/`indeterminate` — the fields that drive
   * behaviour — are unaffected either way.
   *
   * `key` IS ACCEPTED AND DELIBERATELY NOT SENT, same as `paystack.ts`'s own
   * `refund`: this endpoint takes no idempotency parameter, so the only
   * thing standing between a retry and a double refund is the UNIQUE
   * `idempotency_key` already claimed in `shop_refunds` BEFORE this is ever
   * called — see `refunds.ts`; that ordering is not an implementation
   * detail here either.
   *
   * THE AMOUNT CONVERSION APPLIES HERE TOO — `toMajorUnits` going out,
   * `toMinorUnits` coming back — the same two functions `createIntent` and
   * `fetchIntent` use, and the only two places this file crosses the 100
   * line (see this file's header).
   */
  async refund(req: RefundRequest, key: string): Promise<ProviderRefund> {
    void key;

    const intent = await this.fetchIntent(req.providerIntentId);
    const chargeId = intent.providerChargeId;
    if (!chargeId) {
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation: 'refund',
      });
    }

    const data = await this.#request(
      'refund',
      'POST',
      `/transactions/${encodeURIComponent(chargeId)}/refund`,
      {
        amount: toMajorUnits(req.amount),
        ...(req.merchantNote ? { comments: req.merchantNote } : {}),
      },
    );

    const rawId = data.id;
    const providerRefundId =
      typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : str(rawId);
    if (!providerRefundId) {
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation: 'refund',
      });
    }

    return {
      providerRefundId,
      status: mapRefundStatus(str(data.status) ?? ''),
      amount: toMinorUnits(data.amount_refunded) ?? req.amount,
      currency: str(data.currency) ?? req.currency,
    };
  }

  /**
   * VERIFY, THEN PARSE — but what verification proves here is much weaker
   * than `paystack.ts`'s HMAC, and every line below exists because of that
   * gap. Read this comment before changing anything in this method.
   *
   * ⚠ `verif-hash` IS NOT A SIGNATURE. It is the dashboard's webhook secret
   * hash sent back VERBATIM and compared for equality — proving only that
   * the sender knows one static value, never that the body arrived
   * unmodified. Anyone who ever learns that value — a leaked env var, a
   * misconfigured log, a support ticket pasted in full — can replay it
   * forever on a body claiming ANY `tx_ref` was captured for ANY amount,
   * and `verifyFlutterwaveHash` would accept it exactly as it accepts a
   * genuine one.
   *
   * SO THE BODY IS TRUSTED FOR EXACTLY ONE FACT: `data.tx_ref`. No
   * `status`, no `amount`, no `currency` — not even as a fallback when the
   * lookup below fails. Every fact this method actually reports —
   * `intentStatus`, `amount`, `currency`, `failureReason`, and the STATUS
   * half of `providerEventId`'s dedupe key (`flutterwaveEventIdOf`) — comes
   * from `fetchIntent`: a fresh call to Flutterwave's API, over TLS,
   * carrying the secret key, which is the one channel a webhook replay
   * cannot forge. The webhook is a TRIGGER telling this adapter to go look.
   * It is never the source of truth for what it claims happened.
   *
   * `event` IS READ, BUT NEVER TRUSTED FOR CONTENT — only PATTERN-MATCHED
   * against one known-safe literal (`safeEventType`), the same discipline
   * `#classify` already applies to Paystack's error `message` elsewhere in
   * this codebase. The `type` on the returned `ProviderEvent` is therefore
   * always one of exactly two hardcoded strings this adapter chose, never
   * the attacker's own bytes — see `safeEventType`'s own comment for why an
   * unconstrained passthrough would be unsafe SPECIFICALLY FOR THIS GATEWAY
   * (Paystack's `parseWebhook` returns its `event` verbatim, and that is
   * safe there only because Paystack HMACs the whole body before this
   * application ever sees it).
   *
   * THIS IS THE ONE PROPERTY IN THIS FILE A TEST CANNOT PROVE — exercising
   * it for real means forging a webhook, which is exactly the attack it
   * defends against — and there will be no dev check either. It has to be
   * correct by construction, which is the entire reason this comment is as
   * long as it is.
   */
  async parseWebhook(raw: Uint8Array, headers: Headers): Promise<ProviderEvent> {
    if (!verifyFlutterwaveHash(headers, this.#webhookHash)) {
      throw new ProviderError({
        code: 'signature_invalid',
        provider: this.name,
        operation: 'parseWebhook',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      /*
       * A body that carried a valid hash and is not JSON is not an attack —
       * knowing the static secret is not the same as controlling the
       * bytes' shape — so `malformed_response` rather than
       * `signature_invalid` keeps the two distinguishable in a log without
       * either carrying the body.
       */
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation: 'parseWebhook',
      });
    }

    const envelope = asRecord(parsed);
    const event = str(envelope?.event) ?? '';
    const data = asRecord(envelope?.data);

    /*
     * `data.tx_ref` AND NOTHING ELSE FROM THIS PAYLOAD — see this method's
     * own header above. A body with no `tx_ref` cannot be resolved against
     * the API at all, so it is malformed rather than something to guess
     * at.
     */
    const txRef = str(data?.tx_ref);
    if (!txRef) {
      throw new ProviderError({
        code: 'malformed_response',
        provider: this.name,
        operation: 'parseWebhook',
      });
    }

    // THE ONLY SOURCE OF TRUTH. `fetchIntent` throws its own `ProviderError`
    // on failure, and that is left to propagate unchanged — a reference
    // this adapter cannot confirm against the API must not be reported as
    // anything, which is the entire point of this method.
    const intent = await this.fetchIntent(txRef);

    return {
      // THE STATUS HALF OF THIS KEY IS `intent.status` — FETCHED, TRUSTED —
      // NEVER `event` and NEVER the body's own `data.status`. See
      // `flutterwaveEventIdOf`'s own comment for why both alternatives are
      // unsafe (one drops the success event, the other lets a leaked hash
      // mint unlimited keys).
      providerEventId: flutterwaveEventIdOf(intent.status, data, raw),
      // NEVER `event` VERBATIM — see `safeEventType` and this method's own
      // header for why an unconstrained passthrough of the body's claimed
      // event name is unsafe for this gateway specifically.
      type: safeEventType(event),
      providerIntentId: intent.providerIntentId,
      // No refund-event handling: this adapter has no endpoint that reports
      // a refund's own state by reference, and nothing here derives one
      // from a payload it does not trust regardless.
      providerRefundId: null,
      intentStatus: intent.status,
      refundStatus: null,
      failureReason: intent.failureReason,
      amount: intent.amount,
      currency: intent.currency,
      // The VERIFIED RAW BODY, parsed but not reshaped — evidence, not
      // truth. Every fact ABOVE this line came from `fetchIntent`, never
      // from `parsed`.
      payload: parsed,
    };
  }
}
