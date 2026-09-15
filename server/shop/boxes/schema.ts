import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Mystery boxes (migrations 1220 and 1240).
 *
 * NOT THE SOURCE OF TRUTH FOR THE DDL — drizzle-kit has never seen this file;
 * the migrations are the authority and `schema-parity.test.ts` reconciles them.
 */

/** One row, id 'main': the Settings → Mystery box screen (migration 1240). */
export const shopMysteryBoxSettings = pgTable(
  'shop_mystery_box_settings',
  {
    id: text('id').primaryKey(),
    enabled: boolean('enabled').notNull().default(false),
    /** The product the box is sold as. Its variants are the sizes. */
    productId: text('product_id'),
    mode: text('mode').$type<'pack' | 'built' | 'auto'>().notNull().default('pack'),
    shortfall: text('shortfall').$type<'hold' | 'backup' | 'cancel_refund'>().notNull().default('hold'),
    /** The owner who saved it last. An automatic refund is recorded against them. */
    updatedBy: uuid('updated_by'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [
    check('shop_mystery_box_settings_one_ck', sql`${t.id} = 'main'`),
    check('shop_mystery_box_settings_mode_ck', sql`${t.mode} IN ('pack', 'built', 'auto')`),
    check(
      'shop_mystery_box_settings_shortfall_ck',
      sql`${t.shortfall} IN ('hold', 'backup', 'cancel_refund')`,
    ),
    check('shop_mystery_box_settings_revision_ck', sql`${t.revision} > 0`),
  ],
);

/** The tick lists: which variants can go inside, and which are the backup. */
export const shopMysteryBoxItems = pgTable(
  'shop_mystery_box_items',
  {
    variantId: text('variant_id').notNull(),
    list: text('list').$type<'main' | 'backup'>().notNull(),
  },
  (t) => [
    primaryKey({ name: 'shop_mystery_box_items_pk', columns: [t.variantId, t.list] }),
    check('shop_mystery_box_items_list_ck', sql`${t.list} IN ('main', 'backup')`),
  ],
);

/**
 * One row per box. A box sold and filled for an order has an order line and a
 * box number; a box BUILT AHEAD (migration 1240) has neither until it sells,
 * and says which size it is in `boxVariantId`.
 */
export const shopBoxFills = pgTable(
  'shop_box_fills',
  {
    id: text('id').primaryKey(),
    orderLineId: text('order_line_id'),
    boxNo: integer('box_no'),
    source: text('source').$type<'hand' | 'built' | 'auto' | 'backup'>().notNull(),
    /** The parcel it went out in. The customer reveal reads this parcel's status. */
    fulfillmentId: text('fulfillment_id'),
    filledBy: uuid('filled_by'),
    /** Also the CAS token for changing what is in the box. */
    filledAt: bigint('filled_at', { mode: 'number' }).notNull(),
    /** Migration 1240. The size a built-ahead box was packed as. */
    boxVariantId: text('box_variant_id'),
    /** Migration 1240. `ready` on the shelf, `assigned` to a sale, `broken_up` unpacked. */
    builtState: text('built_state').$type<'ready' | 'assigned' | 'broken_up'>(),
  },
  (t) => [
    check('shop_box_fills_box_no_ck', sql`${t.boxNo} > 0`),
    check('shop_box_fills_source_ck', sql`${t.source} IN ('hand', 'built', 'auto', 'backup')`),
    check(
      'shop_box_fills_built_state_ck',
      sql`${t.builtState} IS NULL OR ${t.builtState} IN ('ready', 'assigned', 'broken_up')`,
    ),
    check(
      'shop_box_fills_placed_ck',
      sql`(${t.orderLineId} IS NULL) = (${t.boxNo} IS NULL) AND (${t.orderLineId} IS NOT NULL OR ${t.builtState} IN ('ready', 'broken_up'))`,
    ),
    unique('shop_box_fills_line_box_uq').on(t.orderLineId, t.boxNo),
    index('shop_box_fills_fulfillment_idx').on(t.fulfillmentId),
    index('shop_box_fills_ready_idx').on(t.boxVariantId).where(sql`${t.builtState} = 'ready'`),
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
    /** Set when a cancelled order's item, or a broken-up box's item, goes back on the shelf. */
    returnedToStockAt: bigint('returned_to_stock_at', { mode: 'number' }),
  },
  (t) => [
    check('shop_box_fill_items_position_ck', sql`${t.position} >= 0`),
    index('shop_box_fill_items_fill_idx').on(t.fillId),
  ],
);
