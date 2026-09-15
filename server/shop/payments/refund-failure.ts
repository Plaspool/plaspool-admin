import type { ProviderErrorCode } from './provider/scrub';
import type { ProviderName } from './schema';

/**
 * A REFUND THAT DID NOT HAPPEN, NAMED — so nothing can report it as one.
 *
 * Found in production 2026-09-15. Flutterwave turned down a ₦500 refund; the
 * gateway's `ProviderError` had no row in `server/middleware/errors.ts`, so the
 * owner was shown `internal` for what was a plain "no". Worse, pressing Refund
 * again in the same window re-sent the same idempotency key, `createRefund`
 * read the FAILED row back as a result, and the screen toasted "Refunded". The
 * cancel route's fixed key (`cancel:<order>:<amount>`) turned the same
 * read-through into a cancelled order whose customer was told they had been
 * refunded.
 *
 * So `createRefund` resolves ONLY with a refund that is pending or succeeded.
 * Every other ending throws this, and the error table answers it 422 — a 4xx on
 * purpose, because a 5xx is retried by the client's policy and a retry cannot
 * change this answer.
 *
 * LEAF MODULE: type imports only, so the error table can import it without
 * pulling Payments' database code into the middleware.
 */

/**
 * What is known about the money, which is what decides the next move.
 *
 * - `refused`: the gateway read the request and said no. Nothing moved, so the
 *   same key may try again (`createRefund` frees it).
 * - `unconfirmed`: the gateway may have acted — a 5xx, or a 2xx this adapter
 *   could not read. Somebody must look at the gateway before refunding again,
 *   so the key stays taken and a retry on it is refused without asking.
 */
export type RefundFailureOutcome = 'refused' | 'unconfirmed';

/**
 * Codes where the gateway positively refused. Anything not listed is
 * `unconfirmed`, the safe direction: a refusal wrongly called unconfirmed costs
 * the owner a look at a dashboard, while an unconfirmed failure wrongly called a
 * refusal lets the same money be refunded twice. `timeout` and `network` never
 * reach this — `createRefund` keeps those pending (`isIndeterminate`).
 */
const REFUSED: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'auth',
  'invalid_request',
  'rate_limited',
  'declined',
  'unsupported',
]);

export function refundFailureOutcome(code: ProviderErrorCode): RefundFailureOutcome {
  return REFUSED.has(code) ? 'refused' : 'unconfirmed';
}

/**
 * CARRIES NO GATEWAY MESSAGE, only enumerated facts — the discipline
 * `provider/scrub.ts` explains. `provider` is the gateway recorded on the
 * intent (`shop_payment_intents.provider`), never an adapter handle's name.
 */
export class RefundFailedError extends Error {
  readonly provider: ProviderName;
  readonly outcome: RefundFailureOutcome;
  readonly code: ProviderErrorCode;

  constructor(meta: { provider: ProviderName; outcome: RefundFailureOutcome; code: ProviderErrorCode }) {
    super(`${meta.provider} refund ${meta.outcome}: ${meta.code}`);
    this.name = 'RefundFailedError';
    this.provider = meta.provider;
    this.outcome = meta.outcome;
    this.code = meta.code;
  }
}
