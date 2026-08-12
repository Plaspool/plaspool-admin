import { sql, type SQL } from 'drizzle-orm';
import { toEpochMs } from '../../db/client';
import type { Db } from '../../db/client';
import { encodeCursor, pageLimit, requireCursor } from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';

/**
 * The stock list an operator restocks from (HANDOFF §2 A4).
 *
 * READ-ONLY, AND IT ADDS NO TABLE. Everything here is a join over
 * `shop_inventory`, `shop_variants` and `shop_products`, which Catalog already
 * owns and already writes. Nothing in this directory writes a commerce row —
 * `adjustInventory` in `server/shop/catalog/inventory.ts` is still the one way a
 * count moves, and it stays there because it emits an event and this does not.
 *
 * `available` IS `on_hand - reserved`, DERIVED IN THE STATEMENT AND NEVER
 * STORED. That is Catalog's rule (`shop_inventory`'s declaration: "two columns
 * that must sum to a third are three ways to be inconsistent") and it is
 * inherited rather than restated in TypeScript, because a second definition of
 * availability computed after the read is a number that disagrees with the one
 * `reserve` decides sales on. It is also why the keyset below orders on the
 * EXPRESSION: there is no `available` column to sort by.
 *
 * ⚠️  `available` CAN BE NEGATIVE, and that is not corrupt data. A backorderable
 *     variant is deliberately sold past zero — `shop_inventory_reserved_ck`
 *     permits `reserved > on_hand` for exactly that reason — so an oversold
 *     backorder shows up here as a negative number and belongs at the top of a
 *     low-stock list rather than being clamped out of it.
 *
 * TRASHED PRODUCTS ARE EXCLUDED AND ARCHIVED AND DRAFT ONES ARE NOT. A product
 * in the trash is one nobody intends to sell, so its stock is noise on a
 * restocking screen; a draft or archived product's units are still physically on
 * a shelf and still worth counting. `productStatus` rides along so the client can
 * say which is which rather than guessing from the title.
 */

/** HANDOFF §2 A4: "available ≤ threshold, default 5". */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/**
 * The ordering this list's cursors are minted under, and the only one on offer.
 *
 * Stock is read low-first because the whole reason to open this screen is to
 * find what is about to run out. A second sort would be a second way for a
 * cursor to be spent against the wrong column — the failure `server/repo/cursor.ts`
 * measured, where a cursor from one ordering returned 2 of 8 rows under another
 * and reported no error at all.
 */
const SORT_KEY = 'available';

/**
 * `on_hand - reserved`, written once and used in the SELECT list, the ORDER BY,
 * the keyset predicate and the low-stock filter.
 *
 * ONE EXPRESSION, FOUR USES, ON PURPOSE. `server/shop/catalog/query.ts` makes the
 * same choice for its `MIN_PRICE` subquery and states the cost of not doing it:
 * a sort key computed one way for the ORDER BY and another way for the cursor is
 * a page boundary that skips rows, with nothing anywhere to report it.
 */
const AVAILABLE = sql.raw('(i.on_hand - i.reserved)');

export interface InventoryRow {
  variantId: string;
  sku: string;
  optionValues: Record<string, string>;
  variantStatus: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  onHand: number;
  reserved: number;
  /** `onHand - reserved`. Negative for an oversold backorderable variant. */
  available: number;
  backorderable: boolean;
  updatedAt: number;
}

export interface InventoryQuery {
  /** Only variants at or under `threshold`. */
  belowOnly?: boolean;
  /** Defaults to `DEFAULT_LOW_STOCK_THRESHOLD`. Ignored unless `belowOnly`. */
  threshold?: number;
  cursor?: string;
  limit?: number;
}

export interface InventoryPage {
  items: InventoryRow[];
  nextCursor: string | null;
}

function rowToInventory(row: Record<string, unknown>): InventoryRow {
  const onHand = Number(row.on_hand);
  const reserved = Number(row.reserved);
  return {
    variantId: String(row.variant_id),
    sku: String(row.sku),
    optionValues: row.option_values as Record<string, string>,
    variantStatus: String(row.variant_status),
    productId: String(row.product_id),
    productTitle: String(row.product_title),
    productStatus: String(row.product_status),
    onHand,
    reserved,
    available: onHand - reserved,
    /*
     * `=== true` and not a truthiness test, copied from
     * `server/shop/catalog/mapping.ts` for the reason it is written there: the
     * two drivers are not guaranteed to agree on how a `boolean` column comes
     * back, and `'f'` is truthy in JavaScript.
     */
    backorderable: row.backorderable === true,
    updatedAt: toEpochMs(row.updated_at),
  };
}

/**
 * The stock list, low first, keyset-paginated.
 *
 * `threshold` IS VALIDATED HERE RATHER THAN ONLY AT THE ROUTE, because
 * `shopStats` calls this function directly and would otherwise be able to hand it
 * a NaN that reaches the driver as `available <= NULL` — a filter that quietly
 * matches nothing and looks like a shop with no low stock at all.
 */
export async function listInventory(db: Db, q: InventoryQuery): Promise<InventoryPage> {
  const size = pageLimit(q.limit);
  const where: SQL[] = [sql`p.deleted_at IS NULL`];

  if (q.belowOnly) {
    const threshold = q.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
    if (!Number.isInteger(threshold)) throw new BadRequestError('threshold');
    where.push(sql`${AVAILABLE} <= ${threshold}`);
  }

  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, SORT_KEY);
    if (cursor.sortValues.length !== 1) throw new BadRequestError('cursor');
    const available = Number(cursor.sortValues[0]);
    /*
     * COERCED TO THE COLUMN'S TYPE, as every cursor consumer in this repository
     * does. The payload is base64 JSON anyone can write, and a string compared
     * against an integer expression is SQLSTATE 22P02 — a 500 the client's retry
     * policy re-sends five times for a request that can never succeed.
     */
    if (!Number.isFinite(available)) throw new BadRequestError('cursor');
    where.push(sql`(${AVAILABLE} > ${available}
                    OR (${AVAILABLE} = ${available} AND v.id > ${cursor.id}))`);
  }

  const res = await db.execute(sql`
    SELECT v.id            AS variant_id,
           v.sku           AS sku,
           v.option_values AS option_values,
           v.status        AS variant_status,
           p.id            AS product_id,
           p.title         AS product_title,
           p.status        AS product_status,
           i.on_hand       AS on_hand,
           i.reserved      AS reserved,
           i.backorderable AS backorderable,
           i.updated_at    AS updated_at
      FROM shop_inventory i
      JOIN shop_variants v ON v.id = i.variant_id
      JOIN shop_products p ON p.id = v.product_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${AVAILABLE} ASC, v.id ASC
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const items = res.rows.slice(0, size).map(rowToInventory);
  const last = items[items.length - 1];
  const more = res.rows.length > size;
  return {
    items,
    nextCursor: more && last ? encodeCursor(SORT_KEY, [last.available], last.variantId) : null,
  };
}
