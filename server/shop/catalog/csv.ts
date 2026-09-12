import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import Papa from 'papaparse';
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
import { slugify } from '../../../shared/doc';
import { docToHtml, htmlToDoc } from '../../../shared/doc-html';
import { adminOrigin } from '../../admin-url';
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
  getProduct,
  publishProduct,
  saveProduct,
  unarchiveProduct,
  unpublishProduct,
} from './products';
import type { Product, ProductPatch, VariantPatch, VariantWithPrice } from './types';

/*
 * DEFAULT IMPORT, NOT `import * as Papa` — and the difference was a 500 in
 * production for the whole life of this feature.
 *
 * papaparse is a UMD CommonJS module. `vite.server.config.ts` externalises
 * node_modules, so the deployed function resolves this specifier with NODE'S
 * OWN ESM LOADER, and cjs-module-lexer cannot see exports assigned the way
 * papaparse assigns them: the namespace is ['default', 'module.exports'] and
 * nothing more. `Papa.unparse` was therefore `undefined` on every deployment
 * — POST /api/shop/admin/products/export answered 500 {error:'internal'} —
 * and `Papa.parse` with it, so import was equally dead.
 *
 * Vitest hides this completely: vite-node interops a CommonJS dependency so
 * both forms resolve. The guard that does not lie is the `papaparse under
 * the production module loader` test in csv.test.ts, which runs this exact
 * import line in a real `node`.
 *
 * A NAMED import (`import { unparse } from 'papaparse'`) is not the fix: the
 * same lexer blindness makes it a link-time SyntaxError under Node.
 */
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
 *   Variant Backorderable, Product Image, Product Gallery, Variant Image,
 *   Variant Color Hex, Variant Weight Grams, Variant Position, Variant Status
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
 * - **Description** is the document as HTML, via `shared/doc-html.ts`.
 *
 *   ⚠️ IT USED TO BE PLAIN TEXT, AND THAT DESTROYED LIVE DATA. The column
 *   carried `description_text` — `docToText` output, block boundaries already
 *   collapsed to single spaces — and the import wrapped it in ONE paragraph.
 *   Export → import therefore flattened every heading, list and bold run it
 *   touched, and on 2026-09-04 it did exactly that to two production products.
 *   The rich copy survived only because `shop_product_revisions.description`
 *   stores the whole document on every save;
 *   `scripts/restore-description-revision.ts` is the repair.
 *
 *   HTML rather than the document's JSON because a person can read and edit
 *   `<h2>Key Features</h2><ul><li>…` in a spreadsheet cell, and because it is
 *   what Shopify's `Body (HTML)` column carries. A cell with NO tags is still
 *   read as plain text and becomes one paragraph, so a hand-typed cell and a
 *   Shopify-shaped file both still import.
 *
 *   The list query excludes the description document (LIST_PRODUCT_COLUMNS), so
 *   the export reads it in one extra statement per page — the same shape the
 *   derived-text read had, one column wider.
 *
 *   TWO GUARDS, because "import is authoritative" must not mean "import may
 *   quietly delete formatting". An EMPTY cell never overwrites anything. And a
 *   cell EQUAL TO `docToHtml(stored)` is skipped entirely, so an unedited round
 *   trip does not even bump the revision, whatever the codec does.
 * - **Product Image** is the cover image's id and **Product Gallery** the rest,
 *   comma-joined. **Variant Image** is that option's photograph (migration
 *   0009). These are IDS, not files: the CSV moves which picture is assigned,
 *   never the pixels, and an id naming no committed image is refused per row by
 *   the same check the admin form goes through.
 * - **Variant Color Hex** is `#rrggbb` (migration 0010) — the swatch a shopper
 *   picks a colour by. **Variant Weight Grams**, **Variant Position** and
 *   **Variant Status** (active|discontinued) complete the variant, so an export
 *   describes a variant fully enough to rebuild it.
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
  /*
   * APPENDED, NOT INSERTED, and the position is the contract. A column added
   * in the MIDDLE shifts every later one, so a file exported last week — or a
   * script that writes these rows positionally — silently lands its prices in
   * the stock column. Everything new goes on the end, where a shorter old file
   * simply reads as empty cells and the import leaves those fields alone.
   */
  'Product Image',
  'Product Gallery',
  'Variant Image',
  'Variant Color Hex',
  'Variant Weight Grams',
  'Variant Position',
  'Variant Status',
  /* Migration 1180. ON THE END for the reason above — a file exported before
     this column existed is one cell short here, which reads as "leave alone"
     and leaves the override exactly as the shop already had it. */
  'Variant Shipping Weight Grams',
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
 * The description DOCUMENT per product, as HTML, in one statement.
 *
 * IT READS `description`, NOT `description_text`, AND THAT IS THE WHOLE FIX.
 * The derived-text column is `docToText` output — every heading, list and bold
 * run already gone — so an export built from it could only ever describe a
 * description, never carry one. Two live products were flattened by the round
 * trip that resulted.
 *
 * `LIST_PRODUCT_COLUMNS` excludes the document on purpose, so this is one extra
 * statement per PAGE of the walk (not per row), which is the shape the text
 * read already had.
 */
async function descriptionHtml(db: Db, ids: string[]): Promise<Map<string, string>> {
  const html = new Map<string, string>();
  if (ids.length === 0) return html;
  const res = await db.execute(sql`
    SELECT id, description FROM shop_products
     WHERE id = ANY(${sql.param(ids)}::text[])`);
  for (const row of res.rows) {
    // Both drivers hand jsonb back parsed; the string branch is `mapping.ts`'s
    // same tolerance, and a document read as "[object Object]" would export as
    // a description nobody could get back.
    const doc = typeof row.description === 'string' ? JSON.parse(row.description) : row.description;
    html.set(String(row.id), docToHtml(doc as DocNode));
  }
  return html;
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

function productCells(product: Product, descriptionHtmlCell: string): string[] {
  return [
    product.slug ?? '',
    product.title,
    product.status,
    product.category,
    product.tags.join(', '),
    descriptionHtmlCell,
    product.overview ?? '',
    product.seoTitle ?? '',
    product.seoDescription ?? '',
  ];
}

/** The two product media cells, which sit after the variant block because the
 *  new columns are appended rather than inserted (see CSV_COLUMNS). */
function productMediaCells(product: Product): string[] {
  return [product.coverImageId ?? '', product.imageIds.join(', ')];
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

/** The appended variant columns — media and setup, in CSV_COLUMNS order. */
function variantExtraCells(variant: VariantWithPrice): string[] {
  return [
    variant.imageId ?? '',
    variant.colorHex ?? '',
    variant.weightGrams == null ? '' : String(variant.weightGrams),
    String(variant.position),
    variant.status,
    /* The RAW override, not the resolved weight (migration 1180). Exporting
       the resolved one would turn "no override" into an override on the next
       import, and every variant would end up pinned to whatever it displayed
       the day the file was written. */
    variant.shippingWeightGrams == null ? '' : String(variant.shippingWeightGrams),
  ];
}

/** The seven empty cells a variantless product exports with, from `Variant SKU`
 *  through `Variant Backorderable`. */
const NO_VARIANT_CELLS = ['', '', '', '', '', '', ''];

/** The six appended variant cells, empty for a variantless product. */
const NO_VARIANT_EXTRA_CELLS = ['', '', '', '', '', ''];

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
    const [variants, descriptions] = await Promise.all([
      listVariantsForProducts(db, ids),
      descriptionHtml(db, ids),
    ]);
    const variantIds = [...variants.values()].flat().map((v) => v.id);
    const stock = await onHandByVariant(db, variantIds);

    for (const product of page.items) {
      const base = productCells(product, descriptions.get(product.id) ?? '');
      const media = productMediaCells(product);
      const own = variants.get(product.id) ?? [];
      if (own.length === 0) {
        rows.push([...base, ...NO_VARIANT_CELLS, ...media, ...NO_VARIANT_EXTRA_CELLS]);
        continue;
      }
      for (const variant of own) {
        rows.push([
          ...base,
          ...variantCells(variant, stock.get(variant.id)),
          ...media,
          ...variantExtraCells(variant),
        ]);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  /*
   * `escapeFormulae` because a spreadsheet treats a cell beginning `=`, `+`,
   * `-` or `@` as a formula — a product titled `=HYPERLINK("http://evil",…)`
   * would otherwise export as a live formula that runs when the next admin
   * opens the file in Excel or Sheets. papaparse prefixes such a cell with a
   * `'`, which the reimport trims back off (`cell()`), so the round trip is
   * unaffected.
   */
  const csv = Papa.unparse({ fields: [...CSV_COLUMNS], data: rows }, { escapeFormulae: true });
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
  /** '' = clear the assignment. An id naming no committed image is refused by
   *  `checkVariantImage` and reported on this row. */
  imageId: string;
  /** '' = clear. Normalised to lowercase `#rrggbb` here so the row, not the
   *  repository, is where a bad swatch is named. */
  colorHex: string;
  /** null = empty cell, which CLEARS the weight (export writes '' for NULL). */
  weightGrams: number | null;
  /** null = empty cell, which CLEARS the override so delivery rejoins the
   *  displayed weight (migration 1180). The export writes '' for a stored
   *  NULL, which is what keeps the round trip stable. */
  shippingWeightGrams: number | null;
  /** null = no cell; a variant's order is otherwise left where it is. */
  position: number | null;
  /** '' = no cell. `discontinued` retires a variant without deleting it. */
  status: '' | 'active' | 'discontinued';
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
  coverImageId: string;
  imageIds: string[];
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
const VARIANT_STATUSES = new Set(['active', 'discontinued']);

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
/**
 * The columns a file actually CARRIES, as an allow-list the update path reads.
 *
 * THIS IS THE FIX FOR THE SILENT-WIPE BUG. An absent column and a present-but-
 * blank cell both read as `''` through `cell()`, and on update `''` is the
 * CLEAR instruction — so importing the app's own bulk-price file
 * (`Handle,Title,Variant SKU,Variant Price`) would erase category, tags, SEO,
 * overview and every variant's options on the products it touched, and report
 * a clean success. Shopify leaves omitted columns untouched; so must this. A
 * column NOT in this set is "leave alone", never "clear".
 */
export type PresentColumns = Set<(typeof CSV_COLUMNS)[number]>;

function parseImportRows(csv: string): {
  rows: ImportRow[];
  invalid: CsvProblem[];
  total: number;
  present: PresentColumns;
} {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.data.length > MAX_IMPORT_ROWS) throw new BadRequestError('too_many_rows');

  const present: PresentColumns = new Set(
    (parsed.meta.fields ?? []).filter((f): f is (typeof CSV_COLUMNS)[number] =>
      (CSV_COLUMNS as readonly string[]).includes(f),
    ),
  );

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

    /*
     * SLUGIFIED, so `Case-Spool` matches an existing `case-spool` instead of
     * creating a duplicate the way the raw-string compare did — the create
     * path slugifies too, so an un-normalised handle matched nothing and then
     * took a `-2` suffix off the uniqueness ladder. `slugify('')` is
     * `'untitled'`, so a blank or all-punctuation handle is caught FIRST and
     * reported rather than silently becoming a product named "untitled".
     */
    const rawHandle = cell(raw, 'Handle');
    const handle = rawHandle === '' ? '' : slugify(rawHandle);
    if (rawHandle === '') problems.push('missing Handle');
    else if (handle === 'untitled' && !/[a-z0-9]/i.test(rawHandle.normalize('NFKD'))) {
      problems.push(`Handle "${rawHandle}" has no usable characters`);
    }

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

    /*
     * `#rrggbb`, lowercased, `#` optional on the way in — a spreadsheet author
     * typing `d3d3d3` means the same colour, and refusing it would be pedantry.
     * Checked HERE rather than left to `normalizeColorHex` so the complaint
     * names the offending value on its own line instead of arriving as
     * "refused: colorHex" with no clue which row.
     */
    const colorRaw = cell(raw, 'Variant Color Hex');
    let colorHex = '';
    if (colorRaw !== '') {
      const hex = colorRaw.startsWith('#') ? colorRaw.toLowerCase() : `#${colorRaw.toLowerCase()}`;
      if (!/^#[0-9a-f]{6}$/.test(hex)) problems.push(`bad Variant Color Hex "${colorRaw}"`);
      else colorHex = hex;
    }

    /** A non-negative integer cell, or a complaint naming it. */
    const readCount = (
      name:
        | 'Variant Stock'
        | 'Variant Weight Grams'
        | 'Variant Shipping Weight Grams'
        | 'Variant Position',
      max: number,
    ): number | null => {
      const value = cell(raw, name);
      if (value === '') return null;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
        problems.push(`bad ${name} "${value}"`);
        return null;
      }
      return parsed;
    };
    const weightGrams = readCount('Variant Weight Grams', 10_000_000);
    const shippingWeightGrams = readCount('Variant Shipping Weight Grams', 10_000_000);
    const position = readCount('Variant Position', 100_000);

    const variantStatusRaw = cell(raw, 'Variant Status').toLowerCase();
    if (variantStatusRaw !== '' && !VARIANT_STATUSES.has(variantStatusRaw)) {
      problems.push(`unknown Variant Status "${variantStatusRaw}" (active or discontinued)`);
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
      coverImageId: cell(raw, 'Product Image'),
      imageIds: cell(raw, 'Product Gallery')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
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
              imageId: cell(raw, 'Variant Image'),
              colorHex,
              weightGrams,
              shippingWeightGrams,
              position,
              status: variantStatusRaw as CsvVariantInput['status'],
            },
    });
  });

  return { rows, invalid, total: parsed.data.length, present };
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
/**
 * What each handle names TODAY: a live product, a trashed one, or nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE TWO LOOKUPS USED TO FILTER `deleted_at IS NULL`, AND THAT MINTED TWINS.
 *
 * Watched happen on production 2026-09-04: export at 19:47:13, product moved
 * to the trash at 19:47:29, the same file imported at 19:47:39. Trash is a
 * SOFT delete — the row keeps its slug and its variants keep their SKUs — but
 * a lookup that cannot see it reports "no such handle", so the import created
 * a NEW product, which had to take the slug `…-2-2` because the trashed row
 * still holds the original. Then `createVariant` was refused by
 * `shop_variants_sku_unique`, because that same trashed row still owns the
 * SKU. The result was a nameless duplicate that could never hold a variant,
 * and the only hint was one line in `invalid`.
 *
 * `shop_products_slug_unique` is across the WHOLE table, trash included, so a
 * handle names at most one product and this answer is never ambiguous.
 * ═══════════════════════════════════════════════════════════════════════════
 */
type SlugState = 'live' | 'trashed';

async function slugStates(db: Db, slugs: string[]): Promise<Map<string, SlugState>> {
  const states = new Map<string, SlugState>();
  if (slugs.length === 0) return states;
  const res = await db.execute(sql`
    SELECT slug, deleted_at FROM shop_products
     WHERE slug = ANY(${sql.param(slugs)}::text[])`);
  for (const row of res.rows) {
    if (row.slug == null) continue;
    states.set(String(row.slug), row.deleted_at == null ? 'live' : 'trashed');
  }
  return states;
}

async function productBySlug(
  db: Db,
  slug: string,
): Promise<{ id: string; status: string; trashed: boolean } | null> {
  const res = await db.execute(sql`
    SELECT id, status, deleted_at FROM shop_products WHERE slug = ${slug}`);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status),
    trashed: row.deleted_at != null,
  };
}

/**
 * ONE sentence, used by BOTH preview and apply, so the modal cannot promise
 * something the apply then does differently. Refusing is the owner's call
 * (2026-09-04): an import that silently un-trashed products would bring back
 * things somebody deliberately deleted, and it would do it a thousand rows at
 * a time.
 */
function trashedHandleProblem(handle: string): string {
  return `handle "${handle}" is in the trash — restore that product first, or give this row a different Handle`;
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
      imageId: input.imageId || null,
      colorHex: input.colorHex || null,
      weightGrams: input.weightGrams,
      shippingWeightGrams: input.shippingWeightGrams,
      // Omitted rather than passed as null: `createVariant` appends to the end
      // of the product when it is absent, and a file that carries no position
      // column must not pile every new variant onto index 0.
      ...(input.position === null ? {} : { position: input.position }),
    },
    actor,
  );
  /*
   * Status is a SECOND write because `createVariant` always makes an active
   * one — there is no `status` on its input, and a variant exported as
   * discontinued must come back discontinued rather than quietly for sale.
   */
  if (input.status === 'discontinued') {
    await updateVariant(db, variant.id, { status: 'discontinued' });
  }
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

/**
 * The product-fields patch a group's head row describes, keyed on which
 * columns the FILE actually carried (`present`). A column that is present and
 * blank clears the field (empty SEO/overview → null, matching what export
 * writes for a stored NULL — that symmetry is the round trip); a column that
 * is ABSENT is left untouched, so a partial file (the app's own bulk-price
 * export) updates only what it names. `Title` is always safe to include: a
 * group with no title was already refused whole by `groupRows`.
 */
function headPatch(head: ImportRow, present: PresentColumns): ProductPatch {
  const patch: ProductPatch = { title: head.title };
  if (present.has('Category')) patch.category = head.category;
  if (present.has('Tags')) patch.tags = head.tags;
  if (present.has('SEO Title')) patch.seoTitle = head.seoTitle || null;
  if (present.has('SEO Description')) patch.seoDescription = head.seoDescription || null;
  if (present.has('Overview')) patch.overview = head.overview || null;
  if (present.has('Product Image')) patch.coverImageId = head.coverImageId || null;
  if (present.has('Product Gallery')) patch.imageIds = head.imageIds;
  return patch;
}

async function applyCreate(
  db: Db,
  group: ImportGroup,
  present: PresentColumns,
  actor: AuthUser,
  invalid: CsvProblem[],
): Promise<void> {
  const head = group.head;
  const product = await createProduct(db, actor, {
    ...headPatch(head, present),
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
    ...(head.description === '' ? {} : { description: htmlToDoc(head.description) }),
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
  present: PresentColumns,
  actor: AuthUser,
  invalid: CsvProblem[],
): Promise<void> {
  const head = group.head;
  const patch = headPatch(head, present);

  /*
   * DESCRIPTION: TWO GUARDS, AND BOTH EARNED THEIR PLACE THE HARD WAY.
   *
   * 1. An EMPTY cell never overwrites. A blank cannot honestly mean "delete
   *    this product's copy" — a partial file simply does not carry it.
   * 2. A cell EQUAL TO the stored document's own HTML is skipped, so the
   *    document is never even PARSED, let alone rewritten. This is the guard
   *    that makes export → import provably harmless for descriptions: whatever
   *    `doc-html.ts` does or does not represent, a file nobody edited cannot
   *    change a description, because the bytes are compared before anything is
   *    parsed. (The product ROW is still saved — title, category and the rest
   *    are authoritative on every import — so `revision` does advance by one.
   *    What cannot move is the description.)
   *
   * The old code had neither half working: the export wrote flattened text
   * into every row, so the non-empty test always passed, and the import then
   * replaced a rich document with one paragraph. That is what happened to two
   * live products on 2026-09-04.
   */
  if (head.description !== '') {
    const current = await getProduct(db, existing.id);
    if (current === null || head.description !== docToHtml(current.description)) {
      patch.description = htmlToDoc(head.description);
    }
  }

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

      /*
       * ONLY the variant fields the file actually carried. Without the
       * presence gate, importing a bulk-price file (Options/Compare/Cost
       * columns absent) would wipe every touched variant's option identity to
       * `{}` — a `DuplicateOptionsError` on the second variant and a broken
       * variant picker on the storefront. Present-and-blank still clears
       * (the round-trip symmetry); absent leaves alone.
       */
      const variantPatch: VariantPatch = {};
      if (present.has('Variant Options')) variantPatch.optionValues = input.optionValues;
      if (present.has('Variant Compare At Price')) {
        variantPatch.compareAtMinor = input.compareAtMinor;
      }
      if (present.has('Variant Cost')) variantPatch.costMinor = input.costMinor;
      if (present.has('Variant Image')) variantPatch.imageId = input.imageId || null;
      if (present.has('Variant Color Hex')) variantPatch.colorHex = input.colorHex || null;
      if (present.has('Variant Weight Grams')) variantPatch.weightGrams = input.weightGrams;
      if (present.has('Variant Shipping Weight Grams')) {
        variantPatch.shippingWeightGrams = input.shippingWeightGrams;
      }
      if (input.position !== null) variantPatch.position = input.position;
      if (input.status !== '') variantPatch.status = input.status;
      if (input.backorderable !== null) variantPatch.backorderable = input.backorderable;
      if (Object.keys(variantPatch).length > 0) await updateVariant(db, match.id, variantPatch);

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
   * `adminOrigin()`, never the Host header and no longer `origins[0]`.
   *
   * Not the header for the reason this comment always gave: it is
   * attacker-controlled on any deployment that does not pin it, and a tokened
   * URL built from one is a credential delivered to a domain the attacker
   * chose.
   *
   * Not `origins[0]` because it is an allow-list, not an address — its order
   * is nobody's decision and its entries include every deploy alias. This link
   * still WORKED from one, since it hits the API rather than the Clerk-gated
   * app, which is precisely why it could sit wrong indefinitely: the day an
   * alias is retired, exports already emailed break. `server/admin-url.ts`
   * carries the account of how the invite link learned this the hard way.
   */
  const url = `${adminOrigin()}/api/shop/admin/products/exports/${id}/download?token=${encodeURIComponent(token)}`;

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

  const { rows, invalid, total, present } = parseImportRows(body.csv);
  const groups = groupRows(rows, invalid);

  if (body.mode === 'preview') {
    const states = await slugStates(
      db,
      groups.map((group) => group.handle),
    );
    let creates = 0;
    let updates = 0;
    let skips = 0;
    for (const group of groups) {
      const state = states.get(group.handle);
      if (state === 'trashed') {
        // Counted as neither create nor update: apply refuses this row, and
        // the preview has to say the same thing.
        invalid.push({ line: group.line, problem: trashedHandleProblem(group.handle) });
        continue;
      }
      if (state === 'live') {
        /* Preview must agree with apply: with `replace` off, an existing
         * handle is a SKIP, not an update — otherwise the modal promises
         * changes apply will not make. */
        if (body.replace) updates += 1;
        else skips += 1;
      } else creates += 1;
    }
    return c.json({ creates, updates, skips, invalid, total });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const group of groups) {
    // Looked up per group AT APPLY TIME rather than reusing a preview's set:
    // apply decides against the catalogue as it stands now, not as it stood
    // when somebody previewed — and one code path cannot disagree with itself.
    const existing = await productBySlug(db, group.handle);
    /*
     * A TRASHED HANDLE IS REFUSED, NEVER CREATED AROUND. Falling through to
     * the create below is what produced the `…-2-2` duplicate on production;
     * see `slugStates`. Restoring it here instead was considered and declined
     * by the owner — an import must not un-delete.
     */
    if (existing?.trashed) {
      invalid.push({ line: group.line, problem: trashedHandleProblem(group.handle) });
      continue;
    }
    if (existing && !body.replace) {
      skipped += 1;
      continue;
    }
    try {
      if (existing) {
        await applyUpdate(db, existing, group, present, actor, invalid);
        updated += 1;
      } else {
        await applyCreate(db, group, present, actor, invalid);
        created += 1;
      }
    } catch (err) {
      invalid.push({ line: group.line, problem: problemOf(err) });
    }
  }

  return c.json({ applied: true, created, updated, skipped, invalid });
});
