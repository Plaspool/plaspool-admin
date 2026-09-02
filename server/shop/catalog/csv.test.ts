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

const HEADER =
  'Handle,Title,Status,Category,Tags,Description,Overview,SEO Title,SEO Description,' +
  'Variant SKU,Variant Options,Variant Price,Variant Compare At Price,Variant Cost,' +
  'Variant Stock,Variant Backorderable';

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
