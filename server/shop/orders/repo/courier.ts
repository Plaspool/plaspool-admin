import { sql, type SQL } from 'drizzle-orm';
import { DbError } from '../../../db/client';
import type { Db } from '../../../db/client';
import { NotFoundError } from '../../../repo/errors';
import { ID, newId } from '../ids';
import {
  readFulfillment,
  returning,
  rowToFulfillment,
  type CourierProvider,
  type CourierState,
  type Fulfillment,
} from './fulfillments';

/**
 * COURIER WRITES ON A PARCEL — Orders owns shop_fulfillments, so the courier
 * columns migration 0980 added to it are written HERE, by the same rules as
 * every other write in this folder: one guarded statement, the timeline row
 * in the same statement, never a transaction.
 *
 * The guard for booking and drafting is the courier state, not the revision:
 * a parcel may be (re)booked only while nobody else has a live booking on it.
 * Zero rows back means someone got there first, which the route reports as
 * 409 already_booked rather than as a stale write.
 *
 * `revision` moves on every write that changes something a stale reader would
 * care about, because the admin's optimistic reads and the ship/deliver CAS in
 * `fulfillments.ts` are keyed on it — a courier write that left it alone would
 * let a stale ship dialog win a race it should have lost. The one write that
 * deliberately does NOT move it unconditionally is a snapshot replay — see
 * `recordCourierSnapshot`.
 */
export class CourierConflictError extends Error {
  readonly code = 'already_booked' as const;

  /**
   * `already_booked` (the default): this PARCEL already has a live booking.
   * `ref_in_use`: the (provider, provider_ref) pair belongs to ANOTHER parcel —
   * `shop_fulfillments_provider_ref_uq` fired, which means two parcels are
   * racing to claim the same waybill rather than one parcel being rebooked.
   */
  readonly reason: 'already_booked' | 'ref_in_use';

  constructor(id: string, reason: 'already_booked' | 'ref_in_use' = 'already_booked') {
    super(
      reason === 'ref_in_use'
        ? `parcel ${id}: that provider reference is already booked on another parcel`
        : `parcel ${id} already has a courier`,
    );
    this.name = 'CourierConflictError';
    this.reason = reason;
  }
}

const LINES = sql`(SELECT COALESCE(json_agg(json_build_object('id', fl.id, 'order_line_id', fl.order_line_id,
                                                              'qty', fl.qty) ORDER BY fl.id), '[]'::json)
                    FROM shop_fulfillment_lines fl WHERE fl.fulfillment_id = ful.id) AS lines`;

/** courier_state values from which a new draft/booking is allowed. Mirrors canBook() in the UI. */
const REBOOKABLE = sql`(courier_state IS NULL OR courier_state IN ('draft', 'cancelled', 'failed', 'returned'))`;

export async function readFulfillmentByProviderRef(
  db: Db,
  provider: CourierProvider,
  providerRef: string,
): Promise<Fulfillment | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(returning('ful'))}, ${LINES}
      FROM shop_fulfillments ful WHERE ful.provider = ${provider} AND ful.provider_ref = ${providerRef}`);
  const row = res.rows[0];
  return row ? rowToFulfillment(row) : null;
}

/** The partial unique index a booking/draft can collide with — see `guardedUpdate`. */
const PROVIDER_REF_UNIQUE_CONSTRAINT = 'shop_fulfillments_provider_ref_uq';

async function guardedUpdate(
  db: Db,
  id: string,
  set: SQL,
  guard: SQL,
  timeline: SQL | null,
): Promise<Fulfillment | null> {
  const ctes: SQL[] = [
    sql`ful AS (
      UPDATE shop_fulfillments SET ${set}, revision = revision + 1
       WHERE id = ${id} AND ${guard}
      RETURNING ${sql.raw(returning())})`,
  ];
  if (timeline) ctes.push(timeline);
  try {
    const res = await db.execute(sql`WITH ${sql.join(ctes, sql`, `)} SELECT ${sql.raw(returning())}, ${LINES} FROM ful`);
    const row = res.rows[0];
    return row ? rowToFulfillment(row) : null;
  } catch (err) {
    /*
     * A retried booking the courier answered twice, or two admins racing the
     * same waybill, lands here as a raw 23505 — `server/middleware/errors.ts`
     * has no row for it, so left unclassified it would answer
     * `{"error":"internal"}` and be retried five times for a request whose
     * answer can never change. Classified into the same conflict family as
     * the courier_state guard above, but tagged `ref_in_use` so a caller can
     * tell "this parcel is spoken for" apart from "that reference belongs to
     * someone else".
     */
    if (err instanceof DbError && err.constraint === PROVIDER_REF_UNIQUE_CONSTRAINT) {
      throw new CourierConflictError(id, 'ref_in_use');
    }
    throw err;
  }
}

const timelineRow = (type: string, message: string, now: number, actorId: string | null): SQL => sql`timeline AS (
  INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
  SELECT ${newId(ID.timeline)}, ful.order_id, ${type}, ${message}, ${now}, ${actorId}::text FROM ful RETURNING 1)`;

/**
 * Classify a CAS that matched nothing: the parcel is either gone or already
 * spoken for. Read AFTER the write, never before — a pre-check decides against
 * a snapshot the concurrent booking has already invalidated, which is the whole
 * argument `fulfillments.ts` makes about over-fulfilment.
 */
async function conflictOrMissing(db: Db, id: string): Promise<never> {
  const read = await readFulfillment(db, id);
  if (!read) throw new NotFoundError(id);
  throw new CourierConflictError(id);
}

export async function recordCourierDraft(
  db: Db,
  id: string,
  a: { provider: CourierProvider; providerRef: string; now: number },
): Promise<Fulfillment> {
  const row = await guardedUpdate(
    db,
    id,
    sql`provider = ${a.provider}, provider_ref = ${a.providerRef}, courier_state = 'draft', provider_status = NULL,
        tracking_url = NULL, label_url = NULL, provider_cost_minor = NULL, provider_last_error = NULL, provider_synced_at = ${a.now}`,
    sql`status = 'pending' AND ${REBOOKABLE}`,
    null,
  );
  return row ?? conflictOrMissing(db, id);
}

export async function recordCourierBooking(
  db: Db,
  id: string,
  a: {
    provider: CourierProvider;
    providerRef: string;
    carrier: string;
    trackingNumber: string;
    trackingUrl: string | null;
    labelUrl: string | null;
    costMinor: number | null;
    rawStatus: string;
    state: CourierState;
    now: number;
    actorId: string | null;
    message: string;
  },
): Promise<Fulfillment> {
  const row = await guardedUpdate(
    db,
    id,
    sql`provider = ${a.provider}, provider_ref = ${a.providerRef}, carrier = ${a.carrier}, tracking_number = ${a.trackingNumber},
        tracking_url = ${a.trackingUrl}::text, label_url = ${a.labelUrl}::text, provider_cost_minor = ${a.costMinor}::bigint,
        provider_status = ${a.rawStatus}, courier_state = ${a.state}, provider_synced_at = ${a.now}, provider_last_error = NULL`,
    sql`status = 'pending' AND ${REBOOKABLE}`,
    timelineRow('courier_booked', a.message, a.now, a.actorId),
  );
  return row ?? conflictOrMissing(db, id);
}

/**
 * Apply what the courier says now. The timeline row is written ONLY when the
 * raw status actually changed, so a replayed webhook or an idle poll adds
 * nothing. Links are COALESCEd: a courier that stops sending a URL it once sent
 * does not erase it.
 *
 * `revision` moves under the SAME condition as the timeline row — an idle poll
 * or a redelivered webhook that reports the status we already have must not
 * bump it, or it would invalidate a concurrently open admin view (and the
 * ship/deliver CAS in `fulfillments.ts`) for a change that never happened.
 *
 * ── TWO UPDATES, AND THAT IS THE WHOLE POINT ──────────────────────────────
 *
 * "Did this change anything" is decided by the UPDATE's own WHERE, never by a
 * value read beside it. The obvious shape — a `prev` CTE reading
 * `provider_status`, then one UPDATE that compares against it — is wrong under
 * concurrency, and wrong in exactly the case this subsystem lives in: the
 * sweep and a webhook applying the SAME status at the same moment.
 *
 * Every sub-statement in one statement shares one snapshot, so a `prev` read is
 * a value from before either writer started. Under READ COMMITTED an UPDATE
 * that meets a row another transaction has just committed does NOT use that
 * snapshot: it blocks on the row lock and then re-evaluates its WHERE against
 * the NEWEST row version (EvalPlanQual). So the comparison in a WHERE is
 * re-judged against what is actually there, while a comparison against `prev`
 * is not — and both writers would read the old status, both would answer
 * `changed = true`, and the parcel would grow two identical `courier_update`
 * rows on its timeline for one thing that happened once.
 *
 * Hence: one UPDATE whose WHERE carries the "is this new?" test, and a second
 * that does the rest of the work when it was not. The two are mutually
 * exclusive by `NOT EXISTS (SELECT 1 FROM changed)` — which also orders them,
 * since a data-modifying CTE another CTE reads runs to completion first —
 * because Postgres will not update one row twice in one statement.
 *
 * The second UPDATE deliberately does NOT re-test `provider_status`. Testing it
 * would leave the raced case matching neither branch (the first is refused by
 * the newest version, the second by the snapshot's), and a parcel that plainly
 * exists would come back as a 404.
 *
 * NO REBOOKABLE GUARD, deliberately — a snapshot is the courier telling us what
 * happened, not us asking for something. The only condition is that a booking
 * exists to be updated, so a parcel shipped by hand cannot be moved by a
 * webhook that guessed its id.
 */
export async function recordCourierSnapshot(
  db: Db,
  id: string,
  a: {
    rawStatus: string;
    state: CourierState;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    labelUrl?: string | null;
    carrier?: string | null;
    now: number;
    message: string;
  },
): Promise<{ fulfillment: Fulfillment; changed: boolean }> {
  const links = sql`
        tracking_number = COALESCE(${a.trackingNumber ?? null}::text, f.tracking_number),
        tracking_url = COALESCE(${a.trackingUrl ?? null}::text, f.tracking_url),
        label_url = COALESCE(${a.labelUrl ?? null}::text, f.label_url),
        carrier = COALESCE(${a.carrier ?? null}::text, f.carrier)`;
  const res = await db.execute(sql`
    WITH changed AS (
      UPDATE shop_fulfillments f SET
        provider_status = ${a.rawStatus}, courier_state = ${a.state}, provider_synced_at = ${a.now}, provider_last_error = NULL,
        ${links}, revision = f.revision + 1
       WHERE f.id = ${id} AND f.provider_ref IS NOT NULL
         AND f.provider_status IS DISTINCT FROM ${a.rawStatus}::text
      RETURNING ${sql.raw(returning('f'))}),
    same AS (
      UPDATE shop_fulfillments f SET
        courier_state = ${a.state}, provider_synced_at = ${a.now}, provider_last_error = NULL,
        ${links}
       WHERE f.id = ${id} AND f.provider_ref IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM changed)
      RETURNING ${sql.raw(returning('f'))}),
    timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, changed.order_id, 'courier_update', ${a.message}, ${a.now}, NULL::text
        FROM changed RETURNING 1)
    SELECT ${sql.raw(returning('ful'))}, true AS changed, ${LINES} FROM changed ful
    UNION ALL
    SELECT ${sql.raw(returning('ful'))}, false AS changed, ${LINES} FROM same ful`);
  const row = res.rows[0];
  /* Neither branch matched, which is only ever "no such parcel" or "that parcel
     has no courier on it" — the two WHEREs differ solely in the status test,
     and the second has none. */
  if (!row) throw new NotFoundError(id);
  return { fulfillment: rowToFulfillment(row), changed: row.changed === true };
}

/**
 * Call off a courier that is not coming, and take back every promise made in
 * its name.
 *
 * CLEARS `carrier`, `tracking_number`, `tracking_url` AND `label_url` —
 * everything a later ship-by-hand would otherwise mail to the customer
 * unchanged, quoting a courier that will never show up. `provider` and
 * `provider_ref` are the two columns this does NOT touch: a webhook already in
 * flight when the operator cancelled must still be able to find this parcel by
 * them.
 *
 * GUARDED BY `status = 'pending' AND provider_ref IS NOT NULL`, not just the
 * second half: there is no courier to call off before one was ever booked, and
 * a parcel that has already shipped has a shipment email out the door quoting
 * whatever it quoted — cancelling the courier after the fact would make the
 * row disagree with what the customer was told. Zero rows back is a
 * `CourierConflictError` when the parcel exists in either of those states, and
 * a `NotFoundError` only when it does not exist at all.
 */
export async function recordCourierCancelled(
  db: Db,
  id: string,
  a: { now: number; actorId: string | null; message: string },
): Promise<Fulfillment> {
  const row = await guardedUpdate(
    db,
    id,
    sql`carrier = NULL, tracking_number = NULL, tracking_url = NULL, label_url = NULL,
        courier_state = 'cancelled',
        -- provider_status is the courier's own last raw word, never ours: an
        -- admin cancel is OUR decision, not something the courier said, so
        -- this clears to NULL rather than writing a made-up 'Cancelled'. A
        -- fabricated value here would read as "already the newest status" to
        -- recordCourierSnapshot's IS DISTINCT FROM guard the day the courier
        -- genuinely sends Cancelled for this parcel, and that real webhook
        -- would silently miss the timeline. NULL can never equal a courier's
        -- raw string, so a real one always still lands.
        provider_status = NULL, provider_synced_at = ${a.now}, provider_last_error = NULL`,
    sql`status = 'pending' AND provider_ref IS NOT NULL`,
    timelineRow('courier_cancelled', a.message, a.now, a.actorId),
  );
  return row ?? conflictOrMissing(db, id);
}

export async function recordCourierSyncError(
  db: Db,
  id: string,
  a: { now: number; message: string },
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_fulfillments
       SET provider_last_error = left(${a.message}::text, 500), provider_synced_at = ${a.now}, revision = revision + 1
     WHERE id = ${id}`);
}

/** Parcels with a live courier booking whose story is not over, oldest sync first. */
export async function listCourierParcelsToSync(db: Db, limit: number): Promise<Fulfillment[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(returning('ful'))}, ${LINES}
      FROM shop_fulfillments ful
     WHERE ful.provider_ref IS NOT NULL AND ful.status IN ('pending', 'shipped')
       AND ful.courier_state NOT IN ('draft', 'delivered', 'returned', 'cancelled', 'failed')
     ORDER BY ful.provider_synced_at ASC NULLS FIRST, ful.id ASC
     LIMIT ${limit}`);
  return res.rows.map(rowToFulfillment);
}
