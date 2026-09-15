import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { DbError } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { ID, newId } from '../orders/ids';
import { readOrder } from '../orders/repo/orders';
import { BoxRefusedError } from './errors';
import type { BoxFill, BoxLine } from './types';

/**
 * Filling mystery boxes by hand (migration 1220, phase 1 "I pack it myself").
 *
 * A LINE IS A BOX WHEN ITS VARIANT'S PRODUCT IS IN BOX MODE — the same test the
 * parcel guard and the capacity SQL use, so the three cannot disagree about
 * what a box is.
 */

export interface SaveBoxFillInput {
  orderId: string;
  orderLineId: string;
  boxNo: number;
  variantIds: string[];
  /** `null` for a first fill; the stored `filledAt` when changing one — the CAS token. */
  expectedFilledAt: number | null;
  actorId: string;
  now: number;
}

const parsed = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

function toFills(fills: Record<string, unknown>[], items: Record<string, unknown>[]): BoxFill[] {
  return fills.map((f) => ({
    id: String(f.id),
    orderLineId: String(f.order_line_id),
    boxNo: Number(f.box_no),
    source: String(f.source) as BoxFill['source'],
    fulfillmentId: f.fulfillment_id == null ? null : String(f.fulfillment_id),
    filledBy: f.filled_by == null ? null : String(f.filled_by),
    filledAt: Number(f.filled_at),
    items: items
      .filter((i) => i.fill_id === f.id)
      .map((i) => ({
        id: String(i.id),
        position: Number(i.position),
        variantId: String(i.variant_id),
        sku: String(i.sku),
        title: String(i.title),
        optionValues: parsed<Record<string, string>>(i.option_values) ?? {},
        imageId: i.image_id == null ? null : String(i.image_id),
        returnedToStockAt: i.returned_to_stock_at == null ? null : Number(i.returned_to_stock_at),
      })),
  }));
}

/** Every filled box on an order, in line then box order, with its items. */
export async function listBoxFills(db: Db, orderId: string): Promise<BoxFill[]> {
  const fills = await db.execute(sql`
    SELECT f.* FROM shop_box_fills f JOIN shop_order_lines ol ON ol.id = f.order_line_id
     WHERE ol.order_id = ${orderId} ORDER BY ol.line_no, f.box_no`);
  if (fills.rows.length === 0) return [];
  const items = await db.execute(sql`
    SELECT * FROM shop_box_fill_items
     WHERE fill_id = ANY(${sql.param(fills.rows.map((r) => String(r.id)))}::text[])
     ORDER BY position`);
  return toFills(fills.rows, items.rows);
}

/** Which lines of this order are boxes, whether or not any box is filled yet. */
export async function boxLinesFor(db: Db, orderId: string): Promise<BoxLine[]> {
  const res = await db.execute(sql`
    SELECT ol.id, v.box_pool_tag, v.box_item_count
      FROM shop_order_lines ol
      JOIN shop_variants v ON v.id = ol.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE ol.order_id = ${orderId} AND p.box_mode IS NOT NULL
     ORDER BY ol.line_no`);
  return res.rows.map((r) => ({
    orderLineId: String(r.id),
    poolTag: r.box_pool_tag == null ? null : String(r.box_pool_tag),
    itemCount: r.box_item_count == null ? null : Number(r.box_item_count),
  }));
}

/**
 * Fill one box, or change what is in it — ONE STATEMENT (CLAUDE.md §3).
 *
 * THE STOCK MOVE IS NETTED PER PRODUCT. Changing gold+gold+red into
 * gold+white+white is gold +1, red +1, white −2, applied as three row updates,
 * because one statement may not update the same inventory row twice.
 *
 * ALL OR NOTHING THROUGH shop_box_abort. A decrement whose guard fails matches
 * no row; the final SELECT compares the rows that moved with the rows that had
 * to move and aborts the statement if they differ, which undoes every CTE in it.
 * The reason comes back as the SQLSTATE (BOX01 short, BOX02 changed), because
 * the driver guard scrubs messages.
 */
export async function saveBoxFill(db: Db, input: SaveBoxFillInput): Promise<BoxFill> {
  const read = await readOrder(db, input.orderId);
  if (!read) throw new NotFoundError(input.orderId);
  if (read.order.status !== 'paid' && read.order.status !== 'partially_refunded') {
    throw new BadRequestError('order_not_fillable');
  }
  const line = read.lines.find((l) => l.id === input.orderLineId);
  if (!line) throw new BadRequestError('orderLineId');
  const boxLine = (await boxLinesFor(db, input.orderId)).find((b) => b.orderLineId === line.id);
  if (!boxLine || boxLine.itemCount === null) throw new BadRequestError('not_a_box');
  if (!Number.isInteger(input.boxNo) || input.boxNo < 1 || input.boxNo > line.qty) {
    throw new BadRequestError('boxNo');
  }
  if (input.variantIds.length !== boxLine.itemCount) throw new BadRequestError('variantIds');

  /* Snapshots for the new items, and a refusal for anything that is not an
     ordinary active variant. A box inside a box is not a thing. Any in-stock
     product may be used, not only the pool: someone at the bench with no PETG
     left must be able to substitute. */
  const unique = [...new Set(input.variantIds)];
  const found = await db.execute(sql`
    SELECT v.id, v.sku, v.option_values, v.image_id, p.title
      FROM shop_variants v JOIN shop_products p ON p.id = v.product_id
     WHERE v.id = ANY(${sql.param(unique)}::text[])
       AND v.status = 'active' AND p.box_mode IS NULL AND p.deleted_at IS NULL`);
  if (found.rows.length !== unique.length) throw new BadRequestError('variantIds');
  const byId = new Map(found.rows.map((r) => [String(r.id), r]));

  const existing = (await listBoxFills(db, input.orderId)).find(
    (f) => f.orderLineId === line.id && f.boxNo === input.boxNo,
  );
  if (existing && input.expectedFilledAt === null) throw new BoxRefusedError('box_changed');

  const delta = new Map<string, number>();
  for (const id of input.variantIds) delta.set(id, (delta.get(id) ?? 0) - 1);
  for (const item of existing?.items ?? []) {
    delta.set(item.variantId, (delta.get(item.variantId) ?? 0) + 1);
  }
  const moves = [...delta]
    .filter(([, d]) => d !== 0)
    .map(([variant_id, d]) => ({ variant_id, delta: d }));

  const items = input.variantIds.map((variantId, position) => {
    const r = byId.get(variantId)!;
    return {
      id: newId(ID.boxFillItem),
      position,
      variant_id: variantId,
      sku: String(r.sku),
      title: String(r.title),
      option_values: parsed<Record<string, string>>(r.option_values) ?? {},
      image_id: r.image_id == null ? null : String(r.image_id),
    };
  });

  /*
   * A FIRST FILL inserts, and ON CONFLICT DO NOTHING turns a concurrent first
   * fill into "no row" — box_changed. A CHANGE updates behind the CAS on
   * filled_at, and only while the box is in no parcel (or only a cancelled one).
   */
  const writeFill = existing
    ? sql`
      fill AS (
        UPDATE shop_box_fills f
           SET filled_at = ${input.now}, filled_by = ${input.actorId}::uuid, source = 'hand'
         WHERE f.id = ${existing.id}
           AND f.filled_at = ${input.expectedFilledAt ?? -1}
           AND (f.fulfillment_id IS NULL OR EXISTS (
                  SELECT 1 FROM shop_fulfillments pf
                   WHERE pf.id = f.fulfillment_id AND pf.status = 'cancelled'))
        RETURNING f.id
      ), old AS (
        DELETE FROM shop_box_fill_items it USING fill WHERE it.fill_id = fill.id RETURNING 1
      ),`
    : sql`
      fill AS (
        INSERT INTO shop_box_fills (id, order_line_id, box_no, source, filled_by, filled_at)
        VALUES (${newId(ID.boxFill)}, ${line.id}, ${input.boxNo}, 'hand', ${input.actorId}::uuid, ${input.now})
        ON CONFLICT (order_line_id, box_no) DO NOTHING
        RETURNING id
      ),`;

  try {
    await db.execute(sql`
      WITH d AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS d(variant_id text, delta int)
      ), ${writeFill}
      inv AS (
        UPDATE shop_inventory i
           SET on_hand = i.on_hand + d.delta, updated_at = ${input.now}
          FROM d, fill
         WHERE i.variant_id = d.variant_id
           AND (d.delta > 0 OR i.on_hand - i.reserved + d.delta >= 0)
        RETURNING i.variant_id
      ), ins AS (
        INSERT INTO shop_box_fill_items (id, fill_id, position, variant_id, sku, title, option_values, image_id)
        SELECT x.id, fill.id, x.position, x.variant_id, x.sku, x.title, x.option_values, x.image_id
          FROM fill, jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(
                 id text, position int, variant_id text, sku text, title text,
                 option_values jsonb, image_id text)
        RETURNING 1
      )
      SELECT
        CASE WHEN (SELECT count(*) FROM fill) = 0 THEN shop_box_abort('box_changed') END AS changed,
        CASE WHEN (SELECT count(*) FROM inv) <> ${moves.length} THEN shop_box_abort('box_short') END AS short`);
  } catch (err: unknown) {
    if (err instanceof DbError && err.code === 'BOX02') {
      const now = (await listBoxFills(db, input.orderId)).find(
        (f) => f.orderLineId === line.id && f.boxNo === input.boxNo,
      );
      throw new BoxRefusedError(now?.fulfillmentId ? 'box_in_parcel' : 'box_changed');
    }
    if (err instanceof DbError && err.code === 'BOX01') {
      const short = await db.execute(sql`
        SELECT i.variant_id FROM shop_inventory i
          JOIN jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS d(variant_id text, delta int)
            ON d.variant_id = i.variant_id
         WHERE d.delta < 0 AND i.on_hand - i.reserved + d.delta < 0`);
      throw new BoxRefusedError(
        'box_short',
        short.rows.map((r) => String(byId.get(String(r.variant_id))?.title ?? r.variant_id)),
      );
    }
    throw err;
  }

  return (await listBoxFills(db, input.orderId)).find(
    (f) => f.orderLineId === line.id && f.boxNo === input.boxNo,
  )!;
}

/**
 * The boxes a reader may see, as item titles grouped per box.
 *  - `{ orderId }`: for the CUSTOMER, only boxes whose parcel is DELIVERED.
 *  - `{ fulfillmentId }`: for the delivered email, which renders inside the
 *    transition that makes that parcel delivered, so it is read beforehand.
 */
export async function revealedBoxes(
  db: Db,
  where: { orderId: string } | { fulfillmentId: string },
): Promise<Map<string, { title: string; optionValues: Record<string, string> }[][]>> {
  const filter =
    'orderId' in where
      ? sql`ol.order_id = ${where.orderId} AND pf.status = 'delivered'`
      : sql`f.fulfillment_id = ${where.fulfillmentId}`;
  const res = await db.execute(sql`
    SELECT f.order_line_id, f.box_no, it.title, it.option_values
      FROM shop_box_fills f
      JOIN shop_order_lines ol ON ol.id = f.order_line_id
      JOIN shop_fulfillments pf ON pf.id = f.fulfillment_id
      JOIN shop_box_fill_items it ON it.fill_id = f.id
     WHERE ${filter}
     ORDER BY f.order_line_id, f.box_no, it.position`);
  const out = new Map<string, { title: string; optionValues: Record<string, string> }[][]>();
  let lastKey = '';
  for (const r of res.rows) {
    const lineId = String(r.order_line_id);
    const key = `${lineId}:${String(r.box_no)}`;
    const boxes = out.get(lineId) ?? [];
    if (key !== lastKey) boxes.push([]);
    boxes[boxes.length - 1].push({
      title: String(r.title),
      optionValues: parsed<Record<string, string>>(r.option_values) ?? {},
    });
    out.set(lineId, boxes);
    lastKey = key;
  }
  return out;
}
