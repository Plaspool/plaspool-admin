/**
 * FROZEN at stream fork 2026-08-13 — edits require both streams' consent.
 *
 * THE ONLY THING MARKETING AND THE SHOP MAY BOTH KNOW ABOUT.
 *
 * Points become money at checkout, which means two subsystems have to meet
 * somewhere. They do not meet in each other's code: `server/marketing/**` never
 * imports `server/shop/**` and the shop never imports marketing — the commerce
 * subsystems already talk this way (`shared/commerce/ports.ts`), and the
 * discipline is what lets two sessions work the two halves at once.
 *
 * Marketing IMPLEMENTS this port (`server/marketing/redemption/port.ts`). The
 * shop CONSUMES it, later, through one optional dependency injected at the
 * composition root — the `checkoutPort` precedent in `server/index.ts`. Until
 * that wiring lands, the implementation is fully built and unit-tested against
 * marketing's own tables, so the seam is proven before anything depends on it.
 *
 * WHAT THE SHOP SIDE MUST NOT ASSUME: `quote()` DOES NOT RESERVE. A balance can
 * fall between quoting a cart and committing the order (a concurrent redemption,
 * an admin clawback), and `redeem()` will then answer `insufficient_balance`
 * rather than overdrawing — the balance column has a `CHECK (balance >= 0)` and
 * the debit is guarded in SQL, so there is no path that spends points twice.
 * The recommended shop policy on that answer is to flag the order for manual
 * review, not to silently drop the discount the customer was shown. If the gap
 * ever bites at real volume, the named escape hatch is a reservation ledger kind
 * — which is why `release()` already exists.
 */
import type { Adjustment } from '../commerce/ports';

export interface RedemptionQuoteInput {
  /** Lowercase. Balances are email-keyed: guest checkout is the default path here. */
  email: string;
  customerId?: string | null;
  /** ISO-4217, uppercase. Must match the cart's currency. */
  currency: string;
  /** Integer minor units, for the max-share-of-order cap. */
  cartTotalMinor: number;
  /** Omitted means "as much as the rules allow". */
  pointsRequested?: number;
}

export interface RedemptionQuote {
  /** Negative `amount` — a discount. Flows into `computeTotals()` unchanged. */
  adjustment: Adjustment;
  /** How many points that discount would spend. */
  points: number;
  /** What the balance would be afterwards. For the checkout widget's copy. */
  balanceAfter: number;
}

export type RedeemResult =
  | { ok: true; entryId: string; balance: number }
  | { ok: false; code: 'insufficient_balance' | 'redemption_disabled' };

export interface PointsRedemptionPort {
  /**
   * A pure read. Returns null when redemption is switched off, when the balance
   * buys nothing, or when the rules' minimum is not met — null means "render no
   * widget at all", which is why it is not an error.
   */
  quote(input: RedemptionQuoteInput): Promise<RedemptionQuote | null>;

  /**
   * Spend the points against an order. Idempotent per order by construction: a
   * partial unique index on `(order_id) WHERE kind = 'redemption'` makes a
   * replay return the existing entry instead of debiting twice, so a webhook
   * that fires again is harmless.
   */
  redeem(input: {
    orderId: string;
    email: string;
    points: number;
    currency: string;
  }): Promise<RedeemResult>;

  /**
   * Give the points back when a redeemed order is cancelled or refunded.
   *
   * Without this, a cancelled order strands a debit with no named recovery path
   * and the customer is quietly out of pocket. Idempotent per order in the same
   * way; `entryId` is null when there was no redemption to release, which is a
   * success, not an error — the caller should not have to check first.
   */
  release(input: {
    orderId: string;
    reason: string;
  }): Promise<{ ok: true; entryId: string | null; balance: number | null }>;
}
