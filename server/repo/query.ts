import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMsOrNull } from '../db/client';
import { LIST_POST_COLUMNS, postColumns, rowToListPost } from './mapping';
import { encodeCursor, pageLimit, requireCursor, type CursorValue } from './cursor';
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

interface SortPart {
  /** Used identically in the SELECT list, the ORDER BY and the keyset. */
  expr: SQL;
  direction: 'asc' | 'desc';
  /** Only `published_at` is nullable. NULLS LAST either way, as the client is. */
  nullable?: boolean;
  /** Read the key back off the row, in the type the cursor should carry. */
  read(value: unknown): CursorValue;
}

/**
 * `(a.title || 'Untitled')` compared at base sensitivity, in SQL.
 *
 * DELIBERATELY NOT `COLLATE "en-US-x-icu"`, which is what the plan prescribes:
 * that collation does not exist in PGlite (`42704`, verified), so the plan's
 * expression is unrunnable in the test environment and would be a 500 on the
 * one sort key in any production build without ICU. `und-x-icu` does exist and
 * matches — but it is still a bet on how the deployment was compiled.
 *
 * So the fold is done with built-ins instead, and it is the SAME fold
 * `slugify` already performs in `shared/doc.ts`: NFKD, drop the combining
 * marks, lowercase. `COLLATE "C"` then makes the comparison byte-ordered over
 * the folded text, which is the only collation guaranteed to exist everywhere
 * and the only way the ordering is identical in PGlite and on Neon rather than
 * depending on each database's `datcollate`.
 *
 * Measured against `localeCompare(…, { sensitivity: 'base' })` over accented,
 * mixed-case, punctuated and empty titles: identical ordering. It is not a
 * general collator — it does not know that `ä` sorts as `ae` in German phone
 * books — and the residual difference is punctuation weighting, which
 * `Intl.Collator` treats as variable.
 */
const TITLE_SORT = sql.raw(
  `lower(regexp_replace(normalize(COALESCE(NULLIF(p.title, ''), 'Untitled'), NFKD), ` +
    `'[\\u0300-\\u036f]', '', 'g')) COLLATE "C"`,
);

/** `rank()` from `src/data/posts.ts:493`. */
const STATUS_RANK = sql.raw(
  `CASE p.status WHEN 'draft' THEN 0 WHEN 'published' THEN 1 ELSE 2 END`,
);

const epoch = (value: unknown): CursorValue => toEpochMsOrNull(value);

const SORTS: Record<SortKey, SortPart[]> = {
  updated: [{ expr: sql.raw('p.updated_at'), direction: 'desc', read: epoch }],
  published: [
    { expr: sql.raw('p.published_at'), direction: 'desc', nullable: true, read: epoch },
  ],
  oldest: [{ expr: sql.raw('p.created_at'), direction: 'asc', read: epoch }],
  alphabetical: [{ expr: TITLE_SORT, direction: 'asc', read: (v) => String(v) }],
  'drafts-first': [
    { expr: STATUS_RANK, direction: 'asc', read: (v) => Number(v) },
    { expr: sql.raw('p.updated_at'), direction: 'desc', read: epoch },
  ],
};

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

  // `if (q.category && …)` in the client: an empty string is "no filter", not
  // "posts with no category".
  if (q.category) where.push(sql`p.category = ${q.category}`);
  // `@>` rather than `= ANY`, so the GIN index on `tags` can serve it.
  if (q.tag) where.push(sql`p.tags @> ${sql.param([q.tag])}::text[]`);

  const needle = (q.search ?? '').trim();
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
    const cursor = requireCursor(q.cursor);
    /*
     * A cursor minted under one sort key cannot be spent under another: the
     * components would be compared against the wrong columns, which does not
     * fail, it just returns a wrong page. Width is the cheapest check that
     * catches it, and it catches the case that matters — a one-component
     * cursor from `updated` handed to `drafts-first`.
     */
    if (cursor.sortValues.length !== parts.length) throw new BadRequestError('cursor');
    where.push(keysetPredicate(parts, cursor.sortValues, cursor.id));
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
            parts.map((part, i) => part.read(last[`k${i}`])),
            String(last.id),
          )
        : null,
  };
}
