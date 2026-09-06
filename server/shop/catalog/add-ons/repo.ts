import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { toEpochMs } from '../../../db/client';
import type { Db } from '../../../db/client';
import { NotFoundError } from '../../../repo/errors';
import { newCatalogId } from '../mapping';
import { StaleAddOnWriteError } from '../errors';
import type { AddOnRule, AddOnStatus } from '../../../../shared/commerce/add-ons';

/**
 * shop_add_ons (migration 0940). One statement per operation, CAS on revision
 * like products. The rules column is trusted here because the ROUTE validated
 * it with RulesSchema; this file never re-parses a rule.
 */
export interface AddOn {
  id: string;
  title: string;
  description: string | null;
  imageId: string | null;
  priceMinor: number;
  currency: string;
  status: AddOnStatus;
  rules: AddOnRule[];
  position: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddOnInput {
  title: string;
  description?: string | null;
  imageId?: string | null;
  priceMinor: number;
  currency: string;
  status?: AddOnStatus;
  rules: AddOnRule[];
  position?: number;
}

/** Absent leaves the column alone; null clears a nullable one. */
export type AddOnPatch = Partial<Omit<AddOnInput, 'currency'>>;

const COLUMNS =
  'id, title, description, image_id, price_minor, currency, status, rules, position, revision, created_at, updated_at';

function rulesOf(value: unknown): AddOnRule[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as AddOnRule[]) : [];
}

function rowToAddOn(row: Record<string, unknown>): AddOn {
  return {
    id: String(row.id),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    imageId: row.image_id == null ? null : String(row.image_id),
    priceMinor: Number(row.price_minor),
    currency: String(row.currency),
    status: String(row.status) as AddOnStatus,
    rules: rulesOf(row.rules),
    position: Number(row.position),
    revision: Number(row.revision),
    createdAt: toEpochMs(row.created_at),
    updatedAt: toEpochMs(row.updated_at),
  };
}

export async function listAddOns(db: Db, status?: AddOnStatus): Promise<AddOn[]> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(COLUMNS)} FROM shop_add_ons
     WHERE ${status === undefined ? sql`true` : sql`status = ${status}`}
     ORDER BY position ASC, created_at ASC, id ASC`);
  return res.rows.map(rowToAddOn);
}

export async function getAddOn(db: Db, id: string): Promise<AddOn | null> {
  const res = await db.execute(sql`SELECT ${sql.raw(COLUMNS)} FROM shop_add_ons WHERE id = ${id}`);
  const row = res.rows[0];
  return row ? rowToAddOn(row) : null;
}

export async function createAddOn(db: Db, input: AddOnInput, now: number): Promise<AddOn> {
  const res = await db.execute(sql`
    INSERT INTO shop_add_ons
      (id, title, description, image_id, price_minor, currency, status, rules, position, revision, created_at, updated_at)
    VALUES (${newCatalogId('ado_')}, ${input.title}, ${input.description ?? null}::text,
            ${input.imageId ?? null}::text, ${input.priceMinor}::integer, ${input.currency},
            ${input.status ?? 'draft'}, ${JSON.stringify(input.rules)}::jsonb,
            ${input.position ?? 0}::integer, 1, ${now}::bigint, ${now}::bigint)
    RETURNING ${sql.raw(COLUMNS)}`);
  return rowToAddOn(res.rows[0]);
}

export async function updateAddOn(
  db: Db,
  id: string,
  baseRevision: number,
  patch: AddOnPatch,
  now: number,
): Promise<AddOn> {
  const sets: SQL[] = [];
  if (patch.title !== undefined) sets.push(sql`title = ${patch.title}`);
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}::text`);
  if (patch.imageId !== undefined) sets.push(sql`image_id = ${patch.imageId}::text`);
  if (patch.priceMinor !== undefined) sets.push(sql`price_minor = ${patch.priceMinor}::integer`);
  if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
  if (patch.rules !== undefined) sets.push(sql`rules = ${JSON.stringify(patch.rules)}::jsonb`);
  if (patch.position !== undefined) sets.push(sql`position = ${patch.position}::integer`);
  sets.push(sql`revision = revision + 1`, sql`updated_at = ${now}::bigint`);

  const res = await db.execute(sql`
    UPDATE shop_add_ons SET ${sql.join(sets, sql`, `)}
     WHERE id = ${id} AND revision = ${baseRevision}
    RETURNING ${sql.raw(COLUMNS)}`);
  if (res.rows.length > 0) return rowToAddOn(res.rows[0]);

  const current = await getAddOn(db, id);
  if (!current) throw new NotFoundError(id);
  throw new StaleAddOnWriteError(baseRevision, current.revision, current);
}
