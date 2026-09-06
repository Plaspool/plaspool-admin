import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '../../db/schema';
import {
  HOLD_STATES,
  PRODUCT_STATUSES,
  VARIANT_STATUSES,
} from '../../../shared/commerce/ports';
import type { HoldState, ProductStatus, VariantStatus } from '../../../shared/commerce/ports';
import type { DocNode } from '../../../shared/types';
import type { AddOnRule, AddOnStatus } from '../../../shared/commerce/add-ons';

/**
 * Catalog's five tables (contract §4), declared in a file **Catalog owns
 * exclusively** and re-exported from `server/db/commerce-schema.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT WRITTEN DIRECTLY INTO `commerce-schema.ts`, WHICH IS WHERE
 * CONTRACT §4 PUTS IT. Because "shared, append-only" is a convention with no
 * mechanism behind it, and it did not hold. Over the course of building this
 * subsystem, `server/db/commerce-schema.ts` was WHOLESALE OVERWRITTEN three
 * times by three different agents, each replacing the file rather than
 * appending to it — Catalog's block was silently lost twice before this
 * indirection existed. Raised as amendment A-CAT-004.
 *
 * A file each agent owns exclusively, re-exported from the shared one, keeps
 * §4's actual purpose — one import path where every commerce table is
 * reachable — while reducing the shared file's contested surface to a single
 * `export *` line. A clobber then costs one line instead of three hundred, and
 * `tsc` names it immediately instead of the loss being invisible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️  THESE DECLARATIONS ARE A DESCRIPTION; `server/db/migrations/0100_catalog.sql`
 *     IS THE AUTHORITY. Neither this file nor `commerce-schema.ts` is in the
 *     `schema` path of `drizzle.config.ts`, and that is deliberate on two
 *     grounds that compound:
 *
 *     1. Contract §8 allocates migration NUMBERS in advance (`0100`–`0119` for
 *        Catalog) so four concurrent agents do not collide in the journal.
 *        `drizzle-kit generate` numbers a migration from the journal's LENGTH —
 *        run against a copy of the real folder it emitted `0005`, not `0100`.
 *     2. `drizzle.config.ts`'s own rule is that a hand-written migration may
 *        only touch objects drizzle-kit cannot model, because `generate` diffs
 *        the schema file against the latest snapshot and emits DDL to close any
 *        gap. A table declared in the config's schema path and created by hand
 *        would get a second `CREATE TABLE` on the next `generate`.
 *
 *     A description that drifts from its authority is the exact failure this
 *     project keeps finding — "a validator and a database disagreeing about
 *     what is storable" — so it is not left to discipline.
 *     `server/shop/catalog/schema-parity.test.ts` reads `information_schema`,
 *     `pg_constraint`, `pg_indexes` and `pg_trigger` out of a PGlite built from
 *     the real migrations and reconciles every column, constraint, index and
 *     trigger against what is declared here.
 *
 * Two rules carry over from `server/db/schema.ts` and are not optional (§4):
 * timestamps are `bigint` epoch-milliseconds, never `timestamptz`; and every
 * enum-ish column carries a `check()`, because `.$type<>()` is compile-time only
 * and buys nothing against a bug that writes `status = 'live'`.
 */

/** `'a', 'b'` — a SQL literal list built from the TS constant, so the two cannot drift. */
function sqlLiterals(values: readonly string[]) {
  return sql.join(
    values.map((v) => sql.raw(`'${v}'`)),
    sql`, `,
  );
}

/**
 * The merchandising unit. A name, a description, images, a slug, a category.
 *
 * Shaped after `posts` because it is the same kind of thing: a CAS-written,
 * slug-owning, soft-deletable resource with a revision history and a lifecycle.
 * Everything that looks copied is copied on purpose — that machinery has been
 * through two critic rounds and 200-concurrent-write testing, and a second
 * dialect of it would be a second set of the same bugs.
 */
export const shopProducts = pgTable(
  'shop_products',
  {
    /** `prd_…` (contract §10). Never a sequential integer on the wire. */
    id: text('id').primaryKey(),
    /**
     * Nullable, and UNIQUE — exactly as `posts.slug` is, and for the identical
     * reason: a UNIQUE column cannot hold twenty empty strings but Postgres
     * permits many NULLs, so drafts hold NULL until titled or published.
     */
    slug: text('slug').unique(),
    title: text('title').notNull(),
    /** A `DocNode`, reusing `shared/doc.ts` and validated by `shared/validate.ts`. */
    description: jsonb('description').$type<DocNode>().notNull(),
    /**
     * `docToText(description)`, derived on write. A server-side storage detail;
     * it is never on `Product` and never rides along into a response (brief §2).
     */
    descriptionText: text('description_text').notNull(),
    /**
     * `draft` → not for sale. `active` → sellable. `archived` → withdrawn.
     *
     * NOT `published`, deliberately: a product's sellable state and a blog
     * post's public state are different words for different things, and reusing
     * the word would invite the two lifecycles to be merged later.
     */
    status: text('status').$type<ProductStatus>().notNull(),
    category: text('category').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** An R2 image id (`images.id`). Read-only from commerce's side. */
    coverImageId: text('cover_image_id'),
    imageIds: text('image_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    publishedAt: bigint('published_at', { mode: 'number' }),
    /** Non-null == in the trash, regardless of status. */
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    /**
     * Hand-written SEO copy for the storefront's <title>/<meta description>
     * (migration 0440). NULL means "use the defaults" — the storefront falls
     * back to `title` and the trimmed description — and `''` is normalised to
     * NULL at the write boundary. No length check, matching `title`: no
     * tsvector hangs off this table, so the bound lives in the route's Zod
     * where the refusal can name the field.
     */
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    /**
     * The card/summary line (migration 0580). NULL means "derive it" — the
     * projection falls back to `summarise(description)`, i.e. the first
     * non-empty top-level block, and `''` is normalised to NULL at the write
     * boundary exactly as the SEO pair above is.
     *
     * The fallback is computed in TypeScript, never in SQL, and 0580's header
     * says why at length: 0520 extracted from this same jsonb column with lax
     * jsonpath and doubled every value in production.
     */
    overview: text('overview'),
    /**
     * `summarise(description)`, derived on write — the same contract
     * `descriptionText` two fields up signs, and for a sharper reason:
     * `LIST_PRODUCT_COLUMNS` excludes `description`, so the list route has no
     * document to derive a fallback from and MUST read a stored one.
     *
     * Nullable only because the backfill is a script rather than a statement in
     * 0580; the projection falls through to `summarise(description)` when this
     * is NULL and the document is present.
     */
    overviewFallback: text('overview_fallback'),
    /**
     * Whether the quantity ladder applies to this product (migration 0600).
     *
     * `NOT NULL DEFAULT true` and NOT a nullable boolean meaning "true when
     * NULL": the latter obliges every reader to write `COALESCE(…, true)`, and
     * the first one that forgets sells at full price forever while every test
     * passes.
     */
    bulkDiscountEnabled: boolean('bulk_discount_enabled').notNull().default(true),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** The CAS token. Monotonic per product. */
    revision: integer('revision').notNull(),
    /**
     * The LIFECYCLE CAS token, maintained by a trigger and unsettable from
     * outside. The long note is in `0100_catalog.sql`; the short version is
     * GAUNTLET II Part 2b finding #1, the single most important thing in this
     * repository's history. A predicate over CURRENT STATE ALONE cannot
     * distinguish "never left draft" from "was archived and restored to draft",
     * so every lifecycle retry re-applied an intent a human had deliberately
     * undone, and the measured consequence was a destroyed row with zero
     * surviving revisions.
     */
    lifecycleGeneration: integer('lifecycle_generation').notNull().default(0),
  },
  (t) => [
    check('shop_products_status_ck', sql`${t.status} IN (${sqlLiterals(PRODUCT_STATUSES)})`),
    check('shop_products_revision_ck', sql`${t.revision} > 0`),
    index('shop_products_status_updated_idx').on(t.status, t.updatedAt.desc()),
    index('shop_products_deleted_idx').on(t.deletedAt),
    index('shop_products_category_idx').on(t.category),
    /** The folded category filter (migration 0010) — `listProducts` compares
     *  `lower(category)` now, which the 0100 index above cannot serve. */
    index('shop_products_category_fold_idx').on(sql`lower(${t.category})`),
    index('shop_products_author_idx').on(t.authorId),
  ],
);

/**
 * Mirrors `revisions` (contract §4), and carries the same production backstop.
 *
 * `UNIQUE (product_id, revision)` is unreachable through the CAS as written —
 * the revision row is inserted by `SELECT … FROM upd`, so a losing CAS inserts
 * nothing at all. It is what holds under REAL parallelism, where PGlite's single
 * connection proves nothing, and the repository maps its violation onto the same
 * 409 a lost CAS produces rather than letting it escape as a 500.
 */
export const shopProductRevisions = pgTable(
  'shop_product_revisions',
  {
    /** `prv_…`. */
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => shopProducts.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    description: jsonb('description').$type<DocNode>().notNull(),
    /** The status AS OF this revision, so history explains a lifecycle move. */
    status: text('status').notNull(),
    kind: text('kind').$type<'edit' | 'status'>().notNull(),
    /** Human-readable summary, used by `status` entries. */
    note: text('note'),
  },
  (t) => [
    uniqueIndex('shop_product_revisions_uq').on(t.productId, t.revision),
    check('shop_product_revisions_revision_ck', sql`${t.revision} > 0`),
    check('shop_product_revisions_kind_ck', sql`${t.kind} IN ('edit', 'status')`),
  ],
);

/**
 * The SELLABLE unit. A SKU, an option tuple, a weight, a price, stock.
 *
 * A product with no options still has exactly one variant, and the single-variant
 * product is NOT special-cased (brief §2): the "simple product" shortcut is how
 * catalogs end up with two code paths that disagree about inventory.
 */
export const shopVariants = pgTable(
  'shop_variants',
  {
    /** `var_…`. */
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => shopProducts.id, { onDelete: 'cascade' }),
    /** Unique across the whole shop, not per product — a SKU is an address. */
    sku: text('sku').notNull().unique(),
    /** `{ "Size": "M", "Colour": "Navy" }`. */
    optionValues: jsonb('option_values').$type<Record<string, string>>().notNull(),
    position: integer('position').notNull(),
    /** Shipping needs it; nullable is honest for a variant nobody has weighed. */
    weightGrams: integer('weight_grams'),
    status: text('status').$type<VariantStatus>().notNull(),
    /**
     * ONE image, for the option this variant actually is (migration 0009).
     *
     * The options in this store are colours, and a colour is the thing a
     * photograph disambiguates — the product cover can only show one spool, so
     * choosing between eight PLA colours was choosing between eight words. One
     * image rather than a gallery: a gallery per colour is not a thing anybody
     * asked for, and it would make the orphan collector's walk wider for no gain.
     *
     * NOT an FK to `images`: that is the blog's table, and contract §2 R3 keeps
     * the two halves from constraining one another — the same call
     * `shop_products.cover_image_id` already made. Existence is checked at write
     * time by `checkImageRefs`, and `server/repo/images.ts#REFERENCE_SET` unions
     * this column so an image referenced ONLY from here survives collection.
     */
    imageId: text('image_id'),
    /**
     * The colour code of the option this variant is (migration 0010).
     *
     * A COLUMN, NOT A KEY INSIDE `option_values`: the option tuple is the
     * variant's identity — it feeds SKU derivation and the option summary — and
     * a hex code inside it would leak into both. Nullable (most variants of a
     * non-colour axis never have one), lowercase-only by CHECK, and the
     * repository lowercases before INSERT so the check is a backstop rather
     * than a user-facing refusal.
     */
    colorHex: text('color_hex'),
    /**
     * The struck-through "was" price (migration 0400). MINOR UNITS, integer.
     * A COLUMN, NOT A `shop_prices` ROW: effective-dating exists because a
     * price charges someone; this one is display-only and last-writer-wins,
     * like `weightGrams`. Currency is implied by the current price row's.
     * NULL means "not on sale"; the storefront draws the line through it only
     * when it exceeds the current price, decided at render time.
     */
    compareAtMinor: integer('compare_at_minor'),
    /**
     * What the shop pays for one unit (migration 0420). MINOR UNITS, integer.
     * ⚠️ ADMIN-ONLY ON THE WIRE — `toStorefrontVariant` strips it and
     * `StorefrontVariant` is `Omit<…, 'costMinor'>`, so widening it back is a
     * compile error, not a silent leak. NULL means "never told what it costs".
     */
    costMinor: integer('cost_minor'),
    /**
     * The dollar price for this variant (migration 0860). MINOR UNITS — CENTS,
     * integer. `4999` is $49.99.
     *
     * NULL MEANS DERIVE IT, not "unavailable" and not "free". The dollar price
     * a shopper normally sees is the naira price converted at
     * `shop_currency_settings.ngnPerUsdMinor` and rounded up; this column is
     * the per-variant OVERRIDE, so setting it departs from the rate and
     * clearing it rejoins. That pairing is the owner's instruction: a derived
     * default everywhere, overridable anywhere.
     *
     * ON THE VARIANT RATHER THAN IN `shop_prices`, which is the reverse of what
     * 0400 argues for a price that charges. The migration header has the whole
     * argument; the short version is that `shop_prices_current_uq` is unique on
     * `variant_id` alone and eleven reads join on it, so a second current row
     * would double catalogue rows rather than fail loudly.
     */
    priceUsdMinor: integer('price_usd_minor'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    check(
      'shop_variants_color_hex_ck',
      sql`${t.colorHex} IS NULL OR ${t.colorHex} ~ '^#[0-9a-f]{6}$'`,
    ),
    check('shop_variants_status_ck', sql`${t.status} IN (${sqlLiterals(VARIANT_STATUSES)})`),
    check('shop_variants_position_ck', sql`${t.position} >= 0`),
    check('shop_variants_weight_ck', sql`${t.weightGrams} IS NULL OR ${t.weightGrams} >= 0`),
    // Sign backstops, as `weight_ck`: against a backfill or hand-run UPDATE,
    // not display policy — zero is storable and simply never renders as a sale.
    check(
      'shop_variants_compare_at_ck',
      sql`${t.compareAtMinor} IS NULL OR ${t.compareAtMinor} >= 0`,
    ),
    check('shop_variants_cost_ck', sql`${t.costMinor} IS NULL OR ${t.costMinor} >= 0`),
    check(
      'shop_variants_price_usd_minor_ck',
      sql`${t.priceUsdMinor} IS NULL OR ${t.priceUsdMinor} >= 0`,
    ),
    index('shop_variants_product_idx').on(t.productId, t.position),
    /** Partial: the reference walk and the public check both scan it, and a
     *  variant with no image answers neither question. */
    index('shop_variants_image_idx').on(t.imageId).where(sql`${t.imageId} IS NOT NULL`),
  ],
);

/**
 * Effective-dated price ROWS, not a column on the variant (brief §2).
 *
 * A price change must not retroactively alter what a placed order says it cost —
 * an order line already snapshots its price — but the catalog still has to answer
 * "what did this cost on Tuesday" for reconciliation, and a column cannot. The
 * cost is one join; the alternative is a price history nobody kept.
 *
 * `effective_to IS NULL` means CURRENT, and the partial unique index makes "at
 * most one current price per variant" a database property rather than an
 * intention. Without it two concurrent price changes both close the old row,
 * both insert a new one, and `quote()` starts depending on which row the planner
 * returned — a variant with two current prices is a shop that charges different
 * customers differently for reasons nobody can reconstruct.
 */
export const shopPrices = pgTable(
  'shop_prices',
  {
    /** `prc_…`. */
    id: text('id').primaryKey(),
    variantId: text('variant_id')
      .notNull()
      .references(() => shopVariants.id, { onDelete: 'cascade' }),
    /** MINOR UNITS. Integer, never numeric and never a float (contract §10). */
    amount: integer('amount').notNull(),
    /** ISO-4217, checked as a shape — the same rule `money()` enforces in TS. */
    currency: text('currency').notNull(),
    effectiveFrom: bigint('effective_from', { mode: 'number' }).notNull(),
    /** NULL = current. */
    effectiveTo: bigint('effective_to', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    /**
     * WHY the price moved (migration 0009).
     *
     * The what and the when were always here — this table is append-only and
     * effective-dated. The why was not, and it is the half a person needs: a row
     * saying 18,500 became 22,000 on a Tuesday is a trail nobody can act on.
     *
     * NULLABLE, and it stays nullable: every price written before 0009 has none,
     * and inventing one for them would put a lie in the audit view. "No reason
     * recorded" is a true thing to display; an empty string is not.
     */
    reason: text('reason'),
  },
  (t) => [
    /**
     * A price may be zero (a free sample) but never negative. `Money` permits a
     * negative amount because a refund IS one; a catalogue price is not.
     */
    check('shop_prices_amount_ck', sql`${t.amount} >= 0`),
    check('shop_prices_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'shop_prices_window_ck',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    index('shop_prices_variant_idx').on(t.variantId, t.effectiveFrom.desc()),
    uniqueIndex('shop_prices_current_uq')
      .on(t.variantId)
      .where(sql`${t.effectiveTo} IS NULL`),
  ],
);

/**
 * On-hand stock per variant. **ONLY CATALOG WRITES THIS** (contract §4).
 *
 * A SEPARATE TABLE KEYED BY VARIANT, NOT COLUMNS ON THE VARIANT (brief §2).
 * Inventory is the hottest row in the system under a flash sale, and it is
 * written by a different operation than the variant's merchandising fields. One
 * table means every stock decrement contends with every description edit.
 *
 * `available = on_hand - reserved` is DERIVED and never stored. Two columns that
 * must sum to a third are three ways to be inconsistent.
 */
export const shopInventory = pgTable(
  'shop_inventory',
  {
    variantId: text('variant_id')
      .primaryKey()
      .references(() => shopVariants.id, { onDelete: 'cascade' }),
    onHand: integer('on_hand').notNull(),
    reserved: integer('reserved').notNull(),
    /** When true, `on_hand - reserved >= qty` stops being a condition of sale. */
    backorderable: boolean('backorderable').notNull().default(false),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /**
     * The backstop, not the mechanism: `reserve` refuses in its own conditional
     * statement. These exist so a backfill, an import or a hand-run UPDATE
     * cannot leave a negative count that every read afterwards quietly believes.
     *
     * NOTE `reserved` MAY EXCEED `on_hand`, AND THAT IS NOT AN ERROR: a
     * backorderable variant is deliberately sold past zero available, so a check
     * demanding `reserved <= on_hand` would refuse the feature.
     */
    check('shop_inventory_on_hand_ck', sql`${t.onHand} >= 0`),
    check('shop_inventory_reserved_ck', sql`${t.reserved} >= 0`),
  ],
);

/**
 * Catalog's own record of a hold. **See amendment A-CAT-002** — contract §4 has
 * no row for this table.
 *
 * WHY IT EXISTS. Brief §5 makes `reservationId` the idempotency key and requires
 * it be enforced "with a unique row, not with a JS check on a prior read", and
 * requires `release`/`commitReservation` to be idempotent and safe in either
 * order after expiry. All of that needs Catalog to know durably which
 * reservation ids it has honoured and what became of each. The only row carrying
 * that otherwise is `shop_reservations`, which R3 makes Cart's alone.
 *
 * WHAT IT IS NOT. Not a second `shop_reservations`. No cart, no customer, no
 * expiry policy, no sweeper — the count is Catalog's and the clock is Cart's
 * (brief §5). `expires_at` is recorded so a stuck hold can be diagnosed; nothing
 * in Catalog reads it to make a decision.
 */
export const shopInventoryHolds = pgTable(
  'shop_inventory_holds',
  {
    /** CALLER-SUPPLIED, and the primary key IS the idempotency enforcement. */
    reservationId: text('reservation_id').primaryKey(),
    variantId: text('variant_id')
      .notNull()
      .references(() => shopVariants.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    /**
     * `held` → counted in `shop_inventory.reserved`.
     * `released` → returned; the units are available again.
     * `committed` → sold; `on_hand` and `reserved` both went down.
     *
     * A terminal state is terminal. `release` and `commit` both require `held`,
     * which is what makes the sweeper/capture race a no-op for whichever loses
     * rather than a double decrement.
     */
    state: text('state').$type<HoldState>().notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('shop_inventory_holds_state_ck', sql`${t.state} IN (${sqlLiterals(HOLD_STATES)})`),
    check('shop_inventory_holds_qty_ck', sql`${t.qty} > 0`),
    index('shop_inventory_holds_variant_idx').on(t.variantId, t.state),
  ],
);

/**
 * The bulk quantity ladder (migration 0600).
 *
 * ONE TABLE, TWO SCOPES, discriminated by `productId`: NULL is the store-wide
 * default every product inherits; non-NULL overrides exactly one product.
 *
 * OVERRIDE IS FULL REPLACEMENT, NOT MERGE — `resolveTiers` enforces it. Merging
 * an override into the default yields a combined ladder nobody can predict from
 * reading either input, and makes "drop the 10+ tier for this one product"
 * unexpressible.
 *
 * THE UNIQUE INDEX IS ON `COALESCE(product_id, '')` AND THAT IS LOAD-BEARING.
 * Postgres treats NULLs as distinct in a UNIQUE index, so a bare
 * `uniqueIndex().on(t.productId, t.minQty)` would permit twenty store-wide
 * ladders all claiming qty 5 — the one scope the index exists to make singular.
 */
export const shopBulkTiers = pgTable(
  'shop_bulk_tiers',
  {
    id: text('id').primaryKey(),
    /** NULL = the store-wide default ladder. */
    productId: text('product_id').references(() => shopProducts.id, { onDelete: 'cascade' }),
    minQty: integer('min_qty').notNull(),
    /** Basis points, matching `tax.rateBps`: 10 000 is 100%, so 1000 is 10%. */
    percentBps: integer('percent_bps').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    /* A tier at qty 1 is not a bulk discount, it is a price change, and that
       belongs in `shop_prices` where the price history lives. */
    check('shop_bulk_tiers_min_qty_ck', sql`${t.minQty} >= 2`),
    /* The ceiling guards a mistyped 9000 selling at 10% of list. Not a policy. */
    check('shop_bulk_tiers_percent_ck', sql`${t.percentBps} > 0 AND ${t.percentBps} <= 5000`),
    uniqueIndex('shop_bulk_tiers_scope_qty_idx').on(
      sql`COALESCE(${t.productId}, '')`,
      t.minQty,
    ),
    index('shop_bulk_tiers_product_idx').on(t.productId),
  ],
);

/**
 * Checkout add-ons (migration 0940). The model only; the shopper's answers live
 * on shop_carts and the snapshot on shop_order_add_ons.
 */
export const shopAddOns = pgTable(
  'shop_add_ons',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    imageId: text('image_id'),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<AddOnStatus>().notNull(),
    rules: jsonb('rules').$type<AddOnRule[]>().notNull(),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    check('shop_add_ons_title_ck', sql`${t.title} <> ''`),
    check('shop_add_ons_description_ck', sql`${t.description} IS NULL OR ${t.description} <> ''`),
    check('shop_add_ons_price_ck', sql`${t.priceMinor} >= 0`),
    check('shop_add_ons_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('shop_add_ons_status_ck', sql`${t.status} IN ('draft','active','archived')`),
    check('shop_add_ons_rules_ck', sql`jsonb_typeof(${t.rules}) = 'array'`),
    check('shop_add_ons_revision_ck', sql`${t.revision} > 0`),
    index('shop_add_ons_active_idx').on(t.position).where(sql`${t.status} = 'active'`),
  ],
);
export type DbAddOn = typeof shopAddOns.$inferSelect;

export type DbProduct = typeof shopProducts.$inferSelect;
export type DbBulkTier = typeof shopBulkTiers.$inferSelect;
export type DbVariant = typeof shopVariants.$inferSelect;
export type DbPrice = typeof shopPrices.$inferSelect;
export type DbInventory = typeof shopInventory.$inferSelect;
export type DbInventoryHold = typeof shopInventoryHolds.$inferSelect;
