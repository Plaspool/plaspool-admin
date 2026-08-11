/**
 * Constraint tests. These assert against a real PostgreSQL (PGlite), because
 * `.$type<>()` on a Drizzle column is compile-time only and buys nothing at
 * runtime — a bug anywhere could otherwise persist `role = 'admin'`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { migratedDb } from '../test/harness';
import type { Db } from './client';

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
    VALUES (${id}, ${o.title ?? ''}, '', ${o.slug ?? null}, '',
            ${o.excerptSource ?? 'derived'},
            ${'{"type":"doc","content":[]}'}::jsonb, '', NULL, '',
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
 * Drizzle wraps a driver error in a `Failed query: …` Error and hangs the real
 * one off `cause`, so asserting on the top-level message can never see the
 * constraint name. Flatten the chain and assert on that.
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
});
