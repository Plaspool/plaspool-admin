/**
 * The CAS write path. Everything else in the backend is plumbing around this.
 *
 * The property under test is not "a save works" but "a save that loses a race
 * changes nothing at all" — no bumped revision, and above all no orphan
 * revision row, because a revision written by a losing write is a snapshot of a
 * document that was never stored.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { createPost, getPost, savePost } from './posts';
import { InvalidDocumentError, NotFoundError, StaleWriteError } from './errors';
import {
  MAX_CATEGORY_BYTES,
  MAX_EXCERPT_BYTES,
  MAX_SUBTITLE_BYTES,
  MAX_TAGS,
  MAX_TAG_BYTES,
  MAX_TITLE_BYTES,
  checkPostMeta,
} from '../../shared/validate';
import type { DocNode, Post, PostPatch } from '../../shared/types';

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

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM posts`);
});

const actor = () => ctx.users.owner;

async function countRevisions(postId: string): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${postId}`,
  );
  return Number(res.rows[0].n);
}

/** The rejection itself, typed — `.catch(e => e)` widens to `T | error`. */
async function rejection<T>(promise: Promise<unknown>): Promise<T> {
  let caught: unknown;
  let resolved = false;
  await promise.then(
    () => {
      resolved = true;
    },
    (err: unknown) => {
      caught = err;
    },
  );
  if (resolved) throw new Error('expected the call to reject, but it resolved');
  return caught as T;
}

async function rawPost(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute(sql`SELECT * FROM posts WHERE id = ${id}`);
  return res.rows[0];
}

// ---------------------------------------------------------------- createPost

describe('createPost', () => {
  it('stores the post and its first revision together', async () => {
    const post = await createPost(ctx.db, actor(), { title: 'First', content: doc('hello') });
    expect(post.revision).toBe(1);
    expect(post.authorId).toBe(actor().id);
    expect(post.authorName).toBe(actor().displayName);
    expect(await countRevisions(post.id)).toBe(1);
    expect(await getPost(ctx.db, post.id)).toEqual(post);
  });

  it('normalises an empty slug to NULL so two untitled drafts can coexist', async () => {
    /*
     * `createDraftShape({ slug: '' })` still yields `''` — `'' ?? null` is `''`,
     * not null — so the empty-string convention arrives here from the client and
     * has to die at the write boundary. `slug` is UNIQUE: the SECOND untitled
     * draft is the one that would have failed, with a raw 23505.
     */
    const a = await createPost(ctx.db, actor(), { slug: '' });
    const b = await createPost(ctx.db, actor(), { slug: '' });
    expect(a.slug).toBeNull();
    expect(b.slug).toBeNull();
    expect((await rawPost(a.id)).slug).toBeNull();
  });

  it('runs a supplied slug through the uniqueness walk rather than trusting it', async () => {
    await createPost(ctx.db, actor(), { slug: 'taken', title: 'A' });
    const second = await createPost(ctx.db, actor(), { slug: 'taken', title: 'B' });
    expect(second.slug).toBe('taken-2');
  });

  it('refuses an invalid document instead of storing it', async () => {
    await expect(
      createPost(ctx.db, actor(), { content: { type: 'doc', content: [{ type: 'script' }] } }),
    ).rejects.toBeInstanceOf(InvalidDocumentError);
    const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it('normalises the SHAPE of a supplied slug, not only its uniqueness', async () => {
    /*
     * `slug` becomes a URL path segment, and this function is what
     * `duplicatePost` and `POST /import` go through — both of which carry a slug
     * from outside. The uniqueness walk alone stored `../../admin` verbatim,
     * which is not what "slugs are server-authoritative" (spec §4.5) means.
     */
    const traversal = await createPost(ctx.db, actor(), { slug: '../../admin', title: 'T' });
    expect(traversal.slug).toBe('admin');

    for (const [supplied, expected] of [
      ['Not A Slug', 'not-a-slug'],
      ['  spaced  out  ', 'spaced-out'],
      // `ø` has no NFKD decomposition, so `slugify` drops it — the point here
      // is the charset, not the transliteration.
      ['Ünïcødé Ttl', 'unic-de-ttl'],
      ['%2e%2e%2fetc', '2e-2e-2fetc'],
      ['....', 'untitled'],
    ] as const) {
      const post = await createPost(ctx.db, actor(), { slug: supplied, title: 'T' });
      expect(post.slug, supplied).toBe(expected);
      expect((await rawPost(post.id)).slug, supplied).toBe(expected);
    }
  });

  it('derives wordCount, readingTime and content_text rather than trusting the caller', async () => {
    /*
     * Spec §4.4: derivation is the server's. Untested, the INSERT could store
     * `word_count = 0, reading_time = 0` and the whole suite stayed green —
     * and `duplicatePost` and `POST /import` both come through here, so every
     * imported post would list as a zero-minute read.
     */
    const body = Array.from({ length: 500 }, (_, i) => `word${i % 7}`).join(' ');
    const post = await createPost(ctx.db, actor(), {
      title: 'Derived',
      content: doc(body),
      // Supplied and deliberately wrong: the server's numbers must win.
      wordCount: 9999,
      readingTime: 9999,
    });

    expect(post.wordCount).toBe(500);
    expect(post.readingTime).toBe(2);

    const row = await rawPost(post.id);
    expect(row.word_count).toBe(500);
    expect(row.reading_time).toBe(2);
    expect(row.content_text).toBe(body);

    // An empty document is the other end: zero words, and zero minutes rather
    // than the `Math.max(1, …)` floor.
    const empty = await createPost(ctx.db, actor(), { content: { type: 'doc', content: [] } });
    expect(empty.wordCount).toBe(0);
    expect(empty.readingTime).toBe(0);
    expect((await rawPost(empty.id)).content_text).toBe('');
  });

  it('refuses metadata too large for the search index instead of letting it 500', async () => {
    const violation = await rejection<InvalidDocumentError>(
      createPost(ctx.db, actor(), { title: 'x'.repeat(MAX_TITLE_BYTES + 1) }),
    );
    expect(violation).toBeInstanceOf(InvalidDocumentError);
    expect(violation.path).toBe('title');
    const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(res.rows[0].n)).toBe(0);
  });
});

// ------------------------------------------------------------------ savePost

describe('savePost', () => {
  async function seeded(partial: Partial<Post> = {}): Promise<Post> {
    return createPost(ctx.db, actor(), { content: doc('body'), ...partial });
  }

  it('bumps the revision and appends exactly one revision row', async () => {
    const post = await seeded({ title: 'T', slug: 'fixed' });
    const before = await countRevisions(post.id);

    const saved = await savePost(ctx.db, post.id, { title: 'Changed' }, { actor: actor() });

    expect(saved.revision).toBe(post.revision + 1);
    expect(saved.title).toBe('Changed');
    expect(await countRevisions(post.id)).toBe(before + 1);
    const rev = await ctx.db.execute(
      sql`SELECT revision, kind, author_id, title FROM revisions
           WHERE post_id = ${post.id} ORDER BY revision DESC LIMIT 1`,
    );
    expect(Number(rev.rows[0].revision)).toBe(saved.revision);
    expect(rev.rows[0].kind).toBe('autosave');
    expect(rev.rows[0].author_id).toBe(actor().id);
    expect(rev.rows[0].title).toBe('Changed');
  });

  it('rejects a stale baseRevision without touching the stored row', async () => {
    const post = await seeded({ title: 'T', slug: 'stale' });
    await expect(
      savePost(ctx.db, post.id, { title: 'X' }, { actor: actor(), baseRevision: 999 }),
    ).rejects.toBeInstanceOf(StaleWriteError);

    const stored = await getPost(ctx.db, post.id);
    expect(stored?.title).toBe('T');
    expect(stored?.revision).toBe(post.revision);
  });

  it('THE GUARD: a losing write inserts no revision row', async () => {
    /*
     * The revision insert SELECTs FROM the update, so when the CAS matches
     * nothing the insert structurally has no rows to insert. The guard is the
     * data flow, not a bolted-on WHERE EXISTS — and this is the assertion that
     * proves it, because an orphan revision row is a snapshot of a document
     * that was never stored.
     */
    const post = await seeded({ title: 'T', slug: 'guard' });
    const before = await countRevisions(post.id);
    await expect(
      savePost(ctx.db, post.id, { title: 'X' }, { actor: actor(), baseRevision: 999 }),
    ).rejects.toBeInstanceOf(StaleWriteError);
    expect(await countRevisions(post.id)).toBe(before);
  });

  it('carries both revisions and the current post on the 409', async () => {
    // Spec §4.3: the conflict banner's "Load theirs" renders with no second
    // round trip, so the error has to hold the post.
    const post = await seeded({ title: 'Theirs', slug: 'conflict' });
    const err = await rejection<StaleWriteError>(
      savePost(ctx.db, post.id, { title: 'Mine' }, { actor: actor(), baseRevision: 7 }),
    );

    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.expected).toBe(7);
    expect(err.actual).toBe(post.revision);
    expect(err.post?.title).toBe('Theirs');
  });

  it('is a NotFoundError for a post that does not exist', async () => {
    await expect(
      savePost(ctx.db, 'p_missing', { title: 'X' }, { actor: actor() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('50 overlapping writes from the same base: exactly one wins, one revision row added', async () => {
    /*
     * WHAT THIS PROVES, AND WHAT IT DOES NOT. PGlite is a single-threaded WASM
     * Postgres with one connection and a FIFO statement queue, so these
     * deterministically execute as 50 reads followed by 50 CAS attempts. That
     * genuinely proves the CAS DECISION LOGIC — one winner, 49 losers, no
     * spurious revision rows — and it can never be flaky.
     *
     * It does NOT exercise row-lock blocking or READ COMMITTED EvalPlanQual
     * recheck, which is what real Postgres does under true parallelism. In
     * production the backstop is UNIQUE (post_id, revision), enforced by the
     * database at any degree of parallelism (spec §9).
     */
    const post = await seeded({ title: 'Race', slug: 'race' });
    const before = await countRevisions(post.id);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        savePost(
          ctx.db,
          post.id,
          { title: `writer ${i}` },
          { actor: actor(), baseRevision: post.revision },
        ),
      ),
    );

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);
    for (const r of lost) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StaleWriteError);
    }

    expect(await countRevisions(post.id)).toBe(before + 1);
    const stored = await getPost(ctx.db, post.id);
    expect(stored?.revision).toBe(post.revision + 1);
  });

  it('refuses an invalid document and leaves the row untouched', async () => {
    const post = await seeded({ title: 'Safe', slug: 'safe' });
    await expect(
      savePost(
        ctx.db,
        post.id,
        { content: { type: 'doc', content: [{ type: 'iframe' }] } },
        { actor: actor() },
      ),
    ).rejects.toBeInstanceOf(InvalidDocumentError);

    const stored = await getPost(ctx.db, post.id);
    expect(stored?.revision).toBe(post.revision);
    expect(stored?.content).toEqual(doc('body'));
    expect(await countRevisions(post.id)).toBe(1);
  });

  it('names the offending path on an invalid document', async () => {
    const post = await seeded({ title: 'Path', slug: 'path' });
    const err = await rejection<InvalidDocumentError>(
      savePost(
        ctx.db,
        post.id,
        { content: { type: 'doc', content: [doc('a').content![0], { type: 'iframe' }] } },
        { actor: actor() },
      ),
    );
    expect(err).toBeInstanceOf(InvalidDocumentError);
    expect(err.path).toBe('content[1]');
    expect(err.reason).toBe('unknown_node');
  });

  it('validates patch.content only — a pre-existing violation cannot brick the post', async () => {
    /*
     * Validating the MERGED document would mean one pre-existing violation —
     * from an import, or from a later tightening of the rules — makes that post
     * permanently unsavable, and every word written into it from then on is
     * lost. TipTap supplies the document whole, so validating the patch IS
     * validating what gets stored.
     */
    const post = await seeded({ title: 'Legacy', slug: 'legacy' });
    const hostile = { type: 'doc', content: [{ type: 'blink', content: [] }] };
    await ctx.db.execute(
      sql`UPDATE posts SET content = ${JSON.stringify(hostile)}::jsonb WHERE id = ${post.id}`,
    );

    // A patch that carries a VALID document must succeed.
    const fixed = await savePost(
      ctx.db,
      post.id,
      { content: doc('rewritten') },
      { actor: actor() },
    );
    expect(fixed.content).toEqual(doc('rewritten'));

    // And a patch that does not mention content at all must succeed even while
    // the stored document is still the invalid one — this is the sharper half,
    // because the merged document IS the violation.
    await ctx.db.execute(
      sql`UPDATE posts SET content = ${JSON.stringify(hostile)}::jsonb WHERE id = ${post.id}`,
    );
    const titled = await savePost(ctx.db, post.id, { title: 'Renamed' }, { actor: actor() });
    expect(titled.title).toBe('Renamed');
    expect(titled.content).toEqual(hostile);
  });

  it('never lets a patch smuggle in system fields', async () => {
    const post = await seeded({ title: 'Owned', slug: 'owned' });
    const smuggled = {
      title: 'Changed',
      id: 'p_hijacked',
      status: 'published',
      publishedAt: 123,
      deletedAt: 456,
      createdAt: 1,
      authorId: ctx.users.writer.id,
      authorName: 'Someone Else',
      revision: 99,
      slug: 'chosen-by-client',
    } as unknown as PostPatch;

    const saved = await savePost(ctx.db, post.id, smuggled, { actor: ctx.users.writer });

    expect(saved.id).toBe(post.id);
    expect(saved.status).toBe('draft');
    expect(saved.publishedAt).toBeNull();
    expect(saved.deletedAt).toBeNull();
    expect(saved.createdAt).toBe(post.createdAt);
    expect(saved.authorId).toBe(actor().id);
    expect(saved.authorName).toBe(actor().displayName);
    expect(saved.revision).toBe(post.revision + 1);
    // Slugs are server-authoritative (spec §4.5) — `PostPatch` has no slug key.
    expect(saved.slug).toBe('owned');
    expect(saved.title).toBe('Changed');
    expect(await rawPost('p_hijacked')).toBeUndefined();
  });

  it('assigns a slug on the first save that has a title', async () => {
    const post = await seeded();
    expect(post.slug).toBeNull();
    const saved = await savePost(ctx.db, post.id, { title: 'Hello World' }, { actor: actor() });
    expect(saved.slug).toBe('hello-world');

    // And does not re-slug on a later title change: the published URL is a
    // promise, not a derived value that follows the heading around.
    const again = await savePost(ctx.db, post.id, { title: 'Something Else' }, { actor: actor() });
    expect(again.slug).toBe('hello-world');
  });

  it('leaves an untitled draft unslugged', async () => {
    const post = await seeded();
    const saved = await savePost(ctx.db, post.id, { subtitle: 'sub' }, { actor: actor() });
    expect(saved.slug).toBeNull();
  });

  it('recomputes wordCount and readingTime from the new content', async () => {
    const post = await seeded({ title: 'Counts', slug: 'counts' });
    const saved = await savePost(
      ctx.db,
      post.id,
      {
        content: doc(Array.from({ length: 450 }, () => 'word').join(' ')),
        // A client-supplied count must not survive: the server owns derivation
        // (spec §4.4) and these are not on PostPatch anyway.
      },
      { actor: actor() },
    );
    expect(saved.wordCount).toBe(450);
    expect(saved.readingTime).toBe(2);
    const stored = await rawPost(post.id);
    expect(String(stored.content_text)).toContain('word');
    expect(Number(stored.word_count)).toBe(450);
  });

  it('tags round-trip as a real text[] including the empty array', async () => {
    /*
     * The naive binding is wrong: drizzle's `sql` template expands a bare JS
     * array into a comma-separated parameter list — its `IN (...)` behaviour —
     * producing `tags = ($1, $2)` and `column "tags" is of type text[] but
     * expression is of type record`. `sql.param` binds it as one value.
     */
    const post = await seeded({ title: 'Tagged', slug: 'tagged' });

    const two = await savePost(ctx.db, post.id, { tags: ['beta gamma', 'delta'] }, { actor: actor() });
    expect(two.tags).toEqual(['beta gamma', 'delta']);
    const len = await ctx.db.execute(
      sql`SELECT array_length(tags, 1) AS n FROM posts WHERE id = ${post.id}`,
    );
    expect(Number(len.rows[0].n)).toBe(2);

    const none = await savePost(ctx.db, post.id, { tags: [] }, { actor: actor() });
    expect(none.tags).toEqual([]);
    const empty = await ctx.db.execute(
      sql`SELECT array_length(tags, 1) AS n FROM posts WHERE id = ${post.id}`,
    );
    expect(empty.rows[0].n).toBeNull();
  });

  it('keeps the excerpt rule: author text survives, a derived one tracks the post', async () => {
    const post = await seeded({ title: 'Ex', slug: 'ex' });
    const authored = await savePost(ctx.db, post.id, { excerpt: 'By hand' }, { actor: actor() });
    expect(authored).toMatchObject({ excerpt: 'By hand', excerptSource: 'author' });

    const rewritten = await savePost(
      ctx.db,
      post.id,
      { content: doc('completely new opening') },
      { actor: actor() },
    );
    expect(rewritten.excerpt).toBe('By hand');

    const cleared = await savePost(ctx.db, post.id, { excerpt: '  ' }, { actor: actor() });
    expect(cleared).toMatchObject({
      excerpt: 'completely new opening',
      excerptSource: 'derived',
    });
  });

  it('persists the per-post template rather than dropping it', async () => {
    // `PostPatch` carries `template`, so a write path that ignored it would
    // silently lose a writer's layout choice on every save.
    const post = await seeded({ title: 'Tpl', slug: 'tpl' });
    expect(post.template).toBeNull();
    const saved = await savePost(ctx.db, post.id, { template: 'editorial' }, { actor: actor() });
    expect(saved.template).toBe('editorial');
    expect((await getPost(ctx.db, post.id))?.template).toBe('editorial');
  });

  it('never returns content_text or the search vector', async () => {
    const post = await seeded({ title: 'Leak', slug: 'leak' });
    const saved = await savePost(ctx.db, post.id, { title: 'Leak 2' }, { actor: actor() });
    for (const shape of [saved, (await getPost(ctx.db, post.id)) as Post]) {
      expect(Object.keys(shape)).not.toContain('contentText');
      expect(Object.keys(shape)).not.toContain('content_text');
      expect(Object.keys(shape)).not.toContain('search');
    }
  });

  it('retries a slug lost to a concurrent write rather than surfacing the violation', async () => {
    /*
     * Spec §4.5: the uniqueness index is the authority, the loop is only an
     * optimisation. Two untitled drafts given the SAME title at once is the
     * race — deterministic here, not luck: PGlite has one connection and a FIFO
     * queue, so both `uniqueSlug` reads run before either write, both see
     * `shared-title` free, and the second write hits `posts_slug_unique`.
     *
     * Without the retry that is a raw 23505 the route would render as a 500,
     * for a writer who did nothing wrong.
     */
    const a = await seeded();
    const b = await seeded();

    const [first, second] = await Promise.all([
      savePost(ctx.db, a.id, { title: 'Shared Title' }, { actor: actor() }),
      savePost(ctx.db, b.id, { title: 'Shared Title' }, { actor: actor() }),
    ]);

    expect([first.slug, second.slug].sort()).toEqual(['shared-title', 'shared-title-2']);
    expect(first.revision).toBe(a.revision + 1);
    expect(second.revision).toBe(b.revision + 1);
    // The retried write left exactly one revision, not one per attempt.
    expect(await countRevisions(a.id)).toBe(2);
    expect(await countRevisions(b.id)).toBe(2);
  });

  it.each([10, 25])(
    '%i writers taking the same title all get a slug, none get a raw 23505',
    async (n) => {
      /*
       * THE RETRY MUST DIVERSIFY, NOT RE-DERIVE.
       *
       * Three attempts is not the bound that matters. Every in-flight writer
       * re-reads the same taken set and picks the same next candidate, so each
       * round admits exactly one of them — N writers need N rounds, not three.
       * Measured before the fix: N=3 all succeed, N=10 leaves seven rejected
       * with `DbError code=23505 constraint=posts_slug_unique`, which spec §8
       * has no row for and a route renders as a 500. The random-suffix fallback
       * in `slug.ts` is unreachable from here — it only fires after 198
       * COMMITTED collisions, not after three lost races.
       *
       * Deterministic, not luck: PGlite has one connection and a FIFO queue, so
       * all N `uniqueSlug` reads run before any write (spec §9).
       */
      const posts = await Promise.all(Array.from({ length: n }, () => seeded()));
      const settled = await Promise.allSettled(
        posts.map((p) => savePost(ctx.db, p.id, { title: 'Shared Title' }, { actor: actor() })),
      );

      const rejected = settled.filter((r) => r.status === 'rejected');
      expect(
        rejected.map((r) => String((r as PromiseRejectedResult).reason)),
        'spec §4.5: a unique_violation from a concurrent insert is retried, never surfaced',
      ).toEqual([]);

      const slugs = settled.map((r) => (r as PromiseFulfilledResult<Post>).value.slug);
      // Every writer got a distinct, non-null slug derived from the title.
      expect(new Set(slugs).size).toBe(n);
      for (const slug of slugs) expect(slug).toMatch(/^shared-title(-|$)/);
      // And the retry left one revision per post, not one per attempt.
      for (const p of posts) expect(await countRevisions(p.id)).toBe(2);
    },
  );

  it('refuses oversized metadata as a 422 and leaves the row untouched', async () => {
    /*
     * `title`, `subtitle`, `excerpt`, `category` and `tags` are the other five
     * inputs to the same generated `search` tsvector that
     * `MAX_CONTENT_TEXT_BYTES` bounds. Unbounded, each one reaches SQLSTATE
     * 54000 on this statement — a `DbError` with no row in spec §8, i.e. a 500,
     * which the client's retry policy treats as transient and retries forever
     * for a write that can never succeed.
     */
    const post = await seeded({ title: 'Bounded', slug: 'bounded' });

    const cases: [PostPatch, string][] = [
      [{ title: 'x'.repeat(MAX_TITLE_BYTES + 1) }, 'title'],
      [{ subtitle: 'x'.repeat(MAX_SUBTITLE_BYTES + 1) }, 'subtitle'],
      [{ excerpt: 'x'.repeat(MAX_EXCERPT_BYTES + 1) }, 'excerpt'],
      [{ category: 'x'.repeat(MAX_CATEGORY_BYTES + 1) }, 'category'],
      [{ tags: ['x'.repeat(MAX_TAG_BYTES + 1)] }, 'tags[0]'],
      [{ tags: Array.from({ length: MAX_TAGS + 1 }, () => 't') }, 'tags'],
    ];

    for (const [patch, path] of cases) {
      const err = await rejection<InvalidDocumentError>(
        savePost(ctx.db, post.id, patch, { actor: actor() }),
      );
      expect(err, path).toBeInstanceOf(InvalidDocumentError);
      expect(err.path).toBe(path);
    }

    const after = (await getPost(ctx.db, post.id)) as Post;
    expect(after.revision).toBe(post.revision);
    expect(after.title).toBe('Bounded');
    expect(await countRevisions(post.id)).toBe(1);
  });

  it('THE HAZARD ITSELF: an unbounded title is 54000 at the database', async () => {
    /*
     * Not a test of our code — a test of the database's limit, so the bound
     * above is pinned to the reason it exists rather than to a round number.
     * `to_tsvector` cannot produce more than MAXSTRPOS = 1 048 575 bytes of
     * lexemes and positions, and the `search` column concatenates SIX inputs;
     * bounding only `content_text` left the other five able to blow the same
     * limit on the same statement.
     */
    const huge = Array.from({ length: 120_000 }, (_, i) => `t${i}`).join(' ');
    const err = await rejection<{ code?: string }>(
      ctx.db.execute(sql`
        INSERT INTO posts (id, title, subtitle, slug, excerpt, excerpt_source, content,
                           content_text, category, tags, status, created_at, updated_at,
                           word_count, reading_time, author_id, revision)
        VALUES ('p_54000', ${huge}, '', NULL, '', 'derived',
                '{"type":"doc","content":[]}'::jsonb, '', '', '{}'::text[], 'draft',
                ${Date.now()}, ${Date.now()}, 0, 0, ${actor().id}, 1)`),
    );
    expect(err.code).toBe('54000');
    // And the validator refuses it long before the database is asked.
    expect(checkPostMeta({ title: huge })).toEqual({ path: 'title', reason: 'too_large' });
  });

  it('maps a UNIQUE (post_id, revision) violation onto the 409, not a 500', async () => {
    /*
     * Spec §3.5's backstop, and the one the CAS cannot reach on its own: the
     * revision row is inserted by `SELECT … FROM upd`, so a losing CAS inserts
     * nothing. Under real parallelism — which PGlite's single connection cannot
     * simulate (spec §9) — it is the database's last word on two writers
     * reaching the same revision number, and `isSlugCollision` recognised only
     * `posts_slug_unique`, so it fell through to a generic rethrow and a 500.
     *
     * Reached here by planting the revision row the next save is going to want.
     */
    const post = await seeded({ title: 'Backstop', slug: 'backstop' });
    await ctx.db.execute(sql`
      INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                             title, subtitle, content, word_count, kind, note)
      VALUES ('r_planted', ${post.id}, ${post.revision + 1}, ${Date.now()}, ${actor().id},
              'planted', '', '{"type":"doc","content":[]}'::jsonb, 0, 'manual', NULL)`);

    const err = await rejection<StaleWriteError>(
      savePost(ctx.db, post.id, { title: 'Next' }, { actor: actor() }),
    );
    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.expected).toBe(post.revision);
    expect(err.post?.id).toBe(post.id);
  });

  it('records the kind the caller asked for', async () => {
    const post = await seeded({ title: 'Kind', slug: 'kind' });
    await savePost(ctx.db, post.id, { title: 'K2' }, { actor: actor(), kind: 'manual' });
    const rev = await ctx.db.execute(
      sql`SELECT kind FROM revisions WHERE post_id = ${post.id} ORDER BY revision DESC LIMIT 1`,
    );
    expect(rev.rows[0].kind).toBe('manual');
  });
});
