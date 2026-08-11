/**
 * Revision history: list, get, restore-forward, prune (spec §5.3).
 *
 * Three properties, each of which is a way history gets destroyed if it is
 * wrong:
 *
 * - **A list never carries document bodies.** The panel renders from titles and
 *   word counts; shipping every snapshot to draw a sidebar is the same mistake
 *   as shipping every document to draw a dashboard, except history is
 *   unbounded.
 * - **Restore writes a NEW revision and never rewinds the pointer.** The
 *   version you were on before the restore must still be in the list, or
 *   "restore" is a destructive operation wearing an undo's clothes.
 * - **Prune orders by `revision`, never `created_at`.** `created_at` is
 *   epoch-milliseconds written from a single `now` per statement, so
 *   same-millisecond autosaves tie and the kept set is nondeterministic — an
 *   older revision survives while a newer one is deleted. `revision` is UNIQUE
 *   per post by the schema's own constraint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { createPost, getPost, savePost, publishPost, trashPost } from './posts';
import {
  AUTOSAVE_KEEP,
  getRevision,
  listRevisions,
  pruneAutosaves,
  restoreRevision,
} from './revisions';
import { MAX_PAGE_LIMIT, decodeCursor, encodeCursor } from './cursor';
import { BadRequestError, NotFoundError } from './errors';
import type { DocNode, Post, RevisionMeta } from '../../shared/types';

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

function seeded(partial: Partial<Post> = {}): Promise<Post> {
  return createPost(ctx.db, actor(), { title: 'Post', content: doc('body'), ...partial });
}

/**
 * Revision rows written straight to the table.
 *
 * Forty round trips through `savePost` would cost forty statements to set up a
 * property about the forty-first, and `created_at` is a parameter of the test —
 * the same-millisecond case is the one that matters and cannot be produced by
 * waiting.
 */
async function seedRevisions(
  postId: string,
  entries: { revision: number; kind: string; createdAt: number; note?: string }[],
): Promise<void> {
  for (const e of entries) {
    await ctx.db.execute(sql`
      INSERT INTO revisions (id, post_id, revision, created_at, author_id,
                             title, subtitle, content, word_count, kind, note)
      VALUES (${`r_seed_${e.revision}`}, ${postId}, ${e.revision}, ${e.createdAt},
              ${actor().id}, ${`title ${e.revision}`}, '',
              '{"type":"doc","content":[]}'::jsonb, 0, ${e.kind}, ${e.note ?? null})`);
  }
  const max = Math.max(...entries.map((e) => e.revision));
  await ctx.db.execute(sql`UPDATE posts SET revision = ${max} WHERE id = ${postId}`);
}

async function storedRevisionNumbers(postId: string): Promise<number[]> {
  const res = await ctx.db.execute(
    sql`SELECT revision FROM revisions WHERE post_id = ${postId} ORDER BY revision ASC`,
  );
  return res.rows.map((r) => Number(r.revision));
}

// ---------------------------------------------------------------------- list

describe('listRevisions', () => {
  it('returns metadata without document bodies', async () => {
    const post = await seeded();
    await savePost(ctx.db, post.id, { title: 'Second' }, { actor: actor() });

    const { items } = await listRevisions(ctx.db, post.id);

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('content');
      expect(item.postId).toBe(post.id);
      expect(item.authorId).toBe(actor().id);
    }
    // Newest first, so the panel renders in the order it displays.
    expect(items.map((i) => i.revision)).toEqual([2, 1]);
    expect(items[0]).toMatchObject({ kind: 'autosave', title: 'Second' });
    expect(items[1]).toMatchObject({ kind: 'manual', title: 'Post' });
  });

  it('carries the note a status change left', async () => {
    const post = await seeded();
    await trashPost(ctx.db, post.id, actor());
    const { items } = await listRevisions(ctx.db, post.id);
    expect(items[0]).toMatchObject({ kind: 'status', note: 'Moved to trash' });
  });

  it('scopes to one post', async () => {
    const mine = await seeded({ title: 'Mine' });
    const theirs = await seeded({ title: 'Theirs' });
    await savePost(ctx.db, theirs.id, { title: 'Theirs 2' }, { actor: actor() });

    const { items } = await listRevisions(ctx.db, mine.id);
    expect(items).toHaveLength(1);
    expect(items[0].postId).toBe(mine.id);
  });

  it('walks the whole history exactly once across pages', async () => {
    const post = await seeded();
    await seedRevisions(
      post.id,
      Array.from({ length: 25 }, (_, i) => ({
        revision: i + 2,
        kind: 'autosave',
        createdAt: 1000,
      })),
    );

    const seen: RevisionMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const res = await listRevisions(ctx.db, post.id, cursor, 7);
      expect(res.items.length).toBeLessThanOrEqual(7);
      seen.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }

    const numbers = seen.map((r) => r.revision);
    expect(numbers).toHaveLength(26);
    expect(new Set(numbers).size).toBe(26);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
  });

  it('returns an empty page rather than failing for a post with no history', async () => {
    const res = await listRevisions(ctx.db, 'p_missing');
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });

  it(`rejects a limit above ${MAX_PAGE_LIMIT}, and any limit that is not a positive integer`, async () => {
    const post = await seeded();
    for (const limit of [MAX_PAGE_LIMIT + 1, 0, -1, 2.5, Number.NaN]) {
      await expect(
        listRevisions(ctx.db, post.id, undefined, limit),
        String(limit),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
    await expect(listRevisions(ctx.db, post.id, undefined, MAX_PAGE_LIMIT)).resolves
      .toBeDefined();
  });

  it('an undecodable cursor is a decode failure, not a crash', async () => {
    const post = await seeded();
    for (const cursor of ['', 'not-base64!!', btoa('{'), btoa('{"a":1}'), btoa('[[1],2]')]) {
      expect(decodeCursor(cursor), cursor).toBeNull();
      await expect(
        listRevisions(ctx.db, post.id, cursor),
        cursor,
      ).rejects.toBeInstanceOf(BadRequestError);
    }
  });

  it('round-trips a cursor through the codec', () => {
    const encoded = encodeCursor([12, 'b', null], 'r_1');
    expect(decodeCursor(encoded)).toEqual({ sortValues: [12, 'b', null], id: 'r_1' });
  });
});

// ----------------------------------------------------------------------- get

describe('getRevision', () => {
  it('returns the full snapshot, document and all', async () => {
    const post = await seeded({ content: doc('the original body') });
    const { items } = await listRevisions(ctx.db, post.id);

    const full = await getRevision(ctx.db, items[0].id);

    expect(full?.content).toEqual(doc('the original body'));
    expect(full).toMatchObject({
      postId: post.id,
      revision: 1,
      kind: 'manual',
      title: 'Post',
      authorId: actor().id,
    });
  });

  it('is null for an unknown id rather than throwing', async () => {
    expect(await getRevision(ctx.db, 'r_nope')).toBeNull();
  });
});

// ------------------------------------------------------------------- restore

describe('restoreRevision', () => {
  it('writes a NEW revision and leaves the pre-restore version in the list', async () => {
    const post = await seeded({ content: doc('first draft') });
    await savePost(
      ctx.db,
      post.id,
      { title: 'Rewritten', content: doc('second draft') },
      { actor: actor() },
    );
    const before = await listRevisions(ctx.db, post.id);
    const original = before.items.find((r) => r.revision === 1) as RevisionMeta;

    const restored = await restoreRevision(ctx.db, post.id, original.id, actor());

    // Forward, never backward: the pointer moved on.
    expect(restored.revision).toBe(3);
    expect(restored.title).toBe('Post');
    expect(restored.content).toEqual(doc('first draft'));

    const after = await listRevisions(ctx.db, post.id);
    expect(after.items.map((r) => r.revision)).toEqual([3, 2, 1]);
    // The version we were on before the restore is still there — that is the
    // whole point of restore-forward.
    expect(after.items.find((r) => r.revision === 2)?.title).toBe('Rewritten');
  });

  it('checkpoints the restore as manual with a note naming the revision', async () => {
    // 'manual' and not 'autosave': a restore is a deliberate checkpoint and
    // pruning must never reclaim it.
    const post = await seeded();
    await savePost(ctx.db, post.id, { title: 'Second' }, { actor: actor() });
    const { items } = await listRevisions(ctx.db, post.id);
    const original = items.find((r) => r.revision === 1) as RevisionMeta;

    await restoreRevision(ctx.db, post.id, original.id, ctx.users.writer);

    const after = await listRevisions(ctx.db, post.id);
    expect(after.items[0]).toMatchObject({
      revision: 3,
      kind: 'manual',
      note: 'Restored revision 1',
      authorId: ctx.users.writer.id,
    });
  });

  it('restoring a revision belonging to another post is a NotFoundError', async () => {
    const mine = await seeded({ title: 'Mine' });
    const theirs = await seeded({ title: 'Theirs' });
    const { items } = await listRevisions(ctx.db, theirs.id);

    await expect(
      restoreRevision(ctx.db, mine.id, items[0].id, actor()),
    ).rejects.toBeInstanceOf(NotFoundError);

    // And nothing was written to either post.
    expect((await getPost(ctx.db, mine.id))?.revision).toBe(1);
    expect(await storedRevisionNumbers(mine.id)).toEqual([1]);
  });

  it('is a NotFoundError for a revision id that does not exist', async () => {
    const post = await seeded();
    await expect(
      restoreRevision(ctx.db, post.id, 'r_nope', actor()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('re-derives word count and excerpt from the restored document', async () => {
    // The snapshot stores a word count, but the server owns derivation
    // (spec §4.4) — a restored post must not inherit a stale number.
    const post = await seeded({ content: doc('one two three four five') });
    await savePost(ctx.db, post.id, { content: doc('short') }, { actor: actor() });
    const { items } = await listRevisions(ctx.db, post.id);
    const original = items.find((r) => r.revision === 1) as RevisionMeta;

    const restored = await restoreRevision(ctx.db, post.id, original.id, actor());

    expect(restored.wordCount).toBe(5);
    expect(restored.excerpt).toBe('one two three four five');
  });
});

// --------------------------------------------------------------------- prune

describe('pruneAutosaves', () => {
  it(`keeps the newest ${AUTOSAVE_KEEP} autosaves and every manual, publish and status entry`, async () => {
    const post = await seeded();
    await seedRevisions(post.id, [
      ...Array.from({ length: 40 }, (_, i) => ({
        revision: i + 2,
        kind: 'autosave',
        createdAt: 1000 + i,
      })),
      { revision: 42, kind: 'manual', createdAt: 2000 },
      { revision: 43, kind: 'publish', createdAt: 2001 },
      { revision: 44, kind: 'status', createdAt: 2002, note: 'Archived' },
    ]);

    const removed = await pruneAutosaves(ctx.db, post.id);

    // 41 autosaves exist (revision 1 from createPost is 'manual'), 30 survive.
    expect(removed).toBe(40 - AUTOSAVE_KEEP);
    const kept = await storedRevisionNumbers(post.id);
    // Every non-autosave, untouched.
    for (const keeper of [1, 42, 43, 44]) expect(kept).toContain(keeper);
    // And exactly the newest 30 autosaves.
    const autosaves = kept.filter((r) => r >= 2 && r <= 41);
    expect(autosaves).toEqual(
      Array.from({ length: AUTOSAVE_KEEP }, (_, i) => 41 - AUTOSAVE_KEEP + 1 + i),
    );
  });

  it('never deletes the revision the post currently points at', async () => {
    const post = await seeded();
    await seedRevisions(
      post.id,
      Array.from({ length: 40 }, (_, i) => ({
        revision: i + 2,
        kind: 'autosave',
        createdAt: 1000 + i,
      })),
    );
    // The pointer parked on an old autosave — reachable through a restore that
    // rewound, or through a repair. Deleting the row the post names would make
    // its own history unreadable.
    await ctx.db.execute(sql`UPDATE posts SET revision = 5 WHERE id = ${post.id}`);

    await pruneAutosaves(ctx.db, post.id);

    expect(await storedRevisionNumbers(post.id)).toContain(5);
  });

  it('is deterministic when every autosave shares a millisecond', async () => {
    /*
     * THE REASON THE ORDER IS `revision DESC`. `created_at` comes from a single
     * `now` per statement, so a burst of autosaves ties — and `ORDER BY
     * created_at DESC LIMIT 30` over 40 tied rows is a nondeterministic set,
     * which means an older revision survives while a newer one is deleted.
     */
    const post = await seeded();
    await seedRevisions(
      post.id,
      Array.from({ length: 40 }, (_, i) => ({
        revision: i + 2,
        kind: 'autosave',
        createdAt: 1000,
      })),
    );

    const removed = await pruneAutosaves(ctx.db, post.id);

    expect(removed).toBe(40 - AUTOSAVE_KEEP);
    const kept = await storedRevisionNumbers(post.id);
    expect(kept).toEqual([1, ...Array.from({ length: AUTOSAVE_KEEP }, (_, i) => 12 + i)]);
  });

  it('does nothing when history is already under the cap', async () => {
    const post = await seeded();
    await savePost(ctx.db, post.id, { title: 'Second' }, { actor: actor() });
    expect(await pruneAutosaves(ctx.db, post.id)).toBe(0);
    expect(await storedRevisionNumbers(post.id)).toEqual([1, 2]);
  });

  it('leaves other posts alone', async () => {
    const mine = await seeded({ title: 'Mine' });
    const theirs = await seeded({ title: 'Theirs' });
    await seedRevisions(
      theirs.id,
      Array.from({ length: 40 }, (_, i) => ({
        revision: i + 2,
        kind: 'autosave',
        createdAt: 1000,
      })),
    );

    expect(await pruneAutosaves(ctx.db, mine.id)).toBe(0);
    expect(await storedRevisionNumbers(theirs.id)).toHaveLength(41);
  });

  it('a publish checkpoint survives a prune, so history keeps its landmarks', async () => {
    const post = await seeded();
    const published = await publishPost(ctx.db, post.id, actor());
    await seedRevisions(
      post.id,
      Array.from({ length: 40 }, (_, i) => ({
        revision: i + 3,
        kind: 'autosave',
        createdAt: 1000,
      })),
    );

    await pruneAutosaves(ctx.db, post.id);

    expect(await storedRevisionNumbers(post.id)).toContain(published.revision);
  });
});
