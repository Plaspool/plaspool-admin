import type { CodeDiscount } from '../commerce/ports';

/**
 * The discount-code seam (admin#100 Part B) — marketing's second port into the
 * shop, and the twin of `redemption.ts` next door.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A PORT AND NOT AN IMPORT. The shop may not read marketing's tables and
 * marketing may not read the shop's; `server/index.ts` is the one file that
 * knows both halves, and it hands this across as a factory over the request's
 * database handle exactly as it hands `PointsRedemptionPort`. The alternative —
 * `server/shop/cart/` importing `server/marketing/discounts/repo.ts` — is one
 * import that makes the two subsystems one, and it is the reason the points
 * seam was built this way in the first place.
 *
 * THE TWO METHODS ARE TWO DIFFERENT KINDS OF PROMISE, and the split is the same
 * one `PointsRedemptionPort` makes:
 *
 * - `validate()` READS AND RESERVES NOTHING. It answers "would this code apply
 *   to a cart in this currency, right now" — and its refusals are BUSINESS
 *   OUTCOMES a checkout has to render, not faults. A shopper who types an
 *   expired code has not done anything wrong; they need to be told which of the
 *   six things went wrong so they know whether to retry or give up.
 * - `redeem()` COUNTS ONE USE, at capture, and is IDEMPOTENT PER ORDER BY INDEX
 *   rather than by check: `marketing_discount_redemptions` keys on `order_id`,
 *   so a replayed webhook lands on the row the first pass wrote with every
 *   guard in the consumer deleted. `redeemed_count` is a bare counter and could
 *   not have been made safe any other way — see migration 0820's header.
 *
 * A RESULT UNION, NOT AN EXCEPTION, for the reason `RedeemResult` is one: these
 * are answers a checkout renders, and an exception has nowhere to put the
 * reason. What DOES throw is a malformed argument, because the union has no arm
 * for "the caller sent nonsense" and inventing a business answer for a
 * programming error would hide it forever.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Why a code did not apply — a TYPED reason, and storefront#113 is explicit
 * about why it has to be.
 *
 * "A rejected code shows a specific reason — expired / not found / disabled /
 * not yet started / wrong currency — never a generic 'something went wrong'."
 * A shopper told the latter retries, and retrying cannot fix any of these. Each
 * one implies a different next step: try again with a different code, come back
 * on Friday, or stop.
 */
export type DiscountRejection =
  /** No row with that code. Covers a typo and a code that never existed. */
  | 'not_found'
  /** The row exists and is switched off. */
  | 'disabled'
  /** `ends_at` has passed. The window is EXCLUSIVE of its end. */
  | 'expired'
  /** `starts_at` is in the future — a campaign that has not opened yet. */
  | 'not_started'
  /** A `fixed_amount` code priced in a currency this cart is not in. */
  | 'currency_mismatch'
  /** `max_redemptions` is reached. Not the shopper's fault, and not fixable. */
  | 'limit_reached';

export type DiscountOutcome =
  | {
      ok: true;
      /** `marketing_discount_codes.id` — the key the redemption row carries. */
      id: string;
      /** The part the totals engine reads, and the part frozen onto the order. */
      discount: CodeDiscount;
    }
  | { ok: false; reason: DiscountRejection };

export interface DiscountCodePort {
  /**
   * Judge a code. A pure read — nothing is reserved, and two shoppers holding
   * the last use of a capped code both validate. The cap is settled at capture,
   * where the money is.
   *
   * `now` IS PASSED IN rather than read here, so the schedule is testable
   * without moving the clock, and so one request cannot judge `starts_at` and
   * `ends_at` a millisecond apart.
   */
  validate(input: {
    /** As typed. Normalised to uppercase by the implementation, not the caller. */
    code: string;
    /** The cart's currency, ISO-4217 uppercase. */
    currency: string;
    now: number;
  }): Promise<DiscountOutcome>;

  /**
   * Count one use against an order. Idempotent per order by index.
   *
   * NEVER THROWS, and never refuses. It runs on `payment.captured`, after the
   * order is marked paid — the sale has happened and the discount has already
   * been given. A throw here would park an event whose state change stands, and
   * a refusal would be an opinion about an order that is already complete. A
   * code that has since been disabled or has hit its cap still counts the use
   * that was made of it.
   *
   * Returns an anomaly line when something needed reconciling, or null. Same
   * shape as `refundPoints`, and for the same reason: the consumer records it
   * on the order's history rather than failing.
   */
  redeem(input: {
    orderId: string;
    /** The customer's `2026-000009-D`, for a human reconciling a campaign. */
    orderNumber: string;
    code: string;
    /** POSITIVE minor units — what the code actually took off, after the clamp. */
    amountMinor: number;
    currency: string;
    now: number;
  }): Promise<string | null>;
}
