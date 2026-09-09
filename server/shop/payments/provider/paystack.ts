/**
 * The Paystack adapter. THE ONLY FILE IN THIS REPOSITORY THAT KNOWS THE WORD
 * "Paystack" AT THE PROTOCOL LEVEL.
 *
 * WHY PAYSTACK IS REACHED WITH `fetch` AND NOT AN SDK. `package.json` is not
 * this subsystem's file to edit (contract §2 R1), and every call here is one
 * JSON POST or GET with a bearer token — the whole surface used is four
 * endpoints. Against that, an SDK would add a dependency to a shared file, a
 * bundle to a Vercel Function, and a layer whose error objects would have to be
 * scrubbed sight-unseen. `node:crypto` and `fetch` are both in the Node 24
 * runtime the Functions already use.
 *
 * WHAT IS DIFFERENT ABOUT THIS PROVIDER, and what the rest of the subsystem was
 * shaped around:
 *
 * - **No authorize/capture split.** A card transaction succeeds or fails in one
 *   step. `capture()` and, at the provider, `cancel()` are `unsupported`.
 * - **`reference` is ours.** We choose it, it is unique per transaction, and
 *   re-sending it is refused as a duplicate rather than charging twice. It is
 *   the provider-side half of idempotency, and the API has no
 *   `Idempotency-Key` header of its own.
 * - **The secret key IS the webhook signing key.** There is no separate signing
 *   secret. Rotating `PAYSTACK_SECRET_KEY` therefore rotates webhook
 *   verification at the same instant, and any in-flight redelivery signed under
 *   the old key will fail to verify. Roll with that in mind.
 * - **The webhook envelope carries no event id.** `{ event, data }` and an
 *   `x-paystack-signature` header, and nothing else. The dedupe key is derived
 *   — see `providerEventIdOf`.
 * - **There is no `charge.failed` webhook.** Paystack's published event list
 *   has `charge.success` and no failure counterpart, so a decline is learned by
 *   asking (`fetchIntent`), never by waiting.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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

const BASE_URL = 'https://api.paystack.co';
const SIGNATURE_HEADER = 'x-paystack-signature';

/**
 * Paystack retries a non-200 for 72 hours and times each attempt out at 30s.
 * Ours is far shorter: a Vercel Function holding a socket open for 30 seconds
 * to learn something a webhook will tell it anyway is a function that has
 * turned a slow provider into a slow storefront.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PaystackConfig {
  /** `sk_test_…` / `sk_live_…`. Also the webhook signing key. NEVER logged. */
  secretKey: string;
  /** Overridden by tests to point at a local server. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected so tests need no network and no global patching. */
  fetchImpl?: typeof fetch;
}

const CAPABILITIES: ProviderCapabilities = {
  /*
   * FALSE, and this is the fact the whole intent ladder was shaped around. A
   * Paystack card transaction moves money in one step. Writing a `capture()`
   * that returned success anyway would report money taken that no provider ever
   * moved — the worst possible lie for this subsystem to tell.
   */
  separateCapture: false,
  /*
   * FALSE. There is no endpoint that cancels an uncompleted transaction;
   * abandoning it is the cancellation. So `cancel` is a LOCAL state change, and
   * the ladder admits `cancelled → captured` (with an anomaly recorded)
   * precisely because nothing was said to the provider and the customer may
   * still pay.
   */
  remoteCancel: false,
  partialRefunds: true,
  /**
   * A Nigeria-registered business may charge NGN and USD and nothing else.
   * One currency per account, plus USD as the only addition; GHS/ZAR/KES/XOF/EGP
   * each need a separate business registered in that country, so there is no
   * "other African currencies" tier to add here later.
   */
  currencies: ['NGN', 'USD'],
};

/** Paystack's transaction states → ours. */
function mapIntentStatus(status: string): ProviderIntentStatus {
  switch (status) {
    case 'success':
      return 'captured';
    case 'failed':
    case 'abandoned':
      return 'failed';
    /*
     * `reversed` means money moved and came back. It maps to `failed` and NOT to
     * a refund state on purpose: a refund is something we initiated and have a
     * `shop_refunds` row for, and pretending a provider-side reversal is one
     * would invent a refund nobody created. The rank ladder then refuses to pull
     * an already-`captured` intent backwards and records the anomaly instead,
     * which is the outcome that gets a human to look.
     */
    case 'reversed':
      return 'failed';
    default:
      // pending / ongoing / processing / queued — and anything Paystack adds.
      return 'requires_payment';
  }
}

function mapFailureReason(status: string): ProviderFailureReason | null {
  switch (status) {
    case 'failed':
      return 'declined';
    case 'abandoned':
      return 'abandoned';
    case 'reversed':
      return 'reversed';
    default:
      return null;
  }
}

/**
 * Paystack's four refund states → our three.
 *
 * `needs-attention` maps to `pending` — the SAFE direction. A refund stuck
 * waiting for a human is one whose amount must stay reserved against the
 * intent; calling it `failed` would release the reservation and let somebody
 * refund the same money a second time.
 */
function mapRefundStatus(status: string): ProviderRefundStatus {
  switch (status) {
    case 'processed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

interface PaystackEnvelope {
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

/** Minor units as an integer, or null. Paystack sends these as numbers or strings. */
function minorUnits(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
}

/**
 * A stable, unique identity for a webhook event.
 *
 * PAYSTACK GIVES US NOTHING TO USE. The envelope is `{ event, data }` — no
 * event id in the body, none in a header. But `03-payments.md` §4 requires
 * dedupe on a UNIQUE column rather than a prior read, so an identity has to be
 * derived, and deriving it badly fails in one of two directions:
 *
 * - too COARSE and two legitimately different events collide, so the second is
 *   silently dropped. The real case: two partial refunds against one
 *   transaction both emit `refund.processed`, and a key built from the
 *   transaction reference alone would discard the second one's success.
 * - too FINE and a redelivery of the same event looks new, so it is processed
 *   twice.
 *
 * So the discriminator is chosen per event family:
 *
 * - `charge.*` — the transaction `reference`. It is ours, it is unique per
 *   transaction, and two `charge.success` for one reference cannot legitimately
 *   differ.
 * - `refund.*` — the refund's OWN id, because the transaction reference is
 *   shared by every partial refund against it.
 * - anything else, and any case where no usable discriminator is present — a
 *   SHA-256 of the raw bytes. A redelivery carries the same bytes, so it
 *   dedupes; two different events do not, so they do not collide. This is the
 *   fallback rather than the primary because it is the one that breaks if a
 *   provider ever re-serialises between attempts.
 *
 * A NUMERIC ID IS ONLY USED IF IT SURVIVED THE PARSE. Paystack's own docs warn
 * that transaction ids are unsigned 64-bit — larger than `Number.MAX_SAFE_INTEGER`
 * — and `JSON.parse` silently rounds those. `12345678901234567891` and
 * `…892` both become `12345678901234568000`, i.e. two distinct events with one
 * identity, and the second refund would vanish. So the parsed number is only
 * trusted when it is a safe integer AND its decimal form appears verbatim in
 * the bytes that were signed; otherwise the body digest is used instead.
 */
export function providerEventIdOf(
  event: string,
  data: Record<string, unknown> | null,
  raw: Uint8Array,
): string {
  const bodyDigest = () => `body:${createHash('sha256').update(raw).digest('hex')}`;
  if (!data) return `${event}:${bodyDigest()}`;

  const rawText = Buffer.from(raw).toString('utf8');
  const exactNumber = (value: unknown): string | null => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
    // The verbatim check is what catches a uint64 that lost precision on parse.
    return rawText.includes(String(value)) ? String(value) : null;
  };

  if (event.startsWith('charge.')) {
    const reference = str(data.reference);
    if (reference) return `${event}:${reference}`;
  }

  if (event.startsWith('refund.')) {
    const refundId = exactNumber(data.id) ?? str(data.refund_reference) ?? str(data.id);
    if (refundId) return `${event}:${refundId}`;
  }

  return `${event}:${bodyDigest()}`;
}

/**
 * Verify `x-paystack-signature` over the RAW BYTES.
 *
 * PAYSTACK'S OWN DOCUMENTED SAMPLE IS WRONG FOR THIS PURPOSE and is worth
 * naming, because it is what most integrations copy:
 *
 * ```js
 * const hash = crypto.createHmac('sha512', secret)
 *   .update(JSON.stringify(req.body)).digest('hex');   // <-- a RE-SERIALISE
 * if (hash == req.headers['x-paystack-signature']) { … }
 * ```
 *
 * That verifies a signature against bytes Node produced, not the bytes Paystack
 * signed. It happens to work while Express's parser and `JSON.stringify` agree
 * about key order, escaping and number formatting — and stops working, silently
 * and in the direction of REJECTING GENUINE EVENTS, when they do not: a
 * non-ASCII customer name, a `/` that one side escapes, an exponent-formatted
 * number, U+2028 in a note. It also compares with `==` rather than in constant
 * time.
 *
 * Both are fixed here: the HMAC is computed over the bytes as received, and the
 * comparison is `timingSafeEqual` over fixed-width digests.
 */
export function verifyPaystackSignature(
  raw: Uint8Array,
  signature: string | null,
  secretKey: string,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(raw).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  /*
   * A length check BEFORE `timingSafeEqual`, which throws on a mismatch rather
   * than returning false. It leaks only the length of the attacker's own input,
   * which they already know.
   */
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  readonly capabilities = CAPABILITIES;

  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: PaystackConfig) {
    this.#secretKey = config.secretKey;
    this.#baseUrl = config.baseUrl ?? BASE_URL;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  /**
   * The one place this adapter touches the network.
   *
   * EVERY FAILURE LEAVES HERE AS A `ProviderError` AND NOTHING ELSE. Not the
   * response body, not the request, not the `fetch` rejection — the body is
   * read only to classify it, and the value read is compared against known
   * codes and then dropped. `scrubbedProvider()` wraps every public method as a
   * second layer, so a bug in this method cannot leak either.
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
          // The one place the key is used. It is never interpolated into a URL,
          // where it would reach a proxy log and this application's own traces.
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
       * INDETERMINATE (§5): the request may well have been executed. Classifying
       * one as a plain failure is how a charge gets made twice.
       */
      const name = err instanceof Error ? err.name : '';
      const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      throw new ProviderError({ code, provider: this.name, operation });
    }

    let envelope: PaystackEnvelope | null = null;
    try {
      envelope = (await response.json()) as PaystackEnvelope;
    } catch {
      envelope = null;
    }

    if (!response.ok || envelope?.status !== true) {
      throw new ProviderError({
        code: this.#classify(response.status, envelope),
        provider: this.name,
        operation,
        status: response.status,
        field: this.#classifyField(envelope),
      });
    }

    const data = asRecord(envelope.data);
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
   * An HTTP status and a message shape → an enumerated code.
   *
   * `message` IS MATCHED AGAINST, NEVER CARRIED. The distinction is the whole
   * of this method's safety: reading a string to decide which of eight constants
   * to return cannot leak it, and putting that string on the error would.
   *
   * The duplicate-reference case earns its own code because it is the one 4xx
   * that usually means SUCCESS: Paystack refuses a reference it has already
   * seen, which is exactly what a retry of a lost `createIntent` looks like, and
   * treating it as a hard failure would abandon a transaction the customer may
   * already have paid.
   */
  #classify(status: number, envelope: PaystackEnvelope | null) {
    const message = typeof envelope?.message === 'string' ? envelope.message.toLowerCase() : '';
    if (message.includes('duplicate transaction reference')) return 'duplicate_reference' as const;
    if (status === 401 || status === 403) return 'auth' as const;
    if (status === 429) return 'rate_limited' as const;
    if (status >= 500) return 'provider_unavailable' as const;
    if (status >= 400) return 'invalid_request' as const;
    // A 2xx whose envelope said `status: false` — the request was understood and
    // refused. Permanent, so the client must not retry it as a 500.
    return 'invalid_request' as const;
  }

  /**
   * Which field an `invalid_request` blames, or none (admin#30 review).
   *
   * `invalid_request` is the bucket for every 4xx Paystack returns — a bad
   * email, an amount below the processor's minimum, a currency the account
   * has not enabled, a malformed `callback_url`. Naming `email` for all of
   * them would tell a customer to fix an address that was fine while an
   * operator misconfiguration goes unpaged — the exact failure this issue
   * exists to remove, just moved one layer up. So this ONLY returns `'email'`
   * when Paystack's own message names the address; every other cause returns
   * `null` and the caller falls through to the honest answer, a 500.
   *
   * `message` IS MATCHED AGAINST, NEVER CARRIED — same discipline as
   * `#classify`: a substring test cannot leak the string, and returning it
   * would.
   */
  #classifyField(envelope: PaystackEnvelope | null): 'email' | null {
    const message = typeof envelope?.message === 'string' ? envelope.message.toLowerCase() : '';
    return message.includes('email') ? 'email' : null;
  }

  #toIntent(data: Record<string, unknown>, fallbackReference: string): ProviderIntent {
    const status = str(data.status) ?? '';
    return {
      providerIntentId: str(data.reference) ?? fallbackReference,
      status: mapIntentStatus(status),
      amount: minorUnits(data.amount) ?? 0,
      currency: str(data.currency) ?? '',
      authorizationUrl: str(data.authorization_url),
      failureReason: mapFailureReason(status),
    };
  }

  async createIntent(req: CreateIntentRequest): Promise<ProviderIntent> {
    /*
     * `amount` IS SENT AS-IS. Paystack's subunit and contract §10's minor units
     * are the same thing for every currency Paystack supports (NGN/GHS/ZAR/KES/
     * USD are all 100-subunit), so there is no conversion here — and there must
     * not be one, because a conversion is a recomputation and §1 forbids the
     * amount being anything but the figure `CheckoutPort` froze.
     */
    const data = await this.#request('createIntent', 'POST', '/transaction/initialize', {
      reference: req.reference,
      amount: String(req.amount),
      currency: req.currency,
      email: req.email,
      ...(req.callbackUrl ? { callback_url: req.callbackUrl } : {}),
      ...(req.metadata ? { metadata: JSON.stringify(req.metadata) } : {}),
    });

    /*
     * `initialize` returns only `authorization_url`, `access_code` and
     * `reference` — no status and no amount. The transaction exists and is
     * unpaid, so that is what is reported, rather than echoing back the request
     * as though the provider had confirmed it.
     */
    return {
      providerIntentId: str(data.reference) ?? req.reference,
      status: 'requires_payment',
      amount: req.amount,
      currency: req.currency,
      authorizationUrl: str(data.authorization_url),
      failureReason: null,
    };
  }

  /** Paystack has no two-step capture. Refusing is the honest answer. */
  capture(providerIntentId: string): Promise<ProviderIntent> {
    void providerIntentId;
    return Promise.reject(
      new ProviderError({ code: 'unsupported', provider: this.name, operation: 'capture' }),
    );
  }

  /** Nor a remote cancel: abandoning the transaction is the cancellation. */
  cancel(providerIntentId: string): Promise<ProviderIntent> {
    void providerIntentId;
    return Promise.reject(
      new ProviderError({ code: 'unsupported', provider: this.name, operation: 'cancel' }),
    );
  }

  async fetchIntent(providerIntentId: string): Promise<ProviderIntent> {
    const data = await this.#request(
      'fetchIntent',
      'GET',
      `/transaction/verify/${encodeURIComponent(providerIntentId)}`,
    );
    return this.#toIntent(data, providerIntentId);
  }

  /**
   * `key` IS ACCEPTED AND DELIBERATELY NOT SENT.
   *
   * Paystack's `POST /refund` has no idempotency key: calling it twice creates
   * two refunds and pays the customer twice. The parameter stays in the
   * signature because it is part of the port's contract and another provider
   * will use it — and because removing it would hide the fact that on THIS
   * provider the only thing standing between a retry and a double refund is the
   * UNIQUE `idempotency_key` claimed in `shop_refunds` BEFORE this is called.
   * See `refunds.ts`; that ordering is not an implementation detail.
   */
  async refund(req: RefundRequest, key: string): Promise<ProviderRefund> {
    void key;
    const data = await this.#request('refund', 'POST', '/refund', {
      transaction: req.providerIntentId,
      amount: req.amount,
      currency: req.currency,
      ...(req.merchantNote ? { merchant_note: req.merchantNote } : {}),
    });

    const id = data.id;
    const providerRefundId =
      typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : str(id);
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
      amount: minorUnits(data.amount) ?? req.amount,
      currency: str(data.currency) ?? req.currency,
    };
  }

  /**
   * VERIFY, THEN PARSE. The order is the security property and the code is
   * written so that it cannot be reordered by accident: `raw` is bytes, and the
   * only `JSON.parse` in this method is below the `throw`.
   */
  parseWebhook(raw: Uint8Array, headers: Headers): Promise<ProviderEvent> {
    if (!verifyPaystackSignature(raw, headers.get(SIGNATURE_HEADER), this.#secretKey)) {
      return Promise.reject(
        new ProviderError({
          code: 'signature_invalid',
          provider: this.name,
          operation: 'parseWebhook',
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      /*
       * A body that verified and is not JSON is not an attack — an attacker
       * cannot produce a valid signature — so it is Paystack sending something
       * new. `malformed_response` rather than `signature_invalid`, so the two
       * are distinguishable in a log without either carrying the body.
       */
      return Promise.reject(
        new ProviderError({
          code: 'malformed_response',
          provider: this.name,
          operation: 'parseWebhook',
        }),
      );
    }

    const envelope = asRecord(parsed);
    const event = str(envelope?.event) ?? '';
    const data = asRecord(envelope?.data);

    const isCharge = event.startsWith('charge.');
    const isRefund = event.startsWith('refund.');

    /*
     * `charge.success` is the only charge event Paystack publishes, and it is
     * only ever a capture. It is mapped from the event NAME rather than from
     * `data.status` so that a payload arriving with a status we do not
     * recognise cannot quietly become `requires_payment` on an intent we have
     * already captured.
     */
    const intentStatus: ProviderIntentStatus | null =
      event === 'charge.success' ? 'captured' : null;

    return Promise.resolve({
      providerEventId: providerEventIdOf(event, data, raw),
      type: event,
      providerIntentId: isCharge
        ? str(data?.reference)
        : (str(data?.transaction_reference) ?? str(asRecord(data?.transaction)?.reference)),
      providerRefundId: isRefund ? refundIdOf(data) : null,
      intentStatus,
      refundStatus: isRefund ? mapRefundStatus(str(data?.status) ?? '') : null,
      failureReason: null,
      amount: minorUnits(data?.amount),
      currency: str(data?.currency),
      // The VERIFIED RAW BODY, parsed but not reshaped. Stored as evidence: a
      // parse is a belief, the payload is what the provider actually said.
      payload: parsed,
    });
  }
}

function refundIdOf(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const id = data.id;
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  return str(id) ?? str(data.refund_reference);
}
