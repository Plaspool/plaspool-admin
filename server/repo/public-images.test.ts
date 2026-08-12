/**
 * The public image reference matrix (plan Part 3, D5, threat T5).
 *
 * WHAT THIS SUITE IS FOR: proving that an image reachable ONLY from something
 * unpublished — a draft, an archived post, a trashed post, or a revision of a
 * published one — is not served, and that an image reachable from a live post is.
 *
 * The mutation test at the bottom is the point, for the reason `public.test.ts`
 * states: the project's ledger records a round where every CAS guard could be
 * replaced with `true` and 254 tests stayed green. So the draft case is asserted
 * twice — once that the SAME fragment, given `true` for its scope, DOES find the
 * draft's image (so the corpus really exercises the scope), and once that the
 * real function does not. Delete `PUBLIC_POST_PREDICATE` from
 * `publicImageRefExists` and the second half goes red by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { archivePost, createPost, trashPost } from './posts';
import { getPublicImage, isPubliclyReferencedImage, publicImageRefExists } from './public-images';
import type { AuthUser, CoverImage, DocNode, Post } from '../../shared/types';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM revisions`);
  await ctx.db.execute(sql`DELETE FROM images`);
  await ctx.db.execute(sql`DELETE FROM posts`);
});

const owner = (): AuthUser => ctx.users.owner;

/** A committed image row, placed directly so the test controls every column. */
async function seedImage(id: string, committed = true): Promise<void> {
  const user = owner();
  const now = Date.now();
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    VALUES (${id}, ${user.id}::uuid, ${`images/${user.id}/${id}`},
            'image/png', NULL, NULL, 1000, NULL, ${now},
            ${committed ? now : null}, NULL)`);
}

/** A document carrying an inline `asset:` reference, at a chosen depth. */
function docWithImage(imageId: string, depth = 1): DocNode {
  let node: DocNode = { type: 'image', attrs: { src: `asset:${imageId}` } } as DocNode;
  for (let i = 0; i < depth - 1; i += 1) {
    node = { type: 'blockquote', content: [node] } as DocNode;
  }
  return { type: 'doc', content: [node] };
}

const PLAIN: DocNode = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nothing to see' }] }],
};

const cover = (blobId: string): CoverImage =>
  ({ blobId, alt: 'a cover', focalPoint: '50% 50%', width: 10, height: 10 }) as CoverImage;

/** Published means all four conjuncts, not just `status` (see `public.ts`). */
function published(partial: Partial<Post>): Promise<Post> {
  return createPost(ctx.db, owner(), {
    title: 'Live',
    slug: `live-${Math.random().toString(36).slice(2, 10)}`,
    status: 'published',
    publishedAt: 2000,
    content: PLAIN,
    ...partial,
  });
}

/**
 * A revision holding the OLD document, written directly.
 *
 * Direct SQL because the question is about the revisions TABLE, not about how a
 * row got into it: whatever writes history, history must not make an image
 * public.
 */
async function seedRevision(postId: string, content: DocNode): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO revisions (id, post_id, revision, created_at, author_id, title,
                           subtitle, content, word_count, kind)
    VALUES (${`r_${postId}`}, ${postId}, 99, ${Date.now()}, ${owner().id}::uuid,
            'Live', '', ${JSON.stringify(content)}::jsonb, 3, 'manual')`);
}

/** Raw SQL, because `validateDoc` is exactly the door a malformed row bypasses. */
async function setContent(postId: string, content: unknown): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE posts SET content = ${JSON.stringify(content)}::jsonb WHERE id = ${postId}`);
}

const IMG = 'img_target';

describe('isPubliclyReferencedImage', () => {
  it('is true for an image in a published post’s inline content', async () => {
    await seedImage(IMG);
    await published({ content: docWithImage(IMG) });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
  });

  it('is true for a published post’s cover with a BARE blobId', async () => {
    await seedImage(IMG);
    await published({ coverImage: cover(IMG) });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
  });

  it('is true for a published post’s cover with an asset:-PREFIXED blobId', async () => {
    await seedImage(IMG);
    await published({ coverImage: cover(`asset:${IMG}`) });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
  });

  it('is false for an image referenced only by a DRAFT', async () => {
    await seedImage(IMG);
    await createPost(ctx.db, owner(), {
      title: 'Draft',
      slug: 'draft-one',
      content: docWithImage(IMG),
    });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
  });

  it('is false for an image referenced only by an ARCHIVED post', async () => {
    await seedImage(IMG);
    const post = await published({ content: docWithImage(IMG) });
    await archivePost(ctx.db, post.id, owner());
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
  });

  it('is false for an image referenced only by a TRASHED-but-published post', async () => {
    await seedImage(IMG);
    const post = await published({ content: docWithImage(IMG) });
    const trashed = await trashPost(ctx.db, post.id, owner());
    // Trash is a view, not a status — the row is still `status = 'published'`,
    // so only the `deleted_at` conjunct excludes it.
    expect(trashed.status).toBe('published');
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
  });

  it('is false for an image referenced only by a REVISION of a published post', async () => {
    await seedImage(IMG);
    // The image was cut from the live document and survives only in history.
    const post = await published({ content: PLAIN });
    await seedRevision(post.id, docWithImage(IMG));
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
  });

  it('is true when BOTH a draft and a published post reference it', async () => {
    await seedImage(IMG);
    await createPost(ctx.db, owner(), {
      title: 'Draft',
      slug: 'draft-two',
      content: docWithImage(IMG),
    });
    await published({ content: docWithImage(IMG) });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
  });

  it('is false for an unknown id', async () => {
    await published({ content: docWithImage(IMG) });
    expect(await isPubliclyReferencedImage(ctx.db, 'img_nobody')).toBe(false);
  });

  it('is false — and does not throw — for a published post with MALFORMED content', async () => {
    await seedImage(IMG);
    const post = await published({ content: PLAIN });
    // A node whose `content` is a string: unwalkable, and the id is present in
    // the serialised text, so a text-only extractor would answer TRUE here.
    await setContent(post.id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: `asset:${IMG}` }],
    });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
  });

  it('is true for a reference nested four levels deep', async () => {
    await seedImage(IMG);
    await published({ content: docWithImage(IMG, 4) });
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
  });
});

describe('getPublicImage', () => {
  it('returns the row for a committed, publicly referenced image', async () => {
    await seedImage(IMG);
    await published({ content: docWithImage(IMG) });
    const row = await getPublicImage(ctx.db, IMG);
    expect(row?.id).toBe(IMG);
    expect(row?.committedAt).not.toBeNull();
  });

  it('returns null for an UNCOMMITTED image referenced by a published post', async () => {
    await seedImage(IMG, false);
    await published({ content: docWithImage(IMG) });
    // The reference is live; the bytes were never magic-byte checked.
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(true);
    expect(await getPublicImage(ctx.db, IMG)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await getPublicImage(ctx.db, 'img_nobody')).toBeNull();
  });

  it('returns null for a committed image referenced only by a draft', async () => {
    await seedImage(IMG);
    await createPost(ctx.db, owner(), {
      title: 'Draft',
      slug: 'draft-three',
      content: docWithImage(IMG),
    });
    expect(await getPublicImage(ctx.db, IMG)).toBeNull();
  });
});

describe('mutation test: the published scope is what excludes the draft', () => {
  /** The same fragment the production functions use, with its scope removed. */
  async function referencedUnscoped(imageId: string): Promise<boolean> {
    const res = await ctx.db.execute(
      sql`SELECT ${publicImageRefExists(imageId, sql`true`)} AS referenced`,
    );
    return res.rows[0]?.referenced === true;
  }

  it('finds the draft-only image WITHOUT the scope, and refuses it WITH it', async () => {
    await seedImage(IMG);
    await createPost(ctx.db, owner(), {
      title: 'Draft',
      slug: 'draft-four',
      content: docWithImage(IMG),
    });
    // (a) the corpus really exercises the scope …
    expect(await referencedUnscoped(IMG)).toBe(true);
    // … (b) and the production predicate is what excludes it.
    expect(await isPubliclyReferencedImage(ctx.db, IMG)).toBe(false);
    expect(await getPublicImage(ctx.db, IMG)).toBeNull();
  });
});
