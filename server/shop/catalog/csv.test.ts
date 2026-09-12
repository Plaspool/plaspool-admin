import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { httpClient, json, TEST_ORIGIN } from '../../test/http';
import { DEFAULT_ADMIN_ORIGIN } from '../../admin-url';
import type { HttpClient } from '../../test/http';
import type { Mailer } from '../../mail/port';
import { registerCsvMailer, resetCsvMailer } from './csv';

/**
 * CSV export and import (migration 0720), driven through the REAL app — §2's
 * rule: the seam between the repository and HTTP is what this task adds, so
 * the suite goes through createApp(), the origin guard, the session
 * middleware and the shop app's error rendering, never a test app with its
 * own registrations.
 *
 * The actor is ctx.users.writer — since migration 0680 the products domain is
 * a writer's, and driving the suite as the least-privileged role that may use
 * the feature is what catches a gate rule drifting.
 */

/*
 * SPELLED OUT RATHER THAN BUILT FROM `CSV_COLUMNS`, because the header IS the
 * contract — a file a person exported last week has to keep importing. Deriving
 * it from the source would make this assertion agree with any change, including
 * one that reorders the columns and silently lands prices in the stock column.
 * The appended block (Product Image onward) is the media and variant-setup work
 * of 2026-09-04; the first sixteen have not moved.
 */
const HEADER =
  'Handle,Title,Status,Category,Tags,Description,Overview,SEO Title,SEO Description,' +
  'Variant SKU,Variant Options,Variant Price,Variant Compare At Price,Variant Cost,' +
  'Variant Stock,Variant Backorderable,' +
  'Product Image,Product Gallery,Variant Image,Variant Color Hex,' +
  'Variant Weight Grams,Variant Position,Variant Status,' +
  'Variant Shipping Weight Grams';

const EXPORT_PATH = '/api/shop/admin/products/export';
const IMPORT_PATH = '/api/shop/admin/products/import';

let ctx: TestCtx;
let http: HttpClient;

/** Everything the seam delivered, per test. */
const recorder = {
  sent: [] as { to: string; subject: string; text: string; html: string }[],
  mailer(): Mailer {
    return {
      assertConfigured: () => {},
      send: async (msg) => {
        recorder.sent.push(msg);
      },
    };
  },
};

beforeAll(async () => {
  ctx = await freshDb();
  http = httpClient(ctx.db);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(() => {
  // The registry rule from csv.ts (mirrored from registerClerkVerifier):
  // reset every test, then arm the recorder as this suite's default so a
  // test that forgets is exercising an unconfigured transport, not a leak
  // from its neighbour.
  resetCsvMailer();
  recorder.sent.length = 0;
  registerCsvMailer(recorder.mailer());
});

async function login(): Promise<void> {
  await http.signIn(ctx.users.writer);
}

function doc(text: string): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

interface AdminVariant {
  id: string;
  sku: string;
  optionValues: Record<string, string>;
  price: { amount: number; currency: string } | null;
  compareAtMinor: number | null;
  costMinor: number | null;
  available: number | null;
  backorderable: boolean;
}

interface AdminProduct {
  id: string;
  slug: string | null;
  title: string;
  status: string;
  category: string;
  tags: string[];
  description: unknown;
  seoTitle: string | null;
  seoDescription: string | null;
  overview: string | null;
  variants: AdminVariant[];
}

async function adminProductBySlug(slug: string): Promise<AdminProduct> {
  const list = await http.get('/api/shop/admin/products');
  expect(list.status).toBe(200);
  const page = await json<{ items: { id: string; slug: string | null }[] }>(list);
  const row = page.items.find((item) => item.slug === slug);
  expect(row, `no product with slug ${slug} in the admin list`).toBeTruthy();
  const res = await http.get(`/api/shop/admin/products/${row!.id}`);
  expect(res.status).toBe(200);
  return (await json<{ product: AdminProduct }>(res)).product;
}

// ============================================================================

/**
 * THE ONE THING IN THIS FILE THAT VITEST CANNOT ANSWER FOR — how `papaparse`
 * loads in production.
 *
 * `vite.server.config.ts` builds the function with `ssr`, which externalises
 * everything in node_modules: the bundle keeps the papaparse import verbatim
 * and NODE'S OWN ESM LOADER resolves it on the deployment. Vitest does not —
 * vite-node interops a CommonJS dependency so that the default AND every named
 * export resolve, whichever import form you write.
 *
 * That divergence took POST /api/shop/admin/products/export down in production
 * — 500 {"error":"internal"} — while every test below passed. csv.ts said
 * `import * as Papa from 'papaparse'`, and papaparse is a UMD CommonJS module
 * whose exports cjs-module-lexer cannot see, so under Node the namespace is
 * ['default', 'module.exports'] and nothing else. Papa.unparse was undefined
 * on every deployment this feature ever had, and import was equally dead:
 * Papa.parse is the same undefined.
 *
 * So this runs the import line csv.ts actually contains, in a real node, and
 * dereferences the members csv.ts actually uses. Both are read out of the
 * source rather than restated here, so the test cannot pass while the code
 * says something else.
 */
describe('papaparse under the production module loader', () => {
  it("resolves every member csv.ts uses, with csv.ts's own import line", () => {
    const source = readFileSync('server/shop/catalog/csv.ts', 'utf8');

    const importLine = source.match(/^import .*from 'papaparse';$/m)?.[0]?.trim();
    expect(importLine, 'no papaparse import found in csv.ts').toBeTruthy();

    const local = importLine!.match(/^import (?:\* as )?(\w+)/)![1];
    // The call sites — Papa.unparse, Papa.parse — not the import.
    const used = [
      ...new Set(
        [...source.matchAll(new RegExp(String.raw`\b${local}\.(\w+)`, 'g'))].map((m) => m[1]),
      ),
    ];
    expect(used.length, `csv.ts dereferences nothing on ${local}`).toBeGreaterThan(0);

    const probe = [
      importLine!,
      `const used = ${JSON.stringify(used)};`,
      `const kinds = Object.fromEntries(used.map((k) => [k, typeof ${local}?.[k]]));`,
      'console.log(JSON.stringify(kinds));',
    ].join(' ');

    /*
     * `--input-type=module -e`, not a temp file: Node resolves a bare
     * specifier from the IMPORTING FILE's own directory, so a probe written
     * to the OS temp dir cannot see node_modules at all and dies with
     * ERR_MODULE_NOT_FOUND — a red test that proves nothing. An --eval module
     * resolves from cwd, which vitest runs at the repo root: the same
     * node_modules the deployment ships.
     */
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim())).toEqual(
      Object.fromEntries(used.map((name) => [name, 'function'])),
    );
  }, 30_000);
});

// ============================================================================

describe('export', () => {
  let exportId = '';
  let exportUrl = '';
  let exportCsv = '';

  beforeAll(async () => {
    await login();

    // Product A: everything the columns can carry.
    const a = await http.post('/api/shop/admin/products', {
      title: 'Amber Spool',
      category: 'Fibre',
      tags: ['pla'],
      description: doc('Amber description text'),
      seoTitle: 'Amber SEO title',
      seoDescription: 'Amber SEO description',
      overview: 'Best amber there is',
    });
    expect(a.status).toBe(201);
    const productA = (await json<{ product: { id: string } }>(a)).product;

    const v = await http.post(`/api/shop/admin/products/${productA.id}/variants`, {
      sku: 'AMB-1',
      optionValues: { Color: 'Amber' },
      onHand: 5,
      backorderable: true,
      compareAtMinor: 2_500_000,
      costMinor: 1_000_000,
    });
    expect(v.status).toBe(201);
    const variant = (await json<{ variant: { id: string } }>(v)).variant;

    const price = await http.put(`/api/shop/admin/variants/${variant.id}/price`, {
      amount: 2_350_000,
      currency: 'NGN',
      reason: 'seed',
    });
    expect(price.status).toBe(200);

    // Product B: variantless — exports as ONE row with empty variant cells.
    const b = await http.post('/api/shop/admin/products', { title: 'Bare Spool' });
    expect(b.status).toBe(201);
  });

  it('is 401 without a session', async () => {
    http.clearCookies();
    const res = await http.post(EXPORT_PATH, {});
    expect(res.status).toBe(401);
    await login();
  });

  it('builds the CSV, stores the row, and emails the requester the link', async () => {
    const res = await http.post(EXPORT_PATH, {});
    expect(res.status).toBe(201);
    const body = await json<{
      export: { id: string; rowCount: number; url: string };
      emailed: boolean;
    }>(res);

    // One row per variant: A has one variant, B has none — one row each.
    expect(body.export.rowCount).toBe(2);
    expect(body.emailed).toBe(true);
    expect(body.export.id).toMatch(/^exp_/);
    /*
     * THE ADMIN'S OWN ORIGIN, never a Host header and no longer `origins[0]`.
     * `TEST_ORIGIN` is both what `createApp` got and what the allow-list holds,
     * so the assertion this replaces passed for a link built the wrong way —
     * see `server/admin-url.ts` for the invitation that shipped pointing at a
     * deploy alias. The download below is driven by pathname, so the origin is
     * asserted here and nowhere else.
     */
    expect(body.export.url).toBe(
      `${DEFAULT_ADMIN_ORIGIN}/api/shop/admin/products/exports/${body.export.id}` +
        `/download?token=${new URL(body.export.url).searchParams.get('token') ?? ''}`,
    );
    expect(body.export.url).not.toContain(TEST_ORIGIN);
    exportId = body.export.id;
    exportUrl = body.export.url;

    // The stored row snapshots who asked and where the mail went.
    const stored = await ctx.db.execute(sql`
      SELECT requested_email, row_count, csv FROM product_exports WHERE id = ${exportId}`);
    expect(stored.rows).toHaveLength(1);
    expect(String(stored.rows[0].requested_email)).toBe(ctx.users.writer.email);
    expect(Number(stored.rows[0].row_count)).toBe(2);

    // The mail: rendered from the catalog.export system template, carrying
    // the download link and the row count.
    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0].to).toBe(ctx.users.writer.email);
    expect(recorder.sent[0].subject).toBe('Your product export is ready');
    expect(recorder.sent[0].text).toContain(exportUrl);
    expect(recorder.sent[0].text).toContain('2 rows');
  });

  it('a cold client downloads with the token; the CSV round-trips as pure updates', async () => {
    const target = new URL(exportUrl);
    http.clearCookies(); // the link lands in inboxes: no session, no cookies

    const res = await http.get(target.pathname + target.search);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="plaspool-products-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    exportCsv = await res.text();
    const lines = exportCsv.split(/\r?\n/).filter((line) => line !== '');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(3); // header + two data rows

    const amber = lines.find((line) => line.includes('AMB-1'));
    expect(amber).toBeTruthy();
    // Major units with two decimals, on all three money columns.
    expect(amber).toContain('23500.00');
    expect(amber).toContain('25000.00');
    expect(amber).toContain('10000.00');
    // Options JSON-encoded (papaparse doubles the quotes inside the cell).
    expect(amber).toContain('""Color"":""Amber""');
    // The absolute stock and the flag.
    expect(amber).toContain(',5,true');
    // The plain-text description travelled.
    expect(amber).toContain('Amber description text');

    const bare = lines.find((line) => line.includes('bare-spool'));
    expect(bare).toBeTruthy();
    expect(bare).toContain('Bare Spool');

    // Round trip: what was exported previews as ZERO creates — every handle
    // already exists — with nothing invalid.
    await login();
    const preview = await http.post(IMPORT_PATH, { csv: exportCsv, mode: 'preview' });
    expect(preview.status).toBe(200);
    expect(await json(preview)).toMatchObject({ creates: 0, updates: 2, invalid: [] });
  });

  it('keeps the FIRST downloaded_at across repeat downloads', async () => {
    const target = new URL(exportUrl);
    const first = await ctx.db.execute(sql`
      SELECT downloaded_at FROM product_exports WHERE id = ${exportId}`);
    const stamp = first.rows[0].downloaded_at;
    expect(stamp).not.toBeNull();

    const again = await http.get(target.pathname + target.search);
    expect(again.status).toBe(200);
    const second = await ctx.db.execute(sql`
      SELECT downloaded_at FROM product_exports WHERE id = ${exportId}`);
    expect(String(second.rows[0].downloaded_at)).toBe(String(stamp));
  });

  it('404s without a token, and with a tampered one', async () => {
    const target = new URL(exportUrl);
    http.clearCookies();

    const bare = await http.get(target.pathname);
    expect(bare.status).toBe(404);

    const token = target.searchParams.get('token')!;
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    const res = await http.get(`${target.pathname}?token=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(404);

    await login();
  });

  it('404s once the row is older than seven days', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await ctx.db.execute(sql`
      UPDATE product_exports SET created_at = ${eightDaysAgo} WHERE id = ${exportId}`);
    const target = new URL(exportUrl);
    const res = await http.get(target.pathname + target.search);
    expect(res.status).toBe(404);
  });

  it('answers emailed:false with the URL intact when the mailer is not configured', async () => {
    registerCsvMailer({
      assertConfigured: () => {
        throw new Error('mail is not configured');
      },
      send: async () => {
        throw new Error('unreachable');
      },
    });
    const res = await http.post(EXPORT_PATH, {});
    expect(res.status).toBe(201);
    const body = await json<{ export: { url: string }; emailed: boolean }>(res);
    // The deliverInvite pattern: the URL is the feature, the mail is the
    // convenience — an unconfigured transport must not cost the export.
    expect(body.emailed).toBe(false);
    expect(body.export.url).toContain('/download?token=');
  });
});

// ============================================================================

describe('import', () => {
  beforeAll(login);

  it('is 401 without a session', async () => {
    http.clearCookies();
    const res = await http.post(IMPORT_PATH, { csv: HEADER, mode: 'preview' });
    expect(res.status).toBe(401);
    await login();
  });

  it('refuses a file past MAX_IMPORT_ROWS with a 400', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `cap-${i},Capped`);
    const res = await http.post(IMPORT_PATH, {
      csv: [HEADER, ...rows].join('\n'),
      mode: 'preview',
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: 'bad_request', detail: 'too_many_rows' });
  });

  it('matches an existing handle case- and punctuation-insensitively — no duplicate', async () => {
    /* THE BLOCKING BUG: the raw-string matcher created `case-spool` AND
     * `case-spool-2` when the file's Handle differed only in case. The slugify
     * on both sides now makes `Case-Spool` update the existing `case-spool`. */
    await http.post(IMPORT_PATH, {
      csv: [HEADER, 'case-spool,Case Spool,active,,,,,,,CS-1,,1000.00,,,3,false'].join('\n'),
      mode: 'apply',
    });
    const before = await adminProductBySlug('case-spool');

    const res = await http.post(IMPORT_PATH, {
      csv: [HEADER, 'Case-Spool,Case Spool Renamed,active,,,,,,,CS-1,,1500.00,,,5,false'].join('\n'),
      mode: 'apply',
    });
    expect(await json(res)).toMatchObject({ created: 0, updated: 1, invalid: [] });

    /* Still exactly one product under the slug, updated in place. */
    const after = await adminProductBySlug('case-spool');
    expect(after.id).toBe(before.id);
    expect(after.title).toBe('Case Spool Renamed');
    const strays = await http.get('/api/shop/admin/products?status=active');
    const slugs = (await json<{ items: { slug: string }[] }>(strays)).items.map((p) => p.slug);
    expect(slugs.filter((s) => s === 'case-spool-2')).toHaveLength(0);
  });

  it('a partial-column file updates only what it names and wipes nothing', async () => {
    /* THE OTHER BLOCKING BUG: importing the app's own bulk-price shape
     * (Handle,Title,Variant SKU,Variant Price) used to blank category, tags,
     * SEO, overview and the variant's option identity, reporting clean
     * success. Absent columns must now be left alone. */
    await http.post(IMPORT_PATH, {
      csv: [
        HEADER,
        'rich-spool,Rich Spool,active,Fibre,"pla, blue",A rich spool.,An overview,' +
          'The SEO title,The SEO description,RICH-1,"{""Color"":""Blue""}",2000.00,,,7,false',
      ].join('\n'),
      mode: 'apply',
    });

    const partial = 'Handle,Title,Variant SKU,Variant Price';
    const res = await http.post(IMPORT_PATH, {
      csv: [partial, 'rich-spool,Rich Spool,RICH-1,2500.00'].join('\n'),
      mode: 'apply',
    });
    expect(await json(res)).toMatchObject({ updated: 1, invalid: [] });

    const product = await adminProductBySlug('rich-spool');
    /* Everything the partial file did NOT name survives. */
    expect(product.category).toBe('Fibre');
    expect(product.tags).toEqual(['pla', 'blue']);
    expect(product.seoTitle).toBe('The SEO title');
    expect(product.overview).toBe('An overview');
    expect(product.description).toEqual(doc('A rich spool.'));
    expect(product.variants[0].optionValues).toEqual({ Color: 'Blue' });
    expect(product.variants[0].compareAtMinor).toBeNull();
    /* The one thing it DID name moved. */
    expect(product.variants[0].price).toEqual({ amount: 250_000, currency: 'NGN' });
  });

  it('creates a product with variant, options, price, stock and status — verifiable through the admin read', async () => {
    const csv = [
      HEADER,
      'imported-spool,Imported Spool,active,Fibre,"pla, red",A fine spool of PLA.,' +
        'Short overview,Imported SEO title,Imported SEO description,' +
        'IMP-1,"{""Color"":""Red""}",23500.00,25000.00,19975.00,12,true',
    ].join('\n');

    const preview = await http.post(IMPORT_PATH, { csv, mode: 'preview' });
    expect(preview.status).toBe(200);
    expect(await json(preview)).toMatchObject({
      creates: 1,
      updates: 0,
      invalid: [],
      total: 1,
    });

    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      applied: true,
      created: 1,
      updated: 0,
      skipped: 0,
      invalid: [],
    });

    const product = await adminProductBySlug('imported-spool');
    expect(product.title).toBe('Imported Spool');
    expect(product.status).toBe('active'); // through the real publish transition
    expect(product.category).toBe('Fibre');
    expect(product.tags).toEqual(['pla', 'red']);
    expect(product.seoTitle).toBe('Imported SEO title');
    expect(product.seoDescription).toBe('Imported SEO description');
    expect(product.overview).toBe('Short overview');
    // The description round trip: the CSV's plain text is stored as a
    // single-paragraph document and comes back through the admin read.
    expect(product.description).toEqual(doc('A fine spool of PLA.'));

    expect(product.variants).toHaveLength(1);
    const variant = product.variants[0];
    expect(variant.sku).toBe('IMP-1');
    expect(variant.optionValues).toEqual({ Color: 'Red' });
    // Major-units cells became minor units at the boundary: 23500.00 → 2350000.
    expect(variant.price).toEqual({ amount: 2_350_000, currency: 'NGN' });
    expect(variant.compareAtMinor).toBe(2_500_000);
    expect(variant.costMinor).toBe(1_997_500);
    expect(variant.available).toBe(12); // nothing reserved, so available = onHand
    expect(variant.backorderable).toBe(true);
  });

  it('replace=true (the default) updates title, price and stock on an existing handle — and an empty Description cell does not wipe the document', async () => {
    const csv = [
      HEADER,
      'imported-spool,Imported Spool Mk2,active,Fibre,"pla, red",,' +
        'Short overview,Imported SEO title,Imported SEO description,' +
        'IMP-1,"{""Color"":""Red""}",30000.00,25000.00,19975.00,4,true',
    ].join('\n');

    const preview = await http.post(IMPORT_PATH, { csv, mode: 'preview' });
    expect(await json(preview)).toMatchObject({ creates: 0, updates: 1, invalid: [] });

    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      applied: true,
      created: 0,
      updated: 1,
      skipped: 0,
      invalid: [],
    });

    const product = await adminProductBySlug('imported-spool');
    expect(product.title).toBe('Imported Spool Mk2');
    // The blank cell left the stored document alone — it must NOT become an
    // empty paragraph or wipe what a rich editor wrote.
    expect(product.description).toEqual(doc('A fine spool of PLA.'));

    const variant = product.variants[0];
    expect(variant.price).toEqual({ amount: 3_000_000, currency: 'NGN' });
    expect(variant.available).toBe(4); // absolute stock applied as a delta
  });

  it('replace=false skips the existing handle and counts it', async () => {
    const csv = [
      HEADER,
      'imported-spool,Never Applied,draft,,,,,,,IMP-1,,10.00,,,1,false',
    ].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply', replace: false });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      applied: true,
      created: 0,
      updated: 0,
      skipped: 1,
      invalid: [],
    });
    const product = await adminProductBySlug('imported-spool');
    expect(product.title).toBe('Imported Spool Mk2');
  });

  it('a row with a bad price lands in invalid and does not abort the others', async () => {
    const csv = [
      HEADER,
      'good-spool,Good Spool,draft,,,,,,,GOOD-1,,15000.00,,,3,false',
      'bad-spool,Bad Spool,draft,,,,,,,BAD-1,,abc,,,3,false',
    ].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    const body = await json<{
      created: number;
      invalid: { line: number; problem: string }[];
    }>(res);
    expect(body.created).toBe(1);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0].line).toBe(2);
    expect(body.invalid[0].problem).toContain('Variant Price');

    const product = await adminProductBySlug('good-spool');
    expect(product.variants[0].price).toEqual({ amount: 1_500_000, currency: 'NGN' });
  });

  it('a row with a Handle but no Title is invalid', async () => {
    const csv = [HEADER, 'only-handle,,,,,,,,,,,,,,,'].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    const body = await json<{
      created: number;
      invalid: { line: number; problem: string }[];
    }>(res);
    expect(body.created).toBe(0);
    expect(body.invalid).toEqual([{ line: 1, problem: 'missing Title' }]);
  });

  it('an EMPTY Description cell stores exactly the default document createProduct stores', async () => {
    /*
     * ═══ THE 2026-08-27 LESSON, PINNED ═══
     * The control is a product created through the ORDINARY route with no
     * description at all — whatever createProduct stores as its default is
     * read back here, and the CSV-created product must match it by deep
     * equality. Deliberately NOT an assertion against a literal like
     * { type: 'doc', content: [] }: the day the default changes, this test
     * follows the application instead of enshrining a fixture-only shape —
     * which is precisely how every new product got an uneditable description
     * once before.
     */
    const control = await http.post('/api/shop/admin/products', { title: 'Control Product' });
    expect(control.status).toBe(201);
    const controlId = (await json<{ product: { id: string } }>(control)).product.id;
    const controlRead = await http.get(`/api/shop/admin/products/${controlId}`);
    const controlDoc = (await json<{ product: { description: unknown } }>(controlRead)).product
      .description;
    expect(controlDoc).toBeTruthy();

    const csv = [HEADER, 'blank-desc,Blank Desc Product,,,,,,,,,,,,,,'].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ created: 1, invalid: [] });

    const product = await adminProductBySlug('blank-desc');
    expect(product.status).toBe('draft'); // empty Status cell leaves the default
    expect(product.description).toEqual(controlDoc);
  });
});

// ============================================================================

/**
 * THE 2026-09-04 REGRESSION: THE ROUND TRIP USED TO FLATTEN DESCRIPTIONS AND
 * DROP EVERY PICTURE.
 *
 * The `Description` column carried `description_text` — `docToText` output,
 * blocks already collapsed — and the import wrapped it in one paragraph, so
 * export → import destroyed every heading, list and bold run it touched. It did
 * that to PLA Silk and PLA Basic in production. There was no image column at
 * all, so a variant's photograph, its swatch, its weight, its order and its
 * active/discontinued state were simply absent from the file.
 *
 * These tests drive the real routes end to end: export the catalogue, feed the
 * exported bytes straight back to import, and read the product through the
 * admin API. Anything the format cannot carry shows up as a difference.
 */
describe('lossless round trip', () => {
  /** A description with the structure the flattening destroyed. */
  const richDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Key Features' }] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Glossy, silk-like finish' }] },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', marks: [{ type: 'bold' }], text: 'Material:' },
                  { type: 'text', text: ' Silk PLA' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const COVER = 'img_cover0000000000000000000000';
  const GALLERY = 'img_gallery00000000000000000000';
  const VARIANT_IMG = 'img_variant00000000000000000000';

  async function seedImage(id: string): Promise<string> {
    const now = Date.now();
    const owner = ctx.users.writer;
    await ctx.db.execute(sql`
      INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                          byte_size, checksum, created_at, committed_at, unreferenced_since)
      VALUES (${id}, ${owner.id}::uuid, ${`images/${owner.id}/${id}`},
              'image/png', NULL, NULL, 1000, NULL, ${now}, ${now}, NULL)`);
    return id;
  }

  /** The whole catalogue as the export writes it. */
  async function exportCsv(): Promise<string> {
    const res = await http.post(EXPORT_PATH, {});
    expect(res.status).toBe(201);
    const url = (await json<{ export: { url: string } }>(res)).export.url;
    const download = await http.get(url.replace(DEFAULT_ADMIN_ORIGIN, ''));
    expect(download.status).toBe(200);
    return await download.text();
  }

  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    await login();
    await ctx.db.execute(sql`DELETE FROM shop_products`);

    await seedImage(COVER);
    await seedImage(GALLERY);
    await seedImage(VARIANT_IMG);

    const created = await http.post('/api/shop/admin/products', {
      title: 'Silk Spool',
      category: 'Fibre',
      description: richDoc,
      coverImageId: COVER,
      imageIds: [GALLERY],
    });
    expect(created.status).toBe(201);
    productId = (await json<{ product: { id: string } }>(created)).product.id;

    const variant = await http.post(`/api/shop/admin/products/${productId}/variants`, {
      sku: 'SILK-YELLOW-1KG',
      optionValues: { Size: '1kg', Color: 'Yellow' },
      onHand: 7,
      imageId: VARIANT_IMG,
      colorHex: '#ffd700',
      weightGrams: 1200,
    });
    expect(variant.status).toBe(201);
    variantId = (await json<{ variant: { id: string } }>(variant)).variant.id;
  });

  it('exports the description as HTML, not as flattened text', async () => {
    const csv = await exportCsv();
    // The three things the old plain-text column could not carry.
    expect(csv).toContain('<h2>Key Features</h2>');
    expect(csv).toContain('<strong>Material:</strong>');
    expect(csv).toContain('<ul><li><p>Glossy, silk-like finish</p></li>');
  });

  it('exports the product media and the variant media and setup', async () => {
    const csv = await exportCsv();
    expect(csv).toContain(COVER);
    expect(csv).toContain(GALLERY);
    expect(csv).toContain(VARIANT_IMG);
    expect(csv).toContain('#ffd700');
    expect(csv).toContain('1200');
  });

  it('re-importing an untouched export leaves the description byte-identical', async () => {
    /*
     * The statement the old code could not make at all: the stored jsonb and
     * its derived text are compared, not "it looks the same afterwards".
     *
     * The product ROW is still written — an import is authoritative about
     * title, category, tags and the rest, so `revision` advances by one every
     * time. That is the pre-existing behaviour of `applyUpdate` and is not
     * what this work changed; the description not moving is.
     */
    const before = await ctx.db.execute(sql`
      SELECT description, description_text, overview_fallback FROM shop_products
       WHERE id = ${productId}`);
    const beforeVariant = await ctx.db.execute(sql`
      SELECT image_id, color_hex, weight_grams, position, status FROM shop_variants
       WHERE id = ${variantId}`);

    const res = await http.post(IMPORT_PATH, { csv: await exportCsv(), mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ created: 0, updated: 1, invalid: [] });

    const after = await ctx.db.execute(sql`
      SELECT description, description_text, overview_fallback FROM shop_products
       WHERE id = ${productId}`);
    const afterVariant = await ctx.db.execute(sql`
      SELECT image_id, color_hex, weight_grams, position, status FROM shop_variants
       WHERE id = ${variantId}`);

    // The document, and both values derived from it on write.
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(afterVariant.rows[0]).toEqual(beforeVariant.rows[0]);
  });

  it('preview reports the untouched export as pure updates', async () => {
    const res = await http.post(IMPORT_PATH, { csv: await exportCsv(), mode: 'preview' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ creates: 0, updates: 1, invalid: [] });
  });

  it('applies a description a person actually edited in the spreadsheet', async () => {
    const csv = await exportCsv();
    const edited = csv.replace('<h2>Key Features</h2>', '<h2>What You Get</h2>');
    expect(edited).not.toBe(csv);

    const res = await http.post(IMPORT_PATH, { csv: edited, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ updated: 1, invalid: [] });

    const product = await adminProductBySlug('silk-spool');
    const blocks = (product.description as { content: { type: string; content: { text: string }[] }[] })
      .content;
    expect(blocks[0]!.content[0]!.text).toBe('What You Get');
    // Still a heading with a list under it — the edit changed words, not shape.
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'bulletList']);
  });

  it('round trips a variant made discontinued in the file', async () => {
    const csv = await exportCsv();
    const rows = csv.split(/\r?\n/).filter((line) => line !== '');
    /* The Variant Status cell of the one data row — SECOND-TO-LAST since 1180
       appended a shipping-weight column, which is why the anchor carries the
       trailing cell with it. It cannot be a bare `/active/`: the PRODUCT's own
       Status cell holds the same word near the front of the line. */
    const before = rows[1]!;
    rows[1] = before.replace(/,active,(\d*)$/, ',discontinued,$1');
    expect(rows[1]).not.toBe(before); // the anchor still finds the cell
    const res = await http.post(IMPORT_PATH, { csv: rows.join('\n'), mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ updated: 1, invalid: [] });

    const after = await ctx.db.execute(sql`SELECT status FROM shop_variants WHERE id = ${variantId}`);
    expect(after.rows[0].status).toBe('discontinued');

    // And back, so the suite leaves the fixture as it found it.
    const restored = (await exportCsv()).replace(/discontinued/g, 'active');
    expect((await http.post(IMPORT_PATH, { csv: restored, mode: 'apply' })).status).toBe(200);
  });

  it('leaves the new fields alone when an OLD sixteen-column file is imported', async () => {
    /*
     * The whole reason the columns were APPENDED rather than inserted. A file
     * exported before this work has no media columns at all, and an absent
     * column means "leave alone" — never "clear", which would strip every
     * photograph off the catalogue and report a clean success.
     */
    const before = await ctx.db.execute(sql`
      SELECT image_id, color_hex, weight_grams FROM shop_variants WHERE id = ${variantId}`);
    const oldHeader = HEADER.split(',').slice(0, 16).join(',');
    const csv = [oldHeader, 'silk-spool,Silk Spool,,,,,,,,SILK-YELLOW-1KG,,,,,,'].join('\n');

    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ updated: 1, invalid: [] });

    const after = await ctx.db.execute(sql`
      SELECT image_id, color_hex, weight_grams FROM shop_variants WHERE id = ${variantId}`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const cover = await ctx.db.execute(sql`
      SELECT cover_image_id FROM shop_products WHERE id = ${productId}`);
    expect(cover.rows[0].cover_image_id).toBe(COVER);
  });

  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * THE SHIPPING WEIGHT SURVIVES ITS OWN ROUND TRIP (migration 1180).
   *
   * §2's rule, applied to the column this change adds: feed the export back in
   * and diff the STORED value, rather than reading the writer and the reader
   * and believing they agree. That is the exact test the old CSV code never
   * had, and its absence is what flattened two live descriptions.
   *
   * The trap specific to THIS column is the NULL. It means "price delivery on
   * the displayed weight", so an export that wrote the RESOLVED number would
   * come back as a real override — and one untouched export/import cycle would
   * pin every variant in the shop to whatever it happened to display that day,
   * reporting a clean success while doing it.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  it('round trips a shipping weight, and a NULL stays null rather than becoming an override', async () => {
    const read = async (): Promise<Record<string, unknown>> => {
      const res = await ctx.db.execute(sql`
        SELECT weight_grams, shipping_weight_grams FROM shop_variants WHERE id = ${variantId}`);
      return res.rows[0] as Record<string, unknown>;
    };

    /* The state every variant is in today: a displayed weight, no override. */
    const before = await read();
    expect(before.shipping_weight_grams).toBeNull();

    const csv = await exportCsv();
    /* The cell is EMPTY on the wire — not the resolved 1200. */
    expect(csv.split(/\r?\n/)[1]).toMatch(/,$/);

    expect((await http.post(IMPORT_PATH, { csv, mode: 'apply' })).status).toBe(200);
    expect(await read()).toEqual(before);

    /* Now with an override set, through the same cycle. */
    await ctx.db.execute(sql`
      UPDATE shop_variants SET shipping_weight_grams = 1400 WHERE id = ${variantId}`);
    const withOverride = await exportCsv();
    expect(withOverride).toContain('1400');
    expect((await http.post(IMPORT_PATH, { csv: withOverride, mode: 'apply' })).status).toBe(200);
    expect(await read()).toEqual({ weight_grams: 1200, shipping_weight_grams: 1400 });

    /* And an emptied cell CLEARS it, so delivery rejoins the displayed weight
       — the same "export writes '' for a stored NULL" symmetry every other
       clearable column in this file has. */
    const emptied = withOverride.replace(/,1400$/m, ',');
    expect(emptied).not.toBe(withOverride);
    expect((await http.post(IMPORT_PATH, { csv: emptied, mode: 'apply' })).status).toBe(200);
    expect(await read()).toEqual(before);
  });

  it('leaves the shipping weight alone when the file predates the column', async () => {
    /* The append-only contract, for the newest column: a file exported last
       week is one cell short here, and short must mean "leave alone". Setting
       it would strip an override the shop is pricing parcels on. */
    await ctx.db.execute(sql`
      UPDATE shop_variants SET shipping_weight_grams = 1400 WHERE id = ${variantId}`);
    const shortHeader = HEADER.split(',').slice(0, 23).join(',');
    expect(shortHeader).not.toContain('Shipping');
    const csv = [shortHeader, 'silk-spool,Silk Spool,,,,,,,,SILK-YELLOW-1KG,,,,,,,,,,,,,'].join('\n');

    expect((await http.post(IMPORT_PATH, { csv, mode: 'apply' })).status).toBe(200);
    const after = await ctx.db.execute(sql`
      SELECT shipping_weight_grams FROM shop_variants WHERE id = ${variantId}`);
    expect(Number(after.rows[0].shipping_weight_grams)).toBe(1400);

    // Leave the fixture as it was found.
    await ctx.db.execute(sql`
      UPDATE shop_variants SET shipping_weight_grams = NULL WHERE id = ${variantId}`);
  });

  it('names a bad swatch, weight, position or variant status on its own row', async () => {
    const csv = [
      HEADER,
      'bad-cells,Bad Cells,,,,,,,,BAD-1,,,,,,,,,,not-a-colour,12.5,-3,retired',
    ].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'preview' });
    expect(res.status).toBe(200);
    const body = await json<{ invalid: { line: number; problem: string }[] }>(res);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0]!.problem).toContain('bad Variant Color Hex "not-a-colour"');
    expect(body.invalid[0]!.problem).toContain('bad Variant Weight Grams "12.5"');
    expect(body.invalid[0]!.problem).toContain('bad Variant Position "-3"');
    expect(body.invalid[0]!.problem).toContain('unknown Variant Status "retired"');
  });

  it('refuses an image id that names nothing, on the row that carries it', async () => {
    const csv = [
      HEADER,
      'silk-spool,Silk Spool,,,,,,,,SILK-YELLOW-1KG,,,,,,,,,img_missing000000000000000000,,,,',
    ].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    const body = await json<{ invalid: { problem: string }[] }>(res);
    expect(body.invalid.map((problem) => problem.problem).join(' ')).toContain('imageId');
  });

  it('still accepts a plain-text description cell, so a Shopify-shaped file imports', async () => {
    const csv = [HEADER, 'plain-desc,Plain Desc,,,,Just some words,,,,,,,,,,,,,,,,,'].join('\n');
    const res = await http.post(IMPORT_PATH, { csv, mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ created: 1, invalid: [] });

    const product = await adminProductBySlug('plain-desc');
    expect(product.description).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just some words' }] }],
    });
  });
});

// ============================================================================

/**
 * A HANDLE THAT NAMES A PRODUCT IN THE TRASH.
 *
 * Watched happen on production 2026-09-04: exported at 19:47:13, the product
 * moved to the trash at 19:47:29, the same file imported at 19:47:39. Trash is
 * a SOFT delete, so the row keeps its slug and its variants keep their SKUs —
 * but the import's lookups filtered `deleted_at IS NULL`, saw no such handle,
 * and created a NEW product, which had to take a `…-2` slug because the
 * trashed row still owned the original. `createVariant` was then refused by
 * `shop_variants_sku_unique`, because that same trashed row still owned the
 * SKU. The result was a duplicate that could never hold a variant.
 *
 * Refusing the row is the owner's call (2026-09-04): restoring it here would
 * mean an import silently un-deleting products, a thousand rows at a time.
 */
describe('a handle that is in the trash', () => {
  let productId: string;
  let handle: string;

  /** Handle plus title; every later column is absent, which the import reads
   *  as "leave alone" — the same shape a spreadsheet's trimmed row has. */
  const fileFor = (slug: string): string => [HEADER, `${slug},Binned Spool`].join('\n');

  beforeAll(async () => {
    await login();
    const created = await http.post('/api/shop/admin/products', {
      title: 'Binned Spool',
      category: 'Fibre',
    });
    expect(created.status).toBe(201);
    const product = (await json<{ product: { id: string; slug: string } }>(created)).product;
    productId = product.id;
    handle = product.slug;

    // `http.del`, not `http.delete` — and this is a SOFT delete.
    const trashed = await http.del(`/api/shop/admin/products/${productId}`);
    expect(trashed.status).toBe(200);
  });

  it('preview refuses the row instead of promising a create', async () => {
    const res = await http.post(IMPORT_PATH, { csv: fileFor(handle), mode: 'preview' });
    expect(res.status).toBe(200);
    const body = await json<{ creates: number; updates: number; invalid: { problem: string }[] }>(res);
    expect(body.creates).toBe(0);
    expect(body.updates).toBe(0);
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0]!.problem).toContain('is in the trash');
  });

  it('apply refuses it and mints no twin', async () => {
    const before = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_products`);

    const res = await http.post(IMPORT_PATH, { csv: fileFor(handle), mode: 'apply' });
    expect(res.status).toBe(200);
    const body = await json<{ created: number; updated: number; invalid: { problem: string }[] }>(res);
    expect(body).toMatchObject({ created: 0, updated: 0 });
    expect(body.invalid[0]!.problem).toContain('is in the trash');

    // The whole point: no `…-2` duplicate, and the trashed row is untouched.
    const after = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM shop_products`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const row = await ctx.db.execute(sql`
      SELECT slug, deleted_at FROM shop_products WHERE id = ${productId}`);
    expect(row.rows[0].slug).toBe(handle);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it('names the handle and says what to do about it', async () => {
    const res = await http.post(IMPORT_PATH, { csv: fileFor(handle), mode: 'preview' });
    const body = await json<{ invalid: { problem: string }[] }>(res);
    // Preview and apply share one sentence, so the modal cannot promise
    // something apply then does differently.
    expect(body.invalid[0]!.problem).toContain(handle);
    expect(body.invalid[0]!.problem).toContain('restore that product first');
  });

  it('imports normally once the product is restored', async () => {
    const restored = await http.post(`/api/shop/admin/products/${productId}/restore`, {});
    expect(restored.status).toBe(200);

    const res = await http.post(IMPORT_PATH, { csv: fileFor(handle), mode: 'apply' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ created: 0, updated: 1, invalid: [] });

    // Updated in place — still one product, still the same id.
    const row = await ctx.db.execute(sql`
      SELECT id, deleted_at FROM shop_products WHERE slug = ${handle}`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].id).toBe(productId);
    expect(row.rows[0].deleted_at).toBeNull();
  });
});
