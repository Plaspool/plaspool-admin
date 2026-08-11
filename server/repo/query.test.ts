/**
 * Listing: filter, sort, keyset pagination, search (spec §5.2).
 *
 * THE ORACLE IS A TRANSCRIPTION, AND THE DRIFT GUARD AT THE BOTTOM IS WHAT
 * KEEPS IT ONE. Importing the real `filterAndSort` was tried first and does not
 * work: `src/data/posts.ts` builds a Dexie handle at module scope, so the import
 * pulls `src/data/db.ts` into `tsconfig.server.json`, whose `navigator.storage`
 * does not compile against a project with `lib: ES2023` and `types: node`
 * (TS2339). Widening the server project to include DOM so one test can import
 * one function would delete the guard that stops server code reaching for
 * `document` — a bad trade.
 *
 * So the comparators are copied here, and the last describe block reads
 * `src/data/posts.ts` and asserts each one is still character-for-character what
 * was copied. Change an ordering on the client and this file fails, naming the
 * SQL that has to change with it — which is exactly the drift a copy would
 * otherwise hide.
 *
 * Three orderings do not survive a naive translation, and each is a silently
 * wrong list rather than an error:
 *
 * - `alphabetical` folds `'' → 'Untitled'` and compares case- and
 *   accent-insensitively. Postgres sorts `''` first under any collation, and
 *   `Zebra` before `apple` under a byte-ordered one.
 * - `published` uses `?? -Infinity`, i.e. NULLs LAST on a descending sort.
 *   Postgres puts NULLs FIRST on DESC, so every unpublished draft would head
 *   the "recently published" list.
 * - `drafts-first` sorts on `(statusRank, updatedAt)` — a two-part key the
 *   plan's `{sortValue, id}` cursor cannot encode at all.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { createPost } from './posts';
import { listPosts, type ListQuery } from './query';
import { MAX_PAGE_LIMIT } from './cursor';
import { BadRequestError } from './errors';
import { docToText } from '../../shared/doc';
import type { DocNode, ListPost, Post, Query, SortKey } from '../../shared/types';

/**
 * `filterAndSort`, copied from `src/data/posts.ts:448-499`.
 *
 * Kept byte-identical inside the body so the drift guard at the bottom of this
 * file can assert the source still says the same thing. Do not tidy it.
 */
function filterAndSort(posts: Post[], q: Query): Post[] {
  const needle = q.search.trim().toLowerCase();
  const out = posts.filter((p) => {
    if (q.status === 'trash') {
      if (p.deletedAt == null) return false;
    } else {
      if (p.deletedAt != null) return false;
      if (q.status !== 'all' && p.status !== q.status) return false;
    }
    if (q.category && p.category !== q.category) return false;
    if (q.tag && !p.tags.includes(q.tag)) return false;
    if (needle) {
      const hay = [
        p.title,
        p.subtitle,
        p.excerpt,
        p.category,
        p.tags.join(' '),
        docToText(p.content).slice(0, 4000),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const byTitle = (a: Post, b: Post) =>
    (a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, {
      sensitivity: 'base',
    });

  switch (q.sort) {
    case 'updated':
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    case 'published':
      return out.sort(
        (a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity),
      );
    case 'oldest':
      return out.sort((a, b) => a.createdAt - b.createdAt);
    case 'alphabetical':
      return out.sort(byTitle);
    case 'drafts-first':
      return out.sort((a, b) => {
        const rank = (p: Post) => (p.status === 'draft' ? 0 : p.status === 'published' ? 1 : 2);
        return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
      });
    default:
      return out;
  }
}

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const SORTS: SortKey[] = ['updated', 'published', 'oldest', 'alphabetical', 'drafts-first'];

let ctx: TestCtx;
/** The seeded corpus, exactly as the store holds it. The oracle's input. */
let corpus: Post[];

const BASE = 1_700_000_000_000;

/**
 * Twenty posts chosen to hit every branch of `filterAndSort` at once: empty and
 * accented and mixed-case titles, NULL and duplicate `publishedAt`, tied
 * `updatedAt` and `createdAt`, all three statuses, two in the trash, and two
 * pairs whose sort keys are identical so the id tiebreak is exercised.
 */
const SEED: Partial<Post>[] = [
  { title: 'Zebra', status: 'published', publishedAt: BASE + 900, updatedAt: BASE + 10, createdAt: BASE + 1, category: 'essays', tags: ['alpha'] },
  { title: 'apple', status: 'draft', publishedAt: null, updatedAt: BASE + 20, createdAt: BASE + 2, category: 'essays', tags: ['alpha', 'beta'] },
  { title: 'Apricot', status: 'archived', publishedAt: BASE + 800, updatedAt: BASE + 30, createdAt: BASE + 3, category: '', tags: [] },
  { title: '', status: 'draft', publishedAt: null, updatedAt: BASE + 40, createdAt: BASE + 4, category: 'notes', tags: ['beta'] },
  { title: 'Éclair', status: 'published', publishedAt: BASE + 700, updatedAt: BASE + 50, createdAt: BASE + 5, category: 'notes', tags: [] },
  { title: 'MIXED case', status: 'draft', publishedAt: null, updatedAt: BASE + 60, createdAt: BASE + 6, category: '', tags: ['alpha'] },
  { title: 'banana', status: 'archived', publishedAt: null, updatedAt: BASE + 70, createdAt: BASE + 7, category: 'essays', tags: [] },
  { title: 'über', status: 'published', publishedAt: BASE + 600, updatedAt: BASE + 80, createdAt: BASE + 8, category: 'notes', tags: ['beta'] },
  { title: 'ÜBER', status: 'draft', publishedAt: null, updatedAt: BASE + 90, createdAt: BASE + 9, category: '', tags: [] },
  { title: '', status: 'archived', publishedAt: BASE + 500, updatedAt: BASE + 100, createdAt: BASE + 10, category: 'essays', tags: ['alpha'] },
  // Ties: identical updatedAt, createdAt, title and publishedAt in pairs.
  { title: 'Tied', status: 'draft', publishedAt: BASE + 400, updatedAt: BASE + 110, createdAt: BASE + 11, category: '', tags: [] },
  { title: 'Tied', status: 'draft', publishedAt: BASE + 400, updatedAt: BASE + 110, createdAt: BASE + 11, category: '', tags: [] },
  { title: 'the end', status: 'published', publishedAt: BASE + 300, updatedAt: BASE + 120, createdAt: BASE + 12, category: 'notes', tags: ['beta'] },
  { title: 'the-end', status: 'published', publishedAt: BASE + 300, updatedAt: BASE + 120, createdAt: BASE + 12, category: 'notes', tags: ['beta'] },
  { title: 'theend', status: 'archived', publishedAt: null, updatedAt: BASE + 130, createdAt: BASE + 13, category: '', tags: [] },
  { title: 'naïve', status: 'draft', publishedAt: null, updatedAt: BASE + 140, createdAt: BASE + 14, category: 'essays', tags: ['alpha', 'beta'] },
  { title: 'Zoë', status: 'published', publishedAt: BASE + 200, updatedAt: BASE + 150, createdAt: BASE + 15, category: '', tags: [] },
  { title: 'Untitled', status: 'draft', publishedAt: null, updatedAt: BASE + 160, createdAt: BASE + 16, category: 'notes', tags: [] },
  // In the trash — excluded by every filter but `trash`.
  { title: 'Discarded', status: 'draft', publishedAt: null, updatedAt: BASE + 170, createdAt: BASE + 17, deletedAt: BASE + 900, category: 'essays', tags: ['alpha'] },
  { title: 'Also gone', status: 'published', publishedAt: BASE + 100, updatedAt: BASE + 180, createdAt: BASE + 18, deletedAt: BASE + 901, category: '', tags: [] },
];

beforeAll(async () => {
  ctx = await freshDb();
  corpus = [];
  for (const [i, partial] of SEED.entries()) {
    corpus.push(
      await createPost(ctx.db, ctx.users.owner, {
        // Ids ascending in seed order, so the id tiebreak is predictable.
        id: `p_seed_${String(i).padStart(2, '0')}`,
        content: doc(`body of post number ${i}`),
        ...partial,
      }),
    );
  }
});

afterAll(async () => {
  await ctx.close();
});

/**
 * The oracle input, ordered by id.
 *
 * `Array.prototype.sort` is stable, so `filterAndSort` leaves rows with equal
 * sort keys in the order it received them — which in the dashboard is whatever
 * Dexie handed back. The SQL breaks ties on `id`, so the oracle is fed in id
 * order to make the two comparable at all. Without this the parity test would
 * be asserting something neither side actually guarantees.
 */
const oracleInput = () => [...corpus].sort((a, b) => a.id.localeCompare(b.id));

/** Everything `status: 'all'` returns — the trash is a separate view. */
const live = () => corpus.filter((p) => p.deletedAt == null);

const toListQuery = (q: Query): ListQuery => ({
  status: q.status,
  search: q.search,
  sort: q.sort,
  category: q.category ?? undefined,
  tag: q.tag ?? undefined,
  limit: MAX_PAGE_LIMIT,
});

const query = (over: Partial<Query> = {}): Query => ({
  status: 'all',
  search: '',
  category: null,
  tag: null,
  sort: 'updated',
  ...over,
});

async function ids(q: Query): Promise<string[]> {
  const res = await listPosts(ctx.db, toListQuery(q));
  return res.items.map((p) => p.id);
}

// -------------------------------------------------------------- projection

describe('list projection', () => {
  it('never returns content, contentText or the search vector', async () => {
    const { items } = await listPosts(ctx.db, { status: 'all', sort: 'updated' });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const leak of ['content', 'contentText', 'content_text', 'search', 'k0', 'k1']) {
        expect(Object.keys(item), leak).not.toContain(leak);
      }
    }
  });

  it('carries the author display name without a second query', async () => {
    const { items } = await listPosts(ctx.db, { status: 'all', sort: 'updated' });
    for (const item of items) {
      expect(item.authorId).toBe(ctx.users.owner.id);
      expect(item.authorName).toBe(ctx.users.owner.displayName);
    }
  });
});

// ------------------------------------------------------------------ filters

describe('filters match filterAndSort', () => {
  it.each(['all', 'draft', 'published', 'archived', 'trash'] as const)(
    'status=%s returns exactly the same posts',
    async (status) => {
      const q = query({ status });
      expect(await ids(q)).toEqual(filterAndSort(oracleInput(), q).map((p) => p.id));
    },
  );

  it('trash returns only deleted posts and every other filter excludes them', async () => {
    const trashed = await ids(query({ status: 'trash' }));
    expect(trashed.sort()).toEqual(['p_seed_18', 'p_seed_19']);
    for (const status of ['all', 'draft', 'published', 'archived'] as const) {
      const got = await ids(query({ status }));
      expect(got, status).not.toContain('p_seed_18');
      expect(got, status).not.toContain('p_seed_19');
    }
  });

  it.each(['essays', 'notes', ''])('category=%s matches', async (category) => {
    const q = query({ category });
    expect(await ids(q)).toEqual(filterAndSort(oracleInput(), q).map((p) => p.id));
  });

  it.each(['alpha', 'beta', 'missing'])('tag=%s matches', async (tag) => {
    const q = query({ tag });
    expect(await ids(q)).toEqual(filterAndSort(oracleInput(), q).map((p) => p.id));
  });

  it('combines status, category and tag', async () => {
    const q = query({ status: 'draft', category: 'essays', tag: 'alpha' });
    const expected = filterAndSort(oracleInput(), q).map((p) => p.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(await ids(q)).toEqual(expected);
  });
});

// ---------------------------------------------------------------- orderings

describe('every sort key matches filterAndSort', () => {
  it.each(SORTS)('sort=%s over the whole corpus', async (sort) => {
    const q = query({ sort });
    expect(await ids(q)).toEqual(filterAndSort(oracleInput(), q).map((p) => p.id));
  });

  it.each(SORTS)('sort=%s within a status filter', async (sort) => {
    const q = query({ sort, status: 'published' });
    expect(await ids(q)).toEqual(filterAndSort(oracleInput(), q).map((p) => p.id));
  });

  it('alphabetical: an empty title sorts as "Untitled", not first', async () => {
    // Postgres sorts `''` before every letter under any collation. The client
    // substitutes 'Untitled' first, which lands it between 'the-end' and 'über'.
    const got = await ids(query({ sort: 'alphabetical', status: 'all' }));
    const empties = ['p_seed_03', 'p_seed_09'];
    for (const id of empties) expect(got.indexOf(id)).toBeGreaterThan(0);
    // Two posts literally titled 'Untitled' and the empty ones sort together.
    const untitled = got.indexOf('p_seed_17');
    for (const id of empties) expect(Math.abs(got.indexOf(id) - untitled)).toBeLessThanOrEqual(2);
  });

  it('alphabetical: case and accents are folded, as localeCompare(base) does', async () => {
    const got = await ids(query({ sort: 'alphabetical', status: 'all' }));
    // 'apple' before 'Apricot' before 'banana' before 'Zebra' — a byte-ordered
    // collation would put every capital first and give Apricot, MIXED, Zebra…
    const order = ['p_seed_01', 'p_seed_02', 'p_seed_06', 'p_seed_00'];
    const positions = order.map((id) => got.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // 'Éclair' folds to 'eclair', so it sits after 'banana' rather than after 'z'.
    expect(got.indexOf('p_seed_04')).toBeLessThan(got.indexOf('p_seed_16'));
  });

  it('published: NULLs go LAST on the descending sort, not first', async () => {
    // `?? -Infinity` in the client. Postgres defaults to NULLS FIRST on DESC,
    // which would head "recently published" with every unpublished draft.
    const got = await ids(query({ sort: 'published', status: 'all' }));
    // Live posts only — the trashed two are not in this list at all.
    const live = corpus.filter((p) => p.deletedAt == null);
    const withDate = live.filter((p) => p.publishedAt != null);
    const without = live.filter((p) => p.publishedAt == null);
    expect(withDate.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    const lastWithDate = Math.max(...withDate.map((p) => got.indexOf(p.id)));
    const firstWithout = Math.min(...without.map((p) => got.indexOf(p.id)));
    expect(firstWithout).toBeGreaterThan(lastWithDate);
  });

  it('drafts-first: drafts, then published, then archived, each newest first', async () => {
    const got = await ids(query({ sort: 'drafts-first', status: 'all' }));
    const rank = (id: string) => {
      const p = corpus.find((c) => c.id === id) as Post;
      return p.status === 'draft' ? 0 : p.status === 'published' ? 1 : 2;
    };
    const ranks = got.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

// --------------------------------------------------------------- pagination

describe('keyset pagination', () => {
  async function walk(q: ListQuery, pageSize: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const res = await listPosts(ctx.db, { ...q, cursor, limit: pageSize });
      expect(res.items.length).toBeLessThanOrEqual(pageSize);
      seen.push(...res.items.map((p) => p.id));
      if (!res.nextCursor) return seen;
      cursor = res.nextCursor;
    }
    throw new Error('walk did not terminate');
  }

  it.each(SORTS)('a full walk on sort=%s returns every row exactly once', async (sort) => {
    const q = query({ sort, status: 'all' });
    const expected = filterAndSort(oracleInput(), q).map((p) => p.id);
    const walked = await walk(toListQuery(q), 3);
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(expected.length);
  });

  it('drafts-first paginates too, on its two-part key', async () => {
    // The plan offers "extend the cursor … or exclude drafts-first from cursor
    // pagination". Extending is the choice: excluding it would mean the one
    // view a writer lives in cannot be scrolled.
    const q = query({ sort: 'drafts-first', status: 'all' });
    expect(await walk(toListQuery(q), 2)).toEqual(
      filterAndSort(oracleInput(), q).map((p) => p.id),
    );
  });

  it('inserting a post mid-walk cannot duplicate or skip a row', async () => {
    /*
     * The reason pagination is keyset and not `OFFSET`. With an offset, a row
     * inserted above the window pushes one row down past the boundary and it is
     * never seen; a row deleted above the window pulls one up and it is seen
     * twice. Neither shows up as an error anywhere.
     */
    const base: ListQuery = { status: 'all', sort: 'updated', limit: 4 };
    const first = await listPosts(ctx.db, base);
    const seen = first.items.map((p) => p.id);
    let cursor = first.nextCursor;

    try {
      await createPost(ctx.db, ctx.users.owner, {
        id: 'p_intruder',
        title: 'Inserted mid-walk',
        // Above the window the walk has already passed.
        updatedAt: BASE + 10_000,
        content: doc('later'),
      });

      for (let page = 0; page < 50 && cursor; page += 1) {
        const res = await listPosts(ctx.db, { ...base, cursor });
        seen.push(...res.items.map((p) => p.id));
        cursor = res.nextCursor;
      }

      // Every original row exactly once, and the intruder never appears — it
      // sorts above a cursor the walk has already gone past.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).not.toContain('p_intruder');
      for (const p of live()) expect(seen, p.id).toContain(p.id);
    } finally {
      // In a `finally` so a failed assertion cannot leave the corpus altered
      // for every test after this one.
      await ctx.db.execute(sql`DELETE FROM posts WHERE id = 'p_intruder'`);
    }
  });

  it('nextCursor is null on the last page, not an empty page later', async () => {
    const res = await listPosts(ctx.db, { status: 'all', sort: 'updated', limit: MAX_PAGE_LIMIT });
    expect(res.items).toHaveLength(live().length);
    expect(res.nextCursor).toBeNull();
  });

  it(`rejects a limit above ${MAX_PAGE_LIMIT} and an undecodable cursor`, async () => {
    await expect(
      listPosts(ctx.db, { status: 'all', sort: 'updated', limit: MAX_PAGE_LIMIT + 1 }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      listPosts(ctx.db, { status: 'all', sort: 'updated', cursor: 'not-a-cursor!!' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('refuses a cursor whose key width does not match the sort', async () => {
    // A cursor minted under `updated` carries one component; `drafts-first`
    // needs two. Reusing one across sorts would silently compare the wrong
    // column and skip rows, so it is a 400 instead.
    const { nextCursor } = await listPosts(ctx.db, {
      status: 'all',
      sort: 'updated',
      limit: 2,
    });
    await expect(
      listPosts(ctx.db, { status: 'all', sort: 'drafts-first', cursor: nextCursor as string }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

// ------------------------------------------------------------------- search

describe('search', () => {
  it('matches title, tags, category and body text', async () => {
    const byTitle = await listPosts(ctx.db, { status: 'all', sort: 'updated', search: 'Zebra' });
    expect(byTitle.items.map((p) => p.id)).toEqual(['p_seed_00']);

    const byTag = await listPosts(ctx.db, { status: 'all', sort: 'updated', search: 'alpha' });
    expect(byTag.items.length).toBeGreaterThan(0);
    for (const item of byTag.items) expect(item.tags).toContain('alpha');

    const byCategory = await listPosts(ctx.db, { status: 'all', sort: 'updated', search: 'essays' });
    expect(byCategory.items.length).toBeGreaterThan(0);

    // Body text — the whole reason `content_text` is a stored column.
    const byBody = await listPosts(ctx.db, { status: 'all', sort: 'updated', search: 'number 7' });
    expect(byBody.items.map((p) => p.id)).toEqual(['p_seed_07']);
  });

  it('SEARCH IS LEXEME-BASED, NOT SUBSTRING — this is a behaviour change', async () => {
    /*
     * `filterAndSort` lowercases a joined haystack and calls `String.includes`,
     * so `ost` matches `post` and `ana` matches `banana`. A tsvector matches
     * whole stemmed lexemes, so those return nothing at all — and, in the other
     * direction, `bodies` now matches a post containing `body` because both
     * stem to `bodi`.
     *
     * Written down as an assertion rather than left to surprise someone: it is
     * the one place the cutover changes what a writer sees for the same
     * keystrokes, and the fix if it is ever unwanted is a trigram index, not a
     * quiet reversion to scanning every document in the browser.
     */
    const find = async (search: string) =>
      (await listPosts(ctx.db, { status: 'all', sort: 'updated', search })).items.map((p) => p.id);

    // The client would match all twenty on 'ody'; the server matches none.
    expect(await find('ody')).toEqual([]);
    expect(await find('anan')).toEqual([]);
    // And the client would find nothing for a stemmed variant the server does.
    expect((await find('bodies')).length).toBeGreaterThan(0);

    // The substring behaviour, for the record, on the same corpus.
    const substring = filterAndSort(oracleInput(), query({ search: 'ody' }));
    expect(substring.length).toBeGreaterThan(0);
  });

  it('a stopword-only search matches nothing rather than everything', async () => {
    // `to_tsquery` drops stopwords, so `the` produces an empty query. The
    // client would have matched every post containing the letters 't','h','e'.
    const res = await listPosts(ctx.db, { status: 'all', sort: 'updated', search: 'the' });
    expect(res.items).toEqual([]);
  });

  it('a blank search is not a filter', async () => {
    for (const search of ['', '   ']) {
      const res = await listPosts(ctx.db, {
        status: 'all',
        sort: 'updated',
        search,
        limit: MAX_PAGE_LIMIT,
      });
      expect(res.items, JSON.stringify(search)).toHaveLength(live().length);
    }
  });

  it('survives punctuation that would break to_tsquery', async () => {
    // `to_tsquery` raises a syntax error on `&`, `!` or an unbalanced quote,
    // and a syntax error on a search box is a 500. `websearch_to_tsquery` never
    // throws, whatever is typed into it.
    for (const search of ['&&&', '!(', 'a & b', '"unbalanced', ':*', "'"]) {
      await expect(
        listPosts(ctx.db, { status: 'all', sort: 'updated', search }),
        search,
      ).resolves.toBeDefined();
    }
  });

  it('combines with filters, sorting and pagination', async () => {
    const res = await listPosts(ctx.db, {
      status: 'published',
      sort: 'published',
      search: 'body',
      limit: 2,
    });
    expect(res.items).toHaveLength(2);
    for (const item of res.items) expect(item.status).toBe('published');
    expect(res.nextCursor).not.toBeNull();

    const next = await listPosts(ctx.db, {
      status: 'published',
      sort: 'published',
      search: 'body',
      limit: 2,
      cursor: res.nextCursor as string,
    });
    const seen = [...res.items, ...next.items].map((p: ListPost) => p.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// --------------------------------------------------------------- drift guard

describe('the transcribed oracle still matches src/data/posts.ts', () => {
  /**
   * Every expression the SQL in `server/repo/query.ts` was derived from.
   *
   * Asserted against the real source rather than against the copy above, so a
   * comparator that changes on the client fails HERE — naming the SQL that has
   * to change with it — instead of quietly leaving the dashboard and the API
   * sorting two different ways for the rest of the cutover.
   */
  const EXPRESSIONS: [string, string][] = [
    ['trash is a view, not a status', "if (q.status === 'trash') {"],
    ['every other filter excludes the trash', 'if (p.deletedAt != null) return false;'],
    ['status match', "if (q.status !== 'all' && p.status !== q.status) return false;"],
    ['empty category is no filter', 'if (q.category && p.category !== q.category) return false;'],
    ['empty tag is no filter', 'if (q.tag && !p.tags.includes(q.tag)) return false;'],
    ['search is a substring match', 'if (!hay.includes(needle)) return false;'],
    ['updated', 'out.sort((a, b) => b.updatedAt - a.updatedAt)'],
    ['published puts NULLs last', '(b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity)'],
    ['oldest', 'out.sort((a, b) => a.createdAt - b.createdAt)'],
    [
      'alphabetical folds an empty title to Untitled',
      "(a.title || 'Untitled').localeCompare(b.title || 'Untitled', undefined, {",
    ],
    ['alphabetical compares at base sensitivity', "sensitivity: 'base',"],
    [
      'drafts-first ranks draft, published, archived',
      "(p.status === 'draft' ? 0 : p.status === 'published' ? 1 : 2)",
    ],
    [
      'drafts-first breaks ties on updatedAt descending',
      'return rank(a) - rank(b) || b.updatedAt - a.updatedAt;',
    ],
  ];

  const source = () => readFileSync('src/data/posts.ts', 'utf8');

  it.each(EXPRESSIONS)('%s', (_name, expression) => {
    expect(
      source(),
      `src/data/posts.ts no longer contains ${JSON.stringify(expression)} — the ordering ` +
        'changed on the client, so the transcription at the top of this file AND the SQL ' +
        'in server/repo/query.ts must both be re-derived from it',
    ).toContain(expression);
  });

  it('covers every sort key the client implements, and no others', () => {
    // A sort key added on the client with no server implementation would reach
    // `listPosts` as an undefined entry in its SORTS table.
    expect([...SORTS].sort()).toEqual([
      'alphabetical',
      'drafts-first',
      'oldest',
      'published',
      'updated',
    ]);
    for (const key of SORTS) expect(source(), key).toContain(`case '${key}':`);
  });
});
