import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Case-folding for the catalogue's free-text vocabulary.
 *
 * `category`, `tags` and `option_values` have no managed table behind them — the
 * VALUES are the vocabulary — and free text grows case-twins: the catalogue that
 * motivated this carried `PLA`, `pla`, `Pla` and `pLA` as four tags. Migration
 * `0010_catalogue_case_fold.sql` merged the existing twins; everything here is
 * what keeps new writes from minting more.
 *
 * THE RULE, EVERYWHERE: comparisons fold case, and a write that case-matches
 * something already stored ADOPTS the stored spelling. Typed text never wins a
 * casing fight against the catalogue, because the catalogue is what every other
 * screen is already rendering.
 *
 * THE READS ARE ADVISORY, AND THAT IS FINE. Two concurrent saves can still race
 * a fresh spelling in; the cost is one case-twin that the next save (or a rerun
 * of 0010, which is a fixpoint) irons out, and every read path folds anyway —
 * nothing downstream breaks in the window. A UNIQUE index over the folded value
 * would be the mechanical answer and there is no table to put it on.
 *
 * `toLowerCase()` HERE, `lower()` IN SQL — deliberately the same primitive on
 * both sides rather than a locale-aware collator on one: PGlite and Neon fold
 * with `lower()`, and a JS fold that disagreed with it (Turkish dotless-ı is the
 * classic) would merge in the UI what the database still counts apart.
 */

/** One folded spelling, for map keys. */
export const fold = (value: string): string => value.toLowerCase();

interface Spelling {
  value: string;
  count: number;
}

/** Most uses wins; alphabetical settles a tie, so the pick is stable. */
function best(current: Spelling | undefined, next: Spelling): Spelling {
  if (!current) return next;
  if (next.count > current.count) return next;
  if (next.count === current.count && next.value < current.value) return next;
  return current;
}

/**
 * The stored spelling of `category`, or the trimmed input when it is new.
 *
 * Most-common spelling, ties to the most recently updated product's, then
 * alphabetical — the same pick 0010 made, so a pre-migration straggler resolves
 * to the same canon the migration would have chosen.
 */
export async function canonicalCategory(db: Db, category: string): Promise<string> {
  const trimmed = category.trim();
  if (trimmed === '') return '';
  const res = await db.execute(sql`
    SELECT category FROM shop_products
     WHERE lower(category) = lower(${trimmed}) AND category <> ''
     GROUP BY category
     ORDER BY count(*) DESC, max(updated_at) DESC, category ASC
     LIMIT 1`);
  return res.rows[0] ? String(res.rows[0].category) : trimmed;
}

/**
 * Tags trimmed, case-deduplicated (first spelling and position win), and each
 * mapped to the catalogue's stored spelling when one exists.
 *
 * Dropping empties is deliberate: `''` and `'  '` are what a double comma in
 * the tag box produces, they render as blank chips, and no read path can filter
 * by them. checkPostMeta has already bounded the raw input before this runs.
 */
export async function canonicalTags(db: Db, tags: string[]): Promise<string[]> {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === '' || seen.has(fold(tag))) continue;
    seen.add(fold(tag));
    cleaned.push(tag);
  }
  if (cleaned.length === 0) return cleaned;

  const res = await db.execute(sql`
    SELECT tag AS value, count(*)::int AS cnt
      FROM shop_products, unnest(tags) AS tag
     WHERE lower(tag) = ANY(${sql.param(cleaned.map(fold))})
     GROUP BY tag`);

  const canon = new Map<string, Spelling>();
  for (const row of res.rows) {
    const value = String(row.value);
    canon.set(fold(value), best(canon.get(fold(value)), { value, count: Number(row.cnt) }));
  }
  return cleaned.map((tag) => canon.get(fold(tag))?.value ?? tag);
}

/**
 * The identity of an option tuple, up to case and key order.
 *
 * BUILT IN JS, NOT FROM `option_values::text`: jsonb serialisation orders keys
 * by LENGTH then bytes, so two casings of same-length keys can serialise in
 * different orders and the lowered text stops being an identity. Folding and
 * sorting here makes the comparison independent of anything the database does.
 */
export function foldedTupleKey(optionValues: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(optionValues)
      .map(([k, v]) => [fold(k.trim()), fold(v.trim())])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

/**
 * An incoming tuple, re-spelled in the product's existing vocabulary.
 *
 * Keys adopt the spelling of the axis they case-match (`colour` → `Colour`);
 * values adopt the spelling already stored for that axis (`black` → `Black`).
 * Most-common-then-alphabetical, per product — an axis is one product's
 * vocabulary, not the shop's.
 *
 * Returns null when the tuple has no honest storable form: an empty key or
 * value, or two incoming keys collapsing onto one axis (`Colour` and `colour`
 * in one request). The caller refuses those as `optionValues`.
 */
export function canonicalizeOptions(
  existing: Record<string, string>[],
  incoming: Record<string, string>,
): Record<string, string> | null {
  // Tally every spelling first, pick winners after — folding while tallying
  // would make the pick depend on iteration order whenever counts tie.
  const keySpellings = new Map<string, Map<string, number>>();
  const valueSpellings = new Map<string, Map<string, number>>();
  const bump = (into: Map<string, Map<string, number>>, group: string, spelling: string): void => {
    const counts = into.get(group) ?? new Map<string, number>();
    counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
    into.set(group, counts);
  };
  for (const tuple of existing) {
    for (const [key, value] of Object.entries(tuple)) {
      bump(keySpellings, fold(key), key);
      bump(valueSpellings, `${fold(key)} ${fold(value)}`, value);
    }
  }
  const winner = (counts: Map<string, number> | undefined): string | undefined => {
    let top: Spelling | undefined;
    for (const [value, count] of counts ?? []) top = best(top, { value, count });
    return top?.value;
  };

  const result: Record<string, string> = {};
  const usedAxes = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === '' || value === '') return null;
    const canonKey = winner(keySpellings.get(fold(key))) ?? key;
    // Folded, not raw: `Colour` and `colour` in one request are one axis twice
    // even when the product has no vocabulary yet to map them onto.
    if (usedAxes.has(fold(canonKey))) return null;
    usedAxes.add(fold(canonKey));
    result[canonKey] = winner(valueSpellings.get(`${fold(key)} ${fold(value)}`)) ?? value;
  }
  return result;
}
