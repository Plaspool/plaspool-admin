import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { uniqueViolation } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { rejectNul } from '../../repo/cursor';
import type { AuthUser } from '../../../shared/types';
import type {
  ReservationRequest,
  ReservationResult,
} from '../../../shared/commerce/catalog-port';
import { emitEvent, jsonbObject } from './events';
import { rowToInventoryHold, rowToInventoryLevel } from './mapping';
import type { InventoryHold, InventoryLevel } from './types';

/**
 * Inventory — the part Cart depends on (brief §5).
 *
 * Catalog owns `shop_inventory` and nobody else writes it. Cart reserves through
 * the port; Payments commits through the port; Orders never touches it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE PROPERTIES, AND EVERY ONE OF THEM IS A SINGLE CONDITIONAL STATEMENT
 * RATHER THAN A READ FOLLOWED BY A WRITE.
 *
 * 1. **Insufficient stock is a RETURN VALUE, not an exception** (brief §5). A
 *    shopper taking the last two of an item is the most ordinary event a shop
 *    has. Thrown, it is indistinguishable above from a database being down —
 *    same catch, same 500, same five client retries for a question whose answer
 *    will not change — and the number the customer needs to be told has nowhere
 *    to live.
 *
 * 2. **`reservationId` is the idempotency key, enforced by a UNIQUE ROW.** Not
 *    by a JS check on a prior read: GAUNTLET II Part 2b measured that exact
 *    pattern across six lifecycle transitions and found it made the SQL guards
 *    entirely untested and entirely bypassable, because the check is evaluated
 *    against a snapshot a concurrent request has already invalidated. Here the
 *    primary key of `shop_inventory_holds` IS the check, and the second caller
 *    is told so by the database.
 *
 * 3. **`release` and `commitReservation` are idempotent and safe in EITHER
 *    ORDER after expiry.** Cart's expiry sweeper and Payments' capture will
 *    race; whichever loses must not corrupt the count. Both require `state =
 *    'held'`, so the loser matches zero rows and does nothing at all.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT `available` IS AND IS NOT. `on_hand - reserved`, derived at read, never
 * stored (brief §2) — two columns that must sum to a third are three ways to be
 * inconsistent. It is a number to SHOW a shopper. It is never the number a sale
 * is decided on: that decision is the `WHERE` clause of `reserve`, evaluated by
 * the database against the row as it is at write time.
 */

// -------------------------------------------------------------------- reads

export async function getInventory(db: Db, variantId: string): Promise<InventoryLevel | null> {
  const res = await db.execute(sql`
    SELECT variant_id, on_hand, reserved, backorderable, updated_at
      FROM shop_inventory WHERE variant_id = ${variantId}`);
  const row = res.rows[0];
  return row ? rowToInventoryLevel(row) : null;
}

export async function getHold(db: Db, reservationId: string): Promise<InventoryHold | null> {
  const res = await db.execute(sql`
    SELECT reservation_id, variant_id, qty, state, expires_at, created_at, updated_at
      FROM shop_inventory_holds WHERE reservation_id = ${reservationId}`);
  const row = res.rows[0];
  return row ? rowToInventoryHold(row) : null;
}

// ------------------------------------------------------------------ reserve

/**
 * Hold `qty` of `variantId` until `expiresAt`.
 *
 * THE STATEMENT, AND WHY IT IS ORDERED THIS WAY. The UPDATE runs first and the
 * hold row is inserted `SELECT … FROM upd`, not the other way round. Inserting
 * the hold first and then conditionally updating would leave a hold row recorded
 * for stock that was never held whenever the stock check failed — a phantom
 * reservation that `commitReservation` would later honour by decrementing
 * inventory nobody reserved.
 *
 * This way round, both outcomes are clean:
 *
 * - the stock check fails → `upd` is empty → no hold row, nothing written;
 * - the reservation id already exists → the INSERT raises 23505 → **the whole
 *   statement rolls back, including the UPDATE**, so the retry did not double
 *   the hold. That rollback is the idempotency, and it is a property of the
 *   statement rather than of any code here.
 *
 * `on_hand - reserved` in the RETURNING is the value AFTER the update, because
 * RETURNING sees the new row — so the caller gets availability including its own
 * hold, which is what a cart needs to render "2 left".
 */
export async function reserve(db: Db, req: ReservationRequest): Promise<ReservationResult> {
  /*
   * A malformed quantity is a RETURN VALUE too, not a throw. It arrives from a
   * cart line, which arrives from a request body; a 500 for `qty: 0` would be
   * retried five times by the client's policy for input that can never be
   * accepted. Everything the port can be asked that it cannot do is a
   * `{ ok: false }` with a named reason.
   */
  if (!Number.isInteger(req.qty) || req.qty <= 0) {
    return { ok: false, reason: 'invalid_qty', available: 0 };
  }
  const now = Date.now();

  const rows = await db
    .execute(sql`
      WITH upd AS (
        UPDATE shop_inventory i
           SET reserved = i.reserved + ${req.qty}, updated_at = ${now}
         WHERE i.variant_id = ${req.variantId}
           AND (i.backorderable OR i.on_hand - i.reserved >= ${req.qty})
           /*
            * SELLABILITY IS PART OF THE SAME PREDICATE, not a prior read.
            * A product unpublished, archived or trashed between the quote and
            * the reservation must not have its stock held — and asking that
            * question in TypeScript first would ask it of a row that has already
            * been read, which is exactly the stale-read pattern this file exists
            * to avoid.
            */
           AND EXISTS (
             SELECT 1 FROM shop_variants v
               JOIN shop_products p ON p.id = v.product_id
              WHERE v.id = i.variant_id
                AND v.status = 'active'
                AND p.status = 'active'
                AND p.deleted_at IS NULL
           )
        RETURNING i.variant_id, i.on_hand - i.reserved AS available
      ), hold AS (
        INSERT INTO shop_inventory_holds (reservation_id, variant_id, qty, state,
                                          expires_at, created_at, updated_at)
        SELECT ${req.reservationId}, upd.variant_id, ${req.qty}, 'held',
               ${req.expiresAt}, ${now}, ${now}
          FROM upd
        RETURNING reservation_id
      )
      SELECT upd.available FROM upd`)
    .then((res) => res.rows)
    .catch(async (err: unknown) => {
      /*
       * THE IDEMPOTENT REPLAY. The primary key refused a second hold under the
       * same id, and the rollback means the `reserved` bump that accompanied it
       * is gone too. So the stock is held exactly once — which is success, not
       * failure, and the caller is told which of the two happened via `replayed`
       * so a retry is legible in a log rather than looking like a second sale.
       */
      if (uniqueViolation(err) === 'shop_inventory_holds_pkey') return null;
      throw err;
    });

  if (rows === null) return replay(db, req);
  if (rows.length > 0) {
    return {
      ok: true,
      reservationId: req.reservationId,
      variantId: req.variantId,
      qty: req.qty,
      available: Number(rows[0].available),
      replayed: false,
    };
  }

  /*
   * ZERO ROWS. The predicate matched nothing, and everything below is read
   * AFTER THE FACT purely to classify why — exactly as `transition`'s `holds()`
   * is used. None of it can decide anything and none of it does: the decision
   * has already been made by the database.
   *
   * A REPLAY IS CHECKED HERE TOO, AND THAT IS A BUG FIX RATHER THAN BELT AND
   * BRACES. The 23505 path above only fires when the UPDATE matched — but the
   * UPDATE carries the stock predicate, so a retry of an already-held
   * reservation whose variant has since SOLD OUT never reaches the INSERT at
   * all. Measured: hold 3 of 10, retry the same reservationId, and the caller
   * got `{ ok: false, reason: 'insufficient' }` for a reservation it already
   * holds — an idempotent operation returning failure for work that succeeded,
   * which is precisely how a cart double-books or gives up on stock it owns.
   * The hold row is the authority on "have I already honoured this id", and it
   * is authoritative whatever the stock says now.
   */
  const existing = await getHold(db, req.reservationId);
  if (existing) return replay(db, req);

  return refusal(db, req);
}

/** The hold already existed. Report success, and say it was a replay. */
async function replay(db: Db, req: ReservationRequest): Promise<ReservationResult> {
  const hold = await getHold(db, req.reservationId);
  const level = await getInventory(db, hold?.variantId ?? req.variantId);
  /*
   * `hold.qty`, not `req.qty`. A caller replaying a reservation id with a
   * DIFFERENT quantity has a bug, and answering with the quantity actually held
   * is the only answer that does not lie — the stock behind that id is what the
   * first call reserved, whatever this call asked for.
   */
  return {
    ok: true,
    reservationId: req.reservationId,
    variantId: hold?.variantId ?? req.variantId,
    qty: hold?.qty ?? req.qty,
    available: level?.available ?? 0,
    replayed: true,
  };
}

/** Which half of the predicate said no. Read after the fact, for the message only. */
async function refusal(db: Db, req: ReservationRequest): Promise<ReservationResult> {
  const level = await getInventory(db, req.variantId);
  if (!level) return { ok: false, reason: 'unknown_variant', available: 0 };

  const res = await db.execute(sql`
    SELECT 1 AS ok FROM shop_variants v
      JOIN shop_products p ON p.id = v.product_id
     WHERE v.id = ${req.variantId}
       AND v.status = 'active' AND p.status = 'active' AND p.deleted_at IS NULL`);
  if (res.rows.length === 0) {
    return { ok: false, reason: 'not_sellable', available: level.available };
  }
  return { ok: false, reason: 'insufficient', available: level.available };
}

// ------------------------------------------------------- release and commit

/**
 * Return a hold's units to the pool. Idempotent, and safe after expiry.
 *
 * `state = 'held'` in the predicate is the whole of it. A hold that is already
 * `released` matches nothing (so a repeat is a no-op) and a hold that is
 * `committed` matches nothing either — releasing a committed hold would hand
 * back units that have already been sold and are on their way to a customer.
 *
 * Returns whether it did anything. The `CatalogPort` signature is
 * `Promise<void>`, so the port discards this; the repository exposes it because
 * a sweeper that cannot tell "released 40 stale holds" from "released none" has
 * no way to know it is working. See amendment A-CAT-012 on the port signature.
 */
export async function releaseHold(db: Db, reservationId: string): Promise<boolean> {
  const now = Date.now();
  const res = await db.execute(sql`
    WITH h AS (
      UPDATE shop_inventory_holds
         SET state = 'released', updated_at = ${now}
       WHERE reservation_id = ${reservationId} AND state = 'held'
      RETURNING variant_id, qty
    ), inv AS (
      UPDATE shop_inventory i
         SET reserved = i.reserved - h.qty, updated_at = ${now}
        FROM h WHERE i.variant_id = h.variant_id
      RETURNING i.variant_id
    )
    SELECT variant_id FROM inv`);
  return res.rows.length > 0;
}

/**
 * A hold becomes a permanent decrement. Idempotent, and safe after expiry.
 *
 * `on_hand -= qty` AND `reserved -= qty` together, in one UPDATE, because they
 * are two halves of one fact: the units left the warehouse and are no longer
 * being held for anyone. Doing them in two statements would leave a window in
 * which availability is wrong in whichever direction the first one moved.
 *
 * THE RACE THIS IS BUILT FOR (brief §5). Cart's expiry sweeper calls `release`
 * and Payments' capture calls this, and they will overlap. Both demand `state =
 * 'held'`, so exactly one of them matches — and the loser changes nothing rather
 * than applying a second decrement. Whichever wins, the counts stay consistent:
 * release-then-commit leaves the stock available and unsold; commit-then-release
 * leaves it sold and not handed back.
 */
export async function commitHold(db: Db, reservationId: string): Promise<boolean> {
  const now = Date.now();
  const res = await db.execute(sql`
    WITH h AS (
      UPDATE shop_inventory_holds
         SET state = 'committed', updated_at = ${now}
       WHERE reservation_id = ${reservationId} AND state = 'held'
      RETURNING variant_id, qty
    ), inv AS (
      UPDATE shop_inventory i
         SET on_hand = i.on_hand - h.qty,
             reserved = i.reserved - h.qty,
             updated_at = ${now}
        FROM h WHERE i.variant_id = h.variant_id
      RETURNING i.variant_id
    )
    SELECT variant_id FROM inv`);
  return res.rows.length > 0;
}

// ---------------------------------------------------------------- adjustment

/**
 * An admin moves the count, with a stated reason, and it goes in the outbox.
 *
 * `reason` IS MANDATORY AND IS NOT A FREE PASS FOR AN EMPTY STRING. An
 * unexplained stock change is the thing you will most wish you had logged
 * (brief §6) — the difference between "we wrote off 12 damaged units on Tuesday"
 * and a count that is simply wrong with no record of when it stopped being
 * right.
 *
 * The event is written in the SAME STATEMENT (contract §6 rule 1), so an
 * adjustment that commits without its event, or an event for an adjustment that
 * did not commit, are both unreachable rather than unlikely.
 *
 * NOTE THIS IS THE ONLY INVENTORY OPERATION THAT EMITS. `reserve`, `release` and
 * `commitHold` are the ordinary traffic of selling — one per add-to-cart, one
 * per abandoned-cart sweep, one per capture — and an outbox row per cart
 * interaction is a table nobody can read at 2am to find the event that matters.
 */
export async function adjustInventory(
  db: Db,
  variantId: string,
  delta: number,
  reason: string,
  actor: AuthUser,
): Promise<InventoryLevel> {
  if (!Number.isInteger(delta) || delta === 0) throw new BadRequestError('delta');
  const cleanReason = rejectNul(reason.trim(), 'reason');
  if (!cleanReason) throw new BadRequestError('reason');
  const now = Date.now();

  const row = await db
    .execute(sql`
      WITH upd AS (
        UPDATE shop_inventory
           SET on_hand = on_hand + ${delta}, updated_at = ${now}
         WHERE variant_id = ${variantId}
        RETURNING variant_id, on_hand, reserved, backorderable, updated_at
      ), ev AS (${emitEvent({
        from: sql`upd`,
        type: 'catalog.inventory.adjusted',
        subjectId: sql`upd.variant_id`,
        payload: jsonbObject({
          variantId: sql`upd.variant_id`,
          delta: sql`${delta}::int`,
          onHand: sql`upd.on_hand`,
          reason: sql`${cleanReason}::text`,
          actorId: sql`${actor.id}::text`,
        }),
        occurredAt: now,
      })})
      SELECT * FROM upd`)
    .then((res) => res.rows[0])
    .catch((err: unknown) => {
      /*
       * `shop_inventory_on_hand_ck`. A write-off larger than the stock on hand
       * is a 400 that names the field, not a 500: the request is permanently
       * wrong and a 500 would be retried five times before failing anyway.
       */
      if (String(err).includes('shop_inventory_on_hand_ck')) {
        throw new BadRequestError('delta');
      }
      throw err;
    });

  if (!row) throw new NotFoundError(variantId);
  return rowToInventoryLevel(row);
}
