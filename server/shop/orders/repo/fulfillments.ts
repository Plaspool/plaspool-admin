import { sql, type SQL } from 'drizzle-orm';
import { DbError, toEpochMs, toEpochMsOrNull } from '../../../db/client';
import type { Db } from '../../../db/client';
import {
  BadRequestError,
  NotFoundError,
  PreconditionFailedError,
  StaleWriteError,
} from '../../../repo/errors';
import { ID, newId } from '../ids';
import {
  renderDelivered,
  renderReviewInvite,
  renderShipment,
  type AccessLink,
} from '../mailer';
import { BUILT_IN } from '../../../email/system-templates';
import type { TemplateSet } from '../../../email/system-templates';
import {
  LIFECYCLE_ATTEMPTS,
  asErrorSubject,
  readOrder,
  type Order,
  type OrderRead,
} from './orders';

/**
 * Fulfilments (brief §2, §6, §8).
 *
 * TWO INVARIANTS LIVE IN THE DATABASE AND NOT HERE, and this file is written on the
 * assumption that they do:
 *
 *  - **`sum(fulfillment_lines.qty) per order line ≤ line.qty`**, enforced by
 *    `shop_order_lines_fulfilled_ck` over a counter that
 *    `shop_fulfillment_lines_apply` maintains under a row lock. There is
 *    deliberately NO TypeScript pre-check of the remaining quantity: a read-then-
 *    insert is decided against a snapshot a concurrent fulfilment has already
 *    invalidated, which is the entire finding of GAUNTLET II Part 2b, and a JS
 *    check would additionally make the constraint untestable — the suite would pass
 *    whether or not the CHECK existed. `fulfillments.test.ts` drops the constraint
 *    to prove it is the thing refusing.
 *  - **A fulfilment cannot reach across orders**, enforced by the same trigger.
 *    Both foreign keys are satisfied by a line belonging to a different order.
 *
 * A FULFILMENT HAS ITS OWN LIFECYCLE GENERATION, for the reason brief §1 gives: a
 * re-applied `ship` is a double shipment — a second tracking email and a second
 * shipment recorded against the same goods.
 */

export type FulfillmentStatus = 'pending' | 'shipped' | 'delivered' | 'cancelled';

/** Which courier booked a parcel. NULL on the row = shipped by hand. */
export type CourierProvider = 'fez' | 'terminal';

/** Our normalised reading of the courier's last raw status (migration 0960). */
export type CourierState =
  | 'draft' | 'booked' | 'picked_up' | 'in_transit' | 'delivered'
  | 'returned' | 'cancelled' | 'failed' | 'unknown';

export interface FulfillmentLine {
  id: string;
  orderLineId: string;
  qty: number;
}

export interface Fulfillment {
  id: string;
  orderId: string;
  status: FulfillmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  revision: number;
  lines: FulfillmentLine[];
  /* ── courier booking (0960); all NULL for a parcel shipped by hand ── */
  provider: CourierProvider | null;
  providerRef: string | null;
  providerStatus: string | null;
  courierState: CourierState | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  providerCostMinor: number | null;
  providerSyncedAt: number | null;
  providerLastError: string | null;
}

const FULFILLMENT_COLUMNS = [
  'id',
  'order_id',
  'status',
  'carrier',
  'tracking_number',
  'shipped_at',
  'delivered_at',
  'created_at',
  'revision',
  'provider',
  'provider_ref',
  'provider_status',
  'courier_state',
  'tracking_url',
  'label_url',
  'provider_cost_minor',
  'provider_synced_at',
  'provider_last_error',
];

/** `SELECT`/`RETURNING` list, optionally alias-qualified. Shared with repo/courier.ts. */
export const returning = (alias?: string) =>
  FULFILLMENT_COLUMNS.map((c) => (alias ? `${alias}.${c}` : c)).join(', ');

const text = (v: unknown): string | null => (v == null ? null : String(v));

export function rowToFulfillment(row: Record<string, unknown>): Fulfillment {
  const lines = (row.lines as Record<string, unknown>[]) ?? [];
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    status: row.status as FulfillmentStatus,
    carrier: text(row.carrier),
    trackingNumber: text(row.tracking_number),
    shippedAt: toEpochMsOrNull(row.shipped_at),
    deliveredAt: toEpochMsOrNull(row.delivered_at),
    createdAt: toEpochMs(row.created_at),
    revision: Number(row.revision),
    lines: lines.map((line) => ({
      id: String(line.id),
      orderLineId: String(line.order_line_id),
      qty: Number(line.qty),
    })),
    provider: text(row.provider) as CourierProvider | null,
    providerRef: text(row.provider_ref),
    providerStatus: text(row.provider_status),
    courierState: text(row.courier_state) as CourierState | null,
    trackingUrl: text(row.tracking_url),
    labelUrl: text(row.label_url),
    providerCostMinor: row.provider_cost_minor == null ? null : Number(row.provider_cost_minor),
    providerSyncedAt: toEpochMsOrNull(row.provider_synced_at),
    providerLastError: text(row.provider_last_error),
  };
}

const LINE_AGG = sql`
  COALESCE((
    SELECT json_agg(json_build_object('id', fl.id, 'order_line_id', fl.order_line_id,
                                      'qty', fl.qty) ORDER BY fl.id)
      FROM shop_fulfillment_lines fl WHERE fl.fulfillment_id = f.id
  ), '[]'::json) AS lines`;

interface FulfillmentRead {
  fulfillment: Fulfillment;
  generation: number;
}

export async function readFulfillment(db: Db, id: string): Promise<FulfillmentRead | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(returning('f'))}, f.lifecycle_generation, ${LINE_AGG}
      FROM shop_fulfillments f WHERE f.id = ${id}`);
  const row = res.rows[0];
  return row
    ? { fulfillment: rowToFulfillment(row), generation: Number(row.lifecycle_generation) }
    : null;
}

export async function listFulfillments(db: Db, orderId: string): Promise<Fulfillment[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(returning('f'))}, ${LINE_AGG}
      FROM shop_fulfillments f WHERE f.order_id = ${orderId}
     ORDER BY f.created_at ASC, f.id ASC`);
  return res.rows.map(rowToFulfillment);
}

// -------------------------------------------------------------------- create

export interface FulfillmentRequest {
  lines: { orderLineId: string; qty: number }[];
  carrier: string | null;
  trackingNumber: string | null;
}

/**
 * A fulfilment, its lines, and a timeline entry — in one statement, behind a CAS on
 * the ORDER.
 *
 * WHY THE ORDER IS CAS'd AND NOT JUST READ. The obvious shape is
 * `WITH ord AS (SELECT … WHERE status IN ('paid', …))`, and it has a race: under
 * READ COMMITTED the CTE evaluates against this statement's snapshot, so a cancel
 * that commits after the snapshot is invisible and a fulfilment gets created for an
 * order that is already cancelled. Making the order's own row the thing that must
 * match — revision, pinned generation, and status — closes it, because the UPDATE
 * re-evaluates against the committed row and the concurrent cancel has moved both
 * the revision and the generation.
 *
 * It also means creating a fulfilment BUMPS THE ORDER'S REVISION, which is correct:
 * an order's revision should move when something happens to the order. The
 * generation deliberately does NOT move — the trigger watches status and the four
 * timestamps, not `revision` — so a fulfilment being created does not refuse a
 * concurrent refund.
 *
 * `partially_refunded` IS FULFILLABLE and `refunded` is not. A partial refund on an
 * order that has not shipped is a price adjustment; the goods still owe. A full
 * refund means nothing is owed.
 */
export async function createFulfillment(
  db: Db,
  orderId: string,
  req: FulfillmentRequest,
  actorId: string,
  now: number,
): Promise<Fulfillment> {
  if (req.lines.length === 0) throw new BadRequestError('lines');

  let read = await readOrder(db, orderId);
  if (!read) throw new NotFoundError(orderId);
  const pinned = read.generation;
  const derivedFrom = read.order.revision;

  /*
   * EVERY REQUESTED LINE MUST BELONG TO THIS ORDER, decided against the order's own
   * snapshot rather than by trusting the request. This is a 400 rather than a
   * database error because the caller sent a line id that is not part of the order
   * it named — a malformed request, permanently — and the alternative is SQLSTATE
   * `ORD04` from the cross-order trigger arriving as a 500 the client retries five
   * times. The trigger is still the authority; this only makes the ordinary mistake
   * legible.
   */
  const known = new Set(read.lines.map((line) => line.id));
  for (const line of req.lines) {
    if (!known.has(line.orderLineId)) throw new BadRequestError('lines.orderLineId');
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw new BadRequestError('lines.qty');
  }

  for (let attempt = 0; attempt < LIFECYCLE_ATTEMPTS; attempt += 1) {
    const base = read.order.revision;
    const fulfillmentId = newId(ID.fulfillment);
    const lines = req.lines.map((line) => ({
      id: newId(ID.fulfillmentLine),
      order_line_id: line.orderLineId,
      qty: line.qty,
    }));

    const res = await runOrTranslate(db, orderId, sql`
      WITH ord AS (
        UPDATE shop_orders SET revision = revision + 1
         WHERE id = ${orderId}
           AND revision = ${base}
           AND lifecycle_generation = ${pinned}
           AND status IN ('paid', 'partially_refunded')
        RETURNING id
      ), ful AS (
        INSERT INTO shop_fulfillments (id, order_id, status, carrier, tracking_number,
                                       created_at, revision)
        SELECT ${fulfillmentId}, ord.id, 'pending', ${req.carrier}, ${req.trackingNumber},
               ${now}, 1
          FROM ord
        RETURNING ${sql.raw(returning())}
      ), fl AS (
        INSERT INTO shop_fulfillment_lines (id, fulfillment_id, order_line_id, qty)
        SELECT l.id, ful.id, l.order_line_id, l.qty
          FROM ful, jsonb_to_recordset(${sql`${JSON.stringify(lines)}::jsonb`}) AS l(
                 id text, order_line_id text, qty integer)
        RETURNING id, order_line_id, qty
      ), timeline AS (
        INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
        SELECT ${newId(ID.timeline)}, ful.order_id, 'fulfillment_created',
               'Fulfillment created', ${now}, ${actorId}
          FROM ful
        RETURNING 1
      )
      SELECT ${sql.raw(returning('ful'))},
             (SELECT COALESCE(json_agg(json_build_object('id', x.id,
                                                         'order_line_id', x.order_line_id,
                                                         'qty', x.qty) ORDER BY x.id), '[]'::json)
                FROM fl x) AS lines
        FROM ful`);

    const row = res.rows[0];
    if (row) return rowToFulfillment(row);

    const after = await readOrder(db, orderId);
    if (!after) throw new NotFoundError(orderId);
    if (after.generation === pinned && !fulfillable(after.order)) {
      throw new PreconditionFailedError('fulfill', asErrorSubject(after.order));
    }
    read = after;
  }

  throw new StaleWriteError(derivedFrom, read.order.revision, null);
}

/** The JS mirror of the SQL guard, used ONLY to classify a CAS that matched nothing. */
const fulfillable = (order: Order) =>
  order.status === 'paid' || order.status === 'partially_refunded';

/** The CHECK that bounds `sum(fulfilled qty)` by the line's own `qty`. */
export const OVER_FULFILMENT_CONSTRAINT = 'shop_order_lines_fulfilled_ck';

/**
 * Run the create statement, turning the over-fulfilment CHECK into a domain error.
 *
 * WITHOUT THIS, THE MOST ORDINARY ADMIN MISTAKE IS A 500 THAT GETS RETRIED FIVE TIMES.
 * "Ship 3 of an order line for 2" is a typo an operator makes daily. `guardDb` scrubs the
 * violation to a `DbError`, `server/middleware/errors.ts` has no row for it, so it answers
 * `{"error":"internal"}` — and spec §8's client retries a 5xx five times over ~30 seconds
 * for a request whose answer will never change. Contract §10 states the rule directly: a
 * permanent failure returned as a 500 is a request retried forever that can never succeed.
 *
 * `PreconditionFailedError` (409) AND NOT `BadRequestError` (400), because the request is
 * well-formed and the refusal is about STATE: the same body would have succeeded before
 * the earlier fulfilment existed, and the client's correct response is to re-read the
 * remaining quantities rather than to fix its own input. The client's retry policy stops
 * on both, so nothing is retried either way.
 *
 * The translation is here and not in the trigger because the CHECK is what must stay
 * authoritative — `fulfillments.test.ts` drops it and watches the bound disappear.
 */
async function runOrTranslate(
  db: Db,
  orderId: string,
  statement: SQL,
): Promise<{ rows: Record<string, unknown>[] }> {
  try {
    return await db.execute(statement);
  } catch (err: unknown) {
    if (err instanceof DbError && err.constraint === OVER_FULFILMENT_CONSTRAINT) {
      const order = await readOrder(db, orderId);
      throw new PreconditionFailedError('fulfill', asErrorSubject(order?.order ?? { id: orderId }));
    }
    throw err;
  }
}

// ---------------------------------------------------------------- transitions

interface FulfillmentTransition {
  name: string;
  holds(fulfillment: Fulfillment): boolean;
  guard: SQL;
  set(now: number): SQL;
  timeline: { type: 'shipped' | 'delivered' | 'fulfillment_cancelled'; message: string };
  /**
   * SHIPMENT AND DELIVERY BOTH MAIL A CUSTOMER — `kind` is what tells them apart
   * in `shop_order_email_intents`, and it is required rather than defaulted
   * because a message filed under the wrong kind is invisible to the dedupe key
   * that is supposed to stop it sending twice.
   *
   * Cancelling a fulfilment still mails NOTHING, and that is deliberate: a
   * cancelled parcel is an internal re-plan (the stock is released and the lines
   * become fulfillable again), not a fact about the customer's order. If it is
   * the whole order being cancelled, `orders.ts`'s CANCEL sends that message.
   */
  /**
   * ONE TRANSITION MAY OWE MORE THAN ONE MESSAGE. DELIVER owes two — the
   * delivery notice, which is per PARCEL, and the review invitation, which is
   * per ORDER — and they differ in more than wording: their dedupe keys have
   * different shapes, so a three-parcel order sends three notices and one
   * invitation. Expressing that as two entries in one array keeps both inside
   * the SAME statement as the state change, which is the property this whole
   * file exists to preserve.
   */
  mail?(
    order: OrderRead,
    fulfillment: Fulfillment,
    link: AccessLink | null,
    templates: TemplateSet,
  ): TransitionMail | TransitionMail[];
}

interface TransitionMail {
  kind: 'shipment' | 'delivered' | 'review_invite';
  dedupeKey: string;
  to: string;
  subject: string;
  body: string;
  html?: string | null;
}

/**
 * The same read → PIN → CAS shape `orders.ts` uses, over `shop_fulfillments`.
 *
 * DELIBERATELY NOT SHARED WITH THE ORDER VERSION. The two differ in what they emit,
 * what they mail, whether they claim an outbox event, and what they return, and a
 * generic transition covering both would take five flags to express those
 * differences — at which point the shared code is harder to read than either
 * concrete version and neither is checkable by eye. What matters is that the
 * PROPERTY is the same, and that is pinned by tests on both.
 */
async function fulfillmentTransition(
  db: Db,
  fulfillmentId: string,
  t: FulfillmentTransition,
  now: number,
  link: AccessLink | null,
  actorId: string | null,
  templates: TemplateSet = BUILT_IN,
): Promise<Fulfillment> {
  let read = await readFulfillment(db, fulfillmentId);
  if (!read) throw new NotFoundError(fulfillmentId);

  const pinned = read.generation;
  const derivedFrom = read.fulfillment.revision;
  const order = await readOrder(db, read.fulfillment.orderId);
  if (!order) throw new NotFoundError(read.fulfillment.orderId);

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const base = read.fulfillment.revision;
    const owed = t.mail?.(order, read.fulfillment, link, templates);
    const mails = owed === undefined ? [] : Array.isArray(owed) ? owed : [owed];

    const ctes: SQL[] = [
      sql`ful AS (
        UPDATE shop_fulfillments
           SET ${t.set(now)}, revision = revision + 1
         WHERE id = ${fulfillmentId}
           AND revision = ${base}
           AND lifecycle_generation = ${pinned}
           AND ${t.guard}
        RETURNING ${sql.raw(returning())}
      )`,
      sql`timeline AS (
        INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
        SELECT ${newId(ID.timeline)}, ful.order_id, ${t.timeline.type},
               ${t.timeline.message}, ${now}, ${actorId}
          FROM ful
        RETURNING 1
      )`,
    ];

    /* One CTE per owed message, each with its own alias — two CTEs cannot share
       a name, and `ON CONFLICT DO NOTHING` keeps a redelivery from sending
       either of them twice. */
    mails.forEach((mail, i) => {
      ctes.push(sql`${sql.raw(`mail${i}`)} AS (
        INSERT INTO shop_order_email_intents (id, order_id, kind, to_email, subject, body,
                                              html, created_at, dedupe_key)
        SELECT ${newId(ID.emailIntent)}, ful.order_id, ${mail.kind}, ${mail.to},
               ${mail.subject}, ${mail.body}, ${mail.html ?? null}::text,
               ${now}, ${mail.dedupeKey}
          FROM ful
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING 1
      )`);
    });

    const res = await db.execute(sql`
      WITH ${sql.join(ctes, sql`, `)}
      SELECT ${sql.raw(returning())},
             (SELECT COALESCE(json_agg(json_build_object('id', fl.id,
                                                        'order_line_id', fl.order_line_id,
                                                        'qty', fl.qty) ORDER BY fl.id), '[]'::json)
                FROM shop_fulfillment_lines fl WHERE fl.fulfillment_id = ful.id) AS lines
        FROM ful`);

    const row = res.rows[0];
    if (row) return rowToFulfillment(row);

    const after = await readFulfillment(db, fulfillmentId);
    if (!after) throw new NotFoundError(fulfillmentId);
    if (after.generation === pinned && !t.holds(after.fulfillment)) {
      throw new PreconditionFailedError(t.name, asErrorSubject(after.fulfillment));
    }
    read = after;
  }

  throw new StaleWriteError(derivedFrom, read.fulfillment.revision, null);
}

/**
 * Carrier and tracking details, with three-valued semantics per field:
 * `undefined` keeps what the row holds, an explicit `null` clears it, a string
 * replaces it. The distinction is load-bearing — a ship dialog that did not
 * touch the carrier must not blank a carrier typed at parcel creation.
 */
export interface FulfillmentDetails {
  carrier?: string | null;
  trackingNumber?: string | null;
}

/** The stored row with any ship-time details applied over it — what the row
 *  WILL hold once the transition lands, used to render the mail from the same
 *  values the UPDATE writes. */
function withDetails(fulfillment: Fulfillment, details?: FulfillmentDetails): Fulfillment {
  return {
    ...fulfillment,
    carrier: details?.carrier === undefined ? fulfillment.carrier : details.carrier,
    trackingNumber:
      details?.trackingNumber === undefined
        ? fulfillment.trackingNumber
        : details.trackingNumber,
  };
}

/**
 * A FACTORY, NOT A CONSTANT, because ship is now the one transition that may
 * carry data: the operator confirms carrier/tracking in the ship dialog, and
 * the shipment email renders whatever the row holds AT SHIP TIME. Both halves
 * of that promise live here:
 *
 *  - the SET writes the details IN THE SAME UPDATE as the status change, so
 *    there is no ordering in which the transition lands and the details do not;
 *  - the mail renders from `withDetails(...)` — the values the UPDATE is about
 *    to write — because the intent CTE binds the message rendered in JS, and
 *    rendering from the pre-transition row would email the OLD tracking number
 *    beside a row holding the new one.
 */
function shipTransition(details?: FulfillmentDetails): FulfillmentTransition {
  return {
    name: 'ship',
    holds: (f) => f.status === 'pending',
    guard: sql`status = 'pending'`,
    set: (now) => {
      const sets = [sql`status = 'shipped'`, sql`shipped_at = ${now}`];
      if (details?.carrier !== undefined) sets.push(sql`carrier = ${details.carrier}`);
      if (details?.trackingNumber !== undefined) {
        sets.push(sql`tracking_number = ${details.trackingNumber}`);
      }
      return sql.join(sets, sql`, `);
    },
    timeline: { type: 'shipped', message: 'Shipped' },
    mail: (order, fulfillment, link, templates) => {
      const shipping = withDetails(fulfillment, details);
      return {
        kind: 'shipment',
        /* One shipment mail PER FULFILMENT — a three-parcel order sends three. */
        dedupeKey: `shipment:${fulfillment.id}`,
        ...renderShipment(
          {
            orderNumber: order.order.orderNumber,
            email: order.order.email,
            currency: order.order.currency,
            grandTotal: order.order.grandTotal,
            placedAt: order.order.placedAt,
            /* Only the lines THIS parcel contains — see `parcelLines`. */
            lines: parcelLines(order, fulfillment),
            carrier: shipping.carrier,
            trackingNumber: shipping.trackingNumber,
          },
          link,
          templates,
        ),
      };
    },
  };
}

const DELIVER: FulfillmentTransition = {
  name: 'deliver',
  holds: (f) => f.status === 'shipped',
  guard: sql`status = 'shipped'`,
  set: (now) => sql`status = 'delivered', delivered_at = ${now}`,
  timeline: { type: 'delivered', message: 'Delivered' },
  /*
   * THE END OF THE TIMELINE, AND UNTIL MIGRATION 0320 IT SENT NOTHING. The last
   * thing a customer heard was "on its way", which makes a parcel that arrived
   * and a parcel lost in transit identical from their inbox — and it is the
   * moment a shop most wants to be in front of somebody, because it is when a
   * problem is still cheap to fix and a review is still worth asking for.
   *
   * PER FULFILMENT, exactly like SHIP: a three-parcel order sends three, each
   * listing only what was in that parcel, and the dedupe key carries the
   * fulfilment id for the same reason.
   */
  mail: (order, fulfillment, link, templates) => [
    {
      kind: 'delivered',
      dedupeKey: `delivered:${fulfillment.id}`,
      ...renderDelivered(
        {
          orderNumber: order.order.orderNumber,
          email: order.order.email,
          currency: order.order.currency,
          grandTotal: order.order.grandTotal,
          placedAt: order.order.placedAt,
          lines: parcelLines(order, fulfillment),
        },
        link,
        templates,
      ),
    },
    /*
     * THE REVIEW INVITATION, AND EVERY DIFFERENCE FROM THE NOTICE ABOVE IS
     * DELIBERATE.
     *
     * PER ORDER, NOT PER PARCEL — the dedupe key carries the ORDER id, so a
     * three-parcel order sends three delivery notices and exactly one
     * invitation. Whichever parcel arrives first wins, and the two that follow
     * write nothing because of the unique constraint. A shop that asks three
     * times for one order is a shop people filter.
     *
     * IT LISTS THE WHOLE ORDER, not `parcelLines`. The notice is about a box
     * and must name only what is in that box; the invitation is about the
     * order, and naming a third of it would be strange in the one email that
     * asks the reader to go and look at what they bought.
     */
    {
      kind: 'review_invite',
      dedupeKey: `review_invite:${order.order.id}`,
      ...renderReviewInvite(
        {
          orderNumber: order.order.orderNumber,
          email: order.order.email,
          currency: order.order.currency,
          grandTotal: order.order.grandTotal,
          placedAt: order.order.placedAt,
          lines: order.lines.map((line) => ({
            title: line.title,
            sku: line.sku,
            qty: line.qty,
            lineTotal: line.lineTotal,
            imageId: line.imageId,
          })),
        },
        link,
        templates,
      ),
    },
  ],
};

/**
 * The order lines this parcel actually contains, from the ORDER's own snapshot.
 *
 * Lifted out of SHIP when DELIVER needed the identical thing. A mail listing the
 * whole order would tell a customer their second parcel contains items that are
 * still in the warehouse — and getting that subtly different between the two
 * messages would be worse than either version alone, because the shipment and the
 * delivery notice for the same parcel would disagree.
 */
function parcelLines(
  order: OrderRead,
  fulfillment: Fulfillment,
): { title: string; sku: string; qty: number; lineTotal: number }[] {
  return order.lines
    .filter((line) => fulfillment.lines.some((fl) => fl.orderLineId === line.id))
    .map((line) => {
      const covered = fulfillment.lines.find((fl) => fl.orderLineId === line.id);
      return {
        title: line.title,
        sku: line.sku,
        qty: covered?.qty ?? line.qty,
        lineTotal: line.lineTotal,
        imageId: line.imageId,
      };
    });
}

/**
 * Cancelling releases the quantity, via `shop_fulfillments_release`.
 *
 * A SHIPPED FULFILMENT CAN BE CANCELLED and a DELIVERED ONE CANNOT. A parcel that
 * was lost, recalled or returned to sender is a real and reasonably common event,
 * and the quantity has to come back or those lines could never be fulfilled again.
 * Delivery, by contrast, is the end of the story: unwinding it would be a return,
 * which contract §13 puts explicitly out of scope.
 */
const CANCEL_FULFILLMENT: FulfillmentTransition = {
  name: 'cancel_fulfillment',
  holds: (f) => f.status === 'pending' || f.status === 'shipped',
  guard: sql`status IN ('pending', 'shipped')`,
  set: () => sql`status = 'cancelled'`,
  timeline: { type: 'fulfillment_cancelled', message: 'Fulfillment cancelled' },
};

export const shipFulfillment = (
  db: Db,
  id: string,
  now: number,
  link: AccessLink | null,
  actorId: string | null,
  templates: TemplateSet = BUILT_IN,
  /* Trailing and optional so every existing caller and test compiles unchanged
   * and keeps the stored details — undefined means keep, per FulfillmentDetails. */
  details?: FulfillmentDetails,
): Promise<Fulfillment> =>
  fulfillmentTransition(db, id, shipTransition(details), now, link, actorId, templates);

/**
 * Edit carrier/tracking on a parcel that has NOT shipped, with no transition.
 *
 * `status = 'pending'` IS IN THE WHERE, NOT PRE-CHECKED, and the reason is the
 * whole design of this file: a read-then-update decides against a snapshot a
 * concurrent ship has already invalidated, and editing the tracking number of
 * a parcel whose shipment email JUST went out would silently make the row
 * disagree with what the customer was told. A shipped or delivered parcel's
 * details are frozen — the email is the record — so the refusal is a 409
 * `precondition_failed`, classified exactly the way the transitions classify
 * theirs.
 *
 * NO TIMELINE ENTRY AND NO GENERATION BUMP, both deliberate. The timeline is
 * customer-visible history and a tracking typo fixed before anything shipped is
 * not an event in the order's life (`shop_order_events_type_ck` would also
 * refuse a new type without a migration); and the lifecycle trigger watches
 * status and the two timestamps only, so a details edit does not move the
 * generation — which is precisely what lets it race a concurrent SHIP safely:
 * the ship's CAS still wins or retries on `revision`, which this bumps.
 */
export async function updateFulfillmentDetails(
  db: Db,
  id: string,
  details: FulfillmentDetails,
): Promise<Fulfillment> {
  if (details.carrier === undefined && details.trackingNumber === undefined) {
    throw new BadRequestError('details');
  }

  let read = await readFulfillment(db, id);
  if (!read) throw new NotFoundError(id);
  const pinned = read.generation;
  const derivedFrom = read.fulfillment.revision;

  for (let i = 0; i < LIFECYCLE_ATTEMPTS; i += 1) {
    const base = read.fulfillment.revision;
    const sets: SQL[] = [];
    if (details.carrier !== undefined) sets.push(sql`carrier = ${details.carrier}`);
    if (details.trackingNumber !== undefined) {
      sets.push(sql`tracking_number = ${details.trackingNumber}`);
    }

    const res = await db.execute(sql`
      WITH ful AS (
        UPDATE shop_fulfillments
           SET ${sql.join(sets, sql`, `)}, revision = revision + 1
         WHERE id = ${id}
           AND revision = ${base}
           AND lifecycle_generation = ${pinned}
           AND status = 'pending'
        RETURNING ${sql.raw(returning())}
      )
      SELECT ${sql.raw(returning())},
             (SELECT COALESCE(json_agg(json_build_object('id', fl.id,
                                                        'order_line_id', fl.order_line_id,
                                                        'qty', fl.qty) ORDER BY fl.id), '[]'::json)
                FROM shop_fulfillment_lines fl WHERE fl.fulfillment_id = ful.id) AS lines
        FROM ful`);

    const row = res.rows[0];
    if (row) return rowToFulfillment(row);

    const after = await readFulfillment(db, id);
    if (!after) throw new NotFoundError(id);
    if (after.generation === pinned && after.fulfillment.status !== 'pending') {
      throw new PreconditionFailedError('edit_tracking', asErrorSubject(after.fulfillment));
    }
    read = after;
  }

  throw new StaleWriteError(derivedFrom, read.fulfillment.revision, null);
}

export const deliverFulfillment = (
  db: Db,
  id: string,
  now: number,
  actorId: string | null,
  /* Both trailing and defaulted, so every existing caller and test compiles
   * unchanged and gets a correct message with no link -- see `markOrderPaid`. */
  link: AccessLink | null = null,
  templates: TemplateSet = BUILT_IN,
): Promise<Fulfillment> =>
  fulfillmentTransition(db, id, DELIVER, now, link, actorId, templates);

export const cancelFulfillment = (
  db: Db,
  id: string,
  now: number,
  actorId: string | null,
): Promise<Fulfillment> => fulfillmentTransition(db, id, CANCEL_FULFILLMENT, now, null, actorId);
