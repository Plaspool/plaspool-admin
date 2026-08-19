import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { BadRequestError, NotFoundError, PreconditionFailedError } from '../../../repo/errors';
import { uniqueViolation } from '../../../db/client';
import type { Db } from '../../../db/client';
import type { Post } from '../../../../shared/types';
import type { ShippingZone } from './shipping';

/**
 * Admin-editable shipping zones and their options (migration 0240, admin#19).
 *
 * FOLLOWS `server/shop/catalog/categories.ts`'S SHAPE: plain `sql` templates
 * over hand-written DDL, never `db.transaction` (the Neon HTTP driver throws on
 * it unconditionally, while PGlite's transaction support would let a test pass
 * that 500s in production), and every nullable/array bind cast explicitly —
 * `sql.param(xs)::text[]` for arrays, `${x}::text` for a bare NULL inside
 * `COALESCE`/`IS NOT NULL`, or Postgres refuses the statement with `22P02` or
 * `42P18` respectively.
 *
 * `loadShippingZones` is the function `resolveShopCartDeps`/the checkout routes
 * call to get `ShippingZone[]` in the exact shape `shipping.ts` expects — an
 * empty array means "no rows in the database", and the caller falls back to
 * `DEFAULT_SHIPPING_ZONES` in that case (never here — this module has no
 * opinion about fallbacks, it just reports what is in the table).
 */

const FALLBACK_UQ = 'shop_shipping_zones_fallback_uq';

function newZoneId(): string {
  return `zone_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function newOptionId(): string {
  return `ship_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --------------------------------------------------------------------- types

export interface ShippingOptionRow {
  id: string;
  zoneId: string;
  label: string;
  amountMinor: number;
  estimate: string;
  position: number;
}

export interface ShippingZoneRow {
  id: string;
  label: string;
  countries: string[];
  regions: string[];
  taxRateBps: number;
  taxLabel: string;
  shippingTaxable: boolean;
  isFallback: boolean;
  position: number;
  options: ShippingOptionRow[];
}

/**
 * A conflict on the "exactly one fallback" constraint: creating or updating a
 * second `is_fallback` row, unsetting the sole fallback without promoting
 * another, or deleting it outright. Extends `PreconditionFailedError` for the
 * same reason `CategoryPreconditionFailedError` does — the fallback is a
 * correct 409 through `toResponse` even if a caller never recognises this
 * subclass.
 *
 * `{} as Post` for the same reason `server/repo/categories.ts` casts the same
 * way: the base class requires a non-null `Post` and this has none to give it.
 * Nothing reads `.post` on one of these — the admin screen reads `.operation`
 * off the response body, and the global fallback only ever serialises the
 * value, where `{}` is a strictly better answer than a zone masquerading as a
 * post.
 */
export class ShippingZonePreconditionFailedError extends PreconditionFailedError {
  constructor(operation: string) {
    super(operation, {} as Post);
    this.name = 'ShippingZonePreconditionFailedError';
  }
}

function toOption(row: Record<string, unknown>): ShippingOptionRow {
  return {
    id: String(row.id),
    zoneId: String(row.zone_id),
    label: String(row.label),
    amountMinor: Number(row.amount_minor),
    estimate: row.estimate == null ? '' : String(row.estimate),
    position: Number(row.position ?? 0),
  };
}

function toZone(row: Record<string, unknown>, options: ShippingOptionRow[]): ShippingZoneRow {
  return {
    id: String(row.id),
    label: String(row.label),
    countries: Array.isArray(row.countries) ? (row.countries as string[]) : [],
    regions: Array.isArray(row.regions) ? (row.regions as string[]) : [],
    taxRateBps: Number(row.tax_rate_bps ?? 0),
    taxLabel: row.tax_label == null ? '' : String(row.tax_label),
    shippingTaxable: Boolean(row.shipping_taxable),
    isFallback: Boolean(row.is_fallback),
    position: Number(row.position ?? 0),
    options,
  };
}

// ---------------------------------------------------------------------- read

/** Every zone, with its options, ordered for the admin list. */
export async function listShippingZones(db: Db): Promise<ShippingZoneRow[]> {
  const zoneRes = await db.execute(sql`
    SELECT id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
           is_fallback, position
      FROM shop_shipping_zones
     ORDER BY position ASC, lower(label) ASC`);
  const optionRes = await db.execute(sql`
    SELECT id, zone_id, label, amount_minor, estimate, position
      FROM shop_shipping_options
     ORDER BY position ASC, lower(label) ASC`);

  const optionsByZone = new Map<string, ShippingOptionRow[]>();
  for (const row of optionRes.rows) {
    const option = toOption(row);
    const list = optionsByZone.get(option.zoneId) ?? [];
    list.push(option);
    optionsByZone.set(option.zoneId, list);
  }

  return zoneRes.rows.map((row) => toZone(row, optionsByZone.get(String(row.id)) ?? []));
}

/**
 * `ShippingZone[]` in the exact shape `shipping.ts` expects, for wiring into
 * checkout. Empty means the table has no rows — the caller decides whether
 * that means falling back to `DEFAULT_SHIPPING_ZONES`.
 */
export async function loadShippingZonesForCheckout(db: Db): Promise<readonly ShippingZone[]> {
  const zones = await listShippingZones(db);
  return zones.map((zone) => ({
    id: zone.id,
    label: zone.label,
    countries: zone.countries,
    regions: zone.regions.length > 0 ? zone.regions : undefined,
    taxRateBps: zone.taxRateBps,
    taxLabel: zone.taxLabel,
    shippingTaxable: zone.shippingTaxable,
    fallback: zone.isFallback || undefined,
    options: zone.options.map((o) => ({ id: o.id, label: o.label, amountMinor: o.amountMinor })),
  }));
}

// -------------------------------------------------------------------- zones

export interface ShippingZoneInput {
  label: string;
  countries: string[];
  regions: string[];
  taxRateBps: number;
  taxLabel: string;
  shippingTaxable: boolean;
  isFallback: boolean;
  position: number;
}

export async function createShippingZone(
  db: Db,
  input: ShippingZoneInput,
): Promise<ShippingZoneRow> {
  const now = Date.now();
  try {
    const res = await db.execute(sql`
      INSERT INTO shop_shipping_zones
        (id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
         is_fallback, position, created_at, updated_at)
      VALUES (${newZoneId()}, ${input.label}, ${sql.param(input.countries)}::text[],
              ${sql.param(input.regions)}::text[], ${input.taxRateBps}, ${input.taxLabel},
              ${input.shippingTaxable}, ${input.isFallback}, ${input.position}, ${now}, ${now})
      RETURNING id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
                is_fallback, position`);
    return toZone(res.rows[0], []);
  } catch (err) {
    if (uniqueViolation(err) === FALLBACK_UQ) {
      throw new ShippingZonePreconditionFailedError('create');
    }
    throw err;
  }
}

export interface ShippingZonePatch {
  label?: string;
  countries?: string[];
  regions?: string[];
  taxRateBps?: number;
  taxLabel?: string;
  shippingTaxable?: boolean;
  isFallback?: boolean;
  position?: number;
}

/**
 * THE FALLBACK GUARD, AND WHY IT IS TWO SHAPES NOT ONE.
 *
 * `shop_shipping_zones_fallback_uq` enforces AT MOST one fallback zone.
 * Nothing enforced AT LEAST one, which meant `zoneFor` could be left with no
 * fallback to hand a customer whose region matches nothing — and it does not
 * pick one, it throws (`shipping.ts`), so that customer's
 * `PUT /checkout/addresses` was a 500 with no warning anywhere in the admin
 * screen first.
 *
 * PROMOTING a new fallback (`isFallback: true`) demotes whoever currently
 * holds it FIRST, then sets the target — two statements, not the single
 * guarded one this file otherwise favours (see the long comment at the top of
 * the `promoting` branch below for why: a single `UPDATE` swapping both rows
 * at once looks atomic but hits `shop_shipping_zones_fallback_uq`'s own
 * unique violation mid-statement, because the index is not deferrable and
 * Postgres checks it per row, not once at the end — this repo's own test
 * caught it). The brief window this leaves with zero fallback zones is an
 * operator's deliberate, rare action, not a customer-facing request path.
 *
 * DEMOTING the current fallback (`isFallback: false`) without promoting
 * another zone in the same call is refused outright, not raced around — a
 * lone `UPDATE ... SET is_fallback = false` can only ever produce zero
 * fallbacks, so there is no statement shape that makes it safe. The operator
 * is told to promote another zone first, which is the one operation that
 * always leaves exactly one.
 */
export async function updateShippingZone(
  db: Db,
  id: string,
  patch: ShippingZonePatch,
): Promise<ShippingZoneRow> {
  const now = Date.now();
  const nextLabel = patch.label ?? null;
  const nextCountries = patch.countries ?? null;
  const nextRegions = patch.regions ?? null;
  const nextTaxRateBps = patch.taxRateBps ?? null;
  const nextTaxLabel = patch.taxLabel ?? null;
  const touchShippingTaxable = 'shippingTaxable' in patch;
  const nextShippingTaxable = patch.shippingTaxable ?? false;
  const touchIsFallback = 'isFallback' in patch;
  const nextIsFallback = patch.isFallback ?? false;
  const nextPosition = patch.position ?? null;
  const promoting = touchIsFallback && nextIsFallback;
  const demoting = touchIsFallback && !nextIsFallback;

  let res;
  try {
    if (promoting) {
      /*
       * TWO STATEMENTS, NOT ONE, AND THAT IS A DELIBERATE STEP DOWN FROM WHAT
       * THIS FUNCTION FIRST TRIED. A single `UPDATE ... SET is_fallback = (id
       * = target)` swapping both rows in one statement looks atomic and reads
       * as the "single guarded statement" shape the variant delete uses — but
       * `shop_shipping_zones_fallback_uq` is a NOT-DEFERRED unique index, so
       * Postgres (and PGlite, which caught this in this repo's own test)
       * checks it per row as the statement executes, not once at the end. The
       * row order is not guaranteed, so that single UPDATE intermittently hit
       * its own unique violation trying to have two fallbacks true for an
       * instant mid-statement — proven by `shipping-zones-routes.test.ts`'s
       * promotion test, which failed against this exact shape before it was
       * changed to this one.
       *
       * So: demote whoever currently holds it FIRST, in its own statement,
       * THEN promote the target. There is a real, if brief, window with zero
       * fallback zones between the two — `deleteShippingZone` and the
       * `demoting` branch below both refuse to touch the fallback for exactly
       * this reason, but this promotion path is the one write this module
       * cannot make single-statement-atomic without either a deferrable
       * constraint (unavailable — `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE
       * USING INDEX ... DEFERRABLE` was not carried through this migration)
       * or `db.transaction`, which is never used here. An operator promoting
       * a new fallback is a rare, deliberate action, not a customer-facing
       * request path, so the exposure is a developer crashing the process
       * between these two statements — recoverable by hand, unlike a
       * customer's checkout 500ing on a live region no zone claims.
       */
      const exists = await db.execute(sql`
        SELECT 1 FROM shop_shipping_zones WHERE id = ${id}`);
      if (!exists.rows[0]) throw new NotFoundError(id);

      await db.execute(sql`
        UPDATE shop_shipping_zones SET is_fallback = false
         WHERE is_fallback = true AND id <> ${id}`);

      res = await db.execute(sql`
        UPDATE shop_shipping_zones
           SET label            = COALESCE(${nextLabel}::text, label),
               countries        = COALESCE(${nextCountries != null ? sql.param(nextCountries) : null}::text[], countries),
               regions          = COALESCE(${nextRegions != null ? sql.param(nextRegions) : null}::text[], regions),
               tax_rate_bps     = COALESCE(${nextTaxRateBps}::int, tax_rate_bps),
               tax_label        = COALESCE(${nextTaxLabel}::text, tax_label),
               shipping_taxable = CASE WHEN ${touchShippingTaxable}::boolean
                                       THEN ${nextShippingTaxable}::boolean ELSE shipping_taxable END,
               is_fallback      = true,
               position         = COALESCE(${nextPosition}::int, position),
               updated_at       = ${now}
         WHERE id = ${id}
        RETURNING id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
                  is_fallback, position`);
    } else if (demoting) {
      // Refused, not raced around: unsetting the sole fallback with nothing
      // promoted in the same statement can only ever leave zero.
      res = await db.execute(sql`
        WITH target AS (SELECT id, is_fallback FROM shop_shipping_zones WHERE id = ${id})
        UPDATE shop_shipping_zones z
           SET label            = COALESCE(${nextLabel}::text, label),
               countries        = COALESCE(${nextCountries != null ? sql.param(nextCountries) : null}::text[], countries),
               regions          = COALESCE(${nextRegions != null ? sql.param(nextRegions) : null}::text[], regions),
               tax_rate_bps     = COALESCE(${nextTaxRateBps}::int, tax_rate_bps),
               tax_label        = COALESCE(${nextTaxLabel}::text, tax_label),
               shipping_taxable = CASE WHEN ${touchShippingTaxable}::boolean
                                       THEN ${nextShippingTaxable}::boolean ELSE shipping_taxable END,
               is_fallback      = false,
               position         = COALESCE(${nextPosition}::int, position),
               updated_at       = ${now}
          FROM target
         WHERE z.id = target.id AND target.is_fallback = false
        RETURNING z.id, z.label, z.countries, z.regions, z.tax_rate_bps, z.tax_label,
                  z.shipping_taxable, z.is_fallback, z.position`);
      if (res.rows.length === 0) {
        const target = await db.execute(sql`
          SELECT id, is_fallback FROM shop_shipping_zones WHERE id = ${id}`);
        const row = target.rows[0];
        if (!row) throw new NotFoundError(id);
        if (row.is_fallback) {
          throw new ShippingZonePreconditionFailedError('unset_fallback');
        }
      }
    } else {
      res = await db.execute(sql`
        UPDATE shop_shipping_zones
           SET label            = COALESCE(${nextLabel}::text, label),
               countries        = COALESCE(${nextCountries != null ? sql.param(nextCountries) : null}::text[], countries),
               regions          = COALESCE(${nextRegions != null ? sql.param(nextRegions) : null}::text[], regions),
               tax_rate_bps     = COALESCE(${nextTaxRateBps}::int, tax_rate_bps),
               tax_label        = COALESCE(${nextTaxLabel}::text, tax_label),
               shipping_taxable = CASE WHEN ${touchShippingTaxable}::boolean
                                       THEN ${nextShippingTaxable}::boolean ELSE shipping_taxable END,
               position         = COALESCE(${nextPosition}::int, position),
               updated_at       = ${now}
         WHERE id = ${id}
        RETURNING id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
                  is_fallback, position`);
    }
  } catch (err) {
    if (uniqueViolation(err) === FALLBACK_UQ) {
      throw new ShippingZonePreconditionFailedError('update');
    }
    throw err;
  }

  const row = res?.rows.find((r) => String(r.id) === id);
  if (!row) throw new NotFoundError(id);

  const optionRes = await db.execute(sql`
    SELECT id, zone_id, label, amount_minor, estimate, position
      FROM shop_shipping_options WHERE zone_id = ${id}
     ORDER BY position ASC, lower(label) ASC`);
  return toZone(row, optionRes.rows.map(toOption));
}

/**
 * Refused with a 400 while the zone still has options — an operator deletes
 * the options first, so a zone is never removed out from under a price a
 * customer might still be quoted mid-checkout.
 *
 * Refused with a 409 while the zone IS the fallback, full stop — the fallback
 * is exactly one row by construction, so deleting it always leaves zero. The
 * message says what to do: designate another zone as the fallback first
 * (`updateShippingZone(otherId, { isFallback: true })`, which is the atomic
 * promotion above), and only then delete this one.
 */
export async function deleteShippingZone(db: Db, id: string): Promise<void> {
  const res = await db.execute(sql`
    WITH target AS (SELECT id, is_fallback FROM shop_shipping_zones WHERE id = ${id}),
    used AS (
      SELECT count(*)::int AS n FROM shop_shipping_options o, target t WHERE o.zone_id = t.id
    ),
    removed AS (
      DELETE FROM shop_shipping_zones z
       USING target t
       WHERE z.id = t.id AND (SELECT n FROM used) = 0 AND t.is_fallback = false
      RETURNING z.id
    )
    SELECT t.id AS id, t.is_fallback AS is_fallback, (SELECT n FROM used) AS count,
           (SELECT count(*)::int FROM removed) AS removed
      FROM target t`);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  if (Number(row.removed) === 0) {
    if (row.is_fallback) throw new ShippingZonePreconditionFailedError('delete_fallback');
    throw new BadRequestError('zone_has_options');
  }
}

// ------------------------------------------------------------------ options

export interface ShippingOptionInput {
  zoneId: string;
  label: string;
  amountMinor: number;
  estimate: string;
  position: number;
}

export async function createShippingOption(
  db: Db,
  input: ShippingOptionInput,
): Promise<ShippingOptionRow> {
  if (input.amountMinor < 0) throw new BadRequestError('amountMinor');
  const now = Date.now();
  const res = await db.execute(sql`
    INSERT INTO shop_shipping_options
      (id, zone_id, label, amount_minor, estimate, position, created_at, updated_at)
    VALUES (${newOptionId()}, ${input.zoneId}, ${input.label}, ${input.amountMinor},
            ${input.estimate}, ${input.position}, ${now}, ${now})
    RETURNING id, zone_id, label, amount_minor, estimate, position`);
  return toOption(res.rows[0]);
}

export interface ShippingOptionPatch {
  label?: string;
  amountMinor?: number;
  estimate?: string;
  position?: number;
}

export async function updateShippingOption(
  db: Db,
  id: string,
  patch: ShippingOptionPatch,
): Promise<ShippingOptionRow> {
  if (patch.amountMinor !== undefined && patch.amountMinor < 0) {
    throw new BadRequestError('amountMinor');
  }
  const now = Date.now();
  const nextLabel = patch.label ?? null;
  const nextAmount = patch.amountMinor ?? null;
  const nextEstimate = patch.estimate ?? null;
  const nextPosition = patch.position ?? null;

  const res = await db.execute(sql`
    UPDATE shop_shipping_options
       SET label        = COALESCE(${nextLabel}::text, label),
           amount_minor = COALESCE(${nextAmount}::bigint, amount_minor),
           estimate     = COALESCE(${nextEstimate}::text, estimate),
           position     = COALESCE(${nextPosition}::int, position),
           updated_at   = ${now}
     WHERE id = ${id}
    RETURNING id, zone_id, label, amount_minor, estimate, position`);

  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  return toOption(row);
}

export async function deleteShippingOption(db: Db, id: string): Promise<void> {
  const res = await db.execute(sql`
    DELETE FROM shop_shipping_options WHERE id = ${id} RETURNING id`);
  if (!res.rows[0]) throw new NotFoundError(id);
}
