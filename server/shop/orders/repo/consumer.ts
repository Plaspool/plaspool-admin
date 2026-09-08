import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { BadRequestError, PreconditionFailedError, StaleWriteError } from '../../../repo/errors';
import { asCommerceEventType } from '../../../../shared/commerce/events';
import {
  parseCheckoutCompleted,
  parsePaymentAuthorized,
  parsePaymentCaptured,
  parsePaymentFailed,
  parsePaymentRefunded,
  parsePaymentRefundFailed,
} from '../inbound';
import { mintGuestToken } from '../tokens';
import type { AccessLink } from '../mailer';
import { BUILT_IN } from '../../../email/system-templates';
import type { TemplateSet } from '../../../email/system-templates';
import type { PointsRedemptionPort } from '../../../../shared/marketing/redemption';
import type { DiscountCodePort } from '../../../../shared/marketing/discounts';
import {
  CONSUMER,
  cancelOrder,
  createOrderFromCheckout,
  markOrderPaid,
  readOrderByCheckout,
  recordAuthorization,
  recordRefundFailure,
  refundOrder,
  type OrderRead,
} from './orders';
import { queueStaffOrderEmail } from '../staff-mail';

/**
 * THE CONSUMER (contract §6, brief §4).
 *
 * Orders creates nothing itself; it reacts to rows in `commerce_events`. Which means
 * this file's job is almost entirely to answer one question correctly for each row:
 *
 *   **applied**  — the state changed. The consumption row was written in the SAME
 *                  statement, so this outcome cannot be lost or double-counted.
 *   **ignored**  — nothing will ever change because of this row. An event type this
 *                  subsystem does not handle (§6 rule 4), a duplicate the constraints
 *                  refused, or an operation the order's state REFUSES rather than
 *                  loses. A consumption row is written so it is never re-examined.
 *   **parked**   — this row could not be applied YET. Its predecessor has not
 *                  arrived, or a race was lost, or this build cannot read its
 *                  payload. **No consumption row at all**, which is what makes it
 *                  retryable, plus `last_error` and `attempts` on the outbox row so
 *                  an operator can see what is stuck.
 *
 * THE THREE THINGS THIS FILE MUST NEVER DO, from brief §4:
 *
 *  - **Never throw.** A dispatcher that throws stops draining the outbox at its
 *    first bad row, and the row that stops it is by definition the one nobody
 *    predicted. Every handler is wrapped; an unrecognised failure parks.
 *  - **Never drop.** Nothing here deletes a `commerce_events` row, ever.
 *  - **Never require ordering.** `payment.captured` before `checkout.completed` is
 *    ordinary, not exceptional: providers retry, and a webhook is not a queue.
 *
 * THE CANDIDATE SET IS AN ANTI-JOIN, NOT `processed_at IS NULL`. §6 rule 2 keys
 * idempotency on `(consumer, eventId)`, and `processed_at` is one column on a shared
 * table that cannot say "Orders is done and some future consumer is not". The
 * anti-join is what makes this consumer's progress its own.
 */

export type Disposition =
  | { kind: 'applied'; detail?: string }
  | { kind: 'ignored'; detail: string }
  | { kind: 'parked'; detail: string };

/**
 * How many times a row may park before it is recorded `abandoned`.
 *
 * A parked row is retried on every sweep, so an event whose predecessor will never
 * arrive would be retried forever. Twenty sweeps is generous enough that a same-day
 * redeploy — the realistic fix when the cause is a payload this build cannot read —
 * recovers automatically, and finite enough that a genuinely orphaned event stops
 * consuming the budget.
 *
 * `abandoned` DESTROYS NOTHING. The outbox row keeps its payload and its
 * `last_error`; only the consumption row says this consumer has stopped trying.
 * Recovery is `DELETE FROM shop_order_event_consumptions WHERE consumer = 'orders'
 * AND event_id = …`, which is deliberately a human decision.
 */
export const PARK_ATTEMPT_LIMIT = 20;

/** How many rows one sweep will look at. */
export const EVENT_SWEEP_LIMIT = 100;

export interface EventRow {
  id: string;
  type: string;
  subjectId: string;
  payload: unknown;
  occurredAt: number;
  attempts: number;
}

export interface ConsumerDeps {
  /**
   * The origin guest access links are built from — `AppEnv.origins[0]`, i.e. this
   * deployment's own allow-list.
   *
   * NEVER A `Host` HEADER, and there is not even one available here: the sweeper runs
   * from a cron with no request. A link built from an attacker-supplied header is a
   * phishing link the application sent itself, which is why `server/routes/auth.ts`
   * takes the same value from the same place for invite URLs.
   *
   * `null` means emails carry no link, which is a degraded but honest state.
   */
  origin: string | null;

  /**
   * SpoolPoints (admin#2). Absent means an order that spent points is still
   * created, paid and confirmed — the points are simply not debited. See
   * `OrdersDeps.redemption`.
   */
  redemption?: (db: Db) => PointsRedemptionPort;
  /**
   * Discount codes (admin#100 Part B). Used at the capture only, to COUNT a use
   * — nothing here ever decides whether a code applies; that was settled at the
   * freeze and the price is already struck.
   */
  discounts?: (db: Db) => DiscountCodePort;

  /**
   * The system templates in force, loaded ONCE per sweep by the caller.
   *
   * LOADED BY THE CALLER AND PASSED AS DATA, rather than read here per event.
   * The render happens inside a statement builder that composes SQL
   * synchronously, so it cannot await; and a sweep draining forty events would
   * otherwise issue forty identical reads of a nine-row table.
   *
   * Absent means the built-in defaults, which is a complete, correct, branded
   * message — never a missing one. `server/email/system-templates.ts` carries the
   * argument for why that fallback is the precondition for this feature existing.
   */
  templates?: TemplateSet;
}

// ------------------------------------------------------------------ dispatch

/**
 * One row. Returns a disposition and NEVER THROWS.
 *
 * The `try` is not decoration: `handleEvent` reaches a repository that reaches a
 * driver, and the set of things a driver can raise is not enumerable from here.
 * Whatever it is, the honest answer is "this row is not applied and has not been
 * consumed", which is a park.
 */
export async function handleEvent(
  db: Db,
  row: EventRow,
  deps: ConsumerDeps,
  now: number,
): Promise<Disposition> {
  try {
    return await dispatch(db, row, deps, now);
  } catch (err: unknown) {
    return classify(err);
  }
}

/**
 * The error taxonomy that already exists in this codebase maps EXACTLY onto
 * park-versus-ignore, which is why no new error class was added (contract §10 permits
 * one only for genuinely new client behaviour).
 *
 * - `PreconditionFailedError` — "refused, not lost". `server/repo/errors.ts` split
 *   this out from `StaleWriteError` precisely because the two mean different things,
 *   and the difference is the one this function needs: the order is already in a
 *   state where this event has nothing to do, and it will still be in one on the next
 *   sweep. **Ignored.**
 * - `StaleWriteError` — three attempts, three lost races. Genuinely transient.
 *   **Parked.**
 * - `BadRequestError` — malformed input that can never be accepted, which is exactly
 *   the reason that class exists. **Ignored.**
 * - anything else — unknown, so assume a redeploy might fix it. **Parked.**
 */
function classify(err: unknown): Disposition {
  if (err instanceof PreconditionFailedError) {
    return { kind: 'ignored', detail: `refused: ${err.operation}` };
  }
  if (err instanceof StaleWriteError) {
    return { kind: 'parked', detail: 'lost the write race; will retry' };
  }
  if (err instanceof BadRequestError) {
    return { kind: 'ignored', detail: `bad payload: ${err.detail}` };
  }
  // Names only. A message can quote a value; `DbError` is already scrubbed, but an
  // arbitrary error is not, and this string is written to a column.
  const name = err instanceof Error ? err.name : typeof err;
  return { kind: 'parked', detail: `unhandled ${name}; will retry` };
}

/** A parse failure names the FIELD and parks — never the value, and never a throw. */
function parkOnBadPayload(failure: { detail: string }): Disposition {
  return {
    kind: 'parked',
    detail: `payload not readable by this build at: ${failure.detail}`,
  };
}

/**
 * "Its predecessor has not arrived" — brief §4's park, with a recognisable message.
 *
 * `awaiting predecessor` is a fixed prefix so an operator can find every one of them
 * with a single `LIKE`, which is the difference between a diagnosable backlog and a
 * column full of prose.
 */
function awaitingCheckout(checkoutId: string): Disposition {
  return {
    kind: 'parked',
    detail: `awaiting predecessor: checkout.completed for ${checkoutId}`,
  };
}

/**
 * Spend the SpoolPoints an order was frozen with. Returns a `detail` string when
 * something is worth recording, or null for the ordinary silent success.
 *
 * ═══ THE D9 DECISION, AND IT IS MADE HERE ═══
 *
 * Spec D9: **a quote does not RESERVE.** The discount was decided at the freeze
 * and the debit happens now, and between those two instants a balance can fall —
 * a concurrent checkout, an admin clawback. `redeem()` answers
 * `insufficient_balance` rather than overdrawing, because the balance column has
 * a `CHECK (balance >= 0)` and the debit is guarded in SQL.
 *
 * **WHEN THAT HAPPENS THE ORDER IS STILL PAID AND STILL SHIPS.** The customer
 * agreed to the frozen total, paid the frozen total, and has a confirmation. The
 * shortfall is the SHOP's — it granted a discount it could not fund — and the
 * honest handling of that is a reconciliation note, not a customer who is
 * charged a second time or an order that never appears. Refusing the order here
 * would take money and give nothing, which is the one failure this pipeline
 * exists to prevent.
 *
 * SO IT IS RECORDED WITH THE `anomaly:` PREFIX, the same convention
 * capture-against-a-cancelled-order uses above, so one `LIKE` over
 * `shop_order_event_consumptions.detail` finds every order that needs looking at.
 * `shop_orders_redemption_idx` (migration 0260) is the other half of that query.
 *
 * NEVER THROWS, AND THAT IS DELIBERATE. This runs AFTER `markOrderPaid`. Throwing
 * would park an event whose state change has already been applied, and the next
 * sweep would replay it — so the failure mode of a marketing outage would be an
 * order stuck parked rather than an order that is simply missing its debit. The
 * points are recoverable by hand; a parked paid order is not recoverable by the
 * customer at all.
 *
 * IDEMPOTENT BY CONSTRUCTION, so the replay a parked-then-retried sweep produces
 * is harmless: a partial unique index on `(order_id) WHERE kind = 'redemption'`
 * makes the second call return the first call's entry instead of debiting twice.
 */
async function spendPoints(
  db: Db,
  deps: ConsumerDeps,
  orderId: string,
  now: number,
): Promise<string | null> {
  if (!deps.redemption) return null;
  try {
    /*
     * READ HERE RATHER THAN THROUGH `Order`. `ORDER_COLUMNS` is an explicit list
     * for the reason `orders.ts` gives — a column added to it joins every order
     * response — and the wallet address is not something an order page needs.
     */
    const res = await db.execute(sql`
      SELECT redemption_points, redemption_email, currency, order_number
        FROM shop_orders WHERE id = ${orderId}`);
    const row = res.rows[0];
    if (!row || row.redemption_points == null || row.redemption_email == null) return null;

    const result = await deps.redemption(db).redeem({
      orderId,
      /* The customer's number, off the row this statement already had to read —
       * the ledger writes it into a sentence they will read back. */
      orderNumber: String(row.order_number),
      email: String(row.redemption_email),
      points: Number(row.redemption_points),
      currency: String(row.currency),
    });
    if (result.ok) return null;

    return `anomaly: ${result.code} redeeming ${Number(row.redemption_points)} points — order is paid, the discount was not funded; reconcile with marketing`;
  } catch (err: unknown) {
    return `anomaly: redemption failed after payment — ${err instanceof Error ? err.message : String(err)}; order is paid, reconcile with marketing`;
  }
}

/**
 * Count one use of the order's discount code (admin#100 Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SIBLING OF `spendPoints`, DELIBERATELY, down to the shape of its failure.
 * It runs on `payment.captured`, after the order is marked paid; the sale has
 * happened and the discount has already been given. So it NEVER THROWS and
 * never refuses — a throw would park an event whose state change stands, and an
 * opinion about a completed order is worth nothing to anyone.
 *
 * IDEMPOTENT BY CONSTRUCTION, in the port: `marketing_discount_redemptions`
 * keys on `order_id`, so a replayed sweep lands on the row the first pass wrote
 * rather than counting a second use. See migration 0820's header for why a bare
 * `redeemed_count + 1` could not have been made safe.
 *
 * THE AMOUNT IS READ OFF THE ORDER'S OWN ROW, and it is there rather than in the
 * cart because this runs on a LATER event than the one that created the order —
 * Orders may not read `shop_carts` (contract §2), so the number travels on
 * `checkout.completed` and lands in a column. Migration 0820 makes the same
 * argument from the schema's side.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function countDiscountUse(
  db: Db,
  deps: ConsumerDeps,
  orderId: string,
): Promise<string | null> {
  if (!deps.discounts) return null;
  try {
    /* READ HERE RATHER THAN THROUGH `Order`, for the reason `spendPoints` gives:
     * `ORDER_COLUMNS` is an explicit list and a campaign's code is not something
     * an order page needs. */
    const res = await db.execute(sql`
      SELECT discount_code, discount_amount_minor, currency, order_number
        FROM shop_orders WHERE id = ${orderId}`);
    const row = res.rows[0];
    if (!row || row.discount_code == null) return null;

    return await deps.discounts(db).redeem({
      orderId,
      orderNumber: String(row.order_number),
      code: String(row.discount_code),
      /* Off this order's own row. Migration 0820's CHECK pairs the two columns,
       * so a non-null code guarantees a non-null amount. */
      amountMinor: Number(row.discount_amount_minor ?? 0),
      currency: String(row.currency),
      now: Date.now(),
    });
  } catch (err: unknown) {
    return `anomaly: could not count the use of discount code after payment — ${
      err instanceof Error ? err.message : String(err)
    }; the order is paid and was charged with it applied, reconcile with marketing`;
  }
}

/**
 * Give back the points a cancelled or refunded order spent.
 *
 * CALLED FROM THE CONSUMER'S FAILURE PATHS **AND FROM THE OWNER'S CANCEL ROUTE**
 * (`routes.ts`), which is why it is exported. An admin cancelling a paid order is
 * not an event this consumer ever sees: `cancelOrder` emits `order.cancelled`,
 * and the switch above ignores that as one of this subsystem's OWN emissions. So
 * a cancel driven by a person reaches no branch here, and wiring the release only
 * into the event paths left exactly the hole `release()` exists to close — a
 * cancelled order with its debit stranded and the customer quietly out of pocket.
 *
 * UNCONDITIONAL, AND THAT IS THE PORT'S OWN INSTRUCTION: `release()` answers
 * `entryId: null` when there was no redemption, which it documents as a success
 * rather than an error precisely so every cancellation path can call it without
 * checking first. Most cancelled orders never spent a point.
 *
 * NEVER THROWS, for the same reason `spendPoints` does not: the cancellation has
 * already been applied by the time this runs, and a throw would park an event
 * whose state change stands. A customer whose refund is missing its point credit
 * is a fixable ledger entry; a parked cancellation is a stuck pipeline.
 */
export async function refundPoints(
  db: Db,
  redemption: ((handle: Db) => PointsRedemptionPort) | undefined,
  orderId: string,
  orderNumber: string,
  reason: string,
): Promise<string | null> {
  if (!redemption) return null;
  try {
    await redemption(db).release({ orderId, orderNumber, reason });
    return null;
  } catch (err: unknown) {
    return `anomaly: could not return redeemed points — ${err instanceof Error ? err.message : String(err)}; reconcile with marketing`;
  }
}

function accessLink(read: OrderRead, deps: ConsumerDeps, now: number): AccessLink | null {
  if (deps.origin === null) return null;
  return {
    origin: deps.origin,
    token: mintGuestToken({ orderNumber: read.order.orderNumber, email: read.order.email }, now),
  };
}

async function dispatch(
  db: Db,
  row: EventRow,
  deps: ConsumerDeps,
  now: number,
): Promise<Disposition> {
  const type = asCommerceEventType(row.type);

  /*
   * §6 RULE 4, AND IT IS WHY THESE FOUR SUBSYSTEMS COULD BE BUILT AT ONCE. A type
   * this build has never heard of is logged and ignored — not thrown, which would
   * stop the whole outbox the first time another agent shipped ahead of this one.
   */
  if (type === null) return ignoreAndLog(row, `unknown type: ${row.type}`);

  switch (type) {
    /*
     * MY OWN EMISSIONS, AND EVERY OTHER SUBSYSTEM'S. They are in the same table and
     * this consumer reads the whole table, so they have to be declined explicitly.
     * Recording an `ignored` consumption row is what stops them being re-examined on
     * every sweep for the life of the shop.
     */
    case 'catalog.variant.published':
    case 'catalog.variant.unpublished':
    case 'catalog.inventory.adjusted':
    case 'order.created':
    case 'order.fulfilled':
    case 'order.cancelled':
      return { kind: 'ignored', detail: `not handled by ${CONSUMER}: ${type}` };

    case 'checkout.completed': {
      const parsed = parseCheckoutCompleted(row.payload, row.subjectId);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const outcome = await createOrderFromCheckout(
        db,
        { id: row.id, occurredAt: row.occurredAt },
        parsed.value,
        now,
        deps.origin,
        deps.templates ?? BUILT_IN,
      );
      if (outcome.kind === 'created') return { kind: 'applied' };
      if (outcome.kind === 'replayed') return { kind: 'ignored', detail: 'already consumed' };
      return { kind: 'ignored', detail: `duplicate order for this ${outcome.on}` };
    }

    case 'payment.authorized': {
      const parsed = parsePaymentAuthorized(row.payload);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const read = await readOrderByCheckout(db, parsed.value.checkoutId);
      if (!read) return awaitingCheckout(parsed.value.checkoutId);
      const applied = await recordAuthorization(
        db,
        read.order.id,
        row.id,
        now,
        parsed.value.intentId,
      );
      return applied
        ? { kind: 'applied' }
        : { kind: 'ignored', detail: 'already consumed' };
    }

    case 'payment.captured': {
      const parsed = parsePaymentCaptured(row.payload);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const read = await readOrderByCheckout(db, parsed.value.checkoutId);
      if (!read) return awaitingCheckout(parsed.value.checkoutId);

      /*
       * A CAPTURE AGAINST A CANCELLED ORDER IS AN ANOMALY, AND IT IS NOT SILENTLY
       * IGNORED.
       *
       * It is reachable: `payment.failed` arriving before `payment.captured` cancels
       * the order, and Payments' own status ladder admits `failed → captured`
       * explicitly because a customer can pay a checkout we locally gave up on. The
       * money then exists and the order says it will never ship.
       *
       * Resurrecting the order here would be worse than the anomaly: `cancelled` may
       * have been a deliberate human decision, and stock has been released. So the
       * state is left alone and the row is recorded LOUDLY — `last_error` carries a
       * fixed `anomaly:` prefix so one `LIKE` finds every one of them. Refusing to
       * decide is the correct behaviour; refusing to WRITE IT DOWN would not be.
       */
      if (read.order.status === 'cancelled') {
        return {
          kind: 'ignored',
          detail: `anomaly: capture for a cancelled order (${read.order.orderNumber}) — reconcile with payments`,
        };
      }

      await markOrderPaid(
        db,
        read.order.id,
        now,
        accessLink(read, deps, now),
        { eventId: row.id },
        parsed.value.intentId,
        deps.templates ?? BUILT_IN,
      );

      /*
       * AND THE SHOP TELLS ITSELF (migration 0980) — HERE, AT THE CAPTURE, NOT
       * AT `checkout.completed`.
       *
       * An order row exists at `checkout.completed` and it is `pending`, so
       * announcing there would mail the packing bench about every abandoned
       * basket — and `checkout.completed` is also where the domain emits
       * `order.created`, which is the event this would be duplicating. Paid is
       * the moment somebody should walk over and start picking, so paid is when
       * it is said.
       *
       * ITS RETURN IS DISCARDED AND IT CANNOT THROW. Zero is an ordinary answer
       * — the switch is off, nobody is configured, or a redelivery landed on
       * rows that already exist — and an exception here would park an event
       * whose state change stands, which is the one failure `spendPoints` below
       * exists to avoid. See `staff-mail.ts`'s header.
       */
      await queueStaffOrderEmail(db, read.order.id, now, deps.templates ?? BUILT_IN);

      /*
       * SPOOLPOINTS ARE SPENT HERE — AT THE CAPTURE, NOT AT `checkout.completed`.
       *
       * An order row exists at `checkout.completed`, but it is `pending`. Debiting
       * a wallet there means every checkout that is completed and then never paid
       * for — the ordinary abandonment — strands a debit that something has to
       * find and give back. Spending when the money actually arrives means the
       * common case spends nothing and needs no compensation, and `release()` is
       * left with only the case it was written for: an order that WAS paid and is
       * then cancelled or refunded.
       *
       * IT RUNS INSIDE THE SWEEP'S OWN REQUEST, which is the reason it is safe to
       * put it after the state change at all. Post-response work does not run on
       * Vercel — the function freezes once it has answered, measured twice — but
       * the sweep is a cron-driven request that is still executing here.
       */
      const redeemed = await spendPoints(db, deps, read.order.id, now);
      /*
       * AND THE DISCOUNT CODE'S USE, COUNTED AT THE SAME MOMENT AND FOR THE SAME
       * REASON (admin#100 Part B, owner's decision 2026-09-02): a code is spent
       * when the money arrives, so an abandoned checkout never burns one use of
       * a capped campaign.
       *
       * SEQUENTIAL, NOT `Promise.all`. Both write, and the Neon HTTP driver has
       * no transaction to hold them together (CLAUDE.md §3) — running them
       * concurrently would buy one round trip and cost the ability to say which
       * of the two failed. Each is independently idempotent, so a replay redoes
       * neither.
       */
      const counted = await countDiscountUse(db, deps, read.order.id);
      const details = [redeemed, counted].filter((d): d is string => d !== null);
      return details.length === 0
        ? { kind: 'applied' }
        : { kind: 'applied', detail: details.join('; ') };
    }

    case 'payment.failed': {
      const parsed = parsePaymentFailed(row.payload);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const read = await readOrderByCheckout(db, parsed.value.checkoutId);
      if (!read) return awaitingCheckout(parsed.value.checkoutId);
      /*
       * `order.cancelled` carries the lines, which is how the reservations get
       * released (brief §4). Releasing them from here would be a call into Cart, and
       * contract §2 R4 makes cross-subsystem causation an event.
       */
      await cancelOrder(
        db,
        read.order.id,
        {
          reason: 'payment_failed',
          actorId: null,
          link: accessLink(read, deps, now),
          intentId: parsed.value.intentId,
          templates: deps.templates ?? BUILT_IN,
        },
        now,
        { eventId: row.id },
      );
      /* The order never shipped and never will; the points it was frozen with go
       * back. Unconditional — see `refundPoints`. */
      const released = await refundPoints(
        db,
        deps.redemption,
        read.order.id,
        read.order.orderNumber,
        'payment_failed',
      );
      return released === null ? { kind: 'applied' } : { kind: 'applied', detail: released };
    }

    case 'payment.refunded': {
      const parsed = parsePaymentRefunded(row.payload);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const read = await readOrderByCheckout(db, parsed.value.checkoutId);
      if (!read) return awaitingCheckout(parsed.value.checkoutId);
      await refundOrder(
        db,
        read.order.id,
        {
          refundedAmount: parsed.value.refundedAmount,
          refundedTotal: parsed.value.refundedTotal,
          link: accessLink(read, deps, now),
          eventId: row.id,
          intentId: parsed.value.intentId,
          templates: deps.templates ?? BUILT_IN,
        },
        now,
        { eventId: row.id },
      );
      /*
       * RELEASED ON ANY REFUND, INCLUDING A PARTIAL ONE, and that is a choice
       * rather than an oversight. `release()` gives back what was debited, in
       * full — the ledger has no notion of a fraction of a redemption and
       * inventing one here would be a second place for the number to be wrong.
       * Returning the customer's points to them when the shop has kept some of
       * the money is the direction to round in; the alternative keeps both.
       */
      const returned = await refundPoints(
        db,
        deps.redemption,
        read.order.id,
        read.order.orderNumber,
        'payment_refunded',
      );
      return returned === null ? { kind: 'applied' } : { kind: 'applied', detail: returned };
    }

    /*
     * task-d4. A refund the provider ACCEPTED (a synchronous `succeeded`, or
     * its ordinary `pending`) later FAILED TO SETTLE — `payment.refunded`'s
     * sibling failure, emitted by the same `applyRefundEvent`
     * (`server/shop/payments/refunds.ts`).
     *
     * NO STATUS TRANSITION, ON PURPOSE, UNLIKE EVERY OTHER `payment.*` CASE
     * ABOVE. `payment.failed` cancels; `payment.captured` pays;
     * `payment.refunded` moves the order toward `refunded`. This one does
     * not touch `shop_orders.status` at all — see `recordRefundFailure`'s own
     * comment in `./orders` for why: the order may already be `cancelled`
     * (`b9051ab` refunds a paid order before cancelling it), and un-cancelling
     * would be a second, messier failure — reservations already released,
     * goods possibly gone. The recovery is human, so this makes the failure
     * VISIBLE at both ends: a timeline entry an operator sees on the order,
     * and — since the follow-up to task-d4 — an email to the customer whose
     * money did not come back. `link`/`templates` are threaded exactly as
     * `payment.failed` and `payment.refunded` above thread them, because the
     * message carries the same guest link and honours the same operator edits
     * every other order email does.
     */
    case 'payment.refund_failed': {
      const parsed = parsePaymentRefundFailed(row.payload);
      if (!parsed.ok) return parkOnBadPayload(parsed);
      const read = await readOrderByCheckout(db, parsed.value.checkoutId);
      if (!read) return awaitingCheckout(parsed.value.checkoutId);
      const applied = await recordRefundFailure(
        db,
        read,
        row.id,
        {
          failedAmount: parsed.value.failedAmount,
          link: accessLink(read, deps, now),
          templates: deps.templates ?? BUILT_IN,
        },
        now,
      );
      return applied
        ? { kind: 'applied' }
        : { kind: 'ignored', detail: 'already consumed' };
    }
  }
}

function ignoreAndLog(row: EventRow, detail: string): Disposition {
  // eslint-disable-next-line no-console -- §6 rule 4 says ignore AND LOG
  console.info(
    `[shop/orders/consumer] ignoring event`,
    JSON.stringify({ eventId: row.id, type: row.type, detail }),
  );
  return { kind: 'ignored', detail };
}

// -------------------------------------------------------------------- record

/**
 * Write down what happened to a row that was NOT applied.
 *
 * An `applied` disposition needs nothing here: its consumption row and its
 * `processed_at` were written inside the same statement as the state change, which is
 * the only arrangement in which the two cannot disagree.
 */
async function record(db: Db, row: EventRow, disposition: Disposition, now: number): Promise<void> {
  if (disposition.kind === 'applied') {
    /*
     * AN APPLIED DISPOSITION USUALLY CARRIES NO DETAIL, and there is nothing to
     * write: the consumption row was inserted by the repo function in the SAME
     * statement as the state change, which is what makes the outcome impossible
     * to lose or double-count.
     *
     * IT CARRIES ONE WHEN THE STATE CHANGE SUCCEEDED AND SOMETHING BESIDE IT DID
     * NOT — today that means SpoolPoints (admin#2): the order is paid, and the
     * discount it was frozen with could not be funded. The row is already there,
     * so this patches its `detail` rather than inserting; without this the
     * `anomaly:` string is computed, returned, and silently discarded, which is
     * the same as not recording it at all.
     *
     * `processed_at` IS DELIBERATELY NOT TOUCHED and `last_error` is left alone:
     * the event WAS applied, and writing an error against it would put a
     * successful capture into every query an operator runs for failures.
     */
    if (disposition.detail === undefined) return;
    await db.execute(sql`
      UPDATE shop_order_event_consumptions
         SET detail = ${disposition.detail}
       WHERE consumer = ${CONSUMER} AND event_id = ${row.id}`);
    return;
  }

  if (disposition.kind === 'ignored') {
    await db.execute(sql`
      WITH claim AS (
        INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
        VALUES (${CONSUMER}, ${row.id}, ${now}, 'ignored', ${disposition.detail})
        ON CONFLICT DO NOTHING
        RETURNING event_id
      )
      UPDATE commerce_events
         SET processed_at = ${now}, last_error = ${disposition.detail}
       WHERE id = ${row.id}`);
    return;
  }

  /*
   * PARKED: `processed_at` STAYS NULL and no consumption row is written, which is
   * contract §6 rule 3 exactly — mark `lastError`, do not delete, do not retry in a
   * tight loop. The retry is the NEXT sweep, not a loop here.
   */
  const attempts = row.attempts + 1;
  await db.execute(sql`
    UPDATE commerce_events
       SET attempts = ${attempts}, last_error = ${disposition.detail}
     WHERE id = ${row.id}`);

  if (attempts >= PARK_ATTEMPT_LIMIT) {
    await db.execute(sql`
      INSERT INTO shop_order_event_consumptions (consumer, event_id, handled_at, outcome, detail)
      VALUES (${CONSUMER}, ${row.id}, ${now}, 'abandoned',
              ${`${disposition.detail} (abandoned after ${attempts} attempts)`})
      ON CONFLICT DO NOTHING`);
  }
}

// --------------------------------------------------------------------- sweep

export interface EventSweepSummary {
  applied: number;
  ignored: number;
  parked: number;
  /** Every disposition, in the order they were decided. For tests and for a log. */
  dispositions: { eventId: string; type: string; disposition: Disposition }[];
}

/**
 * Drain what this consumer has not yet handled, oldest first.
 *
 * ONE PASS, NOT A LOOP UNTIL EMPTY. A sweep that kept going until the candidate set
 * was empty would never terminate while a parked event remained parked — it would
 * re-select the same row forever inside a single invocation. Bounded work per
 * invocation, invoked again by whatever schedules it, is the shape that cannot hang.
 *
 * OLDEST FIRST because it is the ordering most likely to make a parked event
 * unnecessary: `checkout.completed` genuinely did happen before `payment.captured`,
 * so processing by `occurred_at` resolves the ordinary out-of-order case within a
 * single sweep rather than needing a second one.
 */
export async function sweepCommerceEvents(
  db: Db,
  deps: ConsumerDeps,
  now: number,
  limit: number = EVENT_SWEEP_LIMIT,
): Promise<EventSweepSummary> {
  const res = await db.execute(sql`
    SELECT e.id, e.type, e.subject_id, e.payload, e.occurred_at, e.attempts
      FROM commerce_events e
     WHERE NOT EXISTS (
             SELECT 1 FROM shop_order_event_consumptions c
              WHERE c.consumer = ${CONSUMER} AND c.event_id = e.id)
     ORDER BY e.occurred_at ASC, e.id ASC
     LIMIT ${limit}`);

  const summary: EventSweepSummary = {
    applied: 0,
    ignored: 0,
    parked: 0,
    dispositions: [],
  };

  for (const raw of res.rows) {
    const row: EventRow = {
      id: String(raw.id),
      type: String(raw.type),
      subjectId: String(raw.subject_id),
      payload: raw.payload,
      occurredAt: toEpochMs(raw.occurred_at),
      attempts: Number(raw.attempts),
    };
    const disposition = await handleEvent(db, row, deps, now);
    await record(db, row, disposition, now);
    summary[disposition.kind] += 1;
    summary.dispositions.push({ eventId: row.id, type: row.type, disposition });
  }

  return summary;
}

/**
 * Sweep repeatedly until no further progress is possible, or the budget runs
 * out (admin#29).
 *
 * ═══ WHY A LOOP AT ALL ═══
 * `sweepCommerceEvents` is deliberately ONE PASS, and its own doc comment says
 * why a loop-until-empty inside it could never terminate: a parked row stays in
 * the candidate set forever, so "until the candidate set is empty" is not a
 * condition that arrives. But a single fixed pass is not a backstop either —
 * measured on Cart's identical problem, a batch of 50 against a day of 120
 * captures leaves 70 behind and falls further behind every day. A daily cron
 * that drains a fixed slice does not catch up.
 *
 * ═══ THE TERMINATION CONDITION IS PROGRESS, NOT EMPTINESS ═══
 * A pass that `applied` or `ignored` nothing changed nothing, so the next pass
 * would select the same rows and decide the same way. That is the honest stop:
 * everything left is parked and waiting on something this invocation cannot
 * produce. Bounded additionally by wall clock and by a pass ceiling, because
 * `vercel.json` caps these functions at `maxDuration: 30` and **Vercel does not
 * retry a timed-out cron** — an over-large batch is one that never completes.
 *
 * NO `db.transaction` ANYWHERE BELOW, and none is wanted: every pass is
 * individually idempotent through the `(consumer, event_id)` consumption ledger,
 * so being interrupted between passes costs a delay and nothing else.
 */
export const COMMERCE_SWEEP_BUDGET_MS = 15_000;
export const COMMERCE_SWEEP_MAX_PASSES = 20;

export interface CommerceDrainSummary {
  applied: number;
  ignored: number;
  parked: number;
  passes: number;
}

export async function drainCommerceEvents(
  db: Db,
  deps: ConsumerDeps,
  a: {
    now?: number;
    limit?: number;
    passes?: number;
    budgetMs?: number;
  } = {},
): Promise<CommerceDrainSummary> {
  const started = Date.now();
  const budget = a.budgetMs ?? COMMERCE_SWEEP_BUDGET_MS;
  const ceiling = a.passes ?? COMMERCE_SWEEP_MAX_PASSES;
  const summary: CommerceDrainSummary = { applied: 0, ignored: 0, parked: 0, passes: 0 };

  for (let pass = 0; pass < ceiling; pass += 1) {
    const one = await sweepCommerceEvents(db, deps, a.now ?? Date.now(), a.limit);
    summary.applied += one.applied;
    summary.ignored += one.ignored;
    summary.parked += one.parked;
    summary.passes += 1;

    // No progress: everything left is parked on something this run cannot make
    // appear. Looping again would re-decide the same rows the same way.
    if (one.applied === 0 && one.ignored === 0) break;
    if (Date.now() - started >= budget) break;
  }

  return summary;
}
