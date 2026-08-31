import { sql } from 'drizzle-orm';
import { money, scale } from '../../../shared/commerce/money';
import { fmtPoints } from '../../../shared/marketing/copy';
import { uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { InsufficientBalanceError } from '../errors';
import { resolveLabels } from '../labels';
import { credit, debit, foldEmail, readBalance } from '../ledger/repo';
import { getSettings } from '../settings/repo';
import type { SQL } from 'drizzle-orm';
import type { Money } from '../../../shared/commerce/money';
import type { Adjustment } from '../../../shared/commerce/ports';
import type {
  PointsRedemptionPort,
  RedeemResult,
  RedemptionQuote,
  RedemptionQuoteInput,
} from '../../../shared/marketing/redemption';
import type { Db } from '../../db/client';
import type { LedgerKind } from '../ledger/fragments';
import type { MarketingSettings } from '../settings/repo';

/**
 * `PointsRedemptionPort`, implemented — the marketing half of spec D9's seam.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS WIRED, AND `server/index.ts` IS STILL THE ONLY FILE THAT KNOWS BOTH
 * HALVES. It hands `redemptionPort` to Cart and to Orders as a factory over the
 * request's handle, so nothing below it imports across the seam. The shop now
 * holds the dependency, which costs this file the freedom it had while nothing
 * called it: the signatures frozen in `shared/marketing/redemption.ts` are no
 * longer its own to move, and widening one is a change to shop-owned files as
 * well. `orderNumber` below was exactly that.
 *
 * THE THREE METHODS ARE THREE DIFFERENT KINDS OF PROMISE:
 *
 * - `quote()` WRITES NOTHING AND RESERVES NOTHING. It answers "what would this
 *   balance be worth against this cart", and `null` means "render no widget" —
 *   switched off, nothing affordable, or under the minimum. None of those is an
 *   error, because none of them is something the customer did wrong. Called at
 *   the checkout FREEZE, by `quoteRedemption`
 *   (`server/shop/cart/checkout/repo.ts`), whose adjustment then goes into
 *   `computeTotals`.
 * - `redeem()` is the debit, at order commit, and it is IDEMPOTENT PER ORDER by
 *   index rather than by check: `marketing_ledger_redemption_uq` refuses a second
 *   row for the same order with every guard in this file deleted (spec D3). A
 *   webhook that fires twice is therefore harmless, which is what makes it safe
 *   for the shop to retry. `spendPoints` (`server/shop/orders/repo/consumer.ts`)
 *   leans on exactly that: it runs on `payment.captured` AFTER the order is
 *   marked paid, so it must never throw, and a re-swept event lands harmlessly
 *   on the row the first pass wrote.
 * - `release()` gives the points back when a redeemed order is cancelled or
 *   refunded. Without it a cancellation strands a debit with no named recovery
 *   path and the customer is quietly out of pocket. `refundPoints` calls it on
 *   `payment.failed` and `payment.refunded` — and so does the owner's cancel
 *   route (`server/shop/orders/routes.ts`), which reaches no branch of that
 *   consumer at all: an admin cancel emits `order.cancelled`, and the switch
 *   ignores that as one of this subsystem's own emissions.
 *
 * IDEMPOTENCY OUTRANKS EVERY OTHER ANSWER, and the ordering in `redeem` says so:
 * the existing row is looked for BEFORE the switch, the currency and the balance
 * are judged. A shop that disabled redemption this morning, or a customer who
 * has since spent the rest of their balance, must not turn a replayed webhook
 * for an order that was already paid for into `redemption_disabled` or
 * `insufficient_balance` — the order WAS redeemed, and the honest answer to
 * "redeem this again" is the entry that already exists.
 *
 * A RESULT UNION, NOT AN EXCEPTION, and `RedemptionDisabledError` is deliberately
 * not thrown here. The union is frozen in `shared/marketing/redemption.ts`: these
 * are business outcomes a checkout has to render (hide the widget, flag the order
 * for review), not faults. The error class exists for the HTTP surface that
 * eventually reports them — `server/marketing/app.ts` already maps it to the
 * catalogue's `409 redemption_disabled` — so the two do not compete: one is what
 * a caller inside the process receives, the other is what a client over the wire
 * receives. What DOES throw here is a malformed argument (`BadRequestError`),
 * because the frozen union has no room for "the caller sent nonsense" and
 * inventing a business answer for a programming error would hide it forever.
 *
 * NO SECOND IMPLEMENTATION OF BALANCE SEMANTICS. Every movement goes through
 * A6's `credit()` / `debit()`, which wrap the same fragments the inspection's
 * award chains inline — one upsert, one ledger insert, one `balance_after`, and
 * the `WHERE balance >= amount` that makes an overdraft structurally impossible.
 * This file adds the words, the arithmetic and the idempotency, and nothing else.
 *
 * NO NOUN A CUSTOMER READS IS WRITTEN DOWN HERE. The points word comes from
 * `marketing_settings` — the cross-program layer, because a cart spends points
 * earned under every program at once (spec D2) — and reaches the ledger row and
 * the checkout line through `fmtPoints`. The rendered strings are RENDER-FINAL:
 * a rename in June must not rewrite what a March receipt said.
 *
 * THE ORDER NUMBER IS THE CUSTOMER'S; THE ORDER ID IS THE INDEX'S. Both arrive
 * on every call and they are not interchangeable: `orderId` is the idempotency
 * key, the partial uniques and the `order_id` column, while `orderNumber`
 * (`2026-000009-D`) is what the confirmation email and the order page already
 * showed the shopper — so it is the ONLY one of the two that may appear in the
 * sentence they read. Printing the internal id here was the bug that widened
 * both inputs; the id is still written, structurally, to its own column, which
 * is where a machine should have been reading it from all along.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The `Adjustment.code` a redeemed cart carries into `computeTotals()`.
 *
 * A MACHINE HANDLE, AND THEREFORE LABEL-FREE. `label` is the customer's wording
 * and moves when the shop renames its currency; this is what the shop's code,
 * its invoices and any later reconciliation match on, so it must survive exactly
 * the rename that changes the label beside it — the `key`-versus-`name` split
 * spec D2 makes for programs, one layer down.
 */
export const REDEMPTION_ADJUSTMENT_CODE = 'points_redemption';

/**
 * The two ledger kinds an order can own, DERIVED rather than restated: a kind
 * renamed in `fragments.ts` breaks this line instead of leaving a string here
 * that no row will ever match.
 */
type OrderKind = Extract<LedgerKind, 'redemption' | 'redemption_release'>;

/** As much of a ledger row as this file's decisions need. */
interface OrderEntry {
  id: string;
  kind: OrderKind;
  /** The address the points came from — a release must credit back the wallet
   *  that paid, not whichever address the caller happens to name. */
  email: string;
  /** The MAGNITUDE. `delta` is negative on the debit and positive on the credit
   *  that undoes it; what both sentences are about is the same number. */
  points: number;
}

/**
 * Everything the ledger knows about one order, in one statement.
 *
 * TWO ARMS RATHER THAN `kind IN (…)`, and it is not style. The only indexes on
 * `order_id` are the two PARTIAL uniques — `(order_id) WHERE kind='redemption'`
 * and `(order_id) WHERE kind='redemption_release'` — and a predicate of
 * `kind IN ('redemption','redemption_release')` implies neither, so the planner
 * cannot use either one and reads the whole ledger. Each arm carries the equality
 * its index was built for, so this is two index lookups on a table that grows
 * with every award the shop ever makes.
 *
 * At most two rows come back, by those same uniques.
 */
async function orderEntries(db: Db, orderId: string): Promise<OrderEntry[]> {
  const arm = (kind: OrderKind): SQL => sql`
    SELECT id, kind, customer_email, delta
      FROM marketing_ledger
     WHERE order_id = ${orderId} AND kind = ${kind}`;

  const res = await db.execute(sql`${arm('redemption')} UNION ALL ${arm('redemption_release')}`);

  return res.rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as OrderKind,
    email: String(row.customer_email),
    points: Math.abs(Number(row.delta)),
  }));
}

/** An order id is the whole of a redemption's idempotency, so a blank one is a
 *  key that collides with every other blank one. */
function requireOrderId(value: string): string {
  const orderId = value.trim();
  if (orderId === '') throw new BadRequestError('orderId');
  return orderId;
}

/** An order number reaches the ledger's PROSE and nothing else, so a blank one
 *  freezes "Order : 500 points spent" — a sentence with a hole in it — into a
 *  row that is never re-rendered. Refused rather than written. */
function requireOrderNumber(value: string): string {
  const orderNumber = value.trim();
  if (orderNumber === '') throw new BadRequestError('orderNumber');
  return orderNumber;
}

/**
 * What `points` are worth, through the settings' integer rational.
 *
 * `rateMinor` MINOR UNITS PER `ratePoints` POINTS, scaled by the number of points
 * being spent — never a decimal rate, and never a multiplication this file does
 * itself. `scale()` keeps the intermediate in `BigInt` and rounds by a named
 * mode, which is `shared/commerce/money.ts`'s whole argument: a rate written as
 * 0.05 is a rounding rule nobody wrote down.
 *
 * HALF-UP, per spec D9. It rounds a part-unit conversion in the customer's
 * favour, and it is the mode the rest of this shop's arithmetic already uses.
 */
function pointsValue(settings: MarketingSettings, points: number, currency: string): Money {
  return scale(
    money(settings.redemptionRateMinor, currency),
    points,
    settings.redemptionRatePoints,
    'half-up',
  );
}

/**
 * The most points a discount of `cap` minor units can pay for — the conversion
 * above, inverted.
 *
 * `BigInt` AND NOT `Math.floor(cap * points / minor)`. Both operands are
 * `integer` columns whose product can pass 2^53, where a double stops being
 * arithmetic and starts being an approximation; the same reason `scale()` gives
 * for its own intermediate. The quotient is then floored by construction, which
 * is the direction a CAP has to round: rounding it up would let a cart spend
 * more of itself than `max_redeem_bps` allows, which is the one number this
 * clamp exists to enforce.
 *
 * The floor is also what keeps the value it feeds back inside the cap — for
 * `p = floor(cap × ratePoints / rateMinor)`, `p × rateMinor / ratePoints ≤ cap`,
 * and half-up rounding of a value at or below an integer cannot exceed it.
 */
function affordablePoints(settings: MarketingSettings, cap: number): bigint {
  return (
    (BigInt(cap) * BigInt(settings.redemptionRatePoints)) /
    BigInt(settings.redemptionRateMinor)
  );
}

/**
 * Are these points spendable against this cart at all?
 *
 * THE CURRENCY COMPARISON IS ALSO THE CURRENCY VALIDATION. `redemption_currency`
 * is `^[A-Z]{3}$` by CHECK, so an input that is lower-case, empty or not a code
 * at all fails this equality before it can reach `money()` — where it would be a
 * `MoneyError` and a 500 for what is really "no, not here".
 *
 * A MISMATCH IS NOT AN ERROR, IT IS AN ABSENCE. There is no conversion step in
 * this system (`shared/commerce/money.ts` refuses arithmetic across currencies on
 * purpose), so points priced in one currency simply cannot discount a cart
 * denominated in another. The shop is single-currency today
 * (`ShopCartDeps.storeCurrency`), which makes this reachable only by an admin
 * setting the redemption currency to something the store does not sell in —
 * a configuration mistake whose honest consequence is that the widget does not
 * appear, not that checkout breaks.
 *
 * `rateMinor > 0` is `marketing_settings_enabled_rate_ck` restated in TypeScript:
 * the database cannot hold an enabled row at a zero rate, and this is what stops
 * a division by zero if one ever existed.
 *
 * A TYPE PREDICATE, so the one condition that is also a narrowing — "there is a
 * settings row" — narrows at the call sites instead of being re-tested there in
 * a second, silently divergent form.
 */
function spendable(
  settings: MarketingSettings | null,
  currency: string,
): settings is MarketingSettings {
  return (
    settings !== null &&
    settings.redemptionEnabled &&
    settings.redemptionRateMinor > 0 &&
    settings.redemptionCurrency === currency
  );
}

/** The cross-program words. There is no program here — a cart spends points
 *  earned under all of them — which is exactly the case `resolveLabels(null, …)`
 *  exists for (spec D2). */
const wordsFor = (settings: MarketingSettings) => resolveLabels(null, settings);

/**
 * The seam, bound to one request's database handle.
 *
 * A FACTORY OVER A `Db` BECAUSE THE FROZEN INTERFACE TAKES NO HANDLE. Compare
 * `CheckoutPort<Db>`, which passes one per call: that shape was chosen before
 * `shared/marketing/redemption.ts` froze this one, and freezing a port that the
 * browser bundle also compiles means it cannot name a server-only type at all.
 * So the handle is closed over instead — and `currentDb(c)` is request-scoped, so
 * whatever `ShopCartDeps` eventually carries must be a function of the handle
 * rather than a long-lived object. This factory holds nothing else, which is what
 * makes constructing one per request free.
 *
 * `now` IS INJECTED so a suite can pin what a ledger row's `created_at` says.
 * Every write inside still goes through A6's executors, which take the instant as
 * an argument for the same reason every repo in this subsystem does.
 */
export function redemptionPort(db: Db, now: () => number = Date.now): PointsRedemptionPort {
  /** The row a replay answers with, plus the live balance of the wallet that
   *  actually paid. The balance is RE-READ rather than remembered: the point of
   *  the answer is what is true now, and by definition this call is not the one
   *  that moved it. */
  const replay = async (entry: OrderEntry): Promise<RedeemResult> => ({
    ok: true,
    entryId: entry.id,
    balance: await readBalance(db, entry.email),
  });

  return {
    async quote(input: RedemptionQuoteInput): Promise<RedemptionQuote | null> {
      const settings = await getSettings(db);
      if (!spendable(settings, input.currency)) return null;

      if (!Number.isSafeInteger(input.cartTotalMinor) || input.cartTotalMinor < 0) {
        throw new BadRequestError('cartTotalMinor');
      }
      if (
        input.pointsRequested !== undefined &&
        (!Number.isSafeInteger(input.pointsRequested) || input.pointsRequested < 0)
      ) {
        throw new BadRequestError('pointsRequested');
      }

      /*
       * READ, NEVER RESERVED — the sentence the shop side must not assume away
       * (`shared/marketing/redemption.ts`). This number can fall before the order
       * commits, and `redeem()` answers `insufficient_balance` rather than
       * overdrawing when it does.
       */
      const balance = await readBalance(db, foldEmail(input.email));

      /*
       * THE THREE CLAMPS, IN `BigInt`, so the widest of them cannot lose
       * precision on the way to the narrowest. The result is bounded by `balance`
       * — an `integer` column — so converting back is exact by construction.
       *
       * `max_redeem_bps` is applied to the CART rather than to the balance: it is
       * "how much of an order may be paid for in points", and rounding that share
       * DOWN is what makes it a cap rather than a suggestion.
       */
      const cap = scale(
        money(input.cartTotalMinor, input.currency),
        settings.maxRedeemBps,
        10_000,
        'down',
      );
      let spend = BigInt(balance);
      if (input.pointsRequested !== undefined && BigInt(input.pointsRequested) < spend) {
        /* A REQUEST IS CLAMPED, NOT REFUSED. "Omitted means as much as the rules
         * allow", so a number that is too large is a customer asking for more
         * than they have — the widget shows what they can spend instead of
         * vanishing. */
        spend = BigInt(input.pointsRequested);
      }
      const affordable = affordablePoints(settings, cap.amount);
      if (affordable < spend) spend = affordable;

      const points = Number(spend);
      /*
       * `null`, NOT AN ERROR, for all three of these. Nothing to spend, less than
       * the shop's minimum, or a quantity that converts to nothing — every one of
       * them is "there is no widget here", and a checkout that had to catch an
       * exception to discover it would be a checkout that breaks when a customer
       * has four points.
       */
      if (points <= 0 || points < settings.minRedeemPoints) return null;
      const value = pointsValue(settings, points, input.currency);
      if (value.amount <= 0) return null;

      const adjustment: Adjustment = {
        code: REDEMPTION_ADJUSTMENT_CODE,
        /* The customer's wording, frozen into `FrozenTotals` at this instant like
         * every other snapshot in this subsystem. */
        label: `${fmtPoints(points, wordsFor(settings))} redeemed`,
        /* NEGATIVE IS A DISCOUNT (`shared/commerce/ports.ts`), and the sign is
         * applied here rather than by asking `scale()` for a negative rate — the
         * value of points is a positive quantity, and what it does to a total is
         * this line. */
        amount: money(-value.amount, value.currency),
      };

      return { adjustment, points, balanceAfter: balance - points };
    },

    async redeem(input): Promise<RedeemResult> {
      const orderId = requireOrderId(input.orderId);

      /*
       * THE REPLAY IS ANSWERED FIRST, before the switch, the currency or the
       * balance are consulted — see the header. This is a read-before-write, and
       * unlike a balance it is a safe one: `marketing_ledger` is append-only and
       * the partial unique means at most one redemption row can EVER exist for an
       * order, so what this read finds cannot be invalidated by a concurrent
       * writer. It can only fail to find a row that appears a moment later, which
       * is the race the `catch` below closes.
       */
      const existing = await orderEntries(db, orderId);
      const already = existing.find((entry) => entry.kind === 'redemption');
      if (already) return replay(already);

      const settings = await getSettings(db);
      if (!spendable(settings, input.currency)) {
        return { ok: false, code: 'redemption_disabled' };
      }
      /*
       * A malformed amount throws (see the header): the frozen union's two codes
       * are business outcomes, and answering one of them for "the caller sent
       * -3 points" would report a bug as a customer's empty wallet.
       */
      if (!Number.isInteger(input.points) || input.points <= 0) {
        throw new BadRequestError('points');
      }
      /*
       * CHECKED HERE RATHER THAN AT THE TOP, and the replay above is exactly
       * why: the order NUMBER is not the idempotency key, so a webhook that
       * replays carrying a blank one must still be answered from the row that
       * already exists instead of throwing. It sits beside the `points` check
       * because it is the same kind of check — a malformed argument, which the
       * frozen union has no code for — and both belong after the answer that
       * outranks them.
       */
      const orderNumber = requireOrderNumber(input.orderNumber);

      /*
       * THE RULES ARE NOT RE-CHECKED HERE, and the frozen signature is why: this
       * call carries no cart total, so `max_redeem_bps` — a share of an order —
       * is not a question it can be asked. `quote()` is where the rules live;
       * this is the commit, and what it enforces is the two things it CAN see,
       * which are the switch and the balance. The balance one is enforced in SQL.
       */
      try {
        const moved = await debit(db, {
          email: input.email,
          amount: input.points,
          reason: `Order ${orderNumber}: ${fmtPoints(input.points, wordsFor(settings))} spent`,
          kind: 'redemption',
          orderId,
          /* The customer spent their own points at a checkout; no admin was
           * involved, and there is no staff account to name. */
          actorType: 'customer',
          now: now(),
        });
        return { ok: true, entryId: moved.entryId, balance: moved.balance };
      } catch (err) {
        /*
         * TWO WAYS A REPLAY CAN ARRIVE HERE, and both end at the same answer.
         *
         * The index refused the second row — the plain race — OR the debit's
         * guard refused first because the wallet has since been spent down, which
         * is what a webhook re-firing a week later looks like. The second is the
         * subtle one: without this, an order that WAS paid for with points would
         * answer `insufficient_balance` and the shop would flag a perfectly good
         * order for manual review.
         */
        const guarded = err instanceof InsufficientBalanceError;
        if (!guarded && uniqueViolation(err) !== 'marketing_ledger_redemption_uq') throw err;

        const raced = (await orderEntries(db, orderId)).find(
          (entry) => entry.kind === 'redemption',
        );
        if (raced) return replay(raced);
        if (guarded) return { ok: false, code: 'insufficient_balance' };
        /* The index refused a row that is not there. That is not a story this
         * port can tell, so it stays an error rather than becoming a plausible
         * answer. */
        throw err;
      }
    },

    async release(input): Promise<{ ok: true; entryId: string | null; balance: number | null }> {
      const orderId = requireOrderId(input.orderId);
      /* Up front here, unlike `redeem`'s, to sit with `reason`: both are prose
       * bound for the same frozen sentence, and this method already refuses a
       * malformed one before it looks anything up. */
      const orderNumber = requireOrderNumber(input.orderNumber);
      const reason = input.reason.trim();
      /* The ledger's own CHECK only refuses the empty string, so a field of
       * spaces would satisfy it and leave the one column that explains why a
       * balance moved rendering as nothing. */
      if (reason === '') throw new BadRequestError('reason');

      const entries = await orderEntries(db, orderId);
      const redeemed = entries.find((entry) => entry.kind === 'redemption');
      /*
       * NOTHING TO RELEASE IS A SUCCESS. Most cancelled orders never spent a
       * point, and the frozen interface says so in its own comment: the caller
       * should not have to check first, which is what makes it safe to call this
       * from every cancellation path unconditionally.
       */
      if (!redeemed) return { ok: true, entryId: null, balance: null };

      const released = entries.find((entry) => entry.kind === 'redemption_release');
      if (released) {
        return {
          ok: true,
          entryId: released.id,
          balance: await readBalance(db, released.email),
        };
      }

      const settings = await getSettings(db);
      if (settings === null) {
        /*
         * The singleton is seeded by migration 0011 and no route deletes it, so
         * this is unreachable — checked because the alternative is inventing a
         * points word in source, which is the one thing spec D2 makes impossible
         * everywhere else in this subsystem (`labels.ts` refuses the same
         * temptation). `patchSettings` answers a missing row the same way.
         */
        throw new NotFoundError('main');
      }

      /*
       * THE AMOUNT AND THE ADDRESS COME FROM THE ROW, not from the caller — the
       * frozen input carries only an order id and a reason, which is deliberate:
       * a compensating credit that could be told how much to give back would be a
       * second place for the number to be wrong. What was debited is what is
       * returned, to the wallet it was taken from.
       *
       * This credit moves `lifetime_earned` like every other credit, because
       * `balanceUpsertFragment` maintains it for all of them with no per-kind
       * branch (`ledger/repo.ts` explains why there is no branch). Recorded here
       * so the consequence is written down rather than discovered: a customer who
       * spends and is refunded reads as having earned slightly more than they did.
       */
      const words = wordsFor(settings);
      try {
        const moved = await credit(db, {
          email: redeemed.email,
          amount: redeemed.points,
          reason: `Order ${orderNumber}: ${fmtPoints(redeemed.points, words)} returned — ${reason}`,
          kind: 'redemption_release',
          orderId,
          /* Nobody typed this. A release is issued by whatever cancelled or
           * refunded the order, which is a process rather than a person. */
          actorType: 'system',
          now: now(),
        });
        return { ok: true, entryId: moved.entryId, balance: moved.balance };
      } catch (err) {
        /* The same race as `redeem`'s, one index along: two cancellations of one
         * order, and the second is answered from the row the first wrote. */
        if (uniqueViolation(err) !== 'marketing_ledger_release_uq') throw err;
        const raced = (await orderEntries(db, orderId)).find(
          (entry) => entry.kind === 'redemption_release',
        );
        if (!raced) throw err;
        return { ok: true, entryId: raced.id, balance: await readBalance(db, raced.email) };
      }
    },
  };
}
