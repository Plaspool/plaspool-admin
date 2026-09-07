import { sql, type SQL } from 'drizzle-orm';
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
 * columns migration 0960 added to it are written HERE, by the same rules as
 * every other write in this folder: one guarded statement, the timeline row
 * in the same statement, never a transaction.
 *
 * The guard for booking and drafting is the courier state, not the revision:
 * a parcel may be (re)booked only while nobody else has a live booking on it.
 * Zero rows back means someone got there first, which the route reports as
 * 409 already_booked rather than as a stale write.
 *
 * `revision` still moves on every write, because the admin's optimistic reads
 * and the ship/deliver CAS in `fulfillments.ts` are keyed on it — a courier
 * write that left it alone would let a stale ship dialog win a race it should
 * have lost.
 */
export class CourierConflictError extends Error {
  readonly code = 'already_booked' as const;

  constructor(id: string) {
    super(`parcel ${id} already has a courier`);
    this.name = 'CourierConflictError';
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
  const res = await db.execute(sql`WITH ${sql.join(ctes, sql`, `)} SELECT ${sql.raw(returning())}, ${LINES} FROM ful`);
  const row = res.rows[0];
  return row ? rowToFulfillment(row) : null;
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
 * raw status actually changed (the CTE reads the previous value), so a replayed
 * webhook or an idle poll adds nothing. Links are COALESCEd: a courier that
 * stops sending a URL it once sent does not erase it.
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
  const res = await db.execute(sql`
    WITH prev AS (SELECT id, provider_status FROM shop_fulfillments WHERE id = ${id}),
    ful AS (
      UPDATE shop_fulfillments f SET
        provider_status = ${a.rawStatus}, courier_state = ${a.state}, provider_synced_at = ${a.now}, provider_last_error = NULL,
        tracking_number = COALESCE(${a.trackingNumber ?? null}::text, f.tracking_number),
        tracking_url = COALESCE(${a.trackingUrl ?? null}::text, f.tracking_url),
        label_url = COALESCE(${a.labelUrl ?? null}::text, f.label_url),
        carrier = COALESCE(${a.carrier ?? null}::text, f.carrier),
        revision = f.revision + 1
       FROM prev WHERE f.id = prev.id AND f.provider_ref IS NOT NULL
      RETURNING ${sql.raw(returning('f'))}, (prev.provider_status IS DISTINCT FROM ${a.rawStatus}::text) AS changed),
    timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, ful.order_id, 'courier_update', ${a.message}, ${a.now}, NULL::text
        FROM ful WHERE ful.changed RETURNING 1)
    SELECT ${sql.raw(returning('ful'))}, ful.changed, ${LINES} FROM ful`);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  return { fulfillment: rowToFulfillment(row), changed: row.changed === true };
}

export async function recordCourierCancelled(
  db: Db,
  id: string,
  a: { now: number; actorId: string | null; message: string },
): Promise<Fulfillment> {
  const row = await guardedUpdate(
    db,
    id,
    sql`courier_state = 'cancelled', provider_status = 'Cancelled', provider_synced_at = ${a.now}, provider_last_error = NULL`,
    sql`provider_ref IS NOT NULL`,
    timelineRow('courier_cancelled', a.message, a.now, a.actorId),
  );
  if (!row) throw new NotFoundError(id);
  return row;
}

export async function recordCourierSyncError(
  db: Db,
  id: string,
  a: { now: number; message: string },
): Promise<void> {
  await db.execute(sql`
    UPDATE shop_fulfillments SET provider_last_error = left(${a.message}::text, 500), provider_synced_at = ${a.now}
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
