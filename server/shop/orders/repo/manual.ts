import { sql } from 'drizzle-orm';
import { uniqueViolation } from '../../../db/client';
import type { Db } from '../../../db/client';
import { BadRequestError, NotFoundError, StaleWriteError } from '../../../repo/errors';
import { adjustInventory } from '../../catalog/inventory';
import { SHOP_CURRENCY } from '../../currency';
import { ID, newId } from '../ids';
import { formatOrderNumber } from '../order-number';
import { readOrder } from './orders';
import type { OrderRead } from './orders';
import type { AuthUser } from '../../../../shared/types';

/**
 * MANUAL ORDERS (migration 1110) — a sale made outside the online checkout,
 * recorded by the owner: paid by a Flutterwave link, a bank transfer, cash.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN ORDINARY ROW IN shop_orders, SO IT COUNTS EVERYWHERE ALREADY. Analytics
 * reads `paid_at`; the list, the board and a customer's history read the same
 * table. So a manual order is written COMPLETE: `fulfilled` ("Sent out"), with
 * placed, paid and sent-out all at the date the owner says it was sold.
 *
 * WHAT IT DELIBERATELY SKIPS: no checkout, no payment intent, no email to the
 * customer, no outbox event. `checkout_id` and `source_event_id` are NOT NULL
 * UNIQUE with no foreign key, so each holds `manual:<order id>` — unique, and a
 * value no payment event can ever match.
 *
 * EDITABLE, WITH EVERY SAVE KEPT: each create, edit and void writes a whole
 * snapshot to `shop_order_revisions` in the SAME statement as the change. Lines
 * of a manual order may be replaced (1110 lifts the append-only guard for
 * them); online lines stay immutable.
 *
 * ONE STATEMENT PER WRITE, NEVER `db.transaction` (the Neon HTTP driver throws
 * on it). Stock is the one thing outside the statement: `adjustInventory`
 * writes its own audit trail, so it runs after the order is saved, one line at
 * a time, and a line it cannot move is REPORTED rather than failing the order —
 * the sale happened whether or not the shelf count agreed.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const PAYMENT_METHODS = [
  'flutterwave_link',
  'paystack_link',
  'bank_transfer',
  'cash',
  'pos',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const SALES_CHANNELS = ['walk_in', 'whatsapp', 'instagram', 'phone', 'website', 'other'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export interface ManualOrderInput {
  /** When it was sold, epoch ms. Placed, paid and sent out all read this. */
  soldAt: number;
  lines: Array<{ variantId: string; qty: number; unitAmount?: number }>;
  paymentMethod: PaymentMethod;
  paymentReference: string | null;
  /** Take the items out of stock (and, on an edit, move stock by the difference). */
  takeFromStock: boolean;
  customer: { name: string | null; email: string | null; phone: string | null };
  salesChannel: SalesChannel | null;
  address: { line1: string | null; city: string | null; region: string | null; countryCode: string | null } | null;
  shippingAmount: number;
  discountAmount: number;
  taxAmount: number;
  note: string | null;
}

/** What only the ADMIN sees about a manual order. Never on `Order`, whose fields a customer's view spreads. */
export interface ManualDetails {
  paymentMethod: PaymentMethod | null;
  paymentReference: string | null;
  salesChannel: SalesChannel | null;
  note: string | null;
  stockTaken: boolean;
  customer: { name: string | null; email: string | null; phone: string | null };
}

export interface ResolvedLine {
  variantId: string;
  sku: string;
  title: string;
  optionValues: Record<string, string>;
  qty: number;
  unitAmount: number;
  lineTotal: number;
}

export interface StockOutcome {
  failed: Array<{ variantId: string; sku: string; reason: 'not_enough_stock' | 'no_stock_record' | 'error' }>;
}

export interface ManualWriteResult {
  read: OrderRead;
  stock: StockOutcome;
}

const NUMBER_ATTEMPTS = 3;
const MAX_LINES = 100;

const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

function dayWords(ms: number): string {
  // West Africa Time, as the analytics buckets are.
  return new Date(ms + 3_600_000).toISOString().slice(0, 10);
}

/**
 * Each line's product code, title and options from the catalogue, snapshotted
 * like an online line; the price the owner typed, or the variant's current one.
 *
 * ANY VARIANT OF A PRODUCT THAT IS NOT DELETED, archived and draft included: a
 * sale recorded a week late may be of something since taken off the shelf.
 */
export async function resolveLines(db: Db, lines: ManualOrderInput['lines']): Promise<ResolvedLine[]> {
  if (lines.length === 0) throw new BadRequestError('lines');
  if (lines.length > MAX_LINES) throw new BadRequestError('lines');
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const res = await db.execute(sql`
    SELECT v.id, v.sku, v.option_values, p.title, pr.amount AS price
      FROM shop_variants v
      JOIN shop_products p ON p.id = v.product_id
      LEFT JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
     WHERE v.id = ANY(${sql.param(ids)}::text[])
       AND p.deleted_at IS NULL`);
  const found = new Map(res.rows.map((r) => [String(r.id), r]));
  return lines.map((line, i) => {
    const row = found.get(line.variantId);
    if (!row) throw new BadRequestError(`lines[${i}].variantId`);
    const unitAmount = line.unitAmount ?? (row.price == null ? null : Number(row.price));
    if (unitAmount === null) throw new BadRequestError(`lines[${i}].unitAmount`);
    const lineTotal = unitAmount * line.qty;
    if (!Number.isSafeInteger(lineTotal)) throw new BadRequestError(`lines[${i}].qty`);
    return {
      variantId: line.variantId,
      sku: String(row.sku),
      title: String(row.title),
      optionValues: (row.option_values ?? {}) as Record<string, string>,
      qty: line.qty,
      unitAmount,
      lineTotal,
    };
  });
}

function totalsOf(input: ManualOrderInput, lines: ResolvedLine[]) {
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const grandTotal = subtotal + input.shippingAmount + input.taxAmount - input.discountAmount;
  if (grandTotal < 0) throw new BadRequestError('advanced.discountAmount');
  if (!Number.isSafeInteger(grandTotal)) throw new BadRequestError('lines');
  return { subtotal, grandTotal };
}

/** The address snapshot, in the same keys an online order's uses. Empty keys left out. */
function addressOf(input: ManualOrderInput): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: string | null | undefined) => {
    if (v) out[k] = v;
  };
  put('name', input.customer.name);
  put('phone', input.customer.phone);
  put('line1', input.address?.line1);
  put('city', input.address?.city);
  put('region', input.address?.region);
  put('countryCode', input.address?.countryCode);
  return out;
}

/** Everything a save changed, whole — what the edit history shows and diffs. */
function snapshotOf(input: ManualOrderInput, lines: ResolvedLine[], status: string) {
  const { subtotal, grandTotal } = totalsOf(input, lines);
  return {
    soldAt: input.soldAt,
    lines,
    paymentMethod: input.paymentMethod,
    paymentReference: input.paymentReference,
    salesChannel: input.salesChannel,
    customer: input.customer,
    address: input.address,
    shippingAmount: input.shippingAmount,
    discountAmount: input.discountAmount,
    taxAmount: input.taxAmount,
    subtotal,
    grandTotal,
    note: input.note,
    takeFromStock: input.takeFromStock,
    status,
  };
}

function lineRows(lines: ResolvedLine[], offset: number) {
  return lines.map((line, index) => ({
    id: newId(ID.orderLine),
    line_no: offset + index,
    variant_id: line.variantId,
    sku: line.sku,
    title: line.title,
    option_values: line.optionValues,
    qty: line.qty,
    unit_amount: line.unitAmount,
    line_total: line.lineTotal,
  }));
}

/** An existing shop customer with this email, so the sale joins their history. */
async function customerIdFor(db: Db, email: string | null): Promise<string | null> {
  if (!email) return null;
  const res = await db.execute(sql`
    SELECT id FROM shop_customers WHERE lower(email) = lower(${email}) LIMIT 1`);
  return res.rows[0] ? String(res.rows[0].id) : null;
}

/**
 * Move stock by `delta` per variant, one audited adjustment each. Never
 * throws: a line that cannot move is reported, and the order stands.
 */
async function moveStock(
  db: Db,
  deltas: Map<string, { delta: number; sku: string }>,
  reason: string,
  actor: AuthUser,
): Promise<StockOutcome> {
  const failed: StockOutcome['failed'] = [];
  for (const [variantId, { delta, sku }] of deltas) {
    if (delta === 0) continue;
    try {
      await adjustInventory(db, variantId, delta, reason, actor);
    } catch (err) {
      const reasonCode =
        err instanceof BadRequestError ? 'not_enough_stock' : err instanceof NotFoundError ? 'no_stock_record' : 'error';
      failed.push({ variantId, sku, reason: reasonCode });
    }
  }
  return { failed };
}

function addDelta(
  map: Map<string, { delta: number; sku: string }>,
  variantId: string,
  sku: string,
  delta: number,
) {
  const cur = map.get(variantId);
  map.set(variantId, { delta: (cur?.delta ?? 0) + delta, sku: cur?.sku ?? sku });
}

// ─────────────────────────────────────────────────────────────────── create

export async function createManualOrder(
  db: Db,
  input: ManualOrderInput,
  actor: AuthUser,
  now: number = Date.now(),
): Promise<ManualWriteResult> {
  const lines = await resolveLines(db, input.lines);
  const { subtotal, grandTotal } = totalsOf(input, lines);
  const customerId = await customerIdFor(db, input.customer.email);
  const address = addressOf(input);
  const snapshot = snapshotOf(input, lines, 'fulfilled');
  const year = new Date(input.soldAt).getUTCFullYear();

  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt += 1) {
    const orderId = newId(ID.order);
    const seq = await db.execute(sql`SELECT nextval('shop_order_number_seq') AS n`);
    const orderNumber = formatOrderNumber(year, Number(seq.rows[0].n));
    /*
     * CUSTOMER-SAFE WORDING: a buyer with an account reads this timeline on the
     * storefront. Who recorded it and how it was paid live in the admin-only
     * revision history (and the admin timeline names the actor from actor_id).
     */
    const message = `Order recorded: sold ${dayWords(input.soldAt)}`;
    try {
      /* Bare column names in these SQL comments: a backtick would end the template. */
      await db.execute(sql`
        WITH ord AS (
          INSERT INTO shop_orders (
            id, order_number, customer_id, email, currency,
            subtotal, shipping_total, tax_total, grand_total, add_on_total,
            status, shipping_address, billing_address, placed_at, paid_at, fulfilled_at,
            revision, source_event_id, checkout_id,
            source, payment_method, payment_reference, sales_channel, staff_note, stock_taken)
          VALUES (
            ${orderId}, ${orderNumber}, ${customerId}::text, ${input.customer.email ?? ''}, ${SHOP_CURRENCY},
            ${subtotal}, ${input.shippingAmount}, ${input.taxAmount}, ${grandTotal}, 0,
            'fulfilled', ${jsonb(address)}, ${jsonb(address)},
            ${input.soldAt}, ${input.soldAt}, ${input.soldAt},
            1, ${`manual:${orderId}`}, ${`manual:${orderId}`},
            'manual', ${input.paymentMethod}, ${input.paymentReference}::text, ${input.salesChannel}::text,
            ${input.note}::text, ${input.takeFromStock})
          RETURNING id
        ), ins_lines AS (
          -- Already handed over, so every unit is sent out: fulfilled_qty equals qty.
          INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                        option_values, qty, unit_amount, line_total,
                                        fulfilled_qty, image_id)
          SELECT l.id, ord.id, l.line_no, l.variant_id, l.sku, l.title,
                 l.option_values, l.qty, l.unit_amount, l.line_total, l.qty, v.image_id
            FROM ord, jsonb_to_recordset(${jsonb(lineRows(lines, 0))}) AS l(
                   id text, line_no integer, variant_id text, sku text, title text,
                   option_values jsonb, qty integer, unit_amount integer, line_total integer)
            LEFT JOIN shop_variants v ON v.id = l.variant_id
          RETURNING 1
        ), timeline AS (
          INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
          SELECT ${newId(ID.timeline)}, ord.id, 'placed', ${message}, ${now}, ${actor.id}
            FROM ord
          RETURNING 1
        ), rev AS (
          INSERT INTO shop_order_revisions (id, order_id, revision, kind, snapshot, edited_by, edited_at)
          SELECT ${newId(ID.orderRevision)}, ord.id, 1, 'created', ${jsonb(snapshot)}, ${actor.id}::uuid, ${now}
            FROM ord
          RETURNING 1
        )
        SELECT id FROM ord`);
    } catch (err) {
      if (uniqueViolation(err) === 'shop_orders_order_number_uq') continue;
      throw err;
    }

    const deltas = new Map<string, { delta: number; sku: string }>();
    if (input.takeFromStock) for (const l of lines) addDelta(deltas, l.variantId, l.sku, -l.qty);
    const stock = await moveStock(db, deltas, `Manual order ${orderNumber}`, actor);
    const read = await readOrder(db, orderId);
    if (!read) throw new Error('manual order vanished after insert');
    return { read, stock };
  }
  throw new Error(`could not mint an unused order number in ${NUMBER_ATTEMPTS} attempts`);
}

// ───────────────────────────────────────────────────────────────────── edit

/** Why a CAS on a manual order matched nothing — read AFTER, never used to decide. */
async function refusal(db: Db, orderId: string, baseRevision: number): Promise<never> {
  const read = await readOrder(db, orderId);
  if (!read) throw new NotFoundError(orderId);
  if (read.order.source !== 'manual') throw new BadRequestError('not_manual');
  if (read.order.status === 'cancelled') throw new BadRequestError('voided');
  throw new StaleWriteError(baseRevision, read.order.revision);
}

export async function updateManualOrder(
  db: Db,
  orderId: string,
  input: ManualOrderInput,
  baseRevision: number,
  actor: AuthUser,
  now: number = Date.now(),
): Promise<ManualWriteResult> {
  const before = await readOrder(db, orderId);
  if (!before) throw new NotFoundError(orderId);
  if (before.order.source !== 'manual') throw new BadRequestError('not_manual');
  const wasTaken = (await readManualDetails(db, orderId))?.stockTaken ?? false;

  const lines = await resolveLines(db, input.lines);
  const { subtotal, grandTotal } = totalsOf(input, lines);
  const customerId = await customerIdFor(db, input.customer.email);
  const address = addressOf(input);
  const snapshot = snapshotOf(input, lines, 'fulfilled');

  /*
   * NEW LINES NUMBER ON FROM THE OLD ONES' HIGHEST, so the DELETE and the
   * INSERT below can share one statement without two rows ever holding the
   * same (order_id, line_no). Numbering stays in sale order; gaps are harmless.
   */
  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE shop_orders
         SET customer_id = ${customerId}::text,
             email = ${input.customer.email ?? ''},
             subtotal = ${subtotal}, shipping_total = ${input.shippingAmount},
             tax_total = ${input.taxAmount}, grand_total = ${grandTotal},
             shipping_address = ${jsonb(address)}, billing_address = ${jsonb(address)},
             placed_at = ${input.soldAt}, paid_at = ${input.soldAt}, fulfilled_at = ${input.soldAt},
             payment_method = ${input.paymentMethod},
             payment_reference = ${input.paymentReference}::text,
             sales_channel = ${input.salesChannel}::text,
             staff_note = ${input.note}::text,
             stock_taken = ${input.takeFromStock},
             revision = revision + 1
       WHERE id = ${orderId} AND source = 'manual' AND status <> 'cancelled'
         AND revision = ${baseRevision}
      RETURNING id, revision
    ), offset_no AS (
      SELECT COALESCE(max(line_no) + 1, 0) AS n FROM shop_order_lines WHERE order_id = ${orderId}
    ), gone AS (
      DELETE FROM shop_order_lines WHERE order_id = (SELECT id FROM upd)
      RETURNING variant_id, sku, qty
    ), ins_lines AS (
      INSERT INTO shop_order_lines (id, order_id, line_no, variant_id, sku, title,
                                    option_values, qty, unit_amount, line_total,
                                    fulfilled_qty, image_id)
      SELECT l.id, upd.id, l.line_no + (SELECT n FROM offset_no), l.variant_id, l.sku, l.title,
             l.option_values, l.qty, l.unit_amount, l.line_total, l.qty, v.image_id
        FROM upd, jsonb_to_recordset(${jsonb(lineRows(lines, 0))}) AS l(
               id text, line_no integer, variant_id text, sku text, title text,
               option_values jsonb, qty integer, unit_amount integer, line_total integer)
        LEFT JOIN shop_variants v ON v.id = l.variant_id
      RETURNING 1
    ), timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, upd.id, 'edited', 'Order details updated', ${now}, ${actor.id}
        FROM upd
      RETURNING 1
    ), rev AS (
      INSERT INTO shop_order_revisions (id, order_id, revision, kind, snapshot, edited_by, edited_at)
      SELECT ${newId(ID.orderRevision)}, upd.id, upd.revision, 'edited', ${jsonb(snapshot)}, ${actor.id}::uuid, ${now}
        FROM upd
      RETURNING 1
    )
    SELECT (SELECT revision FROM upd) AS revision,
           (SELECT COALESCE(json_agg(json_build_object('variantId', variant_id, 'sku', sku, 'qty', qty)), '[]'::json)
              FROM gone) AS old_lines`);

  const row = res.rows[0];
  if (!row || row.revision == null) return refusal(db, orderId, baseRevision);

  /*
   * STOCK MOVES BY THE DIFFERENCE. What was taken before goes back, what is
   * taken now comes off — netted per variant, so an unchanged line moves
   * nothing and leaves no audit noise.
   */
  const oldLines = (row.old_lines as Array<{ variantId: string; sku: string; qty: number }>) ?? [];
  const deltas = new Map<string, { delta: number; sku: string }>();
  if (wasTaken) for (const l of oldLines) addDelta(deltas, l.variantId, l.sku, Number(l.qty));
  if (input.takeFromStock) for (const l of lines) addDelta(deltas, l.variantId, l.sku, -l.qty);
  const stock = await moveStock(db, deltas, `Manual order ${before.order.orderNumber} edited`, actor);

  const read = await readOrder(db, orderId);
  if (!read) throw new NotFoundError(orderId);
  return { read, stock };
}

// ───────────────────────────────────────────────────────────────────── void

/**
 * Void a manual order: it stops being a sale. `paid_at` is cleared so no
 * revenue figure counts it, the status is `cancelled`, and any stock it took
 * goes back. The rows stay, and the revision history says who voided it.
 */
export async function voidManualOrder(
  db: Db,
  orderId: string,
  baseRevision: number,
  reason: string | null,
  actor: AuthUser,
  now: number = Date.now(),
): Promise<ManualWriteResult> {
  const before = await readOrder(db, orderId);
  if (!before) throw new NotFoundError(orderId);
  if (before.order.source !== 'manual') throw new BadRequestError('not_manual');
  const details = await readManualDetails(db, orderId);
  const lastSnapshot = (await listOrderRevisions(db, orderId))[0]?.snapshot ?? {};
  const snapshot = { ...(lastSnapshot as Record<string, unknown>), status: 'cancelled', voidReason: reason };
  // The reason is staff text: it goes in the revision snapshot, never the customer-visible timeline.
  const message = 'Order voided';

  const res = await db.execute(sql`
    WITH upd AS (
      UPDATE shop_orders
         SET status = 'cancelled', cancelled_at = ${now}, paid_at = NULL, fulfilled_at = NULL,
             stock_taken = false, revision = revision + 1
       WHERE id = ${orderId} AND source = 'manual' AND status <> 'cancelled'
         AND revision = ${baseRevision}
      RETURNING id, revision
    ), timeline AS (
      INSERT INTO shop_order_events (id, order_id, type, message, occurred_at, actor_id)
      SELECT ${newId(ID.timeline)}, upd.id, 'cancelled', ${message}, ${now}, ${actor.id}
        FROM upd
      RETURNING 1
    ), rev AS (
      INSERT INTO shop_order_revisions (id, order_id, revision, kind, snapshot, edited_by, edited_at)
      SELECT ${newId(ID.orderRevision)}, upd.id, upd.revision, 'voided', ${jsonb(snapshot)}, ${actor.id}::uuid, ${now}
        FROM upd
      RETURNING 1
    )
    SELECT (SELECT revision FROM upd) AS revision`);
  if (res.rows[0]?.revision == null) return refusal(db, orderId, baseRevision);

  const deltas = new Map<string, { delta: number; sku: string }>();
  if (details?.stockTaken) for (const l of before.lines) addDelta(deltas, l.variantId, l.sku, l.qty);
  const stock = await moveStock(db, deltas, `Manual order ${before.order.orderNumber} voided`, actor);
  const read = await readOrder(db, orderId);
  if (!read) throw new NotFoundError(orderId);
  return { read, stock };
}

// ──────────────────────────────────────────────────────────────────── reads

export async function readManualDetails(db: Db, orderId: string): Promise<ManualDetails | null> {
  const res = await db.execute(sql`
    SELECT source, email, payment_method, payment_reference, sales_channel, staff_note,
           stock_taken, shipping_address
      FROM shop_orders WHERE id = ${orderId}`);
  const r = res.rows[0];
  if (!r || r.source !== 'manual') return null;
  const address = (r.shipping_address ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return {
    paymentMethod: (r.payment_method as PaymentMethod | null) ?? null,
    paymentReference: text(r.payment_reference),
    salesChannel: (r.sales_channel as SalesChannel | null) ?? null,
    note: text(r.staff_note),
    stockTaken: r.stock_taken === true,
    customer: { name: text(address.name), email: text(r.email), phone: text(address.phone) },
  };
}

export interface OrderRevision {
  revision: number;
  kind: 'created' | 'edited' | 'voided';
  editedAt: number;
  editedBy: { id: string; name: string } | null;
  snapshot: unknown;
}

/** Every save of an order, newest first, with who made it. */
export async function listOrderRevisions(db: Db, orderId: string): Promise<OrderRevision[]> {
  const res = await db.execute(sql`
    SELECT r.revision, r.kind, r.edited_at, r.snapshot, u.id AS user_id,
           COALESCE(NULLIF(u.display_name, ''), u.email) AS display_name
      FROM shop_order_revisions r
      LEFT JOIN users u ON u.id = r.edited_by
     WHERE r.order_id = ${orderId}
     ORDER BY r.revision DESC`);
  return res.rows.map((r) => ({
    revision: Number(r.revision),
    kind: r.kind as OrderRevision['kind'],
    editedAt: Number(r.edited_at),
    editedBy: r.user_id == null ? null : { id: String(r.user_id), name: String(r.display_name) },
    snapshot: typeof r.snapshot === 'string' ? JSON.parse(r.snapshot) : r.snapshot,
  }));
}
