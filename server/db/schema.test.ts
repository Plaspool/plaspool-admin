/**
 * Constraint tests. These assert against a real PostgreSQL (PGlite), because
 * `.$type<>()` on a Drizzle column is compile-time only and buys nothing at
 * runtime — a bug anywhere could otherwise persist `role = 'admin'`.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';
import type { Db } from './client';
import {
  MAX_CONTENT_TEXT_BYTES,
  MAX_DOC_BYTES,
  checkDocSize,
} from '../../shared/validate';

let db: Db;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ db, close } = await migratedDb());
});

afterAll(async () => {
  // Tolerant on purpose: if `beforeAll` threw, the setup error is the one
  // worth reading, not a "close is not a function" on top of it.
  await close?.();
});

let seq = 0;
const uid = (prefix: string) => `${prefix}${++seq}_${Date.now().toString(36)}`;

async function mkUser(role = 'owner'): Promise<string> {
  const res = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, role, created_at)
    VALUES (${`${uid('u')}@test.local`}, 'scrypt$dummy', 'Test', ${role}, ${Date.now()})
    RETURNING id`);
  return res.rows[0].id as string;
}

interface PostOverrides {
  id?: string;
  title?: string;
  subtitle?: string;
  excerpt?: string;
  category?: string;
  contentText?: string;
  slug?: string | null;
  tags?: string[];
  status?: string;
  excerptSource?: string;
  revision?: number;
}

async function mkPost(authorId: string, o: PostOverrides = {}): Promise<string> {
  const id = o.id ?? uid('p_');
  const now = Date.now();
  await db.execute(sql`
    INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                       content_text, cover_image, category, tags, status,
                       created_at, updated_at, published_at, deleted_at,
                       word_count, reading_time, author_id, revision)
    VALUES (${id}, ${o.title ?? ''}, ${o.subtitle ?? ''}, ${o.slug ?? null},
            ${o.excerpt ?? ''}, ${o.excerptSource ?? 'derived'},
            ${'{"type":"doc","content":[]}'}::jsonb, ${o.contentText ?? ''}, NULL,
            ${o.category ?? ''},
            ${sql.param(o.tags ?? [])}, ${o.status ?? 'draft'},
            ${now}, ${now}, NULL, NULL, 0, 0, ${authorId}, ${o.revision ?? 1})`);
  return id;
}

async function mkRevision(
  postId: string,
  revision: number,
  authorId: string,
  kind = 'autosave',
): Promise<string> {
  const id = uid('r_');
  await db.execute(sql`
    INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                           title, subtitle, content, word_count, kind, note)
    VALUES (${id}, ${postId}, ${revision}, ${Date.now()}, ${authorId},
            '', '', ${'{"type":"doc","content":[]}'}::jsonb, 0, ${kind}, NULL)`);
  return id;
}

/**
 * Every `Db` in this codebase is wrapped by `guardDb`, which discards the
 * driver error — message, query, params, stack and all — and rethrows a
 * `DbError` carrying only SQLSTATE plus the relation/constraint/column names.
 * That is what these assertions match on. The flattening walk is kept because
 * it also holds for an unguarded handle, where the constraint name is down on
 * `cause` rather than in the message.
 */
function causeChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(' | ');
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return causeChain(err);
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

async function countRevisions(postId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${postId}`,
  );
  return res.rows[0].n as number;
}

describe('posts and revisions integrity', () => {
  it('refuses two different revisions with the same number for one post', async () => {
    const author = await mkUser();
    const post = await mkPost(author);
    await mkRevision(post, 1, author);
    expect(await rejection(mkRevision(post, 1, author))).toMatch(
      /revisions_post_revision_uq/,
    );
    // The first one survived; the rejection did not take it with it.
    expect(await countRevisions(post)).toBe(1);
  });

  it('permits many drafts with a NULL slug', async () => {
    const author = await mkUser();
    await mkPost(author, { slug: null });
    await mkPost(author, { slug: null });
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM posts WHERE slug IS NULL AND author_id = ${author}`);
    expect(res.rows[0].n).toBe(2);
  });

  it('rejects a duplicate non-null slug', async () => {
    const author = await mkUser();
    await mkPost(author, { slug: 'taken-slug' });
    expect(await rejection(mkPost(author, { slug: 'taken-slug' }))).toMatch(
      /posts_slug_unique/,
    );
  });

  it('rejects revision <= 0', async () => {
    const author = await mkUser();
    expect(await rejection(mkPost(author, { revision: 0 }))).toMatch(
      /posts_revision_ck/,
    );
    const post = await mkPost(author);
    expect(await rejection(mkRevision(post, 0, author))).toMatch(
      /revisions_revision_ck/,
    );
    expect(await rejection(mkRevision(post, -3, author))).toMatch(
      /revisions_revision_ck/,
    );
  });

  it('rejects an invalid role, status, excerpt_source or revision kind', async () => {
    expect(await rejection(mkUser('admin'))).toMatch(/users_role_ck/);
    const author = await mkUser('writer');
    expect(await rejection(mkPost(author, { status: 'deleted' }))).toMatch(
      /posts_status_ck/,
    );
    expect(await rejection(mkPost(author, { excerptSource: 'robot' }))).toMatch(
      /posts_excerpt_source_ck/,
    );
    const post = await mkPost(author);
    expect(await rejection(mkRevision(post, 2, author, 'snapshot'))).toMatch(
      /revisions_kind_ck/,
    );
  });

  it('deleting a post cascades to its revisions', async () => {
    const author = await mkUser();
    const post = await mkPost(author);
    await mkRevision(post, 1, author);
    await mkRevision(post, 2, author);
    expect(await countRevisions(post)).toBe(2);
    await db.execute(sql`DELETE FROM posts WHERE id = ${post}`);
    expect(await countRevisions(post)).toBe(0);
  });

  it('the generated search column tokenises title and tags with weights', async () => {
    const author = await mkUser();
    const post = await mkPost(author, { title: 'Hello World', tags: ['beta gamma'] });
    const res = await db.execute(sql`
      SELECT (search @@ to_tsquery('english', 'gamma')) AS hit, search::text AS vec
        FROM posts WHERE id = ${post}`);

    // `array_to_tsvector(tags)` would make 'beta gamma' ONE lexeme, so this
    // misses — which is exactly why the immutable `tags_text` wrapper exists.
    expect(res.rows[0].hit).toBe(true);

    const vec = String(res.rows[0].vec);
    // A-weighted title, C-weighted tags. `array_to_tsvector` emits no
    // positions, which silently makes setweight a no-op.
    expect(vec).toMatch(/'hello':1A/);
    expect(vec).toMatch(/'gamma':\d+C/);
  });

  /**
   * The other four contributions. Only title (A) and tags (C) were covered, so
   * `coalesce(content_text,'')` could be replaced with `''` in the migration
   * and the whole suite stayed green — deleting body-text search, which is the
   * entire justification for storing a `content_text` column at all (spec §3.4).
   * Subtitle, excerpt and category were equally free to delete.
   */
  it('the generated search column indexes body text, subtitle, excerpt and category', async () => {
    const author = await mkUser();
    const post = await mkPost(author, {
      title: 'Titleword',
      subtitle: 'Subtitleword',
      excerpt: 'Excerptword',
      category: 'Categoryword',
      contentText: 'Bodyword appears only in the body text of this post',
      tags: ['Tagword'],
    });

    // `ts_rank`'s weight array is {D,C,B,A}, so zeroing all but one scores only
    // lexemes carrying that weight. Asserting presence alone would not catch a
    // `setweight` dropped from the expression, and the weights ARE the ranking
    // — a body match must never outrank a title match.
    const res = await db.execute(sql`
      SELECT search::text AS vec,
             ts_rank('{1,0,0,0}', search, to_tsquery('english','bodyword'))     AS body_d,
             ts_rank('{0,0,1,0}', search, to_tsquery('english','subtitleword')) AS subtitle_b,
             ts_rank('{0,0,1,0}', search, to_tsquery('english','excerptword'))  AS excerpt_b,
             ts_rank('{0,1,0,0}', search, to_tsquery('english','categoryword')) AS category_c,
             ts_rank('{0,0,0,1}', search, to_tsquery('english','titleword'))    AS title_a,
             ts_rank('{1,0,0,0}', search, to_tsquery('english','titleword'))    AS title_not_d
        FROM posts WHERE id = ${post}`);
    const row = res.rows[0];

    expect(Number(row.body_d)).toBeGreaterThan(0);
    expect(Number(row.subtitle_b)).toBeGreaterThan(0);
    expect(Number(row.excerpt_b)).toBeGreaterThan(0);
    expect(Number(row.category_c)).toBeGreaterThan(0);
    expect(Number(row.title_a)).toBeGreaterThan(0);
    // The weights are distinct, not all the same letter.
    expect(Number(row.title_not_d)).toBe(0);

    // Postgres omits the 'D' label when printing, because D is the default
    // weight — so body text shows as a bare position. A, B and C do print.
    const vec = String(row.vec);
    expect(vec).toMatch(/'bodyword':\d+(?![ABC0-9])/);
    expect(vec).toMatch(/'subtitleword':\d+B/);
    expect(vec).toMatch(/'excerptword':\d+B/);
    expect(vec).toMatch(/'categoryword':\d+C/);
    expect(vec).toMatch(/'titleword':\d+A/);
  });
});

/**
 * THE 1 MB TSVECTOR CLIFF.
 *
 * A `tsvector` cannot hold more than MAXSTRPOS = 1 048 575 bytes of lexemes and
 * positions; past that Postgres raises SQLSTATE 54000. Before migration 0001
 * the generated column fed the whole of `content_text` in unbounded, so a
 * document `shared/validate.ts` calls VALID — under the 2 MB serialised ceiling
 * of spec §4.6 — was physically unwritable. Worse than a size limit in two
 * ways: it is a cliff rather than a gradient (ordinary prose survives past 2 MB
 * because lexemes dedupe), and it is retroactive — an existing post that grows
 * past the line can no longer be saved at all, leaving a readable row that is
 * permanently unwritable. Spec §8 has no mapping for 54000, so it would surface
 * as a 500 rather than the 422 §4.6 promises.
 */
describe('the generated search column has a bounded input', () => {
  /** `k` distinct terms, the shape that defeats lexeme deduplication. */
  const glossary = (k: number) =>
    Array.from({ length: k }, (_, i) => `term${i}`).join(' ');

  it('a document at the validator ceiling saves, and is indexed whole', async () => {
    const author = await mkUser();
    // Exactly MAX_CONTENT_TEXT_BYTES, ending on a term boundary, with a marker
    // at each end so truncation anywhere is visible.
    const filler = glossary(60_000);
    const head = 'openingmarker ';
    const tail = ' closingmarker';
    const body =
      head +
      filler.slice(0, MAX_CONTENT_TEXT_BYTES - head.length - tail.length) +
      tail;
    expect(Buffer.byteLength(body)).toBe(MAX_CONTENT_TEXT_BYTES);

    const post = await mkPost(author, { contentText: body });
    const res = await db.execute(sql`
      SELECT (search @@ to_tsquery('english', 'openingmarker')) AS head,
             (search @@ to_tsquery('english', 'closingmarker')) AS tail
        FROM posts WHERE id = ${post}`);
    // Not truncated at the ceiling: everything the validator accepts is indexed.
    expect(res.rows[0].head).toBe(true);
    expect(res.rows[0].tail).toBe(true);
  });

  it('the 80 000-term document is refused by the validator, not by the database', async () => {
    const author = await mkUser();
    const body = glossary(80_000);
    // Spec-legal by §4.6's serialised ceiling — this is the whole problem.
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_DOC_BYTES);

    // The validator is what rejects it, with a 422-shaped violation.
    const doc = { type: 'doc', content: [{ type: 'text', text: body }] };
    expect(checkDocSize(doc)).toEqual({ path: 'content', reason: 'too_large' });

    // And if it ever reaches the database anyway — an import, a backfill,
    // manual SQL — the row is written rather than rejected with 54000.
    await expect(mkPost(author, { contentText: body })).resolves.toBeTruthy();
  });

  it('a multibyte document far past the ceiling saves too', async () => {
    // The bound is on BYTES, not characters. `left(content_text, 600000)`
    // counts characters, so it bounds nothing here: 600 000 CJK characters are
    // 1.4 MB of lexemes and still raise 54000. Measured on PGlite 18.3.
    const author = await mkUser();
    const chars: string[] = [];
    for (let i = 0; i < 20_000; i += 1) chars.push(String.fromCodePoint(0x4e00 + i));
    const pairs: string[] = [];
    for (let i = 0; i < 250_000; i += 1) {
      pairs.push(chars[i % 20_000] + chars[(Math.floor(i / 20_000) * 7 + 3) % 20_000]);
    }
    const body = [...pairs.join(' ')].slice(0, 750_000).join('');
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_500_000);

    await expect(mkPost(author, { contentText: body })).resolves.toBeTruthy();
  });

  it('the ceiling the validator enforces is the threshold the migration truncates at', async () => {
    // One number in two places. If they drift apart the validator either starts
    // accepting documents the index silently truncates, or rejects ones the
    // database would have stored whole.
    const migration = readFileSync(
      'server/db/migrations/0001_bound_search_input.sql',
      'utf8',
    );
    expect(migration).toContain(`octet_length(coalesce(content_text,'')) <= ${MAX_CONTENT_TEXT_BYTES}`);
    // The truncation fallback must be at most the ceiling in bytes for ANY
    // encoding, so it is expressed in characters at a quarter of it — UTF-8
    // never exceeds four bytes per character.
    expect(migration).toContain(`left(coalesce(content_text,''), ${MAX_CONTENT_TEXT_BYTES / 4})`);
  });
});

/**
 * Two properties of the migration that nothing else asserts, so both could be
 * deleted from `0000_*.sql` with the whole suite staying green.
 */
describe('migration properties', () => {
  it('sessions.user_id cascades on delete, in the catalogue and in behaviour', async () => {
    // Catalogue first: `confdeltype` is 'c' for CASCADE, 'a' for NO ACTION.
    // Asserting the behaviour alone is not enough to name the failure — a
    // downgrade to NO ACTION makes the DELETE below throw rather than leave
    // rows behind, and the test would fail for a reason the message hides.
    const fk = await db.execute(sql`
      SELECT confdeltype FROM pg_constraint
       WHERE conname = 'sessions_user_id_users_id_fk'`);
    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0].confdeltype).toBe('c');

    const user = await mkUser();
    const now = Date.now();
    await db.execute(sql`
      INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
      VALUES (${uid('s')}, ${user}, ${now}, ${now + 1000}, ${now}, NULL)`);

    const before = await db.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user}`);
    expect(before.rows[0].n).toBe(1);

    // Deleting a user must not be blocked by their own sessions, and must not
    // leave orphan rows that a recreated uuid could inherit.
    await db.execute(sql`DELETE FROM users WHERE id = ${user}`);
    const after = await db.execute(sql`
      SELECT count(*)::int AS n FROM sessions WHERE user_id = ${user}`);
    expect(after.rows[0].n).toBe(0);
  });

  it('posts_search_idx exists and is a GIN index over the generated column', async () => {
    // The GIN index is hand-appended DDL, absent from `meta/0000_snapshot.json`
    // — so it is exactly the kind of thing a regenerate or a `drizzle-kit push`
    // silently drops. Without this, full-text search degrades to a sequential
    // scan and every test still passes.
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'posts' AND indexname = 'posts_search_idx'`);
    expect(res.rows).toHaveLength(1);
    const def = String(res.rows[0].indexdef);
    expect(def).toMatch(/USING gin/i);
    expect(def).toMatch(/\bsearch\b/);
  });

  it('posts_tags_idx exists and is a GIN index over tags', async () => {
    // Spec §3.4 requires GIN on `tags` as well as on `search`, and this index
    // is hand-appended DDL for the same reason — invisible to drizzle-kit, so a
    // regenerate or a `push` drops it. Only its twin above was asserted, so
    // rewriting this one to `USING btree (id)` left the suite green while
    // Task 9's `?tag=` filter degraded to a sequential scan over every post.
    const res = await db.execute(sql`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'posts' AND indexname = 'posts_tags_idx'`);
    expect(res.rows).toHaveLength(1);
    const def = String(res.rows[0].indexdef);
    expect(def).toMatch(/USING gin/i);
    expect(def).toMatch(/\btags\b/);
  });
});
