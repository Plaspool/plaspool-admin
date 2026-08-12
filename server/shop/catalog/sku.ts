import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * A SKU, derived rather than demanded.
 *
 * WHY THIS EXISTS. `sku` was required on create, so the first thing the product
 * form asked for was an identifier — before a colour, before a price, before
 * anything a person actually knows about what they are selling. That is the
 * wrong order: a SKU is a consequence of the variant, not a precondition for
 * describing one, and making somebody invent `WOOD-175-EBY-1KG` before they can
 * say "the ebony one" is asking them to do the computer's filing.
 *
 * IT IS STILL EXACTLY ONE SKU PER VARIANT and still UNIQUE — that constraint is
 * a picking error in a warehouse if it slips, and nothing here loosens it.
 * `shop_variants_sku_unique` remains the authority; this only stops the human
 * being the one who has to satisfy it.
 *
 * SUPPLIED BEATS GENERATED, ALWAYS. A shop with an existing catalogue has SKUs
 * that mean something to a supplier, and a generated one that quietly replaced
 * them would be worse than no generator at all.
 */

/**
 * Uppercase, alphanumeric, hyphen-joined, and short enough to read.
 *
 * `1.75 mm` becomes `175`, not `1-75`: a decimal point inside a token is part of
 * the measurement, so stripping it keeps the number legible where splitting on
 * it would produce two meaningless fragments.
 */
function words(value: string): string[] {
  return value
    .normalize('NFKD')
    // Strip accents, so "Café" and "Cafe" cannot become two different codes.
    .replace(/[̀-ͯ]/g, '')
    // `1.75` is ONE measurement. Splitting on the point yields `1` and `75`,
    // which are two numbers that mean nothing.
    .replace(/[.,](?=\d)/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * One option value, shortened: `Natural Birch` -> `NATBIR`, `Black` -> `BLACK`.
 *
 * Multi-word values take each word's head so the two halves both survive —
 * `NATURAL` alone would collide with `Natural Walnut`.
 */
function valueCode(value: string, max = 6): string {
  const parts = words(value);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, max);
  const per = Math.max(2, Math.floor(max / parts.length));
  return parts.map((w) => w.slice(0, per)).join('').slice(0, max);
}

/**
 * The product's half: its first word, plus the first token carrying a digit.
 *
 * NOT AN ABBREVIATION OF EVERY WORD. Squeezing "PLA+ Filament 1.75 mm — 1 kg"
 * into ten characters that way gives `PLFI17MM1K`, which is unreadable and
 * truncates the one number that distinguishes the product from its neighbour.
 * The first word is what a person calls the thing, and the spec digits are what
 * separates two of them — `PLA-175`, which is what somebody writing these by
 * hand actually produces.
 */
function titleCode(title: string): string {
  const parts = words(title);
  if (parts.length === 0) return '';
  const head = parts[0].slice(0, 8);
  const spec = parts.slice(1).find((w) => /\d/.test(w));
  return spec ? `${head}-${spec.slice(0, 5)}` : head;
}

/**
 * The candidate for a variant of `title` with these options.
 *
 * Option VALUES only, never their axis names: `BLACK` says what the variant is
 * and `COLOUR-BLACK` says it twice. The axes are ordered by name so the same
 * combination cannot produce two different SKUs depending on which switch the
 * form happened to render first.
 */
export function skuCandidate(
  title: string,
  optionValues: Record<string, string>,
  suffix = 0,
): string {
  const head = titleCode(title) || 'ITEM';
  const parts = Object.keys(optionValues)
    .sort()
    .map((k) => valueCode(optionValues[k] ?? ''))
    .filter(Boolean);
  const base = [head, ...parts].join('-');
  return suffix === 0 ? base : `${base}-${suffix}`;
}

/** How far the numeric ladder climbs before giving up and randomising. */
const NUMBERED_ATTEMPTS = 12;

/**
 * The first free SKU for this variant.
 *
 * A LADDER, NOT A RETRY, for the reason `slug.ts` documents at length: every
 * concurrent writer derives the same first candidate from the same taken set, so
 * re-deriving admits one writer per round. The numbered rungs keep a family of
 * variants reading as a sequence, and the random tail terminates it rather than
 * leaving a caller to collide forever.
 *
 * The read is advisory — `shop_variants_sku_unique` is what actually decides,
 * and `createVariant` still answers `DuplicateSkuError` if this loses a race.
 */
export async function generateSku(
  db: Db,
  title: string,
  optionValues: Record<string, string>,
): Promise<string> {
  const candidates: string[] = [];
  for (let i = 0; i <= NUMBERED_ATTEMPTS; i += 1) {
    candidates.push(skuCandidate(title, optionValues, i));
  }

  const res = await db.execute(sql`
    SELECT sku FROM shop_variants WHERE sku = ANY(${sql.param(candidates)})`);
  const taken = new Set(res.rows.map((r) => String(r.sku)));
  const free = candidates.find((c) => !taken.has(c));
  if (free) return free;

  // Every rung taken. A short random tail, rather than a longer count that a
  // crowd would also agree on.
  const tail = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${skuCandidate(title, optionValues)}-${tail}`;
}
