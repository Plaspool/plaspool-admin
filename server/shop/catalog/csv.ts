import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import * as Papa from 'papaparse';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from '../../db/client';
import { toEpochMs } from '../../db/client';
import { pathParam, readJson, readJsonOrEmpty, readQuery, str } from '../../middleware/errors';
import { requireAuth } from '../../middleware/session';
import { currentDb, currentUser } from '../../app-env';
import type { AppEnv } from '../../app-env';
import { BadRequestError, InvalidDocumentError, NotFoundError } from '../../repo/errors';
import { mintToken, tokenId } from '../../repo/users';
import { resendMailer } from '../../mail/resend';
import type { Mailer } from '../../mail/port';
import { renderSystem } from '../../email/system-templates';
import { money } from '../../../shared/commerce/money';
import type { AuthUser, DocNode } from '../../../shared/types';
import { SHOP_CURRENCY } from '../currency';
import { listProducts } from './query';
import {
  DuplicateOptionsError,
  DuplicateSkuError,
  createVariant,
  listVariantsForProducts,
  listVariantsWithPrices,
  updateVariant,
} from './variants';
import { setPrice } from './prices';
import { adjustInventory, getInventory } from './inventory';
import {
  archiveProduct,
  createProduct,
  publishProduct,
  saveProduct,
  unarchiveProduct,
  unpublishProduct,
} from './products';
import type { Product, ProductPatch, VariantPatch, VariantWithPrice } from './types';

/**
 * CSV export and import for the product catalogue (migration 0720).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SHAPE: ONE ROW PER VARIANT, PRODUCT FIELDS REPEATED ON EVERY ROW.
 *
 * Shopify's format carries the product fields on a group's FIRST row only and
 * leaves them blank on the rest, which makes a file that has been sorted in a
 * spreadsheet unimportable — the blank rows lose their product. Repeating the
 * product cells on every row costs bytes and buys a lossless round trip:
 * export → import preview reports zero creates, whatever a spreadsheet did to
 * the row order. Import still honours Shopify's semantics on the way in
 * (product fields are read from a group's first row; later rows' product
 * cells are ignored), so a Shopify-shaped file imports too.
 *
 * COLUMNS, exactly and in order:
 *
 *   Handle, Title, Status, Category, Tags, Description, Overview, SEO Title,
 *   SEO Description, Variant SKU, Variant Options, Variant Price,
 *   Variant Compare At Price, Variant Cost, Variant Stock,
 *   Variant Backorderable
 *
 * - **Handle** is the product slug — this app has no separate handle column;
 *   the slug IS the URL identity. A product that has no slug yet (an untitled
 *   draft) exports with an EMPTY handle, and such a row cannot be imported
 *   back: import requires a non-empty Handle, so those rows land in `invalid`
 *   rather than silently minting a product with an address nobody chose.
 * - **Status** is draft|active|archived. Trash is a view, not a status, and
 *   trashed products are excluded from the export entirely.
 * - **Tags** are comma-joined inside the one cell (papaparse quotes it). A tag
 *   that itself contains a comma would split on re-import — the same known
 *   limitation Shopify's format has, accepted for the same reason.
 * - **Description** is the PLAIN TEXT of the document — the stored
 *   description_text, which is docToText output maintained on every write.
 *   The list query deliberately excludes the description document
 *   (LIST_PRODUCT_COLUMNS), so the honest source at export volume is the
 *   derived-text column, read here in one statement per page rather than one
 *   product read per row. On import the text becomes a single-paragraph
 *   document, so a rich description round-trips as its text and LOSES
 *   formatting if re-imported over itself — which is why an EMPTY Description
 *   cell never overwrites anything (see the import notes below).
 * - **Variant Options** is the optionValues record JSON-encoded, e.g.
 *   {"Size":"1kg","Color":"Black"}; an empty record exports as an empty cell.
 * - **Prices are MAJOR units with two decimals** ("23500.00"): CSV is for
 *   spreadsheets and humans, and minor units in a spreadsheet invite a
 *   hundredfold error in whichever direction is worse. The boundary converts:
 *   integer arithmetic on the way out, Math.round(parsed * 100) on the way
 *   in, NaN and negatives refused per row.
 * - **Variant Stock** is the inventory on_hand, ABSOLUTE (import computes the
 *   delta against the current level and adjusts with a stated reason).
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const CSV_COLUMNS = [
  'Handle',
  'Title',
  'Status',
  'Category',
  'Tags',
  'Description',
  'Overview',
  'SEO Title',
  'SEO Description',
  'Variant SKU',
  'Variant Options',
  'Variant Price',
  'Variant Compare At Price',
  'Variant Cost',
  'Variant Stock',
  'Variant Backorderable',
] as const;

/** Download links die after this. Enforced at read time — nothing sweeps. */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The most data rows one import may carry; past it the whole file is a 400. */
export const MAX_IMPORT_ROWS = 1000;

// ------------------------------------------------------------------- mailer

/**
 * The test seam, shaped like `registerClerkVerifier` and for the same reason:
 * the shop app is composed with no arguments, so a suite that built a second,
 * injected copy would be testing a router production never mounts. The
 * registry is read PER REQUEST. **Call `resetCsvMailer()` in `beforeEach`.**
 *
 * The default is the real transport (`resendMailer`), whose `assertConfigured`
 * refuses on a deployment with no mail — which the export route treats as
 * `emailed: false` rather than an error, exactly as `deliverInvite` does: the
 * URL is in the response either way, so a mail outage costs the convenience,
 * never the export.
 */
let registeredMailer: Mailer | null = null;

export function registerCsvMailer(mailer: Mailer | null): void {
  registeredMailer = mailer;
}

export function resetCsvMailer(): void {
  registeredMailer = null;
}

function csvMailer(): Mailer {
  return registeredMailer ?? resendMailer();
}

// ------------------------------------------------------------------- export

/**
 * The id-minting pattern of mapping.ts, with the one prefix this table owns.
 * A local copy rather than a widening of newCatalogId's prefix union: that
 * union documents the ids the CATALOGUE mints, and an export row is a delivery
 * artefact nothing else ever references by id.
 */
function newExportId(): string {
  return `exp_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Minor units → "23500.00". Integer arithmetic only: trunc and modulo are
 * exact for every safe integer, where a division-then-toFixed detour goes
 * through a double. Two decimals always — this store's currency (NGN) is 100
 * minor units per major, confirmed against live prices rather than assumed.
 */
function minorToMajor(minor: number): string {
  const negative = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${negative}${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * "23500.00" → minor units, or null for anything that is not a non-negative
 * amount within the int4 column ceiling. Math.round is what absorbs the
 * binary-float dust of parsed * 100 (19.99 * 100 is 1998.999…8).
 */
function majorToMinor(cell: string): number | null {
  const parsed = Number(cell);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const minor = Math.round(parsed * 100);
  if (!Number.isSafeInteger(minor) || minor > 2_147_483_647) return null;
  return minor;
}

/**
 * The derived plain text per product, in one statement. description_text is
 * maintained beside the document on every write (products.ts), so it IS
 * docToText of the stored description — the list query excludes the document
 * itself on purpose, and re-deriving here from a per-product read would be a
 * round trip per row for a value the table already holds.
 */
async function descriptionTexts(db: Db, ids: string[]): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (ids.length === 0) return texts;
  const res = await db.execute(sql`
    SELECT id, description_text FROM shop_products
     WHERE id = ANY(${sql.param(ids)}::text[])`);
  for (const row of res.rows) {
    texts.set(String(row.id), row.description_text == null ? '' : String(row.description_text));
  }
  return texts;
}

/**
 * on_hand per variant, in one statement. VariantWithPrice carries `available`
 * (on_hand minus reserved) for the storefront's "2 left"; the export needs the
 * ABSOLUTE count, because the import applies a delta against it and a number
 * that already subtracted reservations would write those reservations off.
 */
async function onHandByVariant(db: Db, variantIds: string[]): Promise<Map<string, number>> {
  const stock = new Map<string, number>();
  if (variantIds.length === 0) return stock;
  const res = await db.execute(sql`
    SELECT variant_id, on_hand FROM shop_inventory
     WHERE variant_id = ANY(${sql.param(variantIds)}::text[])`);
  for (const row of res.rows) stock.set(String(row.variant_id), Number(row.on_hand));
  return stock;
}

function productCells(product: Product, descriptionText: string): string[] {
  return [
    product.slug ?? '',
    product.title,
    product.status,
    product.category,
    product.tags.join(', '),
    descriptionText,
    product.overview ?? '',
    product.seoTitle ?? '',
    product.seoDescription ?? '',
  ];
}

function variantCells(variant: VariantWithPrice, onHand: number | undefined): string[] {
  return [
    variant.sku,
    Object.keys(variant.optionValues).length > 0 ? JSON.stringify(variant.optionValues) : '',
    variant.price ? minorToMajor(variant.price.amount) : '',
    variant.compareAtMinor == null ? '' : minorToMajor(variant.compareAtMinor),
    variant.costMinor == null ? '' : minorToMajor(variant.costMinor),
    onHand === undefined ? '' : String(onHand),
    variant.backorderable ? 'true' : 'false',
  ];
}

/** The seven empty variant cells a variantless product exports with. */
const NO_VARIANT_CELLS = ['', '', '', '', '', '', ''];

/**
 * The whole catalogue as CSV, built by walking the existing list query with
 * its cursor until exhausted — the same code path the admin list drives, so
 * what exports is exactly what that screen shows (includeUnpublished, trash
 * excluded), not a second predicate that can drift from it.
 */
export async function buildCatalogCsv(db: Db): Promise<{ csv: string; rowCount: number }> {
  const rows: string[][] = [];
  let cursor: string | undefined;

  do {
    const page = await listProducts(db, {
      sort: 'newest',
      includeUnpublished: true,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const ids = page.items.map((p) => p.id);
    const [variants, texts] = await Promise.all([
      listVariantsForProducts(db, ids),
      descriptionTexts(db, ids),
    ]);
    const variantIds = [...variants.values()].flat().map((v) => v.id);
    const stock = await onHandByVariant(db, variantIds);

    for (const product of page.items) {
      const base = productCells(product, texts.get(product.id) ?? '');
      const own = variants.get(product.id) ?? [];
      if (own.length === 0) {
        rows.push([...base, ...NO_VARIANT_CELLS]);
        continue;
      }
      for (const variant of own) rows.push([...base, ...variantCells(variant, stock.get(variant.id))]);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const csv = Papa.unparse({ fields: [...CSV_COLUMNS], data: rows });
  return { csv, rowCount: rows.length };
}

/**
 * Mail the requester their link — the `deliverInvite` pattern verbatim: an
 * unconfigured transport is `false` and never an error (the URL is in the
 * response either way), and a failed SEND is logged for the operator and
 * swallowed for the caller, because the export row is already committed and
 * the caller holds the link.
 */
async function deliverExport(
  c: Context<AppEnv>,
  db: Db,
  to: string,
  url: string,
  rowCount: number,
): Promise<boolean> {
  const mailer = csvMailer();
  try {
    mailer.assertConfigured?.();
  } catch {
    return false;
  }

  const days = Math.round(EXPORT_TTL_MS / (24 * 60 * 60 * 1000));
  try {
    await mailer.send(
      await renderSystem(db, 'catalog.export', to, {
        download_url: url,
        row_count: String(rowCount),
        expiry_days: String(days),
      }),
    );
    return true;
  } catch (err) {
    // Name and message only — the message never carries the URL, whose token
    // is a live credential. Same status-only rule as server/mail/resend.ts.
    console.error(
      '[api]',
      JSON.stringify({
        requestId: c.get('requestId') ?? '',
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : 'mail send failed',
        route: 'POST /api/shop/admin/products/export',
      }),
    );
    return false;
  }
}

// ------------------------------------------------------------------- import

interface CsvProblem {
  /** 1-based DATA row — the header line is not counted. */
  line: number;
  problem: string;
}

interface CsvVariantInput {
  sku: string;
  optionValues: Record<string, string>;
  /** null = no price cell; a price cannot be cleared, only left alone. */
  priceMinor: number | null;
  /** null = empty cell, which on an update CLEARS the field (import is
   *  authoritative; the export writes '' for a stored NULL, so this is what
   *  makes the round trip stable). */
  compareAtMinor: number | null;
  costMinor: number | null;
  /** null = no stock cell: create defaults to 0, update leaves the count. */
  stock: number | null;
  /** null = no cell: create defaults to false, update leaves the flag. */
  backorderable: boolean | null;
}

interface ImportRow {
  line: number;
  handle: string;
  title: string;
  status: '' | 'draft' | 'active' | 'archived';
  category: string;
  tags: string[];
  description: string;
  overview: string;
  seoTitle: string;
  seoDescription: string;
  /** Present only when the row carries a Variant SKU. */
  variant: CsvVariantInput | null;
}

interface ImportGroup {
  handle: string;
  /** The first row's line — where a group-level problem is reported. */
  line: number;
  head: ImportRow;
  /** Every row of the group that carries a variant, first-row included. */
  variants: ImportRow[];
}

const IMPORT_STATUSES = new Set(['draft', 'active', 'archived']);

function cell(row: Record<string, unknown>, name: (typeof CSV_COLUMNS)[number]): string {
  const value = row[name];
  return value == null ? '' : String(value).trim();
}

/** The parsed Variant Options cell, or null for anything that is not a flat
 *  record. Values are stringified — a spreadsheet will happily turn "1" into
 *  a number, and refusing that would fail files nobody can see a flaw in. */
function parseOptions(raw: string): Record<string, string> | null {
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value === 'object') return null;
    options[key] = String(value);
  }
  return options;
}

/**
 * Every data row, validated one by one. A row with any problem lands in
 * `invalid` (line plus every complaint) and is EXCLUDED from grouping — the
 * rest of the file is never held hostage by one bad cell.
 */
function parseImportRows(csv: string): {
  rows: ImportRow[];
  invalid: CsvProblem[];
  total: number;
} {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.data.length > MAX_IMPORT_ROWS) throw new BadRequestError('csv');

  const invalid: CsvProblem[] = [];
  /*
   * papaparse's structural complaints (bad quoting, mostly), surfaced as
   * ordinary per-row problems so the caller sees one vocabulary — and the row
   * itself is then EXCLUDED, because data behind a quoting error is garbled
   * data. FieldMismatch is deliberately NOT one of these: a spreadsheet that
   * trims trailing empty cells produces TooFewFields on perfectly good rows
   * (the missing cells simply read as empty), and refusing those would refuse
   * most files Excel has touched.
   */
  const garbled = new Set<number>();
  for (const err of parsed.errors) {
    if (err.type === 'FieldMismatch' || typeof err.row !== 'number') continue;
    invalid.push({ line: err.row + 1, problem: err.message });
    garbled.add(err.row);
  }

  const rows: ImportRow[] = [];
  const seenSkus = new Set<string>();

  parsed.data.forEach((raw, index) => {
    if (garbled.has(index)) return;
    const line = index + 1;
    const problems: string[] = [];

    const handle = cell(raw, 'Handle');
    if (handle === '') problems.push('missing Handle');

    const statusRaw = cell(raw, 'Status').toLowerCase();
    if (statusRaw !== '' && !IMPORT_STATUSES.has(statusRaw)) {
      problems.push(`unknown Status "${statusRaw}" (draft, active or archived)`);
    }

    const optionsRaw = cell(raw, 'Variant Options');
    const optionValues = parseOptions(optionsRaw);
    if (optionValues === null) problems.push('malformed Variant Options JSON');

    const readMinor = (
      name: 'Variant Price' | 'Variant Compare At Price' | 'Variant Cost',
    ): number | null => {
      const value = cell(raw, name);
      if (value === '') return null;
      const minor = majorToMinor(value);
      if (minor === null) problems.push(`bad ${name} "${value}"`);
      return minor;
    };
    const priceMinor = readMinor('Variant Price');
    const compareAtMinor = readMinor('Variant Compare At Price');
    const costMinor = readMinor('Variant Cost');

    const stockRaw = cell(raw, 'Variant Stock');
    let stock: number | null = null;
    if (stockRaw !== '') {
      const parsedStock = Number(stockRaw);
      if (!Number.isInteger(parsedStock) || parsedStock < 0 || parsedStock > 100_000_000) {
        problems.push(`bad Variant Stock "${stockRaw}"`);
      } else {
        stock = parsedStock;
      }
    }

    const backRaw = cell(raw, 'Variant Backorderable').toLowerCase();
    let backorderable: boolean | null = null;
    if (backRaw === 'true') backorderable = true;
    else if (backRaw === 'false') backorderable = false;
    else if (backRaw !== '') problems.push(`bad Variant Backorderable "${backRaw}"`);

    const sku = cell(raw, 'Variant SKU');
    if (sku !== '') {
      // SKUs are globally unique (shop_variants_sku_unique), so a duplicate
      // anywhere in the file — not merely within one handle — is refused.
      if (seenSkus.has(sku)) problems.push(`duplicate SKU "${sku}" in the file`);
      else seenSkus.add(sku);
    }

    if (problems.length > 0) {
      invalid.push({ line, problem: problems.join('; ') });
      return;
    }

    rows.push({
      line,
      handle,
      title: cell(raw, 'Title'),
      status: statusRaw as ImportRow['status'],
      category: cell(raw, 'Category'),
      tags: cell(raw, 'Tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      description: cell(raw, 'Description'),
      overview: cell(raw, 'Overview'),
      seoTitle: cell(raw, 'SEO Title'),
      seoDescription: cell(raw, 'SEO Description'),
      variant:
        sku === ''
          ? null
          : {
              sku,
              optionValues: optionValues ?? {},
              priceMinor,
              compareAtMinor,
              costMinor,
              stock,
              backorderable,
            },
    });
  });

  return { rows, invalid, total: parsed.data.length };
}

/**
 * Rows grouped by Handle — Shopify semantics: product fields come from the
 * group's FIRST row, later rows' product cells are ignored, and every row
 * carrying a Variant SKU contributes a variant. A group whose first row has
 * no Title is invalid whole: a product cannot be created nameless, and an
 * update from a file that lost its titles is a file that lost more than that.
 */
function groupRows(rows: ImportRow[], invalid: CsvProblem[]): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const row of rows) {
    let group = groups.get(row.handle);
    if (!group) {
      group = { handle: row.handle, line: row.line, head: row, variants: [] };
      groups.set(row.handle, group);
    }
    if (row.variant) group.variants.push(row);
  }

  const valid: ImportGroup[] = [];
  for (const group of groups.values()) {
    if (group.head.title === '') {
      invalid.push({ line: group.line, problem: 'missing Title' });
      continue;
    }
    valid.push(group);
  }
  return valid;
}

/**
 * Which of these handles already name a product — NON-TRASHED ONLY, decided
 * and written down: a trashed product keeps its slug, but matching it would
 * make an import silently resurrect the bin (or overwrite something an admin
 * deliberately binned). A handle held only by a trashed product therefore
 * counts as a CREATE, and the new product takes a suffixed slug from the
 * ordinary uniqueness ladder.
 *
 * A local statement over shop_products rather than a repo addition: the repo's
 * by-slug read is the storefront's (active only), and this one exists for
 * exactly one caller.
 */
async function existingSlugs(db: Db, slugs: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  if (slugs.length === 0) return existing;
  const res = await db.execute(sql`
    SELECT slug FROM shop_products
     WHERE slug = ANY(${sql.param(slugs)}::text[]) AND deleted_at IS NULL`);
  for (const row of res.rows) if (row.slug != null) existing.add(String(row.slug));
  return existing;
}

async function productBySlug(
  db: Db,
  slug: string,
): Promise<{ id: string; status: string } | null> {
  const res = await db.execute(sql`
    SELECT id, status FROM shop_products
     WHERE slug = ${slug} AND deleted_at IS NULL`);
  const row = res.rows[0];
  return row ? { id: String(row.id), status: String(row.status) } : null;
}

/** The Description cell as a document: one paragraph of the text. */
function paragraphDoc(text: string): DocNode {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A refusal as one line a spreadsheet author can act on. Subclasses first —
 *  DuplicateSkuError IS a BadRequestError, and "refused: sku" helps nobody. */
function problemOf(err: unknown): string {
  if (err instanceof DuplicateSkuError) return `SKU "${err.sku}" is already in use`;
  if (err instanceof DuplicateOptionsError) {
    return `option combination already exists (${err.summary})`;
  }
  if (err instanceof InvalidDocumentError) return `invalid ${err.path}`;
  if (err instanceof BadRequestError) return `refused: ${err.detail}`;
  return err instanceof Error ? err.message : 'failed';
}

async function applyVariantCreate(
  db: Db,
  productId: string,
  input: CsvVariantInput,
  actor: AuthUser,
): Promise<void> {
  const variant = await createVariant(
    db,
    productId,
    {
      sku: input.sku,
      optionValues: input.optionValues,
      onHand: input.stock ?? 0,
      backorderable: input.backorderable ?? false,
      compareAtMinor: input.compareAtMinor,
      costMinor: input.costMinor,
    },
    actor,
  );
  if (input.priceMinor !== null) {
    await setPrice(db, variant.id, money(input.priceMinor, SHOP_CURRENCY), 'CSV import');
  }
}

/**
 * The status column, applied through the real lifecycle transitions — the
 * TRANSITIONS vocabulary of routes.ts, never a direct column write, so the
 * outbox events (variant.published / unpublished) fire exactly as they do for
 * a human clicking the buttons. An empty cell leaves the status alone.
 */
async function applyStatus(
  db: Db,
  productId: string,
  current: string,
  want: ImportRow['status'],
  actor: AuthUser,
): Promise<void> {
  if (want === '' || want === current) return;
  if (want === 'active') {
    await publishProduct(db, productId, actor);
  } else if (want === 'archived') {
    await archiveProduct(db, productId, actor);
  } else if (current === 'active') {
    await unpublishProduct(db, productId, actor);
  } else if (current === 'archived') {
    await unarchiveProduct(db, productId, actor);
  }
}

/** The product-fields patch a group's head row describes. Empty SEO/overview
 *  cells are the CLEAR instruction (null), matching what export writes for a
 *  stored NULL — that symmetry is the round trip. */
function headPatch(head: ImportRow): ProductPatch {
  return {
    title: head.title,
    category: head.category,
    tags: head.tags,
    seoTitle: head.seoTitle || null,
    seoDescription: head.seoDescription || null,
    overview: head.overview || null,
  };
}

async function applyCreate(
  db: Db,
  group: ImportGroup,
  actor: AuthUser,
  invalid: CsvProblem[],
): Promise<void> {
  const head = group.head;
  const product = await createProduct(db, actor, {
    ...headPatch(head),
    slug: group.handle,
    /*
     * ═══ THE 2026-08-27 LESSON, HONOURED BY OMISSION ═══
     * A BLANK Description cell does NOT pass a document at all: the key is
     * left off, so createProduct applies ITS OWN default — the exact document
     * every product created through the admin gets. Spelling a second copy of
     * that default here is precisely how the empty-doc editor lock happened:
     * a fixture-only shape drifts from the one the application actually
     * writes, and nothing fails until a screenshot does. The import suite
     * pins this by deep-equality against a control product created through
     * the ordinary route, not against any literal.
     */
    ...(head.description === '' ? {} : { description: paragraphDoc(head.description) }),
  });

  for (const row of group.variants) {
    try {
      await applyVariantCreate(db, product.id, row.variant!, actor);
    } catch (err) {
      invalid.push({ line: row.line, problem: problemOf(err) });
    }
  }

  try {
    await applyStatus(db, product.id, 'draft', head.status, actor);
  } catch (err) {
    invalid.push({ line: group.line, problem: problemOf(err) });
  }
}

async function applyUpdate(
  db: Db,
  existing: { id: string; status: string },
  group: ImportGroup,
  actor: AuthUser,
  invalid: CsvProblem[],
): Promise<void> {
  const head = group.head;
  const patch = headPatch(head);
  /*
   * Description ONLY when the cell is non-empty. The CSV carries plain text,
   * so a blank cell cannot mean "clear the document" — an exported file whose
   * description column was untouched must not flatten or wipe a rich document
   * on the way back in. (A NON-empty cell does replace the document with a
   * single paragraph of the text: import is authoritative, and that loss of
   * formatting is the documented cost of editing descriptions in a
   * spreadsheet.)
   */
  if (head.description !== '') patch.description = paragraphDoc(head.description);

  /*
   * No baseRevision, deliberately: an import is an authoritative overwrite by
   * design — the operator chose "replace" — and there is no stored revision in
   * the file to be honest about. saveProduct without a base CASes against the
   * revision it just read, so a concurrent edit still cannot be torn, only
   * superseded.
   */
  const product = await saveProduct(db, existing.id, patch, {
    actor,
    note: 'CSV import',
  });

  const current = await listVariantsWithPrices(db, existing.id);
  const bySku = new Map(current.map((variant) => [variant.sku, variant]));

  for (const row of group.variants) {
    const input = row.variant!;
    try {
      const match = bySku.get(input.sku);
      if (!match) {
        // A SKU that exists on ANOTHER product is not matched here (a variant
        // does not move between products); the create below then refuses with
        // the duplicate-SKU conflict, reported on this row.
        await applyVariantCreate(db, existing.id, input, actor);
        continue;
      }

      const variantPatch: VariantPatch = {
        optionValues: input.optionValues,
        compareAtMinor: input.compareAtMinor,
        costMinor: input.costMinor,
      };
      if (input.backorderable !== null) variantPatch.backorderable = input.backorderable;
      await updateVariant(db, match.id, variantPatch);

      if (input.priceMinor !== null && input.priceMinor !== (match.price?.amount ?? null)) {
        await setPrice(db, match.id, money(input.priceMinor, SHOP_CURRENCY), 'CSV import');
      }

      if (input.stock !== null) {
        const level = await getInventory(db, match.id);
        const delta = input.stock - (level?.onHand ?? 0);
        if (delta !== 0) await adjustInventory(db, match.id, delta, 'CSV import', actor);
      }
    } catch (err) {
      invalid.push({ line: row.line, problem: problemOf(err) });
    }
  }

  try {
    await applyStatus(db, existing.id, product.status, head.status, actor);
  } catch (err) {
    invalid.push({ line: group.line, problem: problemOf(err) });
  }
}

// ------------------------------------------------------------------- routes

/**
 * Mounted into the catalog router by routes.ts (routes.route('/', csvRoutes)),
 * which server/shop/app.ts mounts under /api/shop — so every path here rides
 * the same origin guard, session middleware and error rendering as the rest
 * of the catalogue admin, and the domain gate maps the /admin/products prefix
 * to the products domain exactly as it does for its neighbours.
 */
export const csvRoutes = new Hono<AppEnv>();

const auth = requireAuth();

const ExportBody = z.object({}).strict();

const ImportBody = z
  .object({
    csv: str().max(2_000_000),
    mode: z.enum(['preview', 'apply']),
    /**
     * The owner's ask — "if products are similar it should be replaceable" —
     * so replacing is the DEFAULT and skipping is the opt-out.
     */
    replace: z.boolean().default(true),
  })
  .strict();

/**
 * Build the CSV NOW, store it, and email the requester the download link.
 *
 * The file is built at request time rather than at download time so the link
 * always serves exactly what the admin was told was exported — a download a
 * week later is a snapshot of the catalogue as it was, not a surprise.
 */
csvRoutes.post('/admin/products/export', auth, async (c) => {
  await readJsonOrEmpty(c, ExportBody);
  const db = currentDb(c);
  const user = currentUser(c);

  const { csv, rowCount } = await buildCatalogCsv(db);

  const id = newExportId();
  const token = mintToken();
  const now = Date.now();
  await db.execute(sql`
    INSERT INTO product_exports (id, requested_by, requested_email, csv, row_count,
                                 token_hash, created_at, downloaded_at)
    VALUES (${id}, ${user.id}, ${user.email}, ${csv}, ${rowCount},
            ${tokenId(token)}, ${now}, NULL)`);

  /*
   * origins[0], NEVER the Host header — the invite route documents why at
   * length: a host header is attacker-controlled on any deployment that does
   * not pin it, and a tokened URL built from one is a credential delivered to
   * a domain the attacker chose.
   */
  const base = c.get('origins')[0] ?? '';
  const url = `${base}/api/shop/admin/products/exports/${id}/download?token=${encodeURIComponent(token)}`;

  const emailed = await deliverExport(c, db, user.email, url, rowCount);

  return c.json({ export: { id, rowCount, url }, emailed }, 201);
});

const DownloadQuery = z
  .object({
    /** Optional in the SCHEMA so its absence can answer the same 404 as a
     *  wrong one — a missing credential is not a malformed request, it is an
     *  unauthorised one, and the two must be indistinguishable. */
    token: str().max(512).optional(),
  })
  .strict();

/**
 * The download. NO SESSION REQUIRED — the link lands in inboxes and is opened
 * from phones and other browsers, so the token in the query string is its
 * whole authority. That also means the domain gate never fires for the cold
 * caller it is built for: the gate acts only when an admin session resolved,
 * so mounting under the ordinary /admin/products prefix is safe — asserted by
 * the suite with a cookie-less client rather than assumed.
 *
 * ONE ANSWER — 404 — for every refusal: unknown id, absent token, wrong
 * token, expired row. Splitting them would let a link-holder probe which part
 * of a guessed URL was right.
 */
csvRoutes.get('/admin/products/exports/:id/download', async (c) => {
  const db = currentDb(c);
  const id = pathParam(c, 'id');
  const { token } = readQuery(c, DownloadQuery);

  const res = await db.execute(sql`
    SELECT csv, token_hash, created_at FROM product_exports WHERE id = ${id}`);
  const row = res.rows[0];
  if (!row || !token) throw new NotFoundError(id);

  /*
   * A PLAIN === ON THE HEX, AND THAT IS ACCEPTABLE HERE, SAID OUT LOUD: both
   * sides are HMAC-SHA-256 outputs under SESSION_SECRET, so what a timing
   * oracle on the comparison could leak is a prefix of a HASH — and without
   * the key there is no way to search for a TOKEN whose hash extends that
   * prefix. Timing-safe comparison guards a comparison of secrets; this
   * compares two PRF outputs.
   */
  if (tokenId(token) !== String(row.token_hash)) throw new NotFoundError(id);

  const createdAt = toEpochMs(row.created_at);
  const now = Date.now();
  if (now - createdAt > EXPORT_TTL_MS) throw new NotFoundError(id);

  // Keep-first: the stamp records when the file FIRST left the building,
  // and a re-download must not rewrite that fact.
  await db.execute(sql`
    UPDATE product_exports SET downloaded_at = COALESCE(downloaded_at, ${now})
     WHERE id = ${id}`);

  // The filename dates the SNAPSHOT (created_at), not the click.
  const date = new Date(createdAt).toISOString().slice(0, 10);
  return c.body(String(row.csv), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="plaspool-products-${date}.csv"`,
  });
});

/**
 * Import — preview counts what WOULD happen; apply walks the groups
 * SEQUENTIALLY (the bulk-transition precedent: no bulk statement exists, and
 * per-item calls through the real repo functions are honest about partial
 * failure). Rows and groups with problems are SKIPPED and reported, never a
 * reason to abort the file.
 */
csvRoutes.post('/admin/products/import', auth, async (c) => {
  const body = await readJson(c, ImportBody);
  const db = currentDb(c);
  const actor = currentUser(c);

  const { rows, invalid, total } = parseImportRows(body.csv);
  const groups = groupRows(rows, invalid);

  if (body.mode === 'preview') {
    const existing = await existingSlugs(
      db,
      groups.map((group) => group.handle),
    );
    let creates = 0;
    let updates = 0;
    for (const group of groups) {
      if (existing.has(group.handle)) updates += 1;
      else creates += 1;
    }
    return c.json({ creates, updates, invalid, total });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const group of groups) {
    // Looked up per group AT APPLY TIME rather than reusing a preview's set:
    // apply decides against the catalogue as it stands now, not as it stood
    // when somebody previewed — and one code path cannot disagree with itself.
    const existing = await productBySlug(db, group.handle);
    if (existing && !body.replace) {
      skipped += 1;
      continue;
    }
    try {
      if (existing) {
        await applyUpdate(db, existing, group, actor, invalid);
        updated += 1;
      } else {
        await applyCreate(db, group, actor, invalid);
        created += 1;
      }
    } catch (err) {
      invalid.push({ line: group.line, problem: problemOf(err) });
    }
  }

  return c.json({ applied: true, created, updated, skipped, invalid });
});
