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
 * A conflict on the "exactly one fallback" constraint. Extends
 * `PreconditionFailedError` for the same reason `ShopCategoryPreconditionFailedError`
 * does — the fallback is a correct 409 through `toResponse` even if a caller
 * never recognises this subclass.
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

  let res;
  try {
    res = await db.execute(sql`
      UPDATE shop_shipping_zones
         SET label            = COALESCE(${nextLabel}::text, label),
             countries        = COALESCE(${nextCountries != null ? sql.param(nextCountries) : null}::text[], countries),
             regions          = COALESCE(${nextRegions != null ? sql.param(nextRegions) : null}::text[], regions),
             tax_rate_bps     = COALESCE(${nextTaxRateBps}::int, tax_rate_bps),
             tax_label        = COALESCE(${nextTaxLabel}::text, tax_label),
             shipping_taxable = CASE WHEN ${touchShippingTaxable}::boolean
                                     THEN ${nextShippingTaxable}::boolean ELSE shipping_taxable END,
             is_fallback      = CASE WHEN ${touchIsFallback}::boolean
                                     THEN ${nextIsFallback}::boolean ELSE is_fallback END,
             position         = COALESCE(${nextPosition}::int, position),
             updated_at       = ${now}
       WHERE id = ${id}
      RETURNING id, label, countries, regions, tax_rate_bps, tax_label, shipping_taxable,
                is_fallback, position`);
  } catch (err) {
    if (uniqueViolation(err) === FALLBACK_UQ) {
      throw new ShippingZonePreconditionFailedError('update');
    }
    throw err;
  }

  const row = res.rows[0];
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
 */
export async function deleteShippingZone(db: Db, id: string): Promise<void> {
  const res = await db.execute(sql`
    WITH target AS (SELECT id FROM shop_shipping_zones WHERE id = ${id}),
    used AS (
      SELECT count(*)::int AS n FROM shop_shipping_options o, target t WHERE o.zone_id = t.id
    ),
    removed AS (
      DELETE FROM shop_shipping_zones z
       USING target t
       WHERE z.id = t.id AND (SELECT n FROM used) = 0
      RETURNING z.id
    )
    SELECT t.id AS id, (SELECT n FROM used) AS count, (SELECT count(*)::int FROM removed) AS removed
      FROM target t`);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(id);
  if (Number(row.removed) === 0) throw new BadRequestError('zone_has_options');
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
