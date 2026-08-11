import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { commitReservationsForCart, sweepExpiredReservations } from '../reservations/repo';
import type { SweepOutcome } from '../reservations/repo';
import { isConsumed, parsePaymentCaptured } from './inbound';
import type { CatalogPort } from '../catalog-port';

/**
 * Cart's half of the outbox: it consumes `payment.captured` and commits the
 * stock the checkout is holding.
 *
 * ═══ THE GAP THIS FILLS ═══
 * Contract §5 says `commitReservation` is "called on payment capture" and names
 * no caller (amendment A-007). Payments must not call it — §2 R4 makes
 * cross-subsystem causation an event, not a call — and Orders must not either,
 * because `shop_reservations` is Cart's table under R3. Cart is the only
 * subsystem that CAN, so Cart consumes the event.
 *
 * Without this, a checkout is paid for and its holds simply expire: fifteen
 * minutes after the money arrives the sweeper hands the units back and the shop
 * resells what it has already sold. `real-catalog.test.ts` asserted that as a
 * fact before this existed.
 *
 * ═══ IDEMPOTENCY, KEYED ON `(consumer, eventId)` ═══
 * Contract §6 rule 2, as a PRIMARY KEY rather than as a convention. The claim is
 * a conditional upsert whose `RETURNING` decides whether this call handles the
 * event at all, so a redelivery — or a second drain running concurrently — has
 * nothing to act on. No prior read is involved.
 *
 * There is a second, independent guard underneath: `commitReservation` is itself
 * `UPDATE … WHERE state = 'held' RETURNING`, so even a consumption ledger that
 * failed entirely could not produce a double decrement. Belt and braces, and the
 * braces are the ones with the mutation tests.
 *
 * ═══ WHY NOT `commerce_events.processed_at` ═══
 * §6 gives that column one value per ROW while rule 2 keys idempotency on
 * `(consumer, eventId)`. `payment.captured` has TWO consumers — Orders builds
 * the order, Cart commits the stock — so whichever finished first would hide the
 * row from the other. Cart's candidate set is an anti-join against Cart's own
 * ledger and Cart never writes `processed_at`, `attempts` or `last_error` on the
 * shared row. Orders reached the same conclusion independently.
 */

/** The name in the composite key. One day something else will read this table. */
export const CART_CONSUMER = 'cart';

/**
 * How many times a payload Cart cannot read is retried before it is abandoned.
 *
 * Bounded because contract §6 rule 3 says a failed consumer "does not retry in a
 * tight loop", and because GAUNTLET I Round 1 #2 is what an unbounded one costs.
 * Five is enough to survive a deploy window — the realistic cause of a parked
 * capture during a parallel build is that Cart's schema is wrong and the fix is
 * a redeploy — and small enough that a permanently unreadable row stops
 * occupying a slot in every future drain.
 */
export const MAX_EVENT_ATTEMPTS = 5;

/**
 * How many events one drain takes.
 *
 * This runs on a cart read as well as on the cron route, so unbounded its cost
 * would be set by how long the cron had been broken — paid by whichever shopper
 * happened to load a basket next.
 */
export const EVENT_DRAIN_LIMIT = 25;

export type Disposition =
  | { kind: 'applied'; detail: string | null }
  | { kind: 'ignored'; detail: string | null }
  | { kind: 'parked'; detail: string };

export interface DrainSummary {
  /** Events this drain claimed. Zero means the outbox held nothing for Cart. */
  scanned: number;
  applied: number;
  ignored: number;
  /** Could not be read; still candidates. */
  parked: number;
  /**
   * Gave up on this run. **A non-zero value needs a human**: an abandoned
   * capture is stock held for a sale that already happened, and nothing else in
   * the system will say so.
   */
  abandoned: number;
}

interface EventRow {
  id: string;
  type: string;
  subjectId: string;
  payload: unknown;
  occurredAt: number;
}

/**
 * Decide what to do with one event. **Never throws for an unknown type.**
 *
 * Contract §6 rule 4: "A consumer receiving an unknown `type` ignores it and
 * logs; it does not throw. That is what lets subsystem 3 ship an event type
 * before subsystem 4 knows about it — which is the entire point of building
 * these in parallel."
 */
export async function handleEvent(
  db: Db,
  catalog: CatalogPort,
  row: EventRow,
): Promise<Disposition> {
  if (!isConsumed(row.type)) return { kind: 'ignored', detail: row.type };

  const parsed = parsePaymentCaptured(row.payload);
  /*
   * PARKED, NOT IGNORED. `ignored` is a decision that the event does not matter;
   * this is "cannot read it yet", and during a parallel build the likely cause
   * is Cart's own schema being wrong. The row has to still be there after the
   * redeploy that fixes it.
   */
  if (!parsed.ok) return { kind: 'parked', detail: parsed.detail };

  const committed = await commitReservationsForCart(db, catalog, parsed.value.checkoutId);

  /*
   * ZERO IS `ignored`, NOT A FAILURE. It is the ordinary outcome of a redelivery
   * whose holds are already committed, of a checkout that never reserved
   * anything, and of a capture that lost to the expiry sweeper. Only the last of
   * those is a problem, and it is a problem for a human looking at the
   * reservation row — not something another attempt would fix.
   */
  return committed > 0
    ? { kind: 'applied', detail: `committed ${committed}` }
    : { kind: 'ignored', detail: 'no held reservations' };
}

/**
 * Claim an event for this consumer, or find that somebody already handled it.
 *
 * ONE STATEMENT, and the `RETURNING` is the decision. `ON CONFLICT … DO UPDATE
 * … WHERE` re-claims only a row that is `parked` and has attempts left, so an
 * `applied`, `ignored` or `abandoned` event returns nothing and is skipped. Not
 * `db.transaction`: the Neon HTTP driver throws unconditionally on
 * `transaction()` while PGlite supports it, so a transaction here would pass
 * every test in this repository and 500 in production (spec §4.3a).
 *
 * The claim is written as `parked` rather than as an in-flight marker on
 * purpose: if the process dies between the claim and the outcome, the row is
 * left in the state that means "retry me", not one that means "somebody is
 * working on it" — which nothing would ever clear.
 */
async function claim(db: Db, eventId: string, now: number): Promise<number | null> {
  const res = await db.execute(sql`
    INSERT INTO shop_cart_event_consumptions
      (consumer, event_id, handled_at, outcome, attempts, detail)
    VALUES (${CART_CONSUMER}, ${eventId}, ${now}, 'parked', 1, NULL)
    ON CONFLICT (consumer, event_id) DO UPDATE
       SET attempts = shop_cart_event_consumptions.attempts + 1,
           handled_at = ${now}
     WHERE shop_cart_event_consumptions.outcome = 'parked'
       AND shop_cart_event_consumptions.attempts < ${MAX_EVENT_ATTEMPTS}
    RETURNING attempts`);
  // `rows.length`, never `affectedRows` — measured to be 0 even on a winning
  // conditional write (see `server/db/client.ts`).
  return res.rows.length === 0 ? null : Number(res.rows[0].attempts);
}

async function record(
  db: Db,
  eventId: string,
  outcome: 'applied' | 'ignored' | 'parked' | 'abandoned',
  detail: string | null,
  now: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_cart_event_consumptions
       SET outcome = ${outcome}, detail = ${detail}, handled_at = ${now}
     WHERE consumer = ${CART_CONSUMER} AND event_id = ${eventId}`);
}

/**
 * Drain the outbox for Cart. Bounded, oldest first, and safe to call
 * concurrently with itself and with Orders' drain.
 *
 * THE CANDIDATE SET IS AN ANTI-JOIN. Events with no consumption row of Cart's,
 * plus parked ones with attempts left. Never `processed_at IS NULL` — see the
 * note at the top of this file.
 */
export async function drainCommerceEvents(
  db: Db,
  catalog: CatalogPort,
  a: { limit?: number; now?: number } = {},
): Promise<DrainSummary> {
  const now = a.now ?? Date.now();
  const res = await db.execute(sql`
    SELECT e.id, e.type, e.subject_id, e.payload, e.occurred_at
      FROM commerce_events e
      LEFT JOIN shop_cart_event_consumptions c
             ON c.consumer = ${CART_CONSUMER} AND c.event_id = e.id
     WHERE c.event_id IS NULL
        OR (c.outcome = 'parked' AND c.attempts < ${MAX_EVENT_ATTEMPTS})
     ORDER BY e.occurred_at ASC, e.id ASC
     LIMIT ${a.limit ?? EVENT_DRAIN_LIMIT}`);

  const summary: DrainSummary = {
    scanned: 0,
    applied: 0,
    ignored: 0,
    parked: 0,
    abandoned: 0,
  };

  for (const raw of res.rows) {
    const row: EventRow = {
      id: String(raw.id),
      type: String(raw.type),
      subjectId: String(raw.subject_id),
      payload: raw.payload,
      occurredAt: toEpochMs(raw.occurred_at),
    };

    const attempts = await claim(db, row.id, now);
    // Somebody else claimed it between the SELECT and here, or it is already
    // settled. Not an error and not this call's business.
    if (attempts === null) continue;
    summary.scanned += 1;

    let disposition: Disposition;
    try {
      disposition = await handleEvent(db, catalog, row);
    } catch (err) {
      /*
       * A THROW IS PARKED, not abandoned on the spot. The realistic cause is
       * Catalog being briefly unreachable, which the next drain fixes. The
       * message is deliberately NOT stored: it can carry query parameters, and
       * `guardDb` exists because a driver error's own text has held an account
       * email and a live password hash.
       */
      disposition = { kind: 'parked', detail: err instanceof Error ? err.name : 'error' };
    }

    if (disposition.kind === 'parked' && attempts >= MAX_EVENT_ATTEMPTS) {
      await record(db, row.id, 'abandoned', disposition.detail, now);
      summary.abandoned += 1;
      continue;
    }
    await record(db, row.id, disposition.kind, disposition.detail, now);
    summary[disposition.kind] += 1;
  }

  return summary;
}

export interface MaintenanceSummary {
  drain: DrainSummary;
  sweep: SweepOutcome;
}

/**
 * The two housekeeping jobs, **in this order**.
 *
 * DRAIN BEFORE SWEEP, AND THE ORDER IS THE WHOLE POINT. A capture that arrives
 * after the TTL has elapsed must still sell the stock — the customer has paid.
 * Draining first means those holds are `committed` by the time the sweeper looks
 * and its `WHERE state = 'held'` finds nothing; the other way round, the sweeper
 * releases units that have been bought and the capture then finds nothing to
 * commit. `consumer.test.ts` runs both.
 *
 * Called by the admin cron route and lazily on a cart read (brief §4: "Sweep
 * lazily on read plus on a cron route… Do not build a background timer").
 */
export async function runCartMaintenance(
  db: Db,
  catalog: CatalogPort,
  a: { limit?: number; now?: number } = {},
): Promise<MaintenanceSummary> {
  const drain = await drainCommerceEvents(db, catalog, a);
  const sweep = await sweepExpiredReservations(db, catalog, a);
  return { drain, sweep };
}
