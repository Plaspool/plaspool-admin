import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from '../../test/harness';
import type { TestCtx } from '../../test/harness';
import { setPrice } from './prices';
import { adjustInventory } from './inventory';
import { createVariant } from './variants';
import { money } from '../../../shared/commerce/money';
import { seedProduct } from './test/catalog-harness';

/**
 * `0010_catalogue_case_fold.sql`, exercised as DATA, not just as DDL.
 *
 * The harness has already applied the whole journal (0010 included) before any
 * seed runs, so this suite plants the PRE-migration mess by raw UPDATE — the
 * write paths canonicalise now, and raw SQL is exactly what legacy rows are —
 * and then executes the migration file's statements again. That re-run is not a
 * simulation of something else: every statement in 0010 is required to be a
 * fixpoint (the neon-http migrator replays a failed file from statement one),
 * so "run it against mess, then run it again" asserts both the merge and the
 * replay-safety in one pass.
 */

let ctx: TestCtx;
const actor = () => ctx.users.owner;

const FILE = fileURLToPath(
  new URL('../../db/migrations/0010_catalogue_case_fold.sql', import.meta.url),
);

async function runMigrationFile(): Promise<void> {
  const statements = readFileSync(FILE, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(statements.length).toBeGreaterThanOrEqual(5);
  for (const statement of statements) {
    await ctx.db.execute(sql.raw(statement));
  }
}

/** The whole catalogue's observable state, for the idempotency comparison. */
async function snapshot(): Promise<unknown> {
  const products = await ctx.db.execute(sql`
    SELECT id, category, tags FROM shop_products ORDER BY id`);
  const variants = await ctx.db.execute(sql`
    SELECT id, product_id, option_values, color_hex FROM shop_variants ORDER BY id`);
  const inventory = await ctx.db.execute(sql`
    SELECT variant_id, on_hand, reserved FROM shop_inventory ORDER BY variant_id`);
  return { products: products.rows, variants: variants.rows, inventory: inventory.rows };
}

const mangleOptions = (id: string, options: Record<string, string>) =>
  ctx.db.execute(sql`
    UPDATE shop_variants SET option_values = ${JSON.stringify(options)}::jsonb
     WHERE id = ${id}`);

interface Seeded {
  spool: string;
  keptBlack: string;
  doomedBlack: string;
  walnut: string;
  singleA: string;
  singleB: string;
  photographedRed: string;
  adjustedGreen: string;
}

let seeded: Seeded;

beforeAll(async () => {
  ctx = await freshDb();

  // ---- categories: two exact 'Specialty Filament', one lowercase twin ------
  const p1 = await seedProduct(ctx.db, actor(), { title: 'Wood-Fill PLA' });
  const p2 = await seedProduct(ctx.db, actor(), { title: 'Tough PLA' });
  const p3 = await seedProduct(ctx.db, actor(), { title: 'Silk PLA' });
  const p4 = await seedProduct(ctx.db, actor(), { title: 'Matte PLA' });
  await ctx.db.execute(sql`
    UPDATE shop_products SET category = 'Specialty Filament' WHERE id IN (${p1.id}, ${p2.id})`);
  await ctx.db.execute(sql`
    UPDATE shop_products SET category = 'specialty filament' WHERE id = ${p3.id}`);

  // ---- tags: four spellings of PLA, one decisive majority ------------------
  await ctx.db.execute(sql`
    UPDATE shop_products SET tags = ${sql.param(['PLA', 'wood-fill'])} WHERE id = ${p1.id}`);
  await ctx.db.execute(sql`
    UPDATE shop_products SET tags = ${sql.param(['pla', 'Pla', 'strong'])} WHERE id = ${p2.id}`);
  await ctx.db.execute(sql`
    UPDATE shop_products SET tags = ${sql.param(['pLA'])} WHERE id = ${p3.id}`);
  await ctx.db.execute(sql`
    UPDATE shop_products SET tags = ${sql.param(['PLA'])} WHERE id = ${p4.id}`);

  // ---- variants on p1, the case-twin menagerie ------------------------------
  // The write path refuses case-twins now, so every twin is created under a
  // placeholder tuple and mangled into its legacy spelling by raw UPDATE.
  const keptBlack = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'Black' } }, actor());
  await setPrice(ctx.db, keptBlack.id, money(2_650_000, 'NGN'), 'seed');

  // The value is the twin here (`black` vs `Black`); the KEY stays `Colour` so
  // that spelling keeps a decisive majority on this product — the minority-key
  // fold is exercised by `walnut` below, and a seed where `colour` outnumbered
  // `Colour` would flip every assertion about which way the axis folds.
  const doomedBlack = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'placeholder-1' } }, actor());
  await mangleOptions(doomedBlack.id, { Colour: 'black' });

  // Key-spelling minority: 'colour' must fold up to the majority 'Colour'.
  const walnut = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'placeholder-2' } }, actor());
  await mangleOptions(walnut.id, { colour: 'Walnut' });

  // Two option-less variants: a supported shape the merge must not touch.
  const singleA = await createVariant(ctx.db, p1.id, {}, actor());
  const singleB = await createVariant(ctx.db, p1.id, {}, actor());

  // A twin with a photograph: the image guard must keep it.
  const red = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'Red' } }, actor());
  await setPrice(ctx.db, red.id, money(2_650_000, 'NGN'), 'seed');
  const photographedRed = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'placeholder-3' } }, actor());
  await mangleOptions(photographedRed.id, { colour: 'red' });
  await ctx.db.execute(sql`
    UPDATE shop_variants SET image_id = 'img_someone_chose_this' WHERE id = ${photographedRed.id}`);

  // A twin with a human audit trail: adjusted up and back to zero.
  const green = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'Green' } }, actor());
  await setPrice(ctx.db, green.id, money(2_650_000, 'NGN'), 'seed');
  const adjustedGreen = await createVariant(
    ctx.db, p1.id, { optionValues: { Colour: 'placeholder-4' } }, actor());
  await mangleOptions(adjustedGreen.id, { colour: 'green' });
  await adjustInventory(ctx.db, adjustedGreen.id, 5, 'Delivery arrived', actor());
  await adjustInventory(ctx.db, adjustedGreen.id, -5, 'Written off', actor());

  seeded = {
    spool: p1.id,
    keptBlack: keptBlack.id,
    doomedBlack: doomedBlack.id,
    walnut: walnut.id,
    singleA: singleA.id,
    singleB: singleB.id,
    photographedRed: photographedRed.id,
    adjustedGreen: adjustedGreen.id,
  };

  await runMigrationFile();
});

afterAll(async () => {
  await ctx?.close();
});

describe('after the migration runs over a messy catalogue', () => {
  it('every spelling of the category is the canonical one', async () => {
    const res = await ctx.db.execute(sql`
      SELECT DISTINCT category FROM shop_products WHERE lower(category) = 'specialty filament'`);
    expect(res.rows.map((r) => r.category)).toEqual(['Specialty Filament']);
  });

  it('tags are mapped to the majority spelling, deduped, order kept', async () => {
    const rows = await ctx.db.execute(sql`
      SELECT id, tags FROM shop_products ORDER BY id`);
    const byId = new Map(rows.rows.map((r) => [String(r.id), r.tags as string[]]));
    // p2 held ['pla','Pla','strong']: both twins collapse into one 'PLA' at the
    // FIRST twin's position; 'strong' keeps its place after it.
    expect(byId.get(seeded.spool)).toEqual(['PLA', 'wood-fill']);
    const p2Tags = [...byId.values()].find((t) => t.includes('strong'));
    expect(p2Tags).toEqual(['PLA', 'strong']);
  });

  it('deletes exactly the untouched case-twin, cascading its inventory row', async () => {
    const gone = await ctx.db.execute(sql`
      SELECT id FROM shop_variants WHERE id = ${seeded.doomedBlack}`);
    expect(gone.rows).toHaveLength(0);
    const inv = await ctx.db.execute(sql`
      SELECT variant_id FROM shop_inventory WHERE variant_id = ${seeded.doomedBlack}`);
    expect(inv.rows).toHaveLength(0);
  });

  it('keeps the priced winner, and keeps both protected twins', async () => {
    const res = await ctx.db.execute(sql`
      SELECT id FROM shop_variants WHERE id IN
        (${seeded.keptBlack}, ${seeded.photographedRed}, ${seeded.adjustedGreen})`);
    expect(res.rows).toHaveLength(3);
  });

  it('keeps both option-less variants — they are a family, not a collision', async () => {
    const res = await ctx.db.execute(sql`
      SELECT id FROM shop_variants WHERE id IN (${seeded.singleA}, ${seeded.singleB})`);
    expect(res.rows).toHaveLength(2);
  });

  it('folds the minority key spelling up to the majority axis', async () => {
    const res = await ctx.db.execute(sql`
      SELECT option_values FROM shop_variants WHERE id = ${seeded.walnut}`);
    const options =
      typeof res.rows[0].option_values === 'string'
        ? (JSON.parse(res.rows[0].option_values) as Record<string, string>)
        : (res.rows[0].option_values as Record<string, string>);
    expect(options).toEqual({ Colour: 'Walnut' });
  });

  it('is a fixpoint: a second full run changes nothing', async () => {
    const before = await snapshot();
    await runMigrationFile();
    expect(await snapshot()).toEqual(before);
  });
});
