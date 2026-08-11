import { sql } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { newId } from '../ids';
import type { CatalogPort } from '../catalog-port';

/**
 * Stock reservations, the expiry policy, and the sweeper (brief §4).
 *
 * ═══ THE SPLIT ═══
 * Catalog owns the COUNT. Cart owns the CLOCK. Catalog records a hold against a
 * reservation id and never expires it; this module decides when a hold has
 * outlived its checkout and tells Catalog to give it back.
 *
 * ═══ THE RACE, AND THE ONE MECHANISM THAT SETTLES IT ═══
 * A sweeper releasing a hold at the instant a capture commits it must not
 * decrement the count twice. Both sides do the SAME thing:
 *
 *     UPDATE shop_reservations SET state = <next> WHERE id = … AND state = 'held'
 *     RETURNING …
 *
 * and each calls into `CatalogPort` **only for the rows it actually
 * transitioned**. Exactly one of them can transition a given row, so exactly one
 * of them calls Catalog. Whichever loses sees zero rows and does nothing — it is
 * not an error, and `commitReservation` returns `false` rather than throwing,
 * because losing this race is an ordinary outcome that the caller has to be able
 * to tell apart from a failure.
 *
 * `repo.test.ts` runs both orderings, runs the interleaving with a transaction
 * held open, and — the load-bearing part — rewrites `state = 'held'` to `true`
 * on its way to the driver and watches the double decrement appear. GAUNTLET II
 * Part 2b is why: neutralising the real CAS predicates broke none of 254 tests,
 * because every precondition case was satisfied by a JavaScript check on a stale
 * read.
 *
 * ═══ NO BACKGROUND TIMER ═══
 * Brief §4: sweep lazily on read plus on a cron route, the same shape the image
 * orphan sweep uses. A tight retry loop froze a tab in GAUNTLET I Round 1 #2; a
 * tight sweep loop on a serverless platform does the same thing to a bill.
 */

export type ReservationState = 'held' | 'released' | 'committed' | 'expired';

export interface Reservation {
  id: string;
  cartId: string;
  variantId: string;
  qty: number;
  createdAt: number;
  expiresAt: number;
  state: ReservationState;
}

/**
 * Fifteen minutes.
 *
 * THE REASONING, next to the number as brief §4 requires. It is bounded from
 * below by how long a real person takes to type a card number with a phone in
 * the other hand — a hold that dies mid-payment is a customer who is charged for
 * stock somebody else now owns — and from above by how long a shop is willing to
 * make a popular item unbuyable for somebody who has not paid. Fifteen minutes
 * is roughly three times the observed p95 of a card checkout and short enough
 * that a Friday-night rush recovers within one page refresh.
 *
 * It is deliberately NOT reserved at add-to-cart. Reserving on add lets one
 * person with an open tab hold the last unit for a week; the alternative, a short
 * TTL on add, empties a shopper's basket while they read. Add-to-cart checks
 * availability and SAYS so; checkout holds.
 */
export const RESERVATION_TTL_MS = 15 * 60_000;

/**
 * The single extension, granted when payment starts.
 *
 * One, and only one — enforced without an extra column, from the row's own
 * arithmetic: a hold that has never been extended has
 * `expires_at - created_at === RESERVATION_TTL_MS`, and one that has is strictly
 * greater. Unbounded extension is the failure this bound exists for: a client
 * re-calling payment-start every fourteen minutes would hold the last unit of a
 * popular variant indefinitely, for free, with nothing in the system saying
 * anything was wrong.
 */
export const RESERVATION_EXTENSION_MS = 15 * 60_000;

/** How many expired holds one sweep will take. Bounded so a lazy sweep on a
 * read path cannot become an unbounded statement on a busy shop. */
export const SWEEP_BATCH = 200;

const COLUMNS = 'id, cart_id, variant_id, qty, created_at, expires_at, state';

function rowToReservation(row: Record<string, unknown>): Reservation {
  return {
    id: String(row.id),
    cartId: String(row.cart_id),
    variantId: String(row.variant_id),
    qty: Number(row.qty),
    createdAt: toEpochMs(row.created_at),
    expiresAt: toEpochMs(row.expires_at),
    state: String(row.state) as ReservationState,
  };
}

export async function listReservations(db: Db, cartId: string): Promise<Reservation[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(COLUMNS)} FROM shop_reservations
     WHERE cart_id = ${cartId} ORDER BY created_at, id`);
  return res.rows.map(rowToReservation);
}

export async function heldReservations(db: Db, cartId: string): Promise<Reservation[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(COLUMNS)} FROM shop_reservations
     WHERE cart_id = ${cartId} AND state = 'held' ORDER BY created_at, id`);
  return res.rows.map(rowToReservation);
}

// ------------------------------------------------------------------ taking

export interface ReserveLine {
  variantId: string;
  qty: number;
}

/** A line that could not be satisfied, AND THE NUMBER THAT SAYS WHY. */
export interface Shortfall {
  variantId: string;
  requested: number;
  /** How many there actually are. `0` for a variant that no longer exists. */
  available: number;
}

export type ReserveOutcome =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; reason: 'insufficient'; shortfalls: Shortfall[] };

/**
 * Hold every line of a cart, or hold none of them.
 *
 * ═══ ROW FIRST, THEN CATALOG. ONLY ONE ORDER IS SAFE. ═══
 *
 * Row first: if the Catalog call then fails, there is a `held` row whose hold may
 * or may not exist, and the sweeper releases it within the TTL. `release` is
 * idempotent, so releasing a hold that was never taken is a no-op.
 *
 * Catalog first: if the row write then fails, stock is held under an id nothing
 * records. Nothing will ever release it. That unit is unbuyable until a human
 * notices the count is wrong. `repo.test.ts` executes the failing-Catalog case
 * and asserts the row survives to be swept.
 *
 * ═══ ALL-OR-NOTHING, WITH COMPENSATION ═══
 * A checkout that reserved two of one variant and then failed on another must
 * not leave two units held for fifteen minutes for a checkout that never
 * happened. Every shortfall is collected first — a customer told which ONE line
 * failed, then told about the next on the retry, gives up — and then everything
 * taken is released.
 *
 * ═══ IDEMPOTENT PER CART ═══
 * Re-starting a checkout reuses a matching hold rather than stacking a second
 * one, and it does NOT refresh the expiry: only `extendReservations` moves the
 * clock, once, at payment start. Otherwise re-calling start would be an
 * unbounded extension with extra steps.
 */
export async function reserveForCheckout(
  db: Db,
  catalog: CatalogPort,
  a: { cartId: string; lines: readonly ReserveLine[]; ttlMs?: number },
): Promise<ReserveOutcome> {
  // ONE CLOCK READING for the whole checkout. Two reads in a loop give holds
  // that expire at different instants, so a sweep can release half a checkout
  // and leave the rest — a cart that is partly reserved with nothing saying so.
  const now = Date.now();
  const expiresAt = now + (a.ttlMs ?? RESERVATION_TTL_MS);

  const existing = await heldReservations(db, a.cartId);
  const wanted = new Map(a.lines.map((line) => [line.variantId, line.qty]));

  // Anything held that the cart no longer asks for, at the quantity it no longer
  // asks for, goes back before anything new is taken — so a shopper reducing a
  // quantity frees the difference for somebody else immediately.
  const reusable = new Map<string, Reservation>();
  for (const held of existing) {
    if (wanted.get(held.variantId) === held.qty) reusable.set(held.variantId, held);
    else await releaseReservation(db, catalog, held.id);
  }

  const taken: Reservation[] = [];
  const shortfalls: Shortfall[] = [];

  for (const line of a.lines) {
    const reuse = reusable.get(line.variantId);
    const id = reuse?.id ?? newId('reservation');

    if (!reuse) {
      await db.execute(sql`
        INSERT INTO shop_reservations
          (id, cart_id, variant_id, qty, created_at, expires_at, state)
        VALUES (${id}, ${a.cartId}, ${line.variantId}, ${line.qty}, ${now},
                ${expiresAt}, 'held')`);
    }

    const result = await catalog.reserve(db, {
      reservationId: id,
      variantId: line.variantId,
      qty: line.qty,
      expiresAt: reuse?.expiresAt ?? expiresAt,
    });

    if (!result.ok) {
      // The row exists and the hold does not. Mark it released so the sweeper
      // has nothing to do, and record the NUMBER the customer needs.
      await db.execute(sql`
        UPDATE shop_reservations SET state = 'released'
         WHERE id = ${id} AND state = 'held'`);
      shortfalls.push({
        variantId: line.variantId,
        requested: line.qty,
        available: result.available,
      });
      continue;
    }

    taken.push({
      id,
      cartId: a.cartId,
      variantId: line.variantId,
      qty: line.qty,
      createdAt: reuse?.createdAt ?? now,
      expiresAt: reuse?.expiresAt ?? expiresAt,
      state: 'held',
    });
  }

  if (shortfalls.length > 0) {
    for (const reservation of taken) await releaseReservation(db, catalog, reservation.id);
    return { ok: false, reason: 'insufficient', shortfalls };
  }

  return { ok: true, reservations: taken };
}

// ------------------------------------------------------------- transitions

/**
 * The shared shape of every settle: transition under a guard, and call Catalog
 * only for a row this call actually moved.
 *
 * ON A FAILED CATALOG CALL THE ROW IS PUT BACK. Without that, a transition that
 * succeeded followed by a Catalog call that did not would leave a row in its new
 * state and a hold that nothing will ever release — the leak this whole ordering
 * exists to prevent, reintroduced at the last step. The rollback is itself
 * guarded, so it cannot disturb a row something else has since moved, and
 * re-doing the Catalog call on the next attempt is safe because every
 * `CatalogPort` method is idempotent by reservation id.
 */
async function settle(
  db: Db,
  reservationId: string,
  to: 'released' | 'committed' | 'expired',
  call: (row: Reservation) => Promise<void>,
): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE shop_reservations SET state = ${to}
     WHERE id = ${reservationId} AND state = 'held'
    RETURNING ${sql.raw(COLUMNS)}`);

  // `rows.length`, never `affectedRows` — measured to be 0 even on a winning
  // conditional update (see `server/db/client.ts`). Zero rows means somebody
  // else transitioned it first, and this call must do NOTHING.
  if (res.rows.length === 0) return false;

  try {
    await call(rowToReservation(res.rows[0]));
  } catch (err) {
    await db
      .execute(sql`
        UPDATE shop_reservations SET state = 'held'
         WHERE id = ${reservationId} AND state = ${to}`)
      .catch(() => undefined);
    throw err;
  }
  return true;
}

/**
 * Give a hold back. `true` when this call is the one that did it.
 *
 * Idempotent, and safe after expiry: a second call, or a call against a hold the
 * sweeper already took, transitions nothing and returns `false`.
 */
export function releaseReservation(
  db: Db,
  catalog: CatalogPort,
  reservationId: string,
): Promise<boolean> {
  return settle(db, reservationId, 'released', (row) => catalog.release(db, row.id));
}

/**
 * Turn a hold into a permanent decrement. `true` when this call is the one that
 * did it, `false` when it lost to the sweeper.
 *
 * `false` AND NOT A THROW. Losing this race is an ordinary outcome and the
 * caller must be able to tell it apart from a failure: a capture that finds its
 * hold already released has to refund rather than ship, and an exception would
 * put that decision in a `catch` beside "the database is down".
 *
 * WHO CALLS THIS IS UNRESOLVED IN THE CONTRACT — see AMENDMENTS A-007. §5 says
 * `commitReservation` is "called on payment capture", but Payments must not call
 * it (§2 R4: causation is an event, not a call) and Orders must not either
 * (`shop_reservations` is Cart's table under R3). Cart is the only subsystem
 * that can, and Cart is named as a consumer of nothing.
 */
export function commitReservation(
  db: Db,
  catalog: CatalogPort,
  reservationId: string,
): Promise<boolean> {
  return settle(db, reservationId, 'committed', (row) =>
    catalog.commitReservation(db, row.id),
  );
}

/** Every hold for a cart, committed. Returns how many this call transitioned. */
export async function commitReservationsForCart(
  db: Db,
  catalog: CatalogPort,
  cartId: string,
): Promise<number> {
  const held = await heldReservations(db, cartId);
  let committed = 0;
  for (const reservation of held) {
    if (await commitReservation(db, catalog, reservation.id)) committed += 1;
  }
  return committed;
}

/** Every hold for a cart, released. Used when a checkout is abandoned. */
export async function releaseReservationsForCart(
  db: Db,
  catalog: CatalogPort,
  cartId: string,
): Promise<number> {
  const held = await heldReservations(db, cartId);
  let released = 0;
  for (const reservation of held) {
    if (await releaseReservation(db, catalog, reservation.id)) released += 1;
  }
  return released;
}

// ----------------------------------------------------------------- sweeping

export interface SweepOutcome {
  /** Holds this sweep transitioned AND handed back to Catalog. */
  released: number;
  /**
   * Holds this sweep transitioned but could not hand back, and which it
   * therefore put back to `held` for the next sweep to retry.
   *
   * Reported rather than swallowed: a non-zero value here means stock is being
   * held for checkouts that are over, and it is the only signal that says so.
   */
  failed: number;
}

/**
 * Expire holds whose time is up, releasing each exactly once.
 *
 * ONE STATEMENT SELECTS THE WINNERS. Every row this returns is a row this call
 * transitioned out of `held`, so no other sweeper, capture or release can also
 * be acting on it. Everything after the statement is per-row and idempotent.
 *
 * BOUNDED, because this runs on a read path as well as on the cron route. An
 * unbounded `UPDATE` over every expired hold in the table is a statement whose
 * cost is set by how long the cron has been broken, paid by whichever shopper
 * happens to load a cart next.
 */
export async function sweepExpiredReservations(
  db: Db,
  catalog: CatalogPort,
  a: { limit?: number; now?: number } = {},
): Promise<SweepOutcome> {
  const now = a.now ?? Date.now();
  const res = await db.execute(sql`
    UPDATE shop_reservations SET state = 'expired'
     WHERE id IN (
       SELECT id FROM shop_reservations
        WHERE state = 'held' AND expires_at <= ${now}
        ORDER BY expires_at
        LIMIT ${a.limit ?? SWEEP_BATCH}
     )
    RETURNING ${sql.raw(COLUMNS)}`);

  let released = 0;
  let failed = 0;
  for (const row of res.rows) {
    const reservation = rowToReservation(row);
    try {
      await catalog.release(db, reservation.id);
      released += 1;
    } catch {
      /*
       * Put it back so the next sweep retries. Marked `held` again rather than
       * left `expired`, because an `expired` row is one nothing will ever look
       * at again — and the hold behind it would be leaked permanently. Guarded
       * on `state = 'expired'` so it cannot disturb a row something else has
       * moved in the meantime.
       */
      await db
        .execute(sql`
          UPDATE shop_reservations SET state = 'held'
           WHERE id = ${reservation.id} AND state = 'expired'`)
        .catch(() => undefined);
      failed += 1;
    }
  }
  return { released, failed };
}

/**
 * Push a cart's holds out by one extension, at payment start. Returns how many
 * moved.
 *
 * THE "ONCE" IS ENFORCED WITHOUT A COLUMN. A hold that has never been extended
 * satisfies `expires_at - created_at = RESERVATION_TTL_MS`; one that has is
 * strictly greater. Deriving it from the two timestamps the row already carries
 * means there is no `extended_at` to forget to set, and no way for the two to
 * disagree.
 *
 * `expires_at > now` keeps it from resurrecting a hold that has already expired
 * — those units may already have been handed to somebody else, and extending one
 * would be selling the same unit twice.
 */
export async function extendReservations(db: Db, cartId: string): Promise<number> {
  const now = Date.now();
  const res = await db.execute(sql`
    UPDATE shop_reservations
       SET expires_at = expires_at + ${RESERVATION_EXTENSION_MS}
     WHERE cart_id = ${cartId}
       AND state = 'held'
       AND expires_at > ${now}
       AND expires_at - created_at <= ${RESERVATION_TTL_MS}
    RETURNING id`);
  return res.rows.length;
}
