import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { toEpochMs } from '../db/client';
import { LIST_POST_COLUMNS, POST_COLUMNS, postColumns } from './mapping';
import {
  SORTS,
  coerce,
  keysetPredicate,
  orderBy,
  readKey,
  type SortPart,
} from './query';
import { encodeCursor, pageLimit, rejectNul, requireCursor } from './cursor';
import { BadRequestError } from './errors';
import { rowToPublicPost, rowToPublicPostDetail } from './public-projection';
import type { PublicPost, PublicPostDetail } from '../../shared/types';

/**
 * The public read surface, in SQL (plan Part 1).
 *
 * ONE PREDICATE, ONE PLACE, NEVER CLIENT-SUPPLIED (plan D2, threat T1). Every
 * query in this file is bound by `PUBLIC_POST_PREDICATE` — the list, the
 * by-slug read, the feed, the sitemap, and BOTH taxonomy queries. The taxonomies
 * are named explicitly because leaving them outside the predicate is what failed
 * v1 of the plan: the natural `DISTINCT` publishes the category and tag
 * vocabulary of drafts and trashed posts, with counts, which is a
 * pre-announcement signal and exactly what this surface exists to withhold.
 *
 * `listPosts` IS NOT REUSED. Its signature takes a `StatusFilter` and would
 * happily accept `'trash'`; a public wrapper passing `status:'published'` is
 * correct today and one careless refactor from not being. The public list is its
 * own filter builder over its own predicate, sharing only the cursor and
 * ordering helpers, which carry no notion of visibility.
 */

/**
 * The four conjuncts, named — so a mutation test can drop exactly one and prove
 * a specific row leaks without it.
 *
 * Kept as a record rather than as one opaque string for that reason alone. If a
 * conjunct is deleted here, `public.test.ts` fails twice over: once because the
 * name it expects is gone, and once because the row that conjunct excludes
 * starts appearing in the real results.
 */
export const PUBLIC_POST_CONJUNCTS = {
  /** Drafts and archived posts are not published. */
  status: sql`p.status = 'published'`,
  /**
   * Trash is a VIEW, not a status: `deleted_at` is independent of `status`, so a
   * trashed post keeps whatever status it had. A published post that was then
   * trashed still reads `status = 'published'`.
   */
  deleted_at: sql`p.deleted_at IS NULL`,
  /**
   * A published post with no slug has no URL. It could be listed and never
   * opened, so the list and the detail route would disagree about what exists.
   */
  slug: sql`p.slug IS NOT NULL`,
  /**
   * `status = 'published'` DOES NOT IMPLY THIS. `createPost` binds
   * `publishedAt ?? null` independently of `status ?? 'draft'`, and
   * `POST /api/import` forwards both from the bundle, so an imported row sits in
   * the published set with a null date — which `PublicPost.publishedAt: number`
   * would then lie about, and which would reach an RSS `pubDate` and a sitemap
   * `lastmod` as `null`.
   */
  published_at: sql`p.published_at IS NOT NULL`,
} as const;

export type PublicConjunct = keyof typeof PUBLIC_POST_CONJUNCTS;

/** The order the conjuncts are AND-ed in, and the order the index declares them. */
export const PUBLIC_CONJUNCT_ORDER: readonly PublicConjunct[] = [
  'status',
  'deleted_at',
  'slug',
  'published_at',
];

function conjoin(names: readonly PublicConjunct[]): SQL {
  if (names.length === 0) return sql`true`;
  return sql.join(
    names.map((name) => PUBLIC_POST_CONJUNCTS[name]),
    sql` AND `,
  );
}

/**
 * The single fragment. `migration 0005_public_reading.sql` declares a partial
 * index over the SAME four conjuncts in the same order — if they drift, the
 * index silently stops serving the list and every request sorts the whole
 * published set, which is a performance cliff with no error to notice.
 */
export const PUBLIC_POST_PREDICATE: SQL = conjoin(PUBLIC_CONJUNCT_ORDER);

/**
 * Only for the mutation tests: the predicate with one conjunct removed.
 *
 * Exported deliberately and used by nothing in production. A test that
 * transcribed a weakened predicate instead would be asserting against its own
 * copy of the SQL; deriving it from the same record means the corpus is proven
 * to exercise the conjunct that is under test.
 */
export function predicateWithout(omit: PublicConjunct): SQL {
  return conjoin(PUBLIC_CONJUNCT_ORDER.filter((name) => name !== omit));
}

// ---------------------------------------------------------------------- list

/**
 * `updated` and `drafts-first` are NOT offered: the first exposes editing
 * activity on published posts, and the second is meaningless when every row is
 * published.
 */
export type PublicSortKey = 'published' | 'oldest' | 'alphabetical';

const PUBLIC_SORTS: readonly PublicSortKey[] = ['published', 'oldest', 'alphabetical'];

/**
 * THE PUBLIC ORDERINGS, AND `oldest` IS NOT `SORTS.oldest` (plan D3/T2).
 *
 * The shared `SORTS.oldest` is `created_at ASC`, and `FIELD_DISPOSITION` marks
 * `createdAt: 'private'`. The projection therefore never emits it — but the
 * keyset cursor is minted FROM the sort key, sits outside the projection, and is
 * base64url of plain JSON: `?sort=oldest&limit=1` handed back a `nextCursor`
 * decoding to `["oldest",[1786519567813],"p_pub"]`, i.e. the last row's
 * `created_at`. Published rows only, so nothing unpublished leaks — but the
 * compile-time control said one thing and the pagination token said another, and
 * "private by default and provably so" cannot survive that.
 *
 * `published_at ASC` instead: already `'public'`, already emitted on every item,
 * guaranteed NON-NULL by `PUBLIC_POST_PREDICATE` (which is why no `nullable`
 * flag is set here and why the DESC twin needs one), and for a public reader
 * "oldest" means oldest PUBLISHED rather than oldest typed-into.
 *
 * DEFINED HERE AND NOT IN `query.ts`: the authenticated list keeps `created_at`,
 * where a writer legitimately sorts by when a draft was started.
 */
export const PUBLIC_SORTS_PARTS: Record<PublicSortKey, SortPart[]> = {
  published: SORTS.published,
  oldest: [{ expr: sql.raw('p.published_at'), direction: 'asc', type: 'number' }],
  alphabetical: SORTS.alphabetical,
};

/**
 * THERE IS NO `status` FIELD, AND THAT IS THE POINT (threat T1).
 *
 * A public caller cannot name one because the type has nowhere to put it, so
 * the visibility of a row is decided in exactly one place — the predicate above
 * — rather than by anything that arrived over the wire.
 */
export interface PublicListQuery {
  category?: string;
  tag?: string;
  search?: string;
  cursor?: string;
  limit?: number;
  sort?: PublicSortKey;
}

/** The public list's OWN filter builder — never `query.ts`'s `filters()`. */
function publicFilters(q: PublicListQuery): SQL[] {
  const where: SQL[] = [PUBLIC_POST_PREDICATE];

  // All three text filters are checked for U+0000 before they are bound: they
  // arrive from a query string, `.trim()` does not strip a NUL, and one reaches
  // the driver as SQLSTATE 22021 — a 500 for input that can never be accepted.
  if (q.category) where.push(sql`p.category = ${rejectNul(q.category, 'category')}`);
  // `@>` rather than `= ANY`, so the GIN index on `tags` can serve it.
  if (q.tag) where.push(sql`p.tags @> ${sql.param([rejectNul(q.tag, 'tag')])}::text[]`);

  const needle = rejectNul((q.search ?? '').trim(), 'search');
  // `websearch_to_tsquery`, never `to_tsquery`: the latter is a parser and a
  // bare `&` behind a public search box would be a 500 on ordinary typing.
  if (needle) where.push(sql`p.search @@ websearch_to_tsquery('english', ${needle})`);

  return where;
}

function publicSortParts(sort: PublicSortKey): SortPart[] {
  if (!PUBLIC_SORTS.includes(sort)) throw new BadRequestError('sort');
  return PUBLIC_SORTS_PARTS[sort];
}

export async function listPublicPosts(
  db: Db,
  q: PublicListQuery = {},
): Promise<{ items: PublicPost[]; nextCursor: string | null }> {
  const size = pageLimit(q.limit);
  const sort = q.sort ?? 'published';
  const parts = publicSortParts(sort);

  const where = publicFilters(q);
  if (q.cursor !== undefined) {
    // A cursor minted under one sort key cannot be spent under another — the
    // components would be compared against different columns, which is either a
    // 22P02 (a 500 the client retries five times) or a page with rows silently
    // missing from it.
    const cursor = requireCursor(q.cursor, sort);
    if (cursor.sortValues.length !== parts.length) throw new BadRequestError('cursor');
    const values = parts.map((part, i) => coerce(part, cursor.sortValues[i]));
    where.push(keysetPredicate(parts, values, cursor.id));
  }

  // The sort keys are SELECTed rather than recomputed in JS: `alphabetical`
  // orders on a folded, collated expression, and a second implementation of that
  // fold shows up as a page boundary that skips rows rather than as an error.
  const keys = parts.map((part, i) => sql`${part.expr} AS ${sql.raw(`k${i}`)}`);

  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p', LIST_POST_COLUMNS))},
           u.display_name AS author_name,
           ${sql.join(keys, sql`, `)}
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY ${orderBy(parts)}
     LIMIT ${size + 1}`);

  const rows = res.rows.slice(0, size);
  const items = rows.map((row) => rowToPublicPost(row, String(row.author_name)));
  const last = rows[rows.length - 1];
  const more = res.rows.length > size;

  return {
    items,
    nextCursor:
      more && last
        ? encodeCursor(
            sort,
            parts.map((part, i) => readKey(part, last[`k${i}`])),
            String(last.id),
          )
        : null,
  };
}

// -------------------------------------------------------------------- detail

/**
 * `null` for absent AND for unpublished, from the same code path — so the two
 * are the same 404 upstream and unpublished slugs cannot be enumerated (T7).
 */
export async function getPublicPostBySlug(
  db: Db,
  slug: string,
): Promise<PublicPostDetail | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p', POST_COLUMNS))}, u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE ${PUBLIC_POST_PREDICATE}
       AND p.slug = ${rejectNul(slug, 'slug')}
     LIMIT 1`);
  const row = res.rows[0];
  return row ? rowToPublicPostDetail(row, String(row.author_name)) : null;
}

// ------------------------------------------------------------------ taxonomy

export interface PublicTerm {
  value: string;
  count: number;
}

/**
 * Categories OF PUBLISHED POSTS, with counts.
 *
 * The emphasis is the whole point: an unbound `DISTINCT p.category` publishes
 * the working vocabulary of every draft in the system.
 *
 * `''` is excluded because it means "uncategorised", not a category named the
 * empty string.
 */
export async function publicCategories(db: Db): Promise<PublicTerm[]> {
  const res = await db.execute(sql`
    SELECT p.category AS value, count(*)::int AS count
      FROM posts p
     WHERE ${PUBLIC_POST_PREDICATE}
       AND p.category <> ''
     GROUP BY p.category
     ORDER BY count DESC, p.category ASC`);
  return res.rows.map((row) => ({ value: String(row.value), count: Number(row.count) }));
}

/** Tags of published posts, with counts. Same predicate, same reasoning. */
export async function publicTags(db: Db): Promise<PublicTerm[]> {
  const res = await db.execute(sql`
    SELECT t AS value, count(*)::int AS count
      FROM posts p
      CROSS JOIN LATERAL unnest(p.tags) AS t
     WHERE ${PUBLIC_POST_PREDICATE}
       AND t <> ''
     GROUP BY t
     ORDER BY count DESC, t ASC`);
  return res.rows.map((row) => ({ value: String(row.value), count: Number(row.count) }));
}

// ------------------------------------------------------------ feed & sitemap

/** RSS 2.0 carries the newest N. The protocol has no opinion; 20 is the route's. */
export const DEFAULT_FEED_LIMIT = 20;

/**
 * The sitemap protocol's own ceiling. Beyond it a sitemap index is required, so
 * the route says so rather than silently truncating — which is why this is a
 * bound to validate against and not a clamp.
 */
export const MAX_SITEMAP_URLS = 50_000;

function boundedLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new BadRequestError('limit');
  }
  return limit;
}

/**
 * Newest published first — the same ordering the partial index declares, so
 * this is an index scan rather than a sort of the whole published set.
 */
export async function publicFeedPosts(
  db: Db,
  limit: number = DEFAULT_FEED_LIMIT,
): Promise<PublicPost[]> {
  const size = boundedLimit(limit, MAX_SITEMAP_URLS);
  const res = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p', LIST_POST_COLUMNS))}, u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     WHERE ${PUBLIC_POST_PREDICATE}
     ORDER BY p.published_at DESC NULLS LAST, p.id ASC
     LIMIT ${size}`);
  return res.rows.map((row) => rowToPublicPost(row, String(row.author_name)));
}

export interface PublicSitemapEntry {
  slug: string;
  /** `<lastmod>`. */
  updatedAt: number;
  publishedAt: number;
}

/**
 * NO JOIN TO `users`, because a sitemap has no byline — and the narrowest query
 * that answers the question is the one that cannot leak the answer to another.
 */
export async function publicSitemapEntries(
  db: Db,
  limit: number = MAX_SITEMAP_URLS,
): Promise<PublicSitemapEntry[]> {
  const size = boundedLimit(limit, MAX_SITEMAP_URLS);
  const res = await db.execute(sql`
    SELECT p.slug, p.updated_at, p.published_at
      FROM posts p
     WHERE ${PUBLIC_POST_PREDICATE}
     ORDER BY p.published_at DESC NULLS LAST, p.id ASC
     LIMIT ${size}`);
  return res.rows.map((row) => ({
    slug: String(row.slug),
    updatedAt: toEpochMs(row.updated_at),
    publishedAt: toEpochMs(row.published_at),
  }));
}
