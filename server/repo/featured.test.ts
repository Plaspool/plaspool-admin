/**
 * Curation, against a real Postgres.
 *
 * The four invariants under test are the storefront's, written out in the TODO
 * block above `listFeaturedPosts()` in `packages/blog/src/data/posts.ts`. Two of
 * them (the cap and the rank uniqueness) are held by constraints and are proven
 * in `server/db/schema.test.ts`; this file is about the behaviour the API layer
 * has to show for them — that a refusal names the current four, that a swap is
 * one statement, that unpublishing takes a post off the rail.
 *
 * WHY SO MANY TESTS PIN "AND NOTHING ELSE CHANGED". The rail is read by an
 * anonymous edge cache and written by an admin holding an editor open on the
 * same row. Curation that quietly moved `revision` would 409 that editor's next
 * autosave against a change its writer did not make, and curation that moved
 * `updated_at` would tell every reader the post had been edited when only its
 * position changed. Neither is visible from a test that only asserts the rail.
 */
import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import {
  archivePost,
  createPost,
  publishPost,
  trashPost,
  unpublishPost,
} from './posts';
import { FeaturedConflictError, NotFeaturableError, NotFoundError } from './errors';
import {
  MAX_FEATURED,
  featurePost,
  listFeatured,
  listPublicFeatured,
  reorderFeatured,
  unfeaturePost,
} from './featured';
import type { Post } from '../../shared/types';

let ctx: TestCtx;

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A published, publicly visible post — the only kind that may be featured. */
async function live(title: string): Promise<Post> {
  const post = await createPost(ctx.db, ctx.users.owner, {
    title,
    subtitle: '',
    category: 'Essays',
    content: doc(`${title} has some words in it.`),
  });
  return publishPost(ctx.db, post.id, ctx.users.owner);
}

async function draft(title: string): Promise<Post> {
  return createPost(ctx.db, ctx.users.owner, {
    title,
    subtitle: '',
    category: 'Essays',
    content: doc(`${title} is not published.`),
  });
}

async function rowOf(id: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute(sql`
    SELECT featured, featured_rank, revision, updated_at, lifecycle_generation
      FROM posts WHERE id = ${id}`);
  return res.rows[0];
}

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  // Four ranks exist in the whole table, so this block cannot lean on fresh ids
  // the way a per-post suite would.
  await ctx.db.execute(
    sql`UPDATE posts SET featured = false, featured_rank = NULL WHERE featured`,
  );
});

describe('reading the rail', () => {
  it('is an empty list, not an absence, when nothing is curated', async () => {
    // `[]` and `null` are DIFFERENT ANSWERS to the storefront: `null` means the
    // API has no opinion and the newest-posts fallback stands in, `[]` means
    // asked and answered. Once this ships the endpoint always has an opinion,
    // so an empty rail must reach it as `[]`.
    expect(await listPublicFeatured(ctx.db)).toEqual([]);
    expect(await listFeatured(ctx.db)).toEqual([]);
  });

  it('returns the curated order, not the published order', async () => {
    const oldest = await live('Oldest');
    const newest = await live('Newest');
    await featurePost(ctx.db, newest.id);
    await featurePost(ctx.db, oldest.id);

    // The whole point of curation: `newest` was featured first so it holds rank
    // 1, even though `oldest` would come second under any date sort. A rail
    // that re-sorted by `publishedAt` would look identical to the fallback it
    // replaces.
    const items = await listPublicFeatured(ctx.db);
    expect(items.map((i) => i.title)).toEqual(['Newest', 'Oldest']);
  });

  it('carries the same PublicPost shape the list endpoint returns', async () => {
    const post = await live('Shape');
    await featurePost(ctx.db, post.id);
    const [item] = await listPublicFeatured(ctx.db);

    // The contract says "no extra fields; the rail renders the same PublicPost
    // the grid does" — so `featured` and `featuredRank` must NOT ride along.
    expect(item).not.toHaveProperty('featured');
    expect(item).not.toHaveProperty('featuredRank');
    expect(item).not.toHaveProperty('status');
    expect(item.author).toEqual({ name: 'Owner' });
    expect(item.slug).toBe('shape');
  });
});

describe('invariant 1 — only a publicly visible post can be featured', () => {
  it('refuses a draft', async () => {
    const post = await draft('Unfinished');
    await expect(featurePost(ctx.db, post.id)).rejects.toBeInstanceOf(
      NotFeaturableError,
    );
    expect(await listFeatured(ctx.db)).toEqual([]);
  });

  it('refuses a published post that is in the trash', async () => {
    const post = await live('Binned');
    await trashPost(ctx.db, post.id, ctx.users.owner);

    // TRASH IS A VIEW, NOT A STATUS: this row still reads `status =
    // 'published'`. A guard written as `status = 'published'` would accept it,
    // and it would then hold a slot while being invisible to every reader —
    // which is the exact failure invariant 1 exists to prevent, in a form a
    // narrower guard would not catch.
    await expect(featurePost(ctx.db, post.id)).rejects.toBeInstanceOf(
      NotFeaturableError,
    );
  });

  it('refuses an archived post', async () => {
    const post = await live('Shelved');
    await archivePost(ctx.db, post.id, ctx.users.owner);
    await expect(featurePost(ctx.db, post.id)).rejects.toBeInstanceOf(
      NotFeaturableError,
    );
  });

  it('refuses a published row with no publish date', async () => {
    const post = await live('Imported');
    // What `POST /api/import` can produce: `status` and `published_at` are bound
    // independently, so this row is in the published set with a null date. It
    // fails `PUBLIC_POST_PREDICATE`, so it can never appear on the rail.
    await ctx.db.execute(sql`UPDATE posts SET published_at = NULL WHERE id = ${post.id}`);
    await expect(featurePost(ctx.db, post.id)).rejects.toBeInstanceOf(
      NotFeaturableError,
    );
  });

  it('is a not-found, not a refusal, for an id that does not exist', async () => {
    await expect(featurePost(ctx.db, 'p_nothing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('invariant 2 — at most four', () => {
  async function fillRail(): Promise<Post[]> {
    const posts: Post[] = [];
    for (let i = 1; i <= MAX_FEATURED; i += 1) {
      const post = await live(`Rail ${i}`);
      await featurePost(ctx.db, post.id);
      posts.push(post);
    }
    return posts;
  }

  it('refuses the fifth and NAMES the current four', async () => {
    const rail = await fillRail();
    const fifth = await live('Fifth');

    const err = await featurePost(ctx.db, fifth.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeaturedConflictError);

    // The naming is the requirement, not a nicety: without it the admin can
    // only show a dead error, and the contract asks for "unfeature one of
    // these" instead.
    const conflict = err as FeaturedConflictError;
    expect(conflict.reason).toBe('featured_full');
    expect(conflict.items.map((i) => i.id)).toEqual(rail.map((p) => p.id));
    expect(conflict.items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
  });

  it('leaves the rail untouched when it refuses', async () => {
    const rail = await fillRail();
    await featurePost(ctx.db, (await live('Fifth')).id).catch(() => undefined);
    expect((await listFeatured(ctx.db)).map((i) => i.id)).toEqual(rail.map((p) => p.id));
  });

  it('is idempotent: featuring a post already on the rail changes nothing', async () => {
    const post = await live('Twice');
    await featurePost(ctx.db, post.id);
    const before = await listFeatured(ctx.db);

    // Not a 409. The caller asked for a state the row is already in, and a
    // double-click on the toggle is not a conflict.
    expect(await featurePost(ctx.db, post.id)).toEqual(before);
  });
});

describe('rank assignment', () => {
  it('fills the lowest free rank, not the end', async () => {
    const a = await live('A');
    const b = await live('B');
    const c = await live('C');
    for (const p of [a, b, c]) await featurePost(ctx.db, p.id);
    await unfeaturePost(ctx.db, b.id);

    // Rank 2 is free. `max + 1` would put the newcomer at 4 and leave a
    // permanent hole that only a reorder could close.
    const d = await live('D');
    const items = await featurePost(ctx.db, d.id);
    expect(items.find((i) => i.id === d.id)?.rank).toBe(2);
    expect(items.map((i) => i.title)).toEqual(['A', 'D', 'C']);
  });
});

describe('swapping in place', () => {
  it('installs the newcomer at the rank it took over', async () => {
    const posts = [];
    for (let i = 1; i <= MAX_FEATURED; i += 1) {
      const p = await live(`Slot ${i}`);
      await featurePost(ctx.db, p.id);
      posts.push(p);
    }
    const newcomer = await live('Newcomer');

    const items = await featurePost(ctx.db, newcomer.id, { replace: posts[1].id });

    // POSITION IS PRESERVED, which is what makes this a swap rather than a
    // remove-then-add. The operator pointed at second place; the newcomer lands
    // in second place.
    expect(items.map((i) => i.title)).toEqual([
      'Slot 1',
      'Newcomer',
      'Slot 3',
      'Slot 4',
    ]);
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);

    const victim = await rowOf(posts[1].id);
    expect(victim.featured).toBe(false);
    expect(victim.featured_rank).toBeNull();
  });

  it('refuses to replace a post that is not on the rail', async () => {
    const on = await live('On');
    await featurePost(ctx.db, on.id);
    const off = await live('Off');
    const newcomer = await live('Newcomer');

    // The rail moved under the operator — the post they meant to displace is
    // already gone. Silently falling back to "just feature it" would put five
    // on a full rail, or put the newcomer somewhere nobody chose.
    await expect(
      featurePost(ctx.db, newcomer.id, { replace: off.id }),
    ).rejects.toBeInstanceOf(FeaturedConflictError);
  });
});

describe('unfeaturing', () => {
  it('clears both columns', async () => {
    const post = await live('Out');
    await featurePost(ctx.db, post.id);
    await unfeaturePost(ctx.db, post.id);

    const row = await rowOf(post.id);
    expect(row.featured).toBe(false);
    // Not just the boolean: a rank left behind holds a slot no post appears in.
    expect(row.featured_rank).toBeNull();
  });

  it('is idempotent', async () => {
    const post = await live('Never on');
    expect(await unfeaturePost(ctx.db, post.id)).toEqual([]);
  });

  it('leaves the other ranks alone rather than compacting', async () => {
    const a = await live('A');
    const b = await live('B');
    const c = await live('C');
    for (const p of [a, b, c]) await featurePost(ctx.db, p.id);

    const items = await unfeaturePost(ctx.db, b.id);
    // Gaps are legal and invisible: the rail orders by rank and renders two
    // cards. Compacting would rewrite rows the operator did not touch.
    expect(items.map((i) => i.rank)).toEqual([1, 3]);
  });
});

describe('invariant 3 — leaving the published set leaves the rail', () => {
  it('unpublishing clears featured and its rank', async () => {
    const post = await live('Retired');
    await featurePost(ctx.db, post.id);

    await unpublishPost(ctx.db, post.id, ctx.users.owner);

    // Same statement as the status change, so there is no window in which the
    // post is a draft and still on the rail. Without it the rail silently
    // shrinks to three and nothing in the admin says why.
    const row = await rowOf(post.id);
    expect(row.featured).toBe(false);
    expect(row.featured_rank).toBeNull();
    expect(await listFeatured(ctx.db)).toEqual([]);
  });

  it('trashing clears featured and its rank', async () => {
    const post = await live('Binned');
    await featurePost(ctx.db, post.id);
    await trashPost(ctx.db, post.id, ctx.users.owner);
    expect(await listFeatured(ctx.db)).toEqual([]);
  });

  it('archiving clears featured and its rank', async () => {
    const post = await live('Shelved');
    await featurePost(ctx.db, post.id);
    await archivePost(ctx.db, post.id, ctx.users.owner);
    // An archived post fails the public predicate exactly as an unpublished one
    // does, so it has to leave the rail for the same reason.
    expect(await listFeatured(ctx.db)).toEqual([]);
  });

  it('frees the slot it held, so a replacement fits immediately', async () => {
    const posts = [];
    for (let i = 1; i <= MAX_FEATURED; i += 1) {
      const p = await live(`Slot ${i}`);
      await featurePost(ctx.db, p.id);
      posts.push(p);
    }
    await unpublishPost(ctx.db, posts[0].id, ctx.users.owner);

    // The cap is enforced against what is actually featured. If the unpublish
    // had left the flag set, this would be a 409 on a rail showing three posts.
    const replacement = await live('Replacement');
    const items = await featurePost(ctx.db, replacement.id);
    expect(items.map((i) => i.title)).toContain('Replacement');
  });

  it('does not re-feature a post that is published again', async () => {
    const post = await live('Back');
    await featurePost(ctx.db, post.id);
    await unpublishPost(ctx.db, post.id, ctx.users.owner);
    await publishPost(ctx.db, post.id, ctx.users.owner);

    // Curation is a deliberate act. Restoring it automatically would put a post
    // back in front of every reader because somebody fixed a typo.
    expect(await listFeatured(ctx.db)).toEqual([]);
  });
});

describe('invariant 4 — a reorder rewrites every rank at once', () => {
  async function railOf(n: number): Promise<Post[]> {
    const posts: Post[] = [];
    for (let i = 1; i <= n; i += 1) {
      const p = await live(`R${i}`);
      await featurePost(ctx.db, p.id);
      posts.push(p);
    }
    return posts;
  }

  it('reverses the rail in one statement', async () => {
    const rail = await railOf(4);
    const reversed = [...rail].reverse().map((p) => p.id);

    const items = await reorderFeatured(ctx.db, reversed);

    expect(items.map((i) => i.id)).toEqual(reversed);
    // Contiguous from 1: a reorder is the one operation that gets to normalise
    // away the gaps an unpublish leaves.
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
  });

  it('swaps two adjacent posts, which an immediate unique constraint would refuse', async () => {
    const rail = await railOf(2);
    const items = await reorderFeatured(ctx.db, [rail[1].id, rail[0].id]);
    expect(items.map((i) => i.id)).toEqual([rail[1].id, rail[0].id]);
  });

  it('refuses a list that is not exactly the current rail', async () => {
    const rail = await railOf(3);
    const stranger = await live('Stranger');

    // Three ways the submitted list can be wrong, and all three mean the same
    // thing: the rail moved under the operator between the render and the drop.
    // Applying a partial list would drop posts nobody chose to remove.
    for (const ids of [
      [rail[0].id, rail[1].id], // short
      [rail[0].id, rail[1].id, rail[2].id, stranger.id], // long
      [rail[0].id, rail[1].id, stranger.id], // substituted
    ]) {
      const err = await reorderFeatured(ctx.db, ids).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FeaturedConflictError);
      expect((err as FeaturedConflictError).reason).toBe('featured_stale');
    }
  });

  it('refuses a list that repeats an id', async () => {
    const rail = await railOf(2);
    // Same length as the rail, so a naive length check would wave it through —
    // and it would then leave one of the two posts unranked.
    await expect(
      reorderFeatured(ctx.db, [rail[0].id, rail[0].id]),
    ).rejects.toBeInstanceOf(FeaturedConflictError);
  });

  it('carries the truth on the refusal, so the admin can re-render', async () => {
    const rail = await railOf(2);
    const err = (await reorderFeatured(ctx.db, [rail[0].id]).catch(
      (e: unknown) => e,
    )) as FeaturedConflictError;
    expect(err.items.map((i) => i.id)).toEqual(rail.map((p) => p.id));
  });
});

describe('curation writes nothing else', () => {
  it('does not move revision, updated_at or the lifecycle generation', async () => {
    const post = await live('Untouched');
    const before = await rowOf(post.id);

    await featurePost(ctx.db, post.id);
    const featured = await rowOf(post.id);
    await unfeaturePost(ctx.db, post.id);
    const unfeatured = await rowOf(post.id);

    for (const after of [featured, unfeatured]) {
      // `revision` is the editor's CAS token — moving it 409s the next autosave
      // from an open editor against a change its writer did not make.
      expect(after.revision).toEqual(before.revision);
      // `updated_at` is PUBLIC: it is `PublicPost.updatedAt` and it feeds the
      // detail route's `Last-Modified`. Moving it tells every reader the post
      // was edited when only its position in a rail changed.
      expect(after.updated_at).toEqual(before.updated_at);
      // The generation guards lifecycle CAS. If featuring moved it, a
      // concurrent publish or trash would lose its race for no reason.
      expect(after.lifecycle_generation).toEqual(before.lifecycle_generation);
    }
  });

  it('writes no revision snapshot', async () => {
    const post = await live('No history');
    const count = async () => {
      const res = await ctx.db.execute(
        sql`SELECT count(*)::int AS n FROM revisions WHERE post_id = ${post.id}`,
      );
      return Number(res.rows[0].n);
    };
    const before = await count();
    await featurePost(ctx.db, post.id);
    // Featuring is curation, not authorship. A revision per toggle would bury
    // the writing history under the editorial one.
    expect(await count()).toBe(before);
  });
});
