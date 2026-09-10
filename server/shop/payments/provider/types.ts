/**
 * The provider boundary. ONE interface, and every implementation of it lives in
 * this directory.
 *
 * NOTHING OUTSIDE `server/shop/payments/provider/` IMPORTS A PROVIDER SDK OR
 * NAMES A PROVIDER (`03-payments.md` §2). That is not speculative portability.
 * It is what lets the other ninety per cent of this subsystem — the intent
 * ladder, the webhook receiver, the dedupe, the refund sum-check — be tested
 * with no network at all, against `fake.ts`. And it is what keeps a provider
 * change from being a rewrite of the logic that decides whether somebody has
 * been charged twice.
 *
 * ---
 *
 * THREE DELIBERATE DEPARTURES FROM THE INTERFACE PRINTED IN `03-payments.md` §2.
 * Each is recorded here rather than in a commit message because each is a place
 * where following the brief literally would have produced worse code, and this
 * project's history (GAUNTLET II Part 2b: "the prescribed fix was wrong and the
 * builder caught it") says to say so.
 *
 * **1. `parseWebhook(raw: Uint8Array)`, not `raw: string`.** The brief's own
 * §4 requires the signature be verified "on the raw bytes… not the
 * JSON-round-tripped body — signature schemes sign bytes, and a re-serialise
 * changes them." A `string` parameter has ALREADY been through a decode. For a
 * body that is valid UTF-8 the round trip happens to be lossless; for one that
 * is not, `TextDecoder` substitutes U+FFFD and the bytes are gone before the
 * verifier ever sees them — an attacker-controllable way to make a signature
 * check compare the wrong thing. The type is the enforcement: with `Uint8Array`
 * there is no decode to forget.
 *
 * **2. `capabilities`, and `capture`/`cancel` that may refuse.** The brief's
 * interface assumes an authorize-then-capture provider. Paystack is not one:
 * a card transaction succeeds or fails in a single step and there is no
 * endpoint that takes an authorized hold later. Modelling a capability the
 * provider lacks by writing a `capture()` that silently returns success would
 * be worse than not having it — it would report money taken that no provider
 * ever moved. So the capability is DECLARED, and asking for it anyway is a
 * typed `unsupported` refusal. The intent ladder handles both shapes.
 *
 * **3. `fetchIntent`, which the brief does not list.** §8 forbids marking
 * anything paid from a client-side callback. That rule needs somewhere for the
 * legitimate synchronous answer to come from: when the customer returns to
 * `callback_url`, the server asks the PROVIDER what happened rather than
 * believing the browser. Without this method the only source of truth is the
 * webhook, and a webhook that is late leaves a paying customer looking at an
 * unpaid order with no way to resolve it.
 */

/** What this provider can actually do. Read before assuming it can. */
export interface ProviderCapabilities {
  /**
   * True when authorize and capture are separate calls.
   *
   * False for Paystack. When false, `createIntent` returns something the
   * customer completes out-of-band and the money moves in one step — so the
   * intent goes `requires_payment → captured` with no `authorized` in between,
   * and `capture()` throws `unsupported`.
   */
  separateCapture: boolean;
  /**
   * True when an uncompleted charge can be cancelled AT THE PROVIDER.
   *
   * False for Paystack: an unpaid transaction is simply abandoned, so
   * cancelling is a local state change and nothing is sent. This distinction
   * decides whether `cancel()` is allowed to be a no-op at the provider or must
   * actually reach it.
   */
  remoteCancel: boolean;
  /** True when partial refunds are supported. Paystack: yes. */
  partialRefunds: boolean;
  /**
   * Every currency this gateway's API can charge. ISO 4217, uppercase.
   *
   * THE GATEWAY'S DOCUMENTED MAXIMUM, NOT THIS ACCOUNT'S STATE. What an
   * account has actually switched on is data — `shop_payment_settings`'
   * per-gateway columns — because a capability list in code would lie the
   * moment an account differs from the docs, and this one does: Paystack's
   * USD needs a USD request and a Zenith domiciliary account that this
   * business has not completed. Routing reads the row; this list bounds what
   * the admin screen may offer, so nobody can switch on a currency the API
   * cannot charge.
   */
  currencies: readonly string[];
}

/**
 * The provider's view of a charge.
 *
 * `status` IS THE PROVIDER'S, MAPPED ONTO OUR LADDER — not the provider's own
 * vocabulary. The mapping happens inside the adapter, which is the only place
 * that knows what `abandoned` means, so nothing downstream has to learn a
 * second set of state names.
 */
export interface ProviderIntent {
  /** The reference the provider transacts under. */
  providerIntentId: string;
  status: ProviderIntentStatus;
  /** Minor units, AS THE PROVIDER REPORTS IT — for reconciliation, not charging. */
  amount: number;
  currency: string;
  /** Where to send the customer, when the provider hosts the payment page. */
  authorizationUrl: string | null;
  /**
   * A stable failure reason when `status` is `failed`. Never provider prose:
   * `gateway_response` is free text that can quote the input that caused it.
   */
  failureReason: ProviderFailureReason | null;
  /**
   * The gateway's OWN identifier for this charge, when it differs from the
   * reference we supplied. NULL for Paystack, which transacts under ours.
   *
   * EXISTS BECAUSE FLUTTERWAVE REFUNDS REQUIRE IT: `POST /v3/transactions/
   * {id}/refund` takes their numeric id, while verification and the webhook
   * both accept our `tx_ref`. So the reference stays OURS — which is what
   * makes a retry safe — and this carries theirs.
   */
  providerChargeId?: string | null;
}

export type ProviderIntentStatus =
  | 'requires_payment'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled';

export type ProviderFailureReason =
  | 'declined'
  | 'abandoned'
  | 'expired'
  | 'reversed'
  | 'provider_error'
  | 'unknown';

export interface CreateIntentRequest {
  /**
   * OUR reference for this charge, derived from the intent id.
   *
   * Supplied BY US rather than allocated by the provider, and that is what
   * makes a retry safe: Paystack's `reference` is unique per transaction, so
   * re-sending the same one after a lost response either re-initialises the
   * same transaction or is refused as a duplicate — never a second charge.
   */
  reference: string;
  /**
   * MINOR UNITS, FROM `CheckoutPort` (`03-payments.md` §1).
   *
   * Never from the storefront, never recomputed here, and never derived from
   * anything the adapter can see. The adapter's job is to send this number, not
   * to have an opinion about it.
   */
  amount: number;
  currency: string;
  /** The provider needs somewhere to send a receipt. */
  email: string;
  /** Where the customer lands afterwards. A UI hint only — see `fetchIntent`. */
  callbackUrl?: string;
  /** Correlation only. NEVER card data, NEVER anything secret. */
  metadata?: Record<string, string>;
}

export interface RefundRequest {
  /** The charge to refund, by the reference it was made under. */
  providerIntentId: string;
  /** Minor units, positive. Partial when less than the captured amount. */
  amount: number;
  currency: string;
  /** For the provider's own records. Free text; never echoed into a log. */
  merchantNote?: string;
}

export interface ProviderRefund {
  providerRefundId: string;
  status: ProviderRefundStatus;
  amount: number;
  currency: string;
}

/**
 * Three states, mapped down from providers that report four.
 *
 * Paystack has `pending`/`processing`/`processed`/`failed`; the first two are
 * the same fact to this system — committed, not yet confirmed gone — and
 * collapsing them in the adapter keeps the extra state out of the schema, the
 * event payloads and every consumer.
 */
export type ProviderRefundStatus = 'pending' | 'succeeded' | 'failed';

/**
 * A webhook that has been VERIFIED and then parsed, in that order.
 *
 * There is no way to obtain one of these without a signature check, which is
 * the point: the type is only constructible inside an adapter, so "did we
 * verify this" is answered by the type system rather than by remembering.
 */
export interface ProviderEvent {
  /**
   * The dedupe key, unique per event. UNIQUE-CONSTRAINED downstream.
   *
   * DERIVED, not read, for Paystack: its envelope is `{ event, data }` with no
   * event id and no event-id header. See `providerEventIdOf` in `paystack.ts`.
   */
  providerEventId: string;
  /** The provider's own type string, unmapped — unknown ones are logged and ignored. */
  type: string;
  /** The reference this event is about, when it names one. */
  providerIntentId: string | null;
  /** The provider's refund id, for `refund.*` events. */
  providerRefundId: string | null;
  /** What the event says the charge's state now is, when it says anything. */
  intentStatus: ProviderIntentStatus | null;
  refundStatus: ProviderRefundStatus | null;
  failureReason: ProviderFailureReason | null;
  /** Minor units as reported. Used to CHECK ours, never to replace it. */
  amount: number | null;
  currency: string | null;
  /** The verified raw body, parsed. Stored verbatim as evidence. */
  payload: unknown;
}

export interface PaymentProvider {
  /** A name for logs. Never a key. */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  createIntent(req: CreateIntentRequest): Promise<ProviderIntent>;

  /**
   * Take money already authorized. Throws `unsupported` when
   * `capabilities.separateCapture` is false.
   *
   * `key` is the idempotency key. It is a PARAMETER rather than something the
   * adapter derives, because the caller is the one that knows which attempt
   * this is and the whole value of the key is that a retry reuses it.
   */
  capture(providerIntentId: string, key: string): Promise<ProviderIntent>;

  /** Abandon a charge that has not completed. */
  cancel(providerIntentId: string, key: string): Promise<ProviderIntent>;

  refund(req: RefundRequest, key: string): Promise<ProviderRefund>;

  /**
   * Ask the provider what actually happened. The ONLY legitimate synchronous
   * source of truth (§8) — a browser callback is a UI hint.
   */
  fetchIntent(providerIntentId: string): Promise<ProviderIntent>;

  /**
   * VERIFY THE SIGNATURE ON THE RAW BYTES, THEN PARSE. In that order, always.
   *
   * `raw` is bytes and not a string so that no implementation can accidentally
   * verify a re-encode of a decode. Throws `ProviderError('signature_invalid')`
   * — and it must throw rather than return a flag, so that the body cannot be
   * read by a caller who forgot to check one.
   */
  parseWebhook(raw: Uint8Array, headers: Headers): Promise<ProviderEvent>;
}
