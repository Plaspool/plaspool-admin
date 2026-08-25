import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { StaleWriteError } from '../../../repo/errors';
import type { Db } from '../../../db/client';

/**
 * Per-district delivery: does the shop go there, and what does it charge
 * (migration 0300).
 *
 * FOLLOWS `shipping-zones-repo.ts`'S SHAPE, which follows
 * `server/shop/catalog/categories.ts`: plain `sql` templates over hand-written
 * DDL, NEVER `db.transaction` (the Neon HTTP driver throws on it
 * unconditionally while PGlite supports it — so a transaction passes every test
 * here and 500s in production), and every array bind cast explicitly with
 * `sql.param(xs)::text[]`, because a bare array bind is a `22P02`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS TABLE STORES AN OPINION, NOT A PLACE.
 *
 * The districts themselves are `marketing_service_areas`, and the shop does not
 * read marketing's tables (the migration header argues it). So there is no
 * name and no region here — only `area_key`, and the admin screen joins the two
 * lists. A district with no row is not "missing": it means nobody has had an
 * opinion about it, which reads as "we deliver, at the state's zone rate" —
 * exactly the live behaviour before this table existed.
 *
 * WHICH IS WHY EVERY WRITE IS AN UPSERT. There is no `create` and no `delete` in
 * this module's vocabulary: an owner switches a district off, or names a price,
 * and whether that is the first opinion or the fiftieth is the database's
 * problem rather than the screen's.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CHECKOUT READS THIS THROUGH `districtRuling` (`checkout/repo.ts`), since
 * migration 0460 put a `district` on the address: `delivers = false` refuses
 * the address, the shipping options and the freeze; `rate_minor` replaces the
 * zone amount on every option. This module stays the ADMIN's writer — checkout
 * reads the two columns directly and never imports it.
 */

function newAreaId(): string {
  return `darea_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --------------------------------------------------------------------- types

export interface DeliveryAreaRow {
  id: string;
  /** `marketing_service_areas.key` — the handle a rename does not move. */
  areaKey: string;
  delivers: boolean;
  /** `null` means NO OVERRIDE: price from the state's zone. Never "free". */
  rateMinor: number | null;
  revision: number;
}

function toArea(row: Record<string, unknown>): DeliveryAreaRow {
  /*
   * `rate_minor` IS `bigint`, WHICH THE DRIVERS DISAGREE ABOUT. Neon hands back
   * a string for a 64-bit column, PGlite a number. `Number(null)` is 0 — the
   * one wrong answer available — so the null check comes FIRST and the cast
   * second, rather than a `Number(row.rate_minor ?? null)` that quietly prices
   * an un-overridden district at zero.
   */
  const raw = row.rate_minor;
  return {
    id: String(row.id),
    areaKey: String(row.area_key),
    delivers: Boolean(row.delivers),
    rateMinor: raw === null || raw === undefined ? null : Number(raw),
    revision: Number(row.revision ?? 1),
  };
}

const COLUMNS = sql`id, area_key, delivers, rate_minor, revision`;

// ---------------------------------------------------------------------- read

/** Every opinion the shop holds. Districts with no row are simply absent. */
export async function listDeliveryAreas(db: Db): Promise<DeliveryAreaRow[]> {
  const res = await db.execute(sql`
    SELECT ${COLUMNS}
      FROM shop_delivery_areas
     ORDER BY area_key ASC`);
  return res.rows.map((row) => toArea(row as Record<string, unknown>));
}

// --------------------------------------------------------------------- write

export interface DeliveryAreaPatch {
  delivers?: boolean;
  /**
   * `undefined` LEAVES THE RATE ALONE; an explicit `null` CLEARS the override
   * back to the zone rate. The two cannot be collapsed, which is why this is a
   * `| null` field and not an optional number — and why the SQL below uses
   * `CASE WHEN <provided>` rather than `COALESCE`. `COALESCE` cannot tell "do
   * not change" from "set to null", and a bare NULL bind inside one needs an
   * explicit cast anyway or Postgres refuses the statement with `42P18`.
   */
  rateMinor?: number | null;
}

/**
 * Write one district's opinion, creating the row if this is the first.
 *
 * `expectedRevision` IS COMPARE-AND-SWAP, as `marketing_service_areas` does it:
 * `null` means "I believe there is no row here". A concurrent edit loses rather
 * than clobbers — and because a first write and a hundredth are the same
 * statement, "someone created it while I was looking" is caught by the same
 * check as "someone edited it".
 *
 * ONE STATEMENT, NO TRANSACTION. `ON CONFLICT DO UPDATE … WHERE revision = …`
 * makes the read-compare-write atomic in the database. Zero rows back therefore
 * means exactly one thing — the row exists and its revision is not the one the
 * caller read — so the follow-up SELECT is only to report the actual number.
 */
export async function saveDeliveryArea(
  db: Db,
  areaKey: string,
  patch: DeliveryAreaPatch,
  expectedRevision: number | null,
): Promise<DeliveryAreaRow> {
  const now = Date.now();
  const deliversGiven = patch.delivers !== undefined;
  const rateGiven = patch.rateMinor !== undefined;

  const res = await db.execute(sql`
    INSERT INTO shop_delivery_areas
      (id, area_key, delivers, rate_minor, revision, created_at, updated_at)
    VALUES (
      ${newAreaId()},
      ${areaKey},
      ${deliversGiven ? patch.delivers : true},
      ${rateGiven ? (patch.rateMinor ?? null) : null}::bigint,
      1, ${now}, ${now})
    ON CONFLICT (area_key) DO UPDATE SET
      delivers = CASE WHEN ${deliversGiven}
                      THEN EXCLUDED.delivers ELSE shop_delivery_areas.delivers END,
      rate_minor = CASE WHEN ${rateGiven}
                        THEN EXCLUDED.rate_minor ELSE shop_delivery_areas.rate_minor END,
      revision = shop_delivery_areas.revision + 1,
      updated_at = ${now}
    WHERE shop_delivery_areas.revision = ${expectedRevision ?? -1}
    RETURNING ${COLUMNS}`);

  const written = res.rows[0];
  if (written !== undefined) return toArea(written as Record<string, unknown>);

  /* The upsert refused. The row therefore exists (an insert with no conflict
   * always returns), so this read cannot come back empty — but it is written to
   * survive that anyway rather than assert it. */
  const current = await db.execute(sql`
    SELECT revision FROM shop_delivery_areas WHERE area_key = ${areaKey}`);
  const actual = current.rows[0] === undefined ? 0 : Number(current.rows[0].revision ?? 0);
  throw new StaleWriteError(expectedRevision ?? 0, actual);
}

/**
 * Set the same opinion across many districts at once — the "every district in
 * this state" control.
 *
 * NO COMPARE-AND-SWAP HERE, DELIBERATELY. A bulk write is an owner overriding
 * whatever is there; failing the whole batch because one of forty rows moved
 * would be a worse answer than applying it, and there is no sensible partial
 * report for "thirty-nine of your forty". The per-district editor is the
 * careful path and it keeps its CAS.
 *
 * ONE STATEMENT, over `unnest` of two parallel arrays. Ids are generated in JS
 * rather than by `gen_random_uuid()` so this does not depend on pgcrypto being
 * present in whatever engine is running it — and only the ids for rows that
 * turn out to be inserts are ever used.
 */
export async function saveDeliveryAreas(
  db: Db,
  areaKeys: readonly string[],
  patch: DeliveryAreaPatch,
): Promise<DeliveryAreaRow[]> {
  if (areaKeys.length === 0) return [];
  const now = Date.now();
  const deliversGiven = patch.delivers !== undefined;
  const rateGiven = patch.rateMinor !== undefined;
  const ids = areaKeys.map(() => newAreaId());

  const res = await db.execute(sql`
    INSERT INTO shop_delivery_areas
      (id, area_key, delivers, rate_minor, revision, created_at, updated_at)
    SELECT t.id, t.area_key,
           ${deliversGiven ? patch.delivers : true},
           ${rateGiven ? (patch.rateMinor ?? null) : null}::bigint,
           1, ${now}, ${now}
      FROM unnest(${sql.param([...areaKeys])}::text[], ${sql.param(ids)}::text[])
             AS t(area_key, id)
    ON CONFLICT (area_key) DO UPDATE SET
      delivers = CASE WHEN ${deliversGiven}
                      THEN EXCLUDED.delivers ELSE shop_delivery_areas.delivers END,
      rate_minor = CASE WHEN ${rateGiven}
                        THEN EXCLUDED.rate_minor ELSE shop_delivery_areas.rate_minor END,
      revision = shop_delivery_areas.revision + 1,
      updated_at = ${now}
    RETURNING ${COLUMNS}`);

  return res.rows.map((row) => toArea(row as Record<string, unknown>));
}
