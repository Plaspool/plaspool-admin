/**
 * Derivation, slug authority and row mapping — the three things that stop being
 * the browser's job at cutover.
 *
 * All three share one file, and therefore one PGlite boot. The harness costs
 * ~1.5 s per database and `vitest.config.ts` already records that several
 * suites racing that boot is what pushed the old 20 s hook timeout over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { derive, nextExcerpt } from './derive';
import { uniqueSlug } from './slug';
import { POST_COLUMNS, rowToListPost, rowToPost } from '../repo/mapping';
import type { DocNode, Post } from '../../shared/types';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

interface SeedPost {
  id: string;
  slug?: string | null;
  title?: string;
  content?: DocNode;
  contentText?: string;
  tags?: string[];
  template?: string | null;
  coverImage?: unknown;
}

async function seedPost(p: SeedPost): Promise<void> {
  const now = Date.now();
  const content = p.content ?? doc('body');
  await ctx.db.execute(sql`
    INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                       content_text, cover_image, category, tags, template, status,
                       created_at, updated_at, published_at, deleted_at,
                       word_count, reading_time, author_id, revision)
    VALUES (${p.id}, ${p.title ?? 'T'}, 'S', ${p.slug ?? null}, 'E', 'derived',
            ${JSON.stringify(content)}::jsonb, ${p.contentText ?? 'body'},
            ${p.coverImage ? JSON.stringify(p.coverImage) : null}::jsonb, 'cat',
            ${sql.param(p.tags ?? [])}, ${p.template ?? null}, 'draft',
            ${now}, ${now}, null, null, 1, 1, ${ctx.users.owner.id}, 1)`);
}

// ------------------------------------------------------------------ uniqueSlug

describe('uniqueSlug', () => {
  it('returns the base slug when free', async () => {
    expect(await uniqueSlug(ctx.db, 'free-one', 'p_free')).toBe('free-one');
  });

  it('suffixes -2 when taken by another post', async () => {
    await seedPost({ id: 'p_taken', slug: 'taken' });
    expect(await uniqueSlug(ctx.db, 'taken', 'p_other')).toBe('taken-2');
  });

  it('returns the base slug when the only clash is the post itself', async () => {
    // Re-slugging a post must not walk it to `-2` every time it is saved.
    await seedPost({ id: 'p_self', slug: 'self-owned' });
    expect(await uniqueSlug(ctx.db, 'self-owned', 'p_self')).toBe('self-owned');
  });

  it('walks past several collisions', async () => {
    await seedPost({ id: 'p_w1', slug: 'walk' });
    await seedPost({ id: 'p_w2', slug: 'walk-2' });
    await seedPost({ id: 'p_w3', slug: 'walk-3' });
    expect(await uniqueSlug(ctx.db, 'walk', 'p_w9')).toBe('walk-4');
  });

  it('skips only the candidates actually taken', async () => {
    // A gap in the sequence is reused rather than walked past, which is what a
    // "highest suffix + 1" implementation would get wrong after a delete.
    await seedPost({ id: 'p_g1', slug: 'gap' });
    await seedPost({ id: 'p_g3', slug: 'gap-3' });
    expect(await uniqueSlug(ctx.db, 'gap', 'p_g9')).toBe('gap-2');
  });

  it('does not treat a longer unrelated slug as a collision', async () => {
    // `starts_with(slug, base || '-')` and not `LIKE base || '%'`: `posting`
    // must not count as a clash for `post`.
    await seedPost({ id: 'p_pre', slug: 'posting' });
    expect(await uniqueSlug(ctx.db, 'post', 'p_new')).toBe('post');
  });

  it('falls back to a random suffix after 200 collisions', async () => {
    // `base`, then `base-2`…`base-198` — the exact candidate set the client
    // loop tries before giving up (src/data/posts.ts:158-168).
    await seedPost({ id: 'p_x1', slug: 'crowd' });
    await ctx.db.execute(sql`
      INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                         content_text, category, tags, status, created_at, updated_at,
                         word_count, reading_time, author_id, revision)
      SELECT 'p_crowd_' || n, 'T', 'S', 'crowd-' || n, 'E', 'derived',
             '{"type":"doc","content":[]}'::jsonb, '', 'cat', '{}'::text[], 'draft',
             ${Date.now()}, ${Date.now()}, 0, 0, ${ctx.users.owner.id}, 1
        FROM generate_series(2, 198) AS n`);

    const slug = await uniqueSlug(ctx.db, 'crowd', 'p_none');
    expect(slug).toMatch(/^crowd-[0-9a-f]{8,}$/);
    const clash = await ctx.db.execute(
      sql`SELECT id FROM posts WHERE slug = ${slug}`,
    );
    expect(clash.rows).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- derivation

describe('derive', () => {
  it('computes contentText, wordCount and readingTime from the document', () => {
    expect(derive(doc('one two three'))).toEqual({
      contentText: 'one two three',
      wordCount: 3,
      readingTime: 1,
    });
  });

  it('reports zero reading time for an empty document, and never zero otherwise', () => {
    expect(derive({ type: 'doc', content: [] })).toEqual({
      contentText: '',
      wordCount: 0,
      readingTime: 0,
    });
    const long = derive(doc(Array.from({ length: 500 }, () => 'word').join(' ')));
    expect(long.wordCount).toBe(500);
    expect(long.readingTime).toBe(2);
  });
});

describe('nextExcerpt', () => {
  it('explicit text becomes author, explicit empty reverts to derived, absent tracks a derived excerpt and leaves an author one alone', () => {
    const content = doc('The opening line of the post.');

    // Explicit text -> author, trimmed.
    expect(
      nextExcerpt({
        patchExcerpt: '  hand written  ',
        currentExcerpt: 'old',
        currentSource: 'derived',
        content,
      }),
    ).toEqual({ excerpt: 'hand written', excerptSource: 'author' });

    // Explicit empty -> back to derived. This is the "clear the field to let it
    // track the post again" gesture, and it must also flip the source back.
    expect(
      nextExcerpt({
        patchExcerpt: '   ',
        currentExcerpt: 'hand written',
        currentSource: 'author',
        content,
      }),
    ).toEqual({ excerpt: 'The opening line of the post.', excerptSource: 'derived' });

    // Absent, source derived -> re-derived, so a card never advertises text the
    // post no longer contains.
    expect(
      nextExcerpt({ currentExcerpt: 'stale', currentSource: 'derived', content }),
    ).toEqual({ excerpt: 'The opening line of the post.', excerptSource: 'derived' });

    // Absent, source author -> untouched, both fields.
    expect(
      nextExcerpt({ currentExcerpt: 'mine', currentSource: 'author', content }),
    ).toEqual({ excerpt: 'mine', excerptSource: 'author' });
  });
});

// -------------------------------------------------------------------- mapping

describe('rowToPost', () => {
  const EXPECTED_KEYS: (keyof Post)[] = [
    'id', 'title', 'subtitle', 'slug', 'excerpt', 'excerptSource', 'content',
    'coverImage', 'category', 'tags', 'template', 'status', 'createdAt',
    'updatedAt', 'publishedAt', 'deletedAt', 'wordCount', 'readingTime',
    'authorId', 'authorName', 'revision',
  ];

  it('drops contentText and camel-cases every column', async () => {
    await seedPost({
      id: 'p_map',
      slug: 'mapped',
      title: 'Mapped',
      content: doc('mapped body'),
      contentText: 'mapped body',
      tags: ['a', 'b'],
      template: 'minimal',
      coverImage: { blobId: 'img_1', alt: 'a', focalPoint: '50% 50%', width: 4, height: 3 },
    });
    const res = await ctx.db.execute(
      sql`SELECT ${sql.raw(POST_COLUMNS.join(', '))}, content_text FROM posts WHERE id = 'p_map'`,
    );
    const row = res.rows[0];
    // The raw row is not a Post: snake_case keys, and `content_text` present.
    expect(row).toHaveProperty('content_text');
    expect(row).toHaveProperty('author_id');

    const post = rowToPost(row, 'Owner');
    expect(Object.keys(post).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(post).not.toHaveProperty('contentText');
    expect(post).not.toHaveProperty('content_text');
    expect(post).not.toHaveProperty('search');
    expect(post.slug).toBe('mapped');
    expect(post.tags).toEqual(['a', 'b']);
    expect(post.template).toBe('minimal');
    expect(post.coverImage?.blobId).toBe('img_1');
    expect(post.authorId).toBe(ctx.users.owner.id);
    expect(post.authorName).toBe('Owner');
    expect(post.content).toEqual(doc('mapped body'));
  });

  it('POST_COLUMNS can never carry content_text or the search vector into a response', () => {
    // Spec §3.4: both `SELECT`s and `RETURNING`s enumerate columns explicitly so
    // neither can ride along. This is that rule as an assertion.
    expect(POST_COLUMNS).not.toContain('content_text');
    expect(POST_COLUMNS).not.toContain('search');
    expect(POST_COLUMNS).not.toContain('*');
    expect(POST_COLUMNS).toContain('content');
  });

  it('reads bigint columns through the coercion helpers, not raw', async () => {
    // The test driver returns int8 as a STRING, matching @neondatabase/serverless.
    // A mapper that trusted `typeof` would put "1786440456271" on `createdAt`
    // and every date arithmetic downstream would concatenate.
    await seedPost({ id: 'p_bigint' });
    const res = await ctx.db.execute(
      sql`SELECT ${sql.raw(POST_COLUMNS.join(', '))} FROM posts WHERE id = 'p_bigint'`,
    );
    expect(typeof res.rows[0].created_at).toBe('string');

    const post = rowToPost(res.rows[0], 'Owner');
    expect(typeof post.createdAt).toBe('number');
    expect(typeof post.updatedAt).toBe('number');
    expect(post.publishedAt).toBeNull();
    expect(post.deletedAt).toBeNull();
    expect(typeof post.revision).toBe('number');
    expect(typeof post.wordCount).toBe('number');
  });

  it('accepts jsonb as an object or as a string, so a driver change cannot corrupt a document', () => {
    const base = {
      id: 'p_j', title: 'T', subtitle: 'S', slug: null, excerpt: 'E',
      excerpt_source: 'derived', cover_image: null, category: '', tags: [],
      template: null, status: 'draft', created_at: '1', updated_at: '1',
      published_at: null, deleted_at: null, word_count: 0, reading_time: 0,
      author_id: 'u1', revision: 1,
    };
    const parsed = rowToPost({ ...base, content: doc('x') }, 'A');
    const stringified = rowToPost({ ...base, content: JSON.stringify(doc('x')) }, 'A');
    expect(stringified.content).toEqual(parsed.content);
  });

  it('rowToListPost is a Post without its document', async () => {
    const res = await ctx.db.execute(
      sql`SELECT ${sql.raw(POST_COLUMNS.join(', '))} FROM posts WHERE id = 'p_map'`,
    );
    const listed = rowToListPost(res.rows[0], 'Owner');
    expect(listed).not.toHaveProperty('content');
    expect(Object.keys(listed).sort()).toEqual(
      EXPECTED_KEYS.filter((k) => k !== 'content').sort(),
    );
    expect(listed.title).toBe('Mapped');
  });
});
