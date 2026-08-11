/**
 * Lifecycle operations (spec §4.2, §4.3a).
 *
 * Two properties carry this file, and neither is "the status changed".
 *
 * THE PRECONDITION. Every lifecycle CAS carries its precondition in the
 * predicate, and the retry re-checks it on the row it just re-read. Retry
 * answers "the row moved under me"; it must never answer "someone did the
 * opposite thing on purpose". Without that, a queued `unpublish` that lost a
 * race silently reverses a deliberate archive, and a queued `trash` overwrites
 * the trash timestamp of a post someone else had already trashed — which, if
 * the owner then empties the trash, is how a post and its whole history go.
 *
 * ONE STATEMENT. `destroyPost`, `emptyTrash` and `sweepBlankDrafts` are single
 * data-modifying-CTE statements, never `db.transaction`: the neon-http driver
 * throws unconditionally on `transaction()` while PGlite supports it, so a
 * transaction here passes every test and 500s in production (spec §4.3a).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import {
  LIFECYCLE_ATTEMPTS,
  archivePost,
  createPost,
  destroyPost,
  duplicatePost,
  emptyTrash,
  getPost,
  publishPost,
  restorePost,
  savePost,
  sweepBlankDrafts,
  trashPost,
  unarchivePost,
  unpublishPost,
} from './posts';
import { NotFoundError, StaleWriteError } from './errors';
import type { Db } from '../db/client';
import type { DocNode, Post } from '../../shared/types';

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const EMPTY: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] };

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
  return createPost(ctx.db, actor(), { content: doc('body'), ...partial });
}

async function countRevisions(postId: string): Promise<number> {
  const res = await ctx.db.execute(
    sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${postId}`,
  );
  return Number(res.rows[0].n);
}

async function revisionRows(
  postId: string,
): Promise<{ revision: number; kind: string; note: string | null }[]> {
  const res = await ctx.db.execute(
    sql`SELECT revision, kind, note FROM revisions WHERE post_id = ${postId}
         ORDER BY revision ASC`,
  );
  return res.rows.map((r) => ({
    revision: Number(r.revision),
    kind: String(r.kind),
    note: r.note == null ? null : String(r.note),
  }));
}

async function rawPost(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute(sql`SELECT * FROM posts WHERE id = ${id}`);
  return res.rows[0];
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

/**
 * A handle that moves the row out from under every statement issued through it.
 *
 * The bump is applied to the RAW handle, so it does not recurse — and because it
 * runs before each statement rather than after, it lands between an attempt's
 * read and that attempt's CAS. No CAS issued through this handle can ever win,
 * which is the only way to reach the give-up branch deterministically.
 */
function alwaysMoving(db: Db, id: string): { db: Db; statements: () => number } {
  let statements = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop !== 'execute' || typeof value !== 'function') return value;
      const execute = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        statements += 1;
        await execute.apply(target, [
          sql`UPDATE posts SET revision = revision + 1 WHERE id = ${id}`,
        ]);
        return execute.apply(target, args);
      };
    },
  });
  return { db: proxy, statements: () => statements };
}

// ------------------------------------------------------------------- publish

describe('publishPost', () => {
  it('sets status, publishedAt and slug and writes a publish revision', async () => {
    const post = await seeded({ title: 'Hello World' });
    expect(post.slug).toBeNull();

    const published = await publishPost(ctx.db, post.id, actor());

    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();
    expect(published.slug).toBe('hello-world');
    expect(published.revision).toBe(post.revision + 1);

    const revs = await revisionRows(post.id);
    expect(revs).toHaveLength(2);
    expect(revs[1]).toMatchObject({ revision: published.revision, kind: 'publish' });
  });

  it('preserves an existing publishedAt on republish, and clears deletedAt', async () => {
    const post = await seeded({ title: 'Twice' });
    const first = await publishPost(ctx.db, post.id, actor());
    const originally = first.publishedAt;
    expect(originally).not.toBeNull();

    await unpublishPost(ctx.db, post.id, actor());
    await trashPost(ctx.db, post.id, actor());
    expect((await getPost(ctx.db, post.id))?.deletedAt).not.toBeNull();

    const again = await publishPost(ctx.db, post.id, actor());
    expect(again.publishedAt).toBe(originally);
    expect(again.deletedAt).toBeNull();
    expect(again.slug).toBe('twice');
  });

  it('slugs an untitled post rather than leaving it unaddressable', async () => {
    const post = await seeded();
    const published = await publishPost(ctx.db, post.id, actor());
    expect(published.slug).toBe('untitled');
  });

  it('derives the excerpt on publish but leaves an author-written one alone', async () => {
    const derived = await seeded({ title: 'D', content: doc('the opening line') });
    expect((await publishPost(ctx.db, derived.id, actor())).excerpt).toBe(
      'the opening line',
    );

    const authored = await seeded({ title: 'A', content: doc('the opening line') });
    await savePost(ctx.db, authored.id, { excerpt: 'By hand' }, { actor: actor() });
    const published = await publishPost(ctx.db, authored.id, actor());
    expect(published).toMatchObject({ excerpt: 'By hand', excerptSource: 'author' });
  });
});

// -------------------------------------------------------------- preconditions

describe('preconditions (spec §4.2)', () => {
  /**
   * A lifecycle op whose precondition is already false is refused outright. It
   * is the same answer the retry gives, arrived at one statement earlier: the
   * post is already in the state being asked for, so applying the op again
   * would bump the revision, write a duplicate history entry and — for trash —
   * overwrite the timestamp of whoever actually put it there.
   */
  const cases: [string, (p: Post) => Promise<unknown>, Partial<Post>][] = [
    ['publish an already published post', (p) => publishPost(ctx.db, p.id, actor()), { status: 'published', publishedAt: 5 }],
    ['unpublish a draft', (p) => unpublishPost(ctx.db, p.id, actor()), { status: 'draft' }],
    ['archive an archived post', (p) => archivePost(ctx.db, p.id, actor()), { status: 'archived' }],
    ['unarchive a draft', (p) => unarchivePost(ctx.db, p.id, actor()), { status: 'draft' }],
    ['trash a post already in the trash', (p) => trashPost(ctx.db, p.id, actor()), { deletedAt: 111 }],
    ['restore a post that is not in the trash', (p) => restorePost(ctx.db, p.id, actor()), { deletedAt: null }],
  ];

  it.each(cases)('refuses to %s with a 409, changing nothing', async (_name, run, state) => {
    const post = await seeded({ title: 'Precondition', ...state });
    const before = await rawPost(post.id);

    const err = await rejection<StaleWriteError>(run(post) as Promise<unknown>);

    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.post?.id).toBe(post.id);
    expect(await rawPost(post.id)).toEqual(before);
    expect(await countRevisions(post.id)).toBe(1);
  });

  it.each([
    ['publish', publishPost],
    ['unpublish', unpublishPost],
    ['archive', archivePost],
    ['unarchive', unarchivePost],
    ['trash', trashPost],
    ['restore', restorePost],
    ['duplicate', duplicatePost],
  ] as const)('%s is a NotFoundError for a post that does not exist', async (_n, op) => {
    await expect(op(ctx.db, 'p_missing', actor())).rejects.toBeInstanceOf(NotFoundError);
  });
});

// --------------------------------------------------------------------- races

describe('losing the CAS', () => {
  it('retries and derives from the FINAL row, not the one it first read', async () => {
    /*
     * Deterministic, not luck: PGlite is a single connection with a FIFO queue,
     * so the raw UPDATE queued on the line below lands between publish's first
     * read and its first CAS. The CAS loses, publish re-reads, and the slug it
     * assigns must come from the title that is actually stored.
     *
     * GAUNTLET Round 1 #6, re-expressed for CAS: derived fields computed from a
     * stale read are how a publish quietly reverted an autosave.
     */
    const post = await seeded({ title: 'Original Title' });

    const publishing = publishPost(ctx.db, post.id, actor());
    await ctx.db.execute(
      sql`UPDATE posts SET title = 'Final Title', revision = revision + 1
           WHERE id = ${post.id}`,
    );
    const published = await publishing;

    expect(published.title).toBe('Final Title');
    expect(published.slug).toBe('final-title');
    expect(published.revision).toBe(3);
    // One revision for the create, one for the publish — not one per attempt.
    expect(await countRevisions(post.id)).toBe(2);
  });

  it('a trash that loses to a concurrent trash returns 409 and does NOT re-trash', async () => {
    /*
     * THE precondition test. A blind retry here bumps the revision, writes a
     * second "Moved to trash" entry and replaces the other writer's deletedAt
     * with its own — rewriting when the post entered the trash, which is the
     * clock any retention sweep or "recently deleted" view reads.
     */
    const post = await seeded({ title: 'Doomed' });

    const trashing = trashPost(ctx.db, post.id, actor());
    await ctx.db.execute(
      sql`UPDATE posts SET deleted_at = 111, revision = revision + 1
           WHERE id = ${post.id}`,
    );
    const err = await rejection<StaleWriteError>(trashing);

    expect(err).toBeInstanceOf(StaleWriteError);
    const row = await rawPost(post.id);
    expect(Number(row.deleted_at)).toBe(111);
    expect(Number(row.revision)).toBe(2);
    expect(await countRevisions(post.id)).toBe(1);
  });

  it('an unpublish that loses to a concurrent archive returns 409, not a reversal', async () => {
    /*
     * The genuine inverse pair. `unpublish`'s precondition is
     * `status = 'published'`, and an archive falsifies it — so a retry that did
     * not re-check would flip a post someone deliberately archived back to
     * draft, and the archive would simply vanish with no trace but a revision
     * number.
     */
    const post = await seeded({ title: 'Live', status: 'published', publishedAt: 5 });

    const unpublishing = unpublishPost(ctx.db, post.id, actor());
    await ctx.db.execute(
      sql`UPDATE posts SET status = 'archived', revision = revision + 1
           WHERE id = ${post.id}`,
    );
    const err = await rejection<StaleWriteError>(unpublishing);

    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.post?.status).toBe('archived');
    expect((await getPost(ctx.db, post.id))?.status).toBe('archived');
    expect(await countRevisions(post.id)).toBe(1);
  });

  it(`gives up after ${LIFECYCLE_ATTEMPTS} attempts with StaleWriteError`, async () => {
    const post = await seeded({ title: 'Unwinnable' });
    const moving = alwaysMoving(ctx.db, post.id);

    const err = await rejection<StaleWriteError>(trashPost(moving.db, post.id, actor()));

    expect(err).toBeInstanceOf(StaleWriteError);
    expect(err.actual).toBeGreaterThan(err.expected);
    // Bounded: an unbounded retry against a row that never settles is a hung
    // request, not a resilient one.
    expect(moving.statements()).toBeLessThanOrEqual(4 * LIFECYCLE_ATTEMPTS);
    // And it wrote nothing at all.
    expect((await rawPost(post.id)).deleted_at).toBeNull();
    expect(await countRevisions(post.id)).toBe(1);
  });
});

// ------------------------------------------------------------------- history

describe('history', () => {
  it('every lifecycle change leaves a revision with no numbering gap', async () => {
    const post = await seeded({ title: 'Journey' });
    await publishPost(ctx.db, post.id, actor());
    await unpublishPost(ctx.db, post.id, actor());
    await archivePost(ctx.db, post.id, actor());
    await unarchivePost(ctx.db, post.id, actor());
    await trashPost(ctx.db, post.id, actor());
    const final = await restorePost(ctx.db, post.id, actor());

    expect(final.revision).toBe(7);
    const revs = await revisionRows(post.id);
    expect(revs.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(revs.map((r) => r.kind)).toEqual([
      'manual',
      'publish',
      'status',
      'status',
      'status',
      'status',
      'status',
    ]);
    expect(revs.slice(2).map((r) => r.note)).toEqual([
      'Moved back to drafts',
      'Archived',
      'Restored from archive',
      'Moved to trash',
      'Restored from trash',
    ]);
  });

  it('records the actor on the revision but never rewrites the byline', async () => {
    // A second writer acting on someone else's post must not rename its author.
    const post = await seeded({ title: 'Byline' });
    const published = await publishPost(ctx.db, post.id, ctx.users.writer);

    expect(published.authorId).toBe(actor().id);
    expect(published.authorName).toBe(actor().displayName);
    const res = await ctx.db.execute(
      sql`SELECT author_id FROM revisions WHERE post_id = ${post.id}
           ORDER BY revision DESC LIMIT 1`,
    );
    expect(res.rows[0].author_id).toBe(ctx.users.writer.id);
  });

  it('trash is soft: the row and all revisions survive', async () => {
    const post = await seeded({ title: 'Soft' });
    await savePost(ctx.db, post.id, { title: 'Soft 2' }, { actor: actor() });
    const trashed = await trashPost(ctx.db, post.id, actor());

    expect(trashed.deletedAt).not.toBeNull();
    expect(trashed.status).toBe('draft');
    expect(await getPost(ctx.db, post.id)).not.toBeNull();
    expect(await countRevisions(post.id)).toBe(3);
  });

  it('never returns content_text or the search vector', async () => {
    const post = await seeded({ title: 'Leak' });
    const published = await publishPost(ctx.db, post.id, actor());
    const trashed = await trashPost(ctx.db, post.id, actor());
    for (const shape of [published, trashed]) {
      expect(Object.keys(shape)).not.toContain('contentText');
      expect(Object.keys(shape)).not.toContain('content_text');
      expect(Object.keys(shape)).not.toContain('search');
    }
  });
});

// -------------------------------------------------------- destroy / emptyTrash

describe('destroyPost', () => {
  it('removes the post and cascades to its revisions', async () => {
    const post = await seeded({ title: 'Gone' });
    await savePost(ctx.db, post.id, { title: 'Gone 2' }, { actor: actor() });
    expect(await countRevisions(post.id)).toBe(2);

    await destroyPost(ctx.db, post.id);

    expect(await getPost(ctx.db, post.id)).toBeNull();
    expect(await countRevisions(post.id)).toBe(0);
  });

  it('leaves every other post alone and is idempotent', async () => {
    const doomed = await seeded({ title: 'Doomed' });
    const spared = await seeded({ title: 'Spared' });

    await destroyPost(ctx.db, doomed.id);
    await destroyPost(ctx.db, doomed.id);

    expect(await getPost(ctx.db, spared.id)).not.toBeNull();
    expect(await countRevisions(spared.id)).toBe(1);
  });
});

describe('emptyTrash', () => {
  it('removes every trashed post with its revisions and returns the count', async () => {
    const trashed: Post[] = [];
    for (const title of ['a', 'b', 'c']) {
      const p = await seeded({ title });
      await trashPost(ctx.db, p.id, actor());
      trashed.push(p);
    }
    const kept = await seeded({ title: 'kept' });

    expect(await emptyTrash(ctx.db)).toBe(3);

    for (const p of trashed) {
      expect(await getPost(ctx.db, p.id)).toBeNull();
      expect(await countRevisions(p.id)).toBe(0);
    }
    expect(await getPost(ctx.db, kept.id)).not.toBeNull();
    expect(await countRevisions(kept.id)).toBe(1);
  });

  it('returns 0 and touches nothing when the trash is empty', async () => {
    const kept = await seeded({ title: 'kept' });
    expect(await emptyTrash(ctx.db)).toBe(0);
    expect(await getPost(ctx.db, kept.id)).not.toBeNull();
  });
});

// ----------------------------------------------------------------- duplicate

describe('duplicatePost', () => {
  it('copies content and metadata into a fresh unpublished draft', async () => {
    const src = await seeded({
      title: 'Original',
      subtitle: 'sub',
      category: 'essays',
      tags: ['one', 'two'],
      template: 'editorial',
      content: doc('the body'),
      status: 'published',
      publishedAt: 999,
    });
    await trashPost(ctx.db, src.id, actor());

    const copy = await duplicatePost(ctx.db, src.id, ctx.users.writer);

    expect(copy.id).not.toBe(src.id);
    expect(copy.title).toBe('Original (copy)');
    expect(copy.subtitle).toBe('sub');
    expect(copy.category).toBe('essays');
    expect(copy.tags).toEqual(['one', 'two']);
    expect(copy.template).toBe('editorial');
    expect(copy.content).toEqual(doc('the body'));
    expect(copy.status).toBe('draft');
    expect(copy.publishedAt).toBeNull();
    expect(copy.deletedAt).toBeNull();
    expect(copy.revision).toBe(1);
    // A copy is unaddressable until it is titled or published — two posts
    // cannot hold one slug.
    expect(copy.slug).toBeNull();
    // Authored by whoever duplicated it, not by the original's author.
    expect(copy.authorId).toBe(ctx.users.writer.id);
    expect(await countRevisions(copy.id)).toBe(1);
    // And the original is untouched.
    expect((await getPost(ctx.db, src.id))?.title).toBe('Original');
  });

  it('leaves an untitled original untitled rather than naming it "(copy)"', async () => {
    const src = await seeded();
    const copy = await duplicatePost(ctx.db, src.id, actor());
    expect(copy.title).toBe('');
  });
});

// ----------------------------------------------------------- sweepBlankDrafts

describe('sweepBlankDrafts', () => {
  const AGES_AGO = () => Date.now() - 120_000;

  it('destroys a blank draft that is past the grace window', async () => {
    const blank = await seeded({ content: EMPTY, updatedAt: AGES_AGO() });
    expect(await sweepBlankDrafts(ctx.db)).toBe(1);
    expect(await getPost(ctx.db, blank.id)).toBeNull();
    expect(await countRevisions(blank.id)).toBe(0);
  });

  it('never sweeps a draft inside the grace window, or the one being edited', async () => {
    // The age guard is what stops a draft someone is staring at in another tab
    // being pulled out from under them.
    const recent = await seeded({ content: EMPTY });
    const editing = await seeded({ content: EMPTY, updatedAt: AGES_AGO() });

    expect(await sweepBlankDrafts(ctx.db, editing.id)).toBe(0);

    expect(await getPost(ctx.db, recent.id)).not.toBeNull();
    expect(await getPost(ctx.db, editing.id)).not.toBeNull();
  });

  it('an image-only or divider-only draft has no words but is NOT blank', async () => {
    /*
     * `wordCount === 0` is not emptiness. This is the frontend gauntlet's
     * sharpest finding: an image-only draft was destroyed — with its image
     * bytes — the instant the writer left the editor. The document walk is an
     * allow-list of {doc, paragraph, text}, so an unrecognised node counts as
     * content, which is the safe direction to fail.
     */
    const image = await seeded({
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'asset:img_abc123' } }] },
      updatedAt: AGES_AGO(),
    });
    const rule = await seeded({
      content: { type: 'doc', content: [{ type: 'horizontalRule' }] },
      updatedAt: AGES_AGO(),
    });
    const whitespace = await seeded({
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] },
      updatedAt: AGES_AGO(),
    });

    expect(await sweepBlankDrafts(ctx.db)).toBe(1);

    expect(await getPost(ctx.db, image.id)).not.toBeNull();
    expect(await getPost(ctx.db, rule.id)).not.toBeNull();
    expect(await getPost(ctx.db, whitespace.id)).toBeNull();
  });

  it.each([
    ['a title', { title: 'Titled' }],
    ['a subtitle', { subtitle: 'Sub' }],
    ['a category', { category: 'essays' }],
    ['tags', { tags: ['keep'] }],
    ['a cover image', { coverImage: { blobId: 'img_1', alt: '', focalPoint: '50% 50%', width: 1, height: 1 } }],
    ['a published status', { status: 'published' as const, publishedAt: 1 }],
    ['an archived status', { status: 'archived' as const }],
    ['a trash flag', { deletedAt: 111 }],
  ])('never sweeps a draft that has %s', async (_name, partial) => {
    const post = await seeded({ content: EMPTY, updatedAt: AGES_AGO(), ...partial });
    expect(await sweepBlankDrafts(ctx.db)).toBe(0);
    expect(await getPost(ctx.db, post.id)).not.toBeNull();
  });

  it('sweeps every eligible draft in one statement and returns the count', async () => {
    for (let i = 0; i < 3; i += 1) await seeded({ content: EMPTY, updatedAt: AGES_AGO() });
    const kept = await seeded({ title: 'Kept', content: EMPTY, updatedAt: AGES_AGO() });

    expect(await sweepBlankDrafts(ctx.db)).toBe(3);

    const res = await ctx.db.execute(sql`SELECT count(*)::int AS n FROM posts`);
    expect(Number(res.rows[0].n)).toBe(1);
    expect(await getPost(ctx.db, kept.id)).not.toBeNull();
  });
});
