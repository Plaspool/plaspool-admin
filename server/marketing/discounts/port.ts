import { sql } from 'drizzle-orm';
import { formatMoney, money } from '../../../shared/commerce/money';
import type { Db } from '../../db/client';
import type { CodeDiscount } from '../../../shared/commerce/ports';
import type {
  DiscountCodePort,
  DiscountOutcome,
  DiscountRejection,
} from '../../../shared/marketing/discounts';

/**
 * `DiscountCodePort`, implemented (admin#100 Part B) — the marketing half of
 * the second seam, and a deliberate copy of `redemption/port.ts`'s shape.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS WHERE "THE MODEL, AHEAD OF THE SURFACE THAT WILL REDEEM THEM"
 * STOPS BEING TRUE. `repo.ts` has carried that sentence since range 0000 and
 * `redeemed_count` has been 0 on every row in the shop because no code could
 * write it. This is the writer.
 *
 * WHAT IT DOES NOT DO, AND MUST NOT: decide anything about a cart. It knows
 * nothing about lines, totals, tax or allocation — it answers "does this code
 * apply, and what is the rule" and hands back a `CodeDiscount` for the totals
 * engine to apply. The arithmetic lives in `server/shop/cart/totals/compute.ts`
 * and the money decisions are the shop's. A port that also priced would be two
 * subsystems in one file with the seam drawn through the middle of it.
 *
 * `validate()` RESERVES NOTHING, AND THAT IS A CHOICE WITH A CONSEQUENCE. Two
 * shoppers holding the last use of a code capped at one will BOTH be told it
 * applies, and both will see the discount in their totals. The second one to
 * PAY still gets it — `redeem()` records the use rather than refusing it, and
 * the shop absorbs one extra discount. The alternative is holding a reservation
 * across a checkout that may be abandoned, which is the mechanism carts already
 * have for stock and which nobody wants for a coupon. A cap is a marketing
 * budget, not an inventory count, and overshooting one by a single order is
 * cheaper than a code that fails at the payment step.
 *
 * EVERY REFUSAL IS NAMED, and the ORDER they are judged in is the order a
 * shopper needs them: a switched-off code is switched off whether or not its
 * window is open, so `disabled` outranks the schedule. `limit_reached` is last
 * because it is the only one that can change between two requests.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** What one row has to say about whether it still applies. */
interface CodeRow {
  id: string;
  code: string;
  kind: 'percent' | 'fixed_amount';
  percentBps: number | null;
  amountMinor: number | null;
  currency: string | null;
  status: string;
  startsAt: number | null;
  endsAt: number | null;
  maxRedemptions: number | null;
  redeemedCount: number;
}

/**
 * A code as typed, reduced to the form the column holds.
 *
 * NORMALISED HERE AND NOT IN THE ROUTE, so that every caller inherits it —
 * including the freeze's re-validation, which reads a code out of the cart
 * rather than off a request. A shopper types what is on the flyer; the model
 * stores uppercase (`routes.ts` normalises before it validates on the write
 * side, and this is the read side's half of that).
 */
function normalise(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The customer's words for the rule, FROZEN onto the order with the total it
 * moved.
 *
 * RENDER-FINAL, for the reason the points label is: a campaign renamed in June
 * must not rewrite what a March receipt said. It is built from the numbers
 * rather than from anything an operator can edit — `note` is internal and
 * `code` is already carried beside this.
 *
 * The money format is `500.00 NGN`, which is what `formatAmount` in
 * `server/shop/orders/mailer.ts` already prints on every invoice this shop
 * sends. That function is not reachable from here — marketing may not import
 * `server/shop/**`, which is the whole point of the seam — and `formatMoney`
 * in the SHARED module produces the identical string, so this is one convention
 * rather than a second implementation of it.
 */
function labelFor(row: CodeRow): string {
  if (row.kind === 'percent') {
    // `1000` → "10", `550` → "5.5". Division rather than a fixed decimal count,
    // so a half-percent rung does not print as "5.50% off".
    return `${(row.percentBps ?? 0) / 100}% off`;
  }
  return `${formatMoney(money(row.amountMinor ?? 0, row.currency ?? ''))} off`;
}

/** The rule, in the shape the totals engine reads. */
function ruleFor(row: CodeRow): CodeDiscount {
  const label = labelFor(row);
  return row.kind === 'percent'
    ? { code: row.code, label, kind: 'percent', percentBps: row.percentBps ?? 0 }
    : {
        code: row.code,
        label,
        kind: 'fixed_amount',
        amount: money(row.amountMinor ?? 0, row.currency ?? ''),
      };
}

/**
 * The judgement, as data — every reason in one place and in one order.
 *
 * Returns the rejection or null, so the caller reads as "refuse, or apply".
 * Written as a sequence of guarded returns rather than a chain of booleans
 * because each line has to name its own reason, which is the entire feature.
 */
function refuse(row: CodeRow, currency: string, now: number): DiscountRejection | null {
  // A switched-off code is switched off whether or not its window is open.
  if (row.status !== 'active') return 'disabled';
  if (row.startsAt !== null && now < row.startsAt) return 'not_started';
  /* EXCLUSIVE at the end, matching the banner window's convention — `repo.ts`
   * chose that so the two surfaces do not disagree about a campaign's last
   * minute, and a `<=` here is what keeps them agreeing. */
  if (row.endsAt !== null && now >= row.endsAt) return 'expired';
  /* Only a fixed amount has a currency: "500 off" is not a price until it says
   * 500 of what. A percentage is a percentage of whatever the cart is in, and
   * refusing one on currency grounds would make every percent code
   * single-currency for no reason a shopper could see. */
  if (row.kind === 'fixed_amount' && row.currency !== currency) return 'currency_mismatch';
  // Last, because it is the only one that can change between two requests.
  if (row.maxRedemptions !== null && row.redeemedCount >= row.maxRedemptions) {
    return 'limit_reached';
  }
  return null;
}

export function discountPort(db: Db): DiscountCodePort {
  return {
    async validate({ code, currency, now }): Promise<DiscountOutcome> {
      const res = await db.execute(sql`
        SELECT id, code, kind, percent_bps, amount_minor, currency, status,
               starts_at, ends_at, max_redemptions, redeemed_count
          FROM marketing_discount_codes
         WHERE code = ${normalise(code)}`);
      const raw = res.rows[0];
      if (!raw) return { ok: false, reason: 'not_found' };

      const row: CodeRow = {
        id: String(raw.id),
        code: String(raw.code),
        kind: raw.kind as CodeRow['kind'],
        percentBps: raw.percent_bps == null ? null : Number(raw.percent_bps),
        amountMinor: raw.amount_minor == null ? null : Number(raw.amount_minor),
        currency: raw.currency == null ? null : String(raw.currency),
        status: String(raw.status),
        /* `Number`, not a bare comparison: `starts_at` and `ends_at` are bigint
         * columns, which the Neon driver hands back as STRINGS and PGlite is
         * configured to imitate — so `"1786600001000" > now` would be a string
         * comparison and a campaign would open on the wrong day. The same trap
         * `rowToDiscount` calls out in `repo.ts`. */
        startsAt: raw.starts_at == null ? null : Number(raw.starts_at),
        endsAt: raw.ends_at == null ? null : Number(raw.ends_at),
        maxRedemptions: raw.max_redemptions == null ? null : Number(raw.max_redemptions),
        redeemedCount: Number(raw.redeemed_count),
      };

      const reason = refuse(row, currency, now);
      return reason ? { ok: false, reason } : { ok: true, id: row.id, discount: ruleFor(row) };
    },

    async redeem({ orderId, orderNumber, code, amountMinor, currency, now }) {
      try {
        /*
         * ═══ ONE STATEMENT, AND IT HAS TO BE ONE STATEMENT ═══
         *
         * NOT A TRANSACTION: the Neon HTTP driver throws on `db.transaction`
         * unconditionally while PGlite supports it, so a transaction here would
         * pass every test in this repository and 500 in production (CLAUDE.md
         * §3). CTEs are how this codebase writes an atomic multi-table change.
         *
         * THE INSERT CARRIES THE INCREMENT. `redeemed_count` is a bare counter,
         * so `SET redeemed_count = redeemed_count + 1` run twice counts one
         * order twice — and this path replays by design: Paystack redelivers,
         * webhooks retry, and the sweep drains to a fixed point. Making the
         * ledger row the gate means the bump happens if and only if a row was
         * actually inserted, and `ON CONFLICT DO NOTHING` on the `order_id`
         * primary key makes the second pass a no-op BY INDEX rather than by a
         * check two concurrent passes could both clear.
         *
         * THE THREE COUNTS ARE RETURNED TOGETHER because the empty result is
         * ambiguous otherwise: "no row inserted" is the idempotent replay AND
         * the missing-code anomaly, and those need different answers.
         */
        const res = await db.execute(sql`
          WITH target AS (
            SELECT id, code FROM marketing_discount_codes WHERE code = ${normalise(code)}
          ), ins AS (
            INSERT INTO marketing_discount_redemptions
                   (order_id, discount_id, code, order_number, amount_minor, currency, redeemed_at)
            SELECT ${orderId}, target.id, target.code, ${orderNumber},
                   ${amountMinor}, ${currency}, ${now}
              FROM target
            ON CONFLICT (order_id) DO NOTHING
            RETURNING discount_id
          ), bumped AS (
            UPDATE marketing_discount_codes
               SET redeemed_count = redeemed_count + 1, updated_at = ${now}
             WHERE id IN (SELECT discount_id FROM ins)
            RETURNING id
          )
          SELECT (SELECT count(*) FROM target) AS found,
                 (SELECT count(*) FROM ins)    AS inserted,
                 (SELECT count(*) FROM bumped) AS bumped`);

        const row = res.rows[0];
        if (Number(row?.found ?? 0) === 0) {
          /* The order was priced with this code and has been PAID. There is
           * nothing to fail — the consumer writes this onto the order's history
           * and moves on, and a human reconciles the campaign. */
          return `anomaly: discount code ${normalise(code)} no longer exists; the order was charged with it applied — reconcile with marketing`;
        }
        return null;
      } catch (err: unknown) {
        // NEVER THROWS: this runs on `payment.captured`, after the order is
        // marked paid, so a throw would park an event whose state change stands.
        // The same discipline `refundPoints` keeps, for the same reason.
        return `anomaly: could not count the use of discount code ${normalise(code)} — ${
          err instanceof Error ? err.message : String(err)
        }; reconcile with marketing`;
      }
    },
  };
}
