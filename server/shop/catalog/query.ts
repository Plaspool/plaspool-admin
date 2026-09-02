import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { toEpochMsOrNull } from '../../db/client';
import {
  encodeCursor,
  pageLimit,
  rejectNul,
  requireCursor,
  type CursorValue,
} from '../../repo/cursor';
import { BadRequestError } from '../../repo/errors';
import { LIST_PRODUCT_COLUMNS, productColumns, rowToProduct } from './mapping';
import type { Product } from './types';

/**
 * `GET /api/shop/products` — filter, sort, keyset pagination.
 *
 * THE CURSOR CODEC IS `server/repo/cursor.ts`, VERBATIM, AND NOT A SECOND ONE.
 * Contract §3 says so and brief §6 repeats it. That codec carries its own sort
 * key inside the payload for a measured reason (GAUNTLET II Part 2b #2): a width
 * comparison cannot tell four one-component sorts apart, so a storefront
 * changing its sort dropdown mid-scroll either raised 22P02 — a 500 the client
 * retries five times for a request that can never succeed — or silently returned
 * a page with rows missing from it. `requireCursor` refuses a cursor minted
 * under another ordering with a 400.
 *
 * `pageLimit` REJECTS RATHER THAN CLAMPS, also inherited: silently handing back
 * 100 rows to a caller who asked for 500 makes a truncated page
 * indistinguishable from a complete one, which is how a client that paginates by
 * "did I get fewer than I asked for" stops early.
 */

export type ProductSort = 'newest' | 'price_asc' | 'price_desc' | 'alphabetical';

export interface ProductListQuery {
  sort: ProductSort;
  category?: string;
  cursor?: string;
  limit?: number;
  /**
   * Storefront (`false`, the default) sees only what is on sale. Admin (`true`)
   * sees drafts and archived products, and `status` then filters within that.
   */
  includeUnpublished?: boolean;
  status?: 'draft' | 'active' | 'archived' | 'trash';
  /**
   * OPT-IN, and it stays opt-in — see the `size + 1` note in `listProducts`
   * for why the page itself refuses to pay for a COUNT. The products screen
   * asks for it exactly once, to say how many products an export would carry.
   */
  withTotal?: boolean;
}

interface SortPart {
  /** Used identically in the SELECT list, the ORDER BY and the keyset. */
  expr: SQL;
  direction: 'asc' | 'desc';
  /**
   * The Postgres type `expr` has, and therefore the only type a cursor component
   * may be bound as. Declared rather than inferred so a component is COERCED to
   * it before it reaches the driver — the cursor payload is base64 JSON, so a
   * caller can put anything in it, and a string compared against a bigint column
   * is SQLSTATE 22P02 and a 500.
   */
  type: 'number' | 'text';
  /** `price` is NULL for an unpriced variant. NULLS LAST in both directions. */
  nullable?: boolean;
}

/**
 * The lowest current price across a product's active variants.
 *
 * A SUBQUERY IN THE SELECT LIST, NOT A JOIN. A product has many variants and
 * many prices; joining would multiply the product rows and make `LIMIT n + 1`
 * mean something other than "n + 1 products". The alternative — `GROUP BY` over
 * every product column — is the same query with a longer clause and a worse
 * plan on the columns that are actually indexed.
 *
 * `min` and not `max`: a size-graded product sorted by "price low to high"
 * belongs at the position of the cheapest thing a customer can actually buy.
 */
const MIN_PRICE = sql.raw(`(
  SELECT min(pr.amount) FROM shop_variants v
    JOIN shop_prices pr ON pr.variant_id = v.id AND pr.effective_to IS NULL
   WHERE v.product_id = p.id AND v.status = 'active')`);

/**
 * `title` folded for a case- and accent-insensitive sort.
 *
 * DELIBERATELY NOT `COLLATE "en-US-x-icu"`. That collation does not exist in
 * PGlite (42704, verified on the blog side) and is a bet on how any given
 * deployment was compiled. The fold below is built from functions that exist
 * everywhere — NFKD, drop combining marks, lowercase — and `COLLATE "C"` then
 * makes the comparison byte-ordered over the folded text, so the ordering is
 * identical in PGlite and on Neon rather than depending on each database's
 * `datcollate`.
 *
 * NARROWER THAN `server/repo/query.ts`'s `titleFold`, and knowingly: that one
 * carries nine primary-strength expansions (`ß → ss`, `æ → ae`, …) measured
 * against `Intl.Collator` over a 2016-pair census, because the blog's dashboard
 * sorts in the browser and the two had to agree. A product list is sorted only
 * by the server, so there is no second implementation to match and no census to
 * satisfy — but `Straße` will sort after `zzz` here, which is recorded rather
 * than left to be discovered. Importing `titleFold` would be the better answer
 * and is a cross-module dependency on a file Catalog does not own; it is
 * available to reuse the day this list gains a client-side twin.
 */
const TITLE_SORT = sql.raw(
  `lower(regexp_replace(normalize(COALESCE(NULLIF(p.title, ''), 'Untitled'), NFKD), ` +
    `'[\\u0300-\\u036f]', '', 'g')) COLLATE "C"`,
);

const SORTS: Record<ProductSort, SortPart[]> = {
  newest: [{ expr: sql.raw('p.created_at'), direction: 'desc', type: 'number' }],
  price_asc: [{ expr: MIN_PRICE, direction: 'asc', nullable: true, type: 'number' }],
  price_desc: [{ expr: MIN_PRICE, direction: 'desc', nullable: true, type: 'number' }],
  alphabetical: [{ expr: TITLE_SORT, direction: 'asc', type: 'text' }],
};

function readKey(part: SortPart, value: unknown): CursorValue {
  return part.type === 'text' ? String(value) : toEpochMsOrNull(value);
}

/**
 * A cursor component forced into the type its part declares — or a 400.
 *
 * The last line of defence for both halves of the cursor contract. The sort key
 * inside the payload already refuses a cursor minted under another ordering, but
 * the payload is base64 JSON that anyone can write, so a hand-made cursor can
 * name the right sort and still carry the wrong shape.
 */
function coerce(part: SortPart, value: CursorValue): CursorValue {
  if (value === null) {
    // Only a price can BE null. A null against a non-nullable part would make
    // `expr > NULL` evaluate to NULL — an empty page rather than an error, i.e.
    // a silent skip.
    if (!part.nullable) throw new BadRequestError('cursor');
    return null;
  }
  if (part.type === 'text') return rejectNul(String(value), 'cursor');
  const n = Number(value);
  if (!Number.isFinite(n)) throw new BadRequestError('cursor');
  return n;
}

/**
 * Strictly after `value` in this part's own ordering.
 *
 * The NULL branches are what make NULLS LAST paginate. Under NULLS LAST nothing
 * sorts after a NULL, so a cursor holding one leaves only the id tiebreak; and a
 * cursor holding a value has every NULL after it, which is why `IS NULL` is
 * OR-ed in rather than left to the comparison (`col < 5` is NULL, not true, for
 * a NULL column).
 */
function after(part: SortPart, value: CursorValue): SQL {
  const op = part.direction === 'desc' ? sql.raw('<') : sql.raw('>');
  if (!part.nullable) return sql`${part.expr} ${op} ${value}`;
  if (value === null) return sql`false`;
  return sql`(${part.expr} ${op} ${value} OR ${part.expr} IS NULL)`;
}

function equal(part: SortPart, value: CursorValue): SQL {
  return value === null ? sql`${part.expr} IS NULL` : sql`${part.expr} = ${value}`;
}

/**
 * The lexicographic "row strictly after the cursor" predicate, with the id
 * tiebreak that makes the order TOTAL.
 *
 * Without the tiebreak, two products sharing a sort key — two published in the
 * same millisecond, two at £19.99 — can be returned twice or skipped entirely
 * across a page boundary, and neither shows up as an error anywhere.
 */
function keysetPredicate(parts: SortPart[], values: CursorValue[], id: string): SQL {
  const clauses: SQL[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const conditions = parts
      .slice(0, i)
      .map((part, j) => equal(part, values[j]))
      .concat(after(parts[i], values[i]));
    clauses.push(sql`(${sql.join(conditions, sql` AND `)})`);
  }
  const tie = parts.map((part, j) => equal(part, values[j])).concat(sql`p.id > ${id}`);
  clauses.push(sql`(${sql.join(tie, sql` AND `)})`);
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

function orderBy(parts: SortPart[]): SQL {
  const terms = parts.map((part) => {
    const direction = part.direction === 'desc' ? 'DESC' : 'ASC';
    // NULLS LAST in BOTH directions: an unpriced product belongs at the end of
    // "cheapest first" and at the end of "most expensive first" alike, because
    // in neither case is it a price the customer can compare.
    const nulls = part.nullable ? ' NULLS LAST' : '';
    return sql`${part.expr} ${sql.raw(direction + nulls)}`;
  });
  return sql.join(terms.concat(sql`p.id ASC`), sql`, `);
}

function filters(q: ProductListQuery): SQL[] {
  const where: SQL[] = [];

  if (q.includeUnpublished) {
    /*
     * Trash is a VIEW, not a status — `deleted_at` is independent of `status`,
     * so a trashed product keeps whatever status it had. Every other filter
     * excludes the trash entirely, exactly as the blog's does.
     */
    if (q.status === 'trash') {
      where.push(sql`p.deleted_at IS NOT NULL`);
    } else {
      where.push(sql`p.deleted_at IS NULL`);
      if (q.status) where.push(sql`p.status = ${q.status}`);
    }
  } else {
    /*
     * THE STOREFRONT PREDICATE, AND IT IS NOT OPTIONAL. It is the same one
     * `getActiveProductBySlug` and `quote()` apply; a list that showed a draft
     * would give a customer a link to a page that 404s, and one that showed a
     * trashed product would offer something the cart refuses to hold.
     */
    where.push(sql`p.deleted_at IS NULL`);
    where.push(sql`p.status = 'active'`);
  }

  // `if (q.category && …)`: an empty string is "no filter", not "products with
  // no category". NUL-checked before binding — it arrives from a query string,
  // `.trim()` does not strip a U+0000, and one reaching the driver is SQLSTATE
  // 22021, a 500 the client retries five times for input never acceptable.
  //
  // FOLDED ON BOTH SIDES (migration 0010): `Specialty` and `specialty` are one
  // category to every screen now, so a filter that matched only one spelling
  // would return a subset with no error anywhere to explain the missing rows —
  // the exact failure the old exact-match version of this line was defending
  // against from the other direction, back when the picker offered raw
  // spellings. `admin/categories.ts` folds its grouping to match; the two move
  // together or not at all. Served by `shop_products_category_fold_idx`.
  if (q.category) {
    where.push(sql`lower(p.category) = lower(${rejectNul(q.category, 'category')})`);
  }

  return where;
}

export async function listProducts(
  db: Db,
  q: ProductListQuery,
): Promise<{ items: Product[]; nextCursor: string | null; total?: number }> {
  const size = pageLimit(q.limit);
  const parts = SORTS[q.sort];
  if (!parts) throw new BadRequestError('sort');

  const matching = filters(q);
  const where = [...matching];
  if (q.cursor !== undefined) {
    const cursor = requireCursor(q.cursor, q.sort);
    if (cursor.sortValues.length !== parts.length) throw new BadRequestError('cursor');
    const values = parts.map((part, i) => coerce(part, cursor.sortValues[i]));
    where.push(keysetPredicate(parts, values, cursor.id));
  }

  /*
   * THE SORT KEYS ARE SELECTED, NOT RECOMPUTED IN JS. `alphabetical` sorts on a
   * folded, collated expression and `price_asc` on a subquery; deriving either
   * in TypeScript to build the cursor would be a second implementation, and any
   * disagreement shows up as a page boundary that skips or repeats rows rather
   * than as an error.
   */
  const keys = parts.map((part, i) => sql`${part.expr} AS ${sql.raw(`k${i}`)}`);

  const res = await db.execute(sql`
    SELECT ${sql.raw(productColumns('p', LIST_PRODUCT_COLUMNS))},
           ${sql.join(keys, sql`, `)}
      FROM shop_products p
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${orderBy(parts)}
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const rows = res.rows.slice(0, size);
  const items = rows.map(rowToProduct);
  const last = rows[rows.length - 1];
  const more = res.rows.length > size;

  /*
   * The COUNT the paging deliberately avoids, run ONLY when asked and against
   * `matching` — the filters WITHOUT the cursor predicate, so it answers "how
   * many in total" rather than "how many are left after this page".
   */
  let total: number | undefined;
  if (q.withTotal) {
    const counted = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM shop_products p
       WHERE ${sql.join(matching, sql` AND `)}`);
    // `::int` for the reason categories.ts gives: an unqualified count(*) is
    // int8, which one driver hands back as a string and the other as a number.
    total = Number(counted.rows[0]?.n ?? 0);
  }

  return {
    items,
    ...(total === undefined ? {} : { total }),
    nextCursor:
      more && last
        ? encodeCursor(
            q.sort,
            parts.map((part, i) => readKey(part, last[`k${i}`])),
            String(last.id),
          )
        : null,
  };
}
