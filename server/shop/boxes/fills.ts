import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { DbError } from '../../db/client';
import { BadRequestError, NotFoundError } from '../../repo/errors';
import { ID, newId } from '../orders/ids';
import { readOrder } from '../orders/repo/orders';
import { BoxRefusedError } from './errors';
import type { BoxFill, BoxLine, BuiltBox } from './types';

/**
 * Filling mystery boxes (migrations 1220 and 1240).
 *
 * A LINE IS A BOX WHEN ITS VARIANT'S PRODUCT IS IN BOX MODE — the same test the
 * parcel guard and the capacity SQL use, so the three cannot disagree about
 * what a box is.
 */

const parsed = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

function toFills(fills: Record<string, unknown>[], items: Record<string, unknown>[]): BoxFill[] {
  return fills.map((f) => ({
    id: String(f.id),
    orderLineId: f.order_line_id == null ? '' : String(f.order_line_id),
    boxNo: f.box_no == null ? 0 : Number(f.box_no),
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

async function itemsFor(db: Db, fillIds: string[]): Promise<Record<string, unknown>[]> {
  if (fillIds.length === 0) return [];
  const res = await db.execute(sql`
    SELECT * FROM shop_box_fill_items
     WHERE fill_id = ANY(${sql.param(fillIds)}::text[])
     ORDER BY position`);
  return res.rows;
}

/** Every filled box on an order, in line then box order, with its items. */
export async function listBoxFills(db: Db, orderId: string): Promise<BoxFill[]> {
  const fills = await db.execute(sql`
    SELECT f.* FROM shop_box_fills f JOIN shop_order_lines ol ON ol.id = f.order_line_id
     WHERE ol.order_id = ${orderId} ORDER BY ol.line_no, f.box_no`);
  return toFills(fills.rows, await itemsFor(db, fills.rows.map((r) => String(r.id))));
}

/** Which lines of this order are boxes, whether or not any box is filled yet. */
export async function boxLinesFor(db: Db, orderId: string): Promise<BoxLine[]> {
  const res = await db.execute(sql`
    SELECT ol.id, v.box_item_count
      FROM shop_order_lines ol
      JOIN shop_variants v ON v.id = ol.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE ol.order_id = ${orderId} AND p.box_mode IS NOT NULL
     ORDER BY ol.line_no`);
  return res.rows.map((r) => ({
    orderLineId: String(r.id),
    itemCount: r.box_item_count == null ? null : Number(r.box_item_count),
  }));
}

/** Boxes built ahead and still on the shelf, oldest first (migration 1240). */
export async function listBuiltBoxes(db: Db): Promise<BuiltBox[]> {
  const fills = await db.execute(sql`
    SELECT * FROM shop_box_fills WHERE built_state = 'ready' ORDER BY filled_at, id`);
  const items = await itemsFor(db, fills.rows.map((r) => String(r.id)));
  return toFills(fills.rows, items).map((f, i) => ({
    id: f.id,
    sizeVariantId: String(fills.rows[i].box_variant_id),
    filledAt: f.filledAt,
    items: f.items,
  }));
}

/** When the shop could not fill this order's box by itself, or null (migration 1240). */
export async function boxShortAt(db: Db, orderId: string): Promise<number | null> {
  const res = await db.execute(sql`SELECT box_short_at FROM shop_orders WHERE id = ${orderId}`);
  const v = res.rows[0]?.box_short_at;
  return v == null ? null : Number(v);
}

/** Snapshots for the items, refusing anything that is not an ordinary active variant. */
async function snapshots(db: Db, variantIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(variantIds)];
  const found = await db.execute(sql`
    SELECT v.id, v.sku, v.option_values, v.image_id, p.title
      FROM shop_variants v JOIN shop_products p ON p.id = v.product_id
     WHERE v.id = ANY(${sql.param(unique)}::text[])
       AND v.status = 'active' AND p.box_mode IS NULL AND p.deleted_at IS NULL`);
  if (found.rows.length !== unique.length) throw new BadRequestError('variantIds');
  return new Map(found.rows.map((r) => [String(r.id), r]));
}

/**
 * The one statement every fill goes through — by hand, by the shop at payment,
 * or built ahead (CLAUDE.md §3).
 *
 * THE STOCK MOVE IS NETTED PER PRODUCT. Changing gold+gold+red into
 * gold+white+white is gold +1, red +1, white −2, applied as three row updates,
 * because one statement may not update the same inventory row twice.
 *
 * ALL OR NOTHING THROUGH shop_box_abort. A decrement whose guard fails matches no
 * row; the final SELECT compares the rows that moved with the rows that had to
 * move and aborts the statement if they differ, which undoes every CTE in it. The
 * reason comes back as the SQLSTATE (BOX01 short, BOX02 changed), because the
 * driver guard scrubs messages.
 */
async function commitFill(
  db: Db,
  args: {
    variantIds: string[];
    source: BoxFill['source'];
    actorId: string | null;
    now: number;
    /** A new box: where it goes. */
    place?: { orderLineId: string; boxNo: number } | { sizeVariantId: string };
    /** Changing an existing box: it, and the filledAt the caller last saw. */
    existing?: { id: string; filledAt: number; items: { variantId: string }[] };
  },
): Promise<string> {
  const byId = await snapshots(db, args.variantIds);

  const delta = new Map<string, number>();
  for (const id of args.variantIds) delta.set(id, (delta.get(id) ?? 0) - 1);
  for (const item of args.existing?.items ?? []) {
    delta.set(item.variantId, (delta.get(item.variantId) ?? 0) + 1);
  }
  const moves = [...delta]
    .filter(([, d]) => d !== 0)
    .map(([variant_id, d]) => ({ variant_id, delta: d }));

  const items = args.variantIds.map((variantId, position) => {
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

  const fillId = args.existing?.id ?? newId(ID.boxFill);
  const actor = sql`${args.actorId}::uuid`;
  let writeFill;
  if (args.existing) {
    writeFill = sql`
      fill AS (
        UPDATE shop_box_fills f
           SET filled_at = ${args.now}, filled_by = ${actor}, source = ${args.source}
         WHERE f.id = ${args.existing.id}
           AND f.filled_at = ${args.existing.filledAt}
           AND (f.fulfillment_id IS NULL OR EXISTS (
                  SELECT 1 FROM shop_fulfillments pf
                   WHERE pf.id = f.fulfillment_id AND pf.status = 'cancelled'))
        RETURNING f.id
      ), old AS (
        DELETE FROM shop_box_fill_items it USING fill WHERE it.fill_id = fill.id RETURNING 1
      ),`;
  } else if (args.place && 'orderLineId' in args.place) {
    writeFill = sql`
      fill AS (
        INSERT INTO shop_box_fills (id, order_line_id, box_no, source, filled_by, filled_at)
        VALUES (${fillId}, ${args.place.orderLineId}, ${args.place.boxNo}, ${args.source}, ${actor}, ${args.now})
        ON CONFLICT (order_line_id, box_no) DO NOTHING
        RETURNING id
      ),`;
  } else if (args.place) {
    writeFill = sql`
      fill AS (
        INSERT INTO shop_box_fills (id, source, filled_by, filled_at, box_variant_id, built_state)
        VALUES (${fillId}, 'built', ${actor}, ${args.now}, ${args.place.sizeVariantId}, 'ready')
        RETURNING id
      ),`;
  } else {
    throw new BadRequestError('place');
  }

  try {
    await db.execute(sql`
      WITH d AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) AS d(variant_id text, delta int)
      ), ${writeFill}
      inv AS (
        UPDATE shop_inventory i
           SET on_hand = i.on_hand + d.delta, updated_at = ${args.now}
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
    if (err instanceof DbError && err.code === 'BOX02') throw new BoxRefusedError('box_changed');
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
  return fillId;
}

export interface SaveBoxFillInput {
  orderId: string;
  orderLineId: string;
  boxNo: number;
  variantIds: string[];
  /** `null` for a first fill; the stored `filledAt` when changing one — the CAS token. */
  expectedFilledAt: number | null;
  /** `null` when the shop fills it by itself at payment. */
  actorId: string | null;
  now: number;
  source?: BoxFill['source'];
}

/**
 * Fill one box on a paid order, or change what is in it. Any in-stock ordinary
 * product may be used, not only the ticked list: someone at the bench with no
 * PETG left must be able to substitute.
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

  const findFill = async () =>
    (await listBoxFills(db, input.orderId)).find(
      (f) => f.orderLineId === line.id && f.boxNo === input.boxNo,
    );
  const existing = await findFill();
  if (existing && input.expectedFilledAt === null) throw new BoxRefusedError('box_changed');

  try {
    await commitFill(db, {
      variantIds: input.variantIds,
      source: input.source ?? 'hand',
      actorId: input.actorId,
      now: input.now,
      ...(existing
        ? { existing: { id: existing.id, filledAt: input.expectedFilledAt ?? -1, items: existing.items } }
        : { place: { orderLineId: line.id, boxNo: input.boxNo } }),
    });
  } catch (err) {
    if (err instanceof BoxRefusedError && err.reason === 'box_changed') {
      const now = await findFill();
      throw new BoxRefusedError(now?.fulfillmentId ? 'box_in_parcel' : 'box_changed');
    }
    throw err;
  }
  return (await findFill())!;
}

/**
 * Pack a box ahead of any sale, for one size of the mystery box (migration
 * 1240, "I build boxes ahead"). Its items leave the shelf now.
 */
export async function buildBox(
  db: Db,
  input: { sizeVariantId: string; variantIds: string[]; actorId: string; now: number },
): Promise<string> {
  const size = await db.execute(sql`
    SELECT v.box_item_count FROM shop_variants v JOIN shop_products p ON p.id = v.product_id
     WHERE v.id = ${input.sizeVariantId} AND p.box_mode IS NOT NULL`);
  const count = size.rows[0]?.box_item_count;
  if (count == null) throw new BadRequestError('sizeVariantId');
  if (input.variantIds.length !== Number(count)) throw new BadRequestError('variantIds');
  return commitFill(db, {
    variantIds: input.variantIds,
    source: 'built',
    actorId: input.actorId,
    now: input.now,
    place: { sizeVariantId: input.sizeVariantId },
  });
}

/**
 * Unpack a built box that has not sold: its items go back on the shelf and the
 * box is gone. One statement; a box that has just been sold matches nothing.
 */
export async function breakUpBox(db: Db, fillId: string, now: number): Promise<boolean> {
  const res = await db.execute(sql`
    WITH box AS (
      UPDATE shop_box_fills SET built_state = 'broken_up'
       WHERE id = ${fillId} AND built_state = 'ready'
      RETURNING id
    ), back AS (
      UPDATE shop_box_fill_items it SET returned_to_stock_at = ${now}
        FROM box WHERE it.fill_id = box.id AND it.returned_to_stock_at IS NULL
      RETURNING it.variant_id
    ), agg AS (
      SELECT variant_id, count(*)::int AS qty FROM back GROUP BY variant_id
    ), inv AS (
      UPDATE shop_inventory i SET on_hand = i.on_hand + agg.qty, updated_at = ${now}
        FROM agg WHERE i.variant_id = agg.variant_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM box)::int AS broken`);
  return Number(res.rows[0]?.broken ?? 0) > 0;
}

/**
 * Hand the oldest ready built box of this size to one box on a paid order.
 * Guarded on `built_state = 'ready'`, so two sales racing for the last box get
 * one each or one nothing, never the same box twice. Returns false when there is
 * no ready box left.
 */
export async function assignBuiltBox(
  db: Db,
  input: { orderLineId: string; boxNo: number; sizeVariantId: string },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pick = await db.execute(sql`
      SELECT id FROM shop_box_fills
       WHERE built_state = 'ready' AND box_variant_id = ${input.sizeVariantId}
       ORDER BY filled_at, id LIMIT 1`);
    const id = pick.rows[0]?.id;
    if (id == null) return false;
    const res = await db.execute(sql`
      UPDATE shop_box_fills
         SET order_line_id = ${input.orderLineId}, box_no = ${input.boxNo}, built_state = 'assigned'
       WHERE id = ${String(id)} AND built_state = 'ready'
         AND NOT EXISTS (SELECT 1 FROM shop_box_fills x
                          WHERE x.order_line_id = ${input.orderLineId} AND x.box_no = ${input.boxNo})
      RETURNING id`);
    if (res.rows.length > 0) return true;
  }
  return false;
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
