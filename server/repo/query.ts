import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMsOrNull } from '../db/client';
import { LIST_POST_COLUMNS, postColumns, rowToListPost } from './mapping';
import {
  encodeCursor,
  pageLimit,
  rejectNul,
  requireCursor,
  type CursorValue,
} from './cursor';
import { BadRequestError } from './errors';
import type { ListPost, SortKey, StatusFilter } from '../../shared/types';

/**
 * `GET /api/posts` (spec §5.2): filter, sort, keyset pagination, full-text
 * search.
 *
 * This is the one place the frontend's `filterAndSort` moves server-side, and
 * three of its five orderings do not survive a naive translation. Each failure
 * is a list that is quietly in the wrong order rather than an error:
 *
 * - `alphabetical` compares `(title || 'Untitled')` with
 *   `localeCompare(…, { sensitivity: 'base' })` — case- and accent-insensitive,
 *   with `''` folded to `'Untitled'`. Postgres sorts `''` before every letter,
 *   and a byte-ordered collation puts every capital before every lowercase, so
 *   `Zebra` would precede `apple`.
 * - `published` uses `?? -Infinity`, i.e. NULLS **LAST** on a descending sort.
 *   Postgres defaults to NULLS FIRST on DESC, which would head "recently
 *   published" with every post that has never been published.
 * - `drafts-first` sorts on a two-part key, `(statusRank, updatedAt)`.
 *
 * AND SEARCH IS NOT A SUBSTRING MATCH ANY MORE. `filterAndSort` lowercases a
 * joined haystack and calls `String.includes`; this matches a `tsvector`. Most
 * of the difference is an improvement — `bodies` now finds `body` — but two
 * cases are a visible regression to a writer, and the second is the one that
 * will be reported as a bug: `ost` no longer matches `post`, and **a
 * stopword-only search matches nothing at all**, so `?search=the` returns zero
 * rows where the dashboard returned every post containing those three letters.
 * Both are asserted in `query.test.ts` and recorded in spec §5.2 so the cutover
 * meets them as a decision rather than as a surprise. The fix, if it is ever
 * unwanted, is a trigram index — not a reversion to scanning every document in
 * the browser.
 */

export interface ListQuery {
  status: StatusFilter;
  search?: string;
  category?: string;
  tag?: string;
  sort: SortKey;
  cursor?: string;
  limit?: number;
}

/** The plan places the cursor codec here; it is defined in `./cursor`. */
export { encodeCursor, decodeCursor } from './cursor';

// ------------------------------------------------------------------ sorting

/**
 * EXPORTED so the PUBLIC list (`./public.ts`) can reuse the ordering, the keyset
 * and the cursor coercion without reusing `listPosts` itself — whose signature
 * takes a `StatusFilter` and would happily accept `'trash'` (plan D2). Sharing
 * the pagination machinery is safe; sharing the filter builder is not.
 *
 * Additive: nothing below changed except the `export` keywords.
 */
export interface SortPart {
  /** Used identically in the SELECT list, the ORDER BY and the keyset. */
  expr: SQL;
  direction: 'asc' | 'desc';
  /**
   * The Postgres type `expr` has, and therefore the only type a cursor
   * component may be bound as.
   *
   * Declared rather than inferred so a cursor component is COERCED to it before
   * it reaches the driver: the cursor payload is base64 JSON, so a caller can
   * put anything in it, and a string compared against `p.updated_at` is
   * SQLSTATE 22P02 — a `DbError`, a 500, and five client retries for a request
   * that can never succeed.
   */
  type: 'number' | 'text';
  /** Only `published_at` is nullable. NULLS LAST either way, as the client is. */
  nullable?: boolean;
}

/**
 * Letters ICU treats as equal to a base letter (or to a pair of them) at
 * PRIMARY strength but that NFKD does not decompose, because they are letters
 * in their own right rather than letter-plus-accent.
 *
 * Without these, `Straße` folds to `straße`, whose UTF-8 bytes put it after
 * every ASCII string — so it sorted after `zzz` on the server and mid-alphabet
 * in the dashboard. Same for `Ærø`, `Œuvre`, `Øst`, `Łódź`.
 *
 * MEASURED, NOT ASSUMED, AND `þ` IS DELIBERATELY ABSENT. Over the 64-title,
 * 2016-pair census in `query.test.ts`, against
 * `Intl.Collator(undefined, { sensitivity: 'base' })`, adding `þ → th` makes
 * parity WORSE: ICU's root collation gives thorn its own primary weight after
 * `z` rather than treating it as a digraph, and an unexpanded `þ` folds to a
 * two-byte sequence `COLLATE "C"` also sorts after every ASCII letter — so
 * leaving it alone is what matches. `ð`, by contrast, ICU really does weight as
 * a `d`, so it is expanded.
 *
 * `ı → i` and `ŋ → n` are near misses kept on purpose. ICU orders those two
 * immediately AFTER their base letter rather than equal to it, so folding makes
 * `ıstanbul` tie with `istanbul` where ICU separates them by one — against not
 * folding, which puts it after `zzz`.
 */
const PRIMARY_EXPANSIONS: [string, string][] = [
  ['ß', 'ss'],
  ['æ', 'ae'],
  ['œ', 'oe'],
  ['ø', 'o'],
  ['ð', 'd'],
  ['đ', 'd'],
  ['ł', 'l'],
  ['ı', 'i'],
  ['ŋ', 'n'],
];

/**
 * `(a.title || 'Untitled')` compared at base sensitivity, in SQL.
 *
 * DELIBERATELY NOT `COLLATE "en-US-x-icu"`, which is what the plan prescribes:
 * that collation does not exist in PGlite (`42704`, verified), so the plan's
 * expression is unrunnable in the test environment and would be a 500 on the
 * one sort key in any production build without ICU. `und-x-icu` does exist and
 * matches — but it is still a bet on how the deployment was compiled.
 *
 * So the fold is done with built-ins instead: NFKD, drop the combining marks,
 * lowercase — the same fold `slugify` performs in `shared/doc.ts` — plus the
 * primary-strength expansions above, which `slugify` does not need and a
 * collator does. `COLLATE "C"` then makes the comparison byte-ordered over the
 * folded text, which is the only collation guaranteed to exist everywhere and
 * the only way the ordering is identical in PGlite and on Neon rather than
 * depending on each database's `datcollate`.
 *
 * WHAT THIS IS AND IS NOT — MEASURED, AND NARROWER THAN THIS COMMENT USED TO
 * CLAIM. It said "identical ordering", having been measured over a corpus that
 * contained none of the shapes that break it. Censused against
 * `Intl.Collator(undefined, { sensitivity: 'base' })` over 64 titles chosen to
 * include them, it disagrees on 84 of 2016 pairs:
 *
 * - **Punctuation, 80 pairs.** ICU gives punctuation primary weights of its
 *   own, ordered by category rather than by code point: `~tilde` sorts before
 *   every letter for ICU and after every letter here, `-dash` before `_under`
 *   there and after it here, and the same rule applies inside a word
 *   (`the-end` vs `the_end` vs `the'end`). Reproducing it needs ICU's weight
 *   table, which is the dependency this expression exists to avoid.
 * - **NFKD compatibility forms, 2 pairs.** `normalize(…, NFKD)` is
 *   COMPATIBILITY decomposition, so `①`, `½`, `ﬁ` and `㎏` fold to their ASCII
 *   spellings; ICU keeps them distinct at primary strength.
 * - **Dotless `ı` and eng `ŋ`, 2 pairs.** Folded to their base letter, so they
 *   tie where ICU orders them one apart. See `PRIMARY_EXPANSIONS`.
 *
 * NO PAIR OF ORDINARY ALPHABETIC TITLES DISAGREES, which is the claim that
 * matters and the one that was false before the expansions: `Straße` used to
 * sort after `zzz` here and next to `Strasse` in the dashboard.
 *
 * All four counts are pinned by the census in `query.test.ts`, which imports
 * this expression rather than transcribing it — a second copy of a sort key is
 * a second implementation, and the disagreement between two of them is a page
 * boundary that skips rows.
 */
export function titleFold(column: string): string {
  return PRIMARY_EXPANSIONS.reduce(
    (expr, [from, to]) => `replace(${expr}, '${from}', '${to}')`,
    `lower(regexp_replace(normalize(COALESCE(NULLIF(${column}, ''), 'Untitled'), NFKD), ` +
      `'[\\u0300-\\u036f]', '', 'g'))`,
  );
}

const TITLE_SORT = sql.raw(`${titleFold('p.title')} COLLATE "C"`);

/** `rank()` from `src/data/posts.ts:493`. */
const STATUS_RANK = sql.raw(
  `CASE p.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END`,
);

export const SORTS: Record<SortKey, SortPart[]> = {
  updated: [{ expr: sql.raw('p.updated_at'), direction: 'desc', type: 'number' }],
  published: [
    { expr: sql.raw('p.published_at'), direction: 'desc', nullable: true, type: 'number' },
  ],
  oldest: [{ expr: sql.raw('p.created_at'), direction: 'asc', type: 'number' }],
  alphabetical: [{ expr: TITLE_SORT, direction: 'asc', type: 'text' }],
  'drafts-first': [
    { expr: STATUS_RANK, direction: 'asc', type: 'number' },
    { expr: sql.raw('p.updated_at'), direction: 'desc', type: 'number' },
  ],
};

/** Read the key back off the row, in the type the cursor should carry. */
export function readKey(part: SortPart, value: unknown): CursorValue {
  return part.type === 'text' ? String(value) : toEpochMsOrNull(value);
}

/**
 * A cursor component, forced into the type its part declares — or a 400.
 *
 * The last line of defence for BOTH halves of the cursor contract. The sort key
 * inside the payload already refuses a cursor minted under another ordering,
 * but the payload is base64 JSON that anyone can write, so a hand-made cursor
 * can name the right sort and still carry the wrong shape. Coercing here means
 * no cursor component can reach the driver as a type the column does not
 * accept, whatever the payload said.
 */
export function coerce(part: SortPart, value: CursorValue): CursorValue {
  if (value === null) {
    // Only `published_at` can BE null. A null against a non-nullable part would
    // make `expr > NULL` evaluate to NULL, i.e. an empty page rather than an
    // error — a skip, silently.
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
 * sorts after a NULL, so a cursor holding one leaves only the id tiebreak; and
 * a cursor holding a value has every NULL after it, which is why `IS NULL` is
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
 * The lexicographic "row strictly after the cursor" predicate.
 *
 * A plain row comparison `(a, b) < ($1, $2)` would be shorter and is wrong
 * here: `drafts-first` mixes directions (rank ascending, updatedAt descending)
 * and row comparison applies one direction to the whole tuple. Expanded, each
 * part carries its own direction and its own NULL rule, and the final clause is
 * the id tiebreak that makes the order total — without which two posts sharing
 * a sort key can be returned twice or skipped entirely across a page boundary.
 */
export function keysetPredicate(parts: SortPart[], values: CursorValue[], id: string): SQL {
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

export function orderBy(parts: SortPart[]): SQL {
  const terms = parts.map((part) => {
    const direction = part.direction === 'desc' ? 'DESC' : 'ASC';
    // NULLS LAST in BOTH directions: `?? -Infinity` puts them last on the
    // client's descending sort, and ASC is NULLS LAST by default anyway.
    const nulls = part.nullable ? ' NULLS LAST' : '';
    return sql`${part.expr} ${sql.raw(direction + nulls)}`;
  });
  return sql.join(terms.concat(sql`p.id ASC`), sql`, `);
}

// ------------------------------------------------------------------- filters

function filters(q: ListQuery): SQL[] {
  const where: SQL[] = [];

  /*
   * Trash is a view, not a status: `deleted_at` is independent of `status`, so
   * a trashed post keeps whatever status it had. Every other filter excludes
   * the trash entirely — `src/data/posts.ts:451-456`.
   */
  if (q.status === 'trash') {
    where.push(sql`p.deleted_at IS NOT NULL`);
  } else {
    where.push(sql`p.deleted_at IS NULL`);
    if (q.status !== 'all') where.push(sql`p.status = ${q.status}`);
  }

  /*
   * ALL THREE TEXT FILTERS ARE CHECKED FOR U+0000 BEFORE THEY ARE BOUND.
   *
   * They arrive from a query string and go straight into the predicate;
   * `.trim()` does not strip a NUL and no domain rule forbids one, so
   * `GET /api/posts?search=%00` reached the driver as SQLSTATE 22021, scrubbed
   * to a `DbError`, and answered 500 — which the client's retry policy then
   * repeats five times for a request that can never succeed. `pageLimit` and
   * `decodeCursor` already answer their own malformed input with a 400; this is
   * the same answer for the same class of input.
   */
  // `if (q.category && …)` in the client: an empty string is "no filter", not
  // "posts with no category".
  if (q.category) where.push(sql`p.category = ${rejectNul(q.category, 'category')}`);
  // `@>` rather than `= ANY`, so the GIN index on `tags` can serve it.
  if (q.tag) where.push(sql`p.tags @> ${sql.param([rejectNul(q.tag, 'tag')])}::text[]`);

  const needle = rejectNul((q.search ?? '').trim(), 'search');
  if (needle) {
    /*
     * `websearch_to_tsquery`, never `to_tsquery`. `to_tsquery` is a parser: a
     * bare `&`, a `!`, or an unbalanced quote raises a syntax error, and a
     * syntax error behind a search box is a 500 on ordinary typing.
     * `websearch_to_tsquery` accepts anything and additionally gives quoted
     * phrases and `-exclusion` for free.
     */
    where.push(sql`p.search @@ websearch_to_tsquery('english', ${needle})`);
  }

  return where;
}

// ---------------------------------------------------------------------- list

export async function listPosts(
  db: Db,
  q: ListQuery,
): Promise<{ items: ListPost[]; nextCursor: string | null }> {
  const size = pageLimit(q.limit);
  const parts = SORTS[q.sort];
  if (!parts) throw new BadRequestError('sort');

  const where = filters(q);
  if (q.cursor !== undefined) {
    /*
     * A cursor minted under one sort key cannot be spent under another: the
     * components would be compared against different columns, which either
     * raises a type error (an `alphabetical` cursor under `updated` is 22P02, a
     * 500, five retries) or does not fail at all and simply returns a page with
     * rows missing from it (measured: a `published` cursor under `oldest`
     * returned 2 of 8 rows). `requireCursor` matches the sort key the payload
     * carries against the active one, so neither is reachable — and the width
     * check below is no longer the thing standing between the two, it is only
     * the guard for a hand-made payload that names the right sort and carries
     * the wrong number of components.
     */
    const cursor = requireCursor(q.cursor, q.sort);
    if (cursor.sortValues.length !== parts.length) throw new BadRequestError('cursor');
    const values = parts.map((part, i) => coerce(part, cursor.sortValues[i]));
    where.push(keysetPredicate(parts, values, cursor.id));
  }

  /*
   * THE SORT KEYS ARE SELECTED, NOT RECOMPUTED IN JS.
   *
   * `alphabetical` sorts on a folded, collated expression; deriving the same
   * value in TypeScript to build the cursor would be a second implementation of
   * that fold, and any disagreement between the two shows up as a page boundary
   * that skips or repeats rows rather than as an error. Letting the database
   * hand back the value it ordered on removes the possibility.
   */
  const keys = parts.map((part, i) => sql`${part.expr} AS ${sql.raw(`k${i}`)}`);

  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p', LIST_POST_COLUMNS))},
           u.display_name AS author_name,
           ${sql.join(keys, sql`, `)}
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${orderBy(parts)}
     LIMIT ${size + 1}`);

  // `size + 1` rather than a COUNT: the extra row is the whole of the evidence
  // needed for "is there another page", at no extra scan.
  const rows = res.rows.slice(0, size);
  const items = rows.map((row) => rowToListPost(row, String(row.author_name)));
  const last = rows[rows.length - 1];
  const more = res.rows.length > size;

  return {
    items,
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
