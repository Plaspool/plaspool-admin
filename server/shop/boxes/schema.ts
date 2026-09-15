import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Mystery-box fills (migration 1220).
 *
 * NOT THE SOURCE OF TRUTH FOR THE DDL — drizzle-kit has never seen this file;
 * `1220_mystery_boxes.sql` is the authority and `schema-parity.test.ts`
 * reconciles the two, column by column.
 */
export const shopBoxFills = pgTable(
  'shop_box_fills',
  {
    id: text('id').primaryKey(),
    /** The order line this box belongs to. One row per box UNIT: qty 2 is box 1 and box 2. */
    orderLineId: text('order_line_id').notNull(),
    boxNo: integer('box_no').notNull(),
    source: text('source').$type<'hand' | 'built' | 'auto' | 'backup'>().notNull(),
    /** The parcel the box went out in. The customer reveal reads this parcel's status. */
    fulfillmentId: text('fulfillment_id'),
    filledBy: uuid('filled_by'),
    /** Also the CAS token for changing what is in the box. */
    filledAt: bigint('filled_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('shop_box_fills_box_no_ck', sql`${t.boxNo} > 0`),
    check('shop_box_fills_source_ck', sql`${t.source} IN ('hand', 'built', 'auto', 'backup')`),
    unique('shop_box_fills_line_box_uq').on(t.orderLineId, t.boxNo),
    index('shop_box_fills_fulfillment_idx').on(t.fulfillmentId),
  ],
);

export const shopBoxFillItems = pgTable(
  'shop_box_fill_items',
  {
    id: text('id').primaryKey(),
    fillId: text('fill_id').notNull(),
    position: integer('position').notNull(),
    /** Not a foreign key, per contract §2 R3 — exactly as `shop_order_lines.variant_id`. */
    variantId: text('variant_id').notNull(),
    /** Snapshots: the product can change after the box was packed. */
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull(),
    imageId: text('image_id'),
    /** Set when a cancelled order's item goes back on the shelf. */
    returnedToStockAt: bigint('returned_to_stock_at', { mode: 'number' }),
  },
  (t) => [
    check('shop_box_fill_items_position_ck', sql`${t.position} >= 0`),
    index('shop_box_fill_items_fill_idx').on(t.fillId),
  ],
);
