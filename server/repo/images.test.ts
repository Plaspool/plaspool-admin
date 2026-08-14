/**
 * The image store, against a real Postgres (spec §3.6, §5.4).
 *
 * WHAT THIS SUITE IS FOR, AND THE REASON IT IS WRITTEN THE WAY IT IS.
 *
 * The previous round of this project was mutation-tested: replacing every CAS
 * guard in the write path with `true` broke NONE of 254 tests, because each
 * precondition case was satisfied by a JavaScript pre-check on an already-stale
 * read. So every test here that names a predicate calls the REPOSITORY function
 * directly — no route, no pre-read — and asserts on what the statement did.
 * `commitImage` with a stranger's id, `deleteUnclaimedImage` on a committed
 * row, `collectOrphans` against a fresh `unreferenced_since`: each one goes red
 * if its half of the SQL is removed, because there is nothing else in the path
 * that could refuse it.
 *
 * The orphan tests are the point of the task. Each of the six rules in
 * `docs/superpowers/plans/2026-08-11-part4-media.md` has at least one test whose
 * failure mode is deleted bytes, and they are written so that the SAFE
 * direction (keeping an image) is what is asserted — a mutation that makes
 * collection more eager is what these are here to catch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb, type TestCtx } from '../test/harness';
import { createPost } from './posts';
import { BadRequestError } from './errors';
import {
  MAX_IMAGE_BYTES,
  MAX_OPEN_SLOTS,
  MAX_TOTAL_BYTES,
  QUARANTINE_MS,
  SLOT_TTL_MS,
  collectOrphans,
  commitImage,
  createSlot,
  deleteUnclaimedImage,
  findUnwalkableDocs,
  getImage,
  getOwnedImage,
  markUnreferenced,
  previewOrphans,
  sweepUncommitted,
} from './images';
import type { AuthUser, DocNode, Post } from '../../shared/types';

const HOUR = 60 * 60 * 1000;

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await freshDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM images`);
  await ctx.db.execute(sql`DELETE FROM posts`);
});

const owner = (): AuthUser => ctx.users.owner;
const writer = (): AuthUser => ctx.users.writer;

interface SeedImage {
  id: string;
  user?: AuthUser;
  createdAt?: number;
  committedAt?: number | null;
  unreferencedSince?: number | null;
  byteSize?: number;
}

/**
 * A row inserted directly, so a test can place it anywhere in time.
 *
 * `createSlot` stamps `Date.now()`, and every property under test here is about
 * an interval measured in hours. Faking the clock would fake it for the
 * statement too; placing the ROW is the honest way to ask the question.
 */
async function seedImage(seed: SeedImage): Promise<void> {
  const user = seed.user ?? owner();
  const createdAt = seed.createdAt ?? Date.now();
  await ctx.db.execute(sql`
    INSERT INTO images (id, owner_id, storage_key, content_type, width, height,
                        byte_size, checksum, created_at, committed_at,
                        unreferenced_since)
    VALUES (${seed.id}, ${user.id}::uuid, ${`images/${user.id}/${seed.id}`},
            'image/png', NULL, NULL, ${seed.byteSize ?? 1000}, NULL,
            ${createdAt},
            ${seed.committedAt === undefined ? createdAt : seed.committedAt},
            ${seed.unreferencedSince ?? null})`);
}

const EMPTY: DocNode = { type: 'doc', content: [{ type: 'paragraph' }] };

function post(content: DocNode = EMPTY): Promise<Post> {
  return createPost(ctx.db, owner(), { content });
}

/**
 * Write a document that `validateDoc` would refuse.
 *
 * Raw SQL on purpose. The rows most likely to hold a malformed document are the
 * ones that arrived through import, a backfill or manual SQL — which is exactly
 * the door the whole malformed-node rule exists for, and exactly the door
 * `validateDoc` does not stand at.
 */
async function setContent(id: string, content: unknown): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE posts SET content = ${JSON.stringify(content)}::jsonb WHERE id = ${id}`);
}

async function idsInStore(): Promise<string[]> {
  const res = await ctx.db.execute(sql`SELECT id FROM images ORDER BY id`);
  return res.rows.map((row) => String(row.id));
}

async function unreferencedSince(id: string): Promise<number | null> {
  return (await getImage(ctx.db, id))?.unreferencedSince ?? null;
}

/**
 * A mark pass a full quarantine window BEFORE the delete pass.
 *
 * The two cannot be run at the same instant and collect anything — that is the
 * quarantine working, and the `describe('the two-phase quarantine')` block below
 * asserts it directly. The walk tests are about WHAT is referenced, so they run
 * the two passes far enough apart that the clock is never the reason for the
 * answer.
 */
async function sweep(now: number): Promise<string[]> {
  await markUnreferenced(ctx.db, now - QUARANTINE_MS - HOUR);
  return (await collectOrphans(ctx.db, now)).collected.map((o) => o.id);
}

// ------------------------------------------------------------------- slots

describe('createSlot', () => {
  it('rejects a disallowed content type before anything is presigned', async () => {
    await expect(
      createSlot(ctx.db, owner(), { contentType: 'text/html', byteSize: 10 }),
    ).rejects.toThrow(BadRequestError);
    // Nothing was written, so nothing has to be swept back out.
    expect(await idsInStore()).toEqual([]);
  });

  it('rejects a byteSize over 12 MB, and a zero or negative one', async () => {
    for (const byteSize of [MAX_IMAGE_BYTES + 1, 0, -1, 1.5, Number.NaN]) {
      await expect(
        createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize }),
      ).rejects.toThrow(BadRequestError);
    }
    expect(await idsInStore()).toEqual([]);
  });

  it('stores width and height as NULL — the server has not seen the bytes', async () => {
    // The whole reason migration 0004 exists. With NOT NULL this insert is a
    // hard 23502 and the media flow is unreachable; with a 0 default it is a
    // number every consumer downstream believes.
    const slot = await createSlot(ctx.db, owner(), {
      contentType: 'image/png',
      byteSize: 2048,
    });
    expect(slot.width).toBeNull();
    expect(slot.height).toBeNull();
    expect(slot.committedAt).toBeNull();
    expect(slot.byteSize).toBe(2048);
    expect(slot.storageKey).toBe(`images/${owner().id}/${slot.id}`);
  });

  it('caps concurrent uncommitted slots per user', async () => {
    // Without this, one session mints unbounded 12 MB presigned PUTs in a loop.
    for (let i = 0; i < MAX_OPEN_SLOTS; i += 1) {
      await createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize: 10 });
    }
    await expect(
      createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize: 10 }),
    ).rejects.toThrow(/slots/);
    expect(await idsInStore()).toHaveLength(MAX_OPEN_SLOTS);
  });

  it('the cap is per user, not global', async () => {
    for (let i = 0; i < MAX_OPEN_SLOTS; i += 1) {
      await createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize: 10 });
    }
    await expect(
      createSlot(ctx.db, writer(), { contentType: 'image/png', byteSize: 10 }),
    ).resolves.toBeDefined();
  });

  it('a committed row and an aged-out slot do not count against the cap', async () => {
    // Both halves of the `committed_at IS NULL AND created_at > cutoff`
    // predicate: a writer who has uploaded ten images must still be able to
    // upload an eleventh, and an abandoned slot must not lock the account out
    // for a day.
    for (let i = 0; i < MAX_OPEN_SLOTS; i += 1) {
      await seedImage({ id: `img_done_${i}`, committedAt: Date.now() });
    }
    for (let i = 0; i < MAX_OPEN_SLOTS; i += 1) {
      await seedImage({
        id: `img_stale_${i}`,
        createdAt: Date.now() - SLOT_TTL_MS - HOUR,
        committedAt: null,
      });
    }
    await expect(
      createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize: 10 }),
    ).resolves.toBeDefined();
  });

  it('refuses once the per-user byte quota is reached', async () => {
    /*
     * The slot cap bounds only UNCOMMITTED rows, so commit-then-repeat walks
     * straight past it. This is the bound on stored bytes, and it counts
     * committed rows — which is what the slot cap deliberately does not.
     */
    await seedImage({
      id: 'img_huge',
      committedAt: Date.now(),
      byteSize: MAX_TOTAL_BYTES,
    });
    await expect(
      createSlot(ctx.db, owner(), { contentType: 'image/png', byteSize: 1 }),
    ).rejects.toThrow(/quota/);
    // And it is per user: the writer's allowance is untouched.
    await expect(
      createSlot(ctx.db, writer(), { contentType: 'image/png', byteSize: 1 }),
    ).resolves.toBeDefined();
  });
});

// ------------------------------------------------------------------ commit

describe('commitImage', () => {
  it('claims an unclaimed slot and writes the dimensions read from the bytes', async () => {
    await seedImage({ id: 'img_a', committedAt: null });
    const row = await commitImage(ctx.db, owner().id, 'img_a', {
      width: 640,
      height: 480,
      byteSize: 4096,
    });
    expect(row?.committedAt).toBeGreaterThan(0);
    expect(row?.width).toBe(640);
    expect(row?.height).toBe(480);
    // Corrected from headObject, not the client's declaration.
    expect(row?.byteSize).toBe(4096);
  });

  it('a writer cannot commit another writer\'s image', async () => {
    /*
     * THE `owner_id` HALF OF THE PREDICATE, and nothing else in this path could
     * refuse it — there is no pre-read here. Ids appear in documents every
     * writer can read, so without this line any writer can claim, and therefore
     * finalise, somebody else's in-flight upload.
     */
    await seedImage({ id: 'img_owned', user: owner(), committedAt: null });
    const row = await commitImage(ctx.db, writer().id, 'img_owned', {
      width: 1,
      height: 1,
      byteSize: 1,
    });
    expect(row).toBeNull();
    // And the row is genuinely untouched, not merely unreported.
    expect((await getImage(ctx.db, 'img_owned'))?.committedAt).toBeNull();
  });

  it('a second commit matches nothing — the unclaimed half of the predicate', async () => {
    await seedImage({ id: 'img_b', committedAt: null });
    const first = await commitImage(ctx.db, owner().id, 'img_b', {
      width: 10,
      height: 10,
      byteSize: 100,
    });
    expect(first).not.toBeNull();

    const second = await commitImage(ctx.db, owner().id, 'img_b', {
      width: 99,
      height: 99,
      byteSize: 999,
    });
    expect(second).toBeNull();
    // The point of the guard: the live image's facts were NOT rewritten.
    const stored = await getImage(ctx.db, 'img_b');
    expect(stored?.width).toBe(10);
    expect(stored?.byteSize).toBe(100);
    expect(stored?.committedAt).toBe(first?.committedAt);
  });

  it('commit clears any quarantine clock the row was carrying', async () => {
    await seedImage({
      id: 'img_c',
      committedAt: null,
      unreferencedSince: Date.now() - 5 * QUARANTINE_MS,
    });
    await commitImage(ctx.db, owner().id, 'img_c', {
      width: null,
      height: null,
      byteSize: 1,
    });
    // A clock that started before the image existed would read as days of
    // continuous non-reference that never happened.
    expect(await unreferencedSince('img_c')).toBeNull();
  });

  it('getOwnedImage is what tells "not yours" apart from "already done"', async () => {
    await seedImage({ id: 'img_d', user: owner(), committedAt: Date.now() });
    expect(await getOwnedImage(ctx.db, owner().id, 'img_d')).not.toBeNull();
    expect(await getOwnedImage(ctx.db, writer().id, 'img_d')).toBeNull();
  });
});

describe('deleteUnclaimedImage', () => {
  it('refuses a stranger, so rejection cannot destroy another writer\'s upload', async () => {
    await seedImage({ id: 'img_e', user: owner(), committedAt: null });
    expect(await deleteUnclaimedImage(ctx.db, writer().id, 'img_e')).toBeNull();
    expect(await idsInStore()).toEqual(['img_e']);
  });

  it('refuses a row that is already committed', async () => {
    await seedImage({ id: 'img_f', committedAt: Date.now() });
    expect(await deleteUnclaimedImage(ctx.db, owner().id, 'img_f')).toBeNull();
    expect(await idsInStore()).toEqual(['img_f']);
  });

  it('removes the owner\'s own unclaimed row and reports the key', async () => {
    await seedImage({ id: 'img_g', committedAt: null });
    expect(await deleteUnclaimedImage(ctx.db, owner().id, 'img_g')).toBe(
      `images/${owner().id}/img_g`,
    );
    expect(await idsInStore()).toEqual([]);
  });
});

// ------------------------------------------------------ abandoned uploads

describe('sweepUncommitted', () => {
  it('sweeps uncommitted rows older than 24h and nothing else', async () => {
    const now = Date.now();
    await seedImage({ id: 'img_old', createdAt: now - SLOT_TTL_MS - HOUR, committedAt: null });
    await seedImage({ id: 'img_young', createdAt: now - HOUR, committedAt: null });
    await seedImage({
      id: 'img_committed',
      createdAt: now - SLOT_TTL_MS - HOUR,
      committedAt: now - HOUR,
    });

    const swept = await sweepUncommitted(ctx.db, now);
    expect(swept.map((s) => s.id)).toEqual(['img_old']);
    expect(swept[0].storageKey).toBe(`images/${owner().id}/img_old`);
    expect(await idsInStore()).toEqual(['img_committed', 'img_young']);
  });
});

// ------------------------------------------------------- orphan collection

describe('the reference walk', () => {
  /** An image committed and aged well past every floor, referenced by nothing. */
  async function agedOrphan(id = 'img_orphan'): Promise<void> {
    const long = Date.now() - 10 * SLOT_TTL_MS;
    await seedImage({ id, createdAt: long, committedAt: long });
  }

  it('collects an aged, committed image nothing points at', async () => {
    // The control. Without it every "is NOT collected" test below would pass
    // against an implementation that collects nothing at all.
    await agedOrphan();
    await post();
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual(['img_orphan']);
  });

  it('keeps an image referenced inline as asset: in a live post', async () => {
    await agedOrphan();
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_orphan' } }],
    });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps an image referenced as the legacy idb: scheme', async () => {
    await agedOrphan();
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'idb:img_orphan' } }],
    });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('extracts by SCHEME at any depth, not from nodes whose type is image', async () => {
    /*
     * Rule 5. A reference parked in a node type nobody has thought of yet, five
     * levels down, inside an attribute that is not `src`. Matching on
     * `type = 'image'` would miss every one of these and delete the bytes.
     */
    await agedOrphan();
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'gallery',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'x',
                      marks: [{ type: 'link', attrs: { poster: 'asset:img_orphan' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps an image referenced only by a revision', async () => {
    /*
     * History is the thing nobody can re-upload. `createPost` writes revision 1
     * holding the document as it was; the post is then rewritten without the
     * reference, so the ONLY surviving mention is in `revisions.content`.
     */
    await agedOrphan();
    const p = await createPost(ctx.db, owner(), {
      content: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'asset:img_orphan' } }],
      } as DocNode,
    });
    await setContent(p.id, EMPTY);
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps an image referenced only by a SOFT-DELETED post', async () => {
    /*
     * Rule 4. Trashing is reversible and byte deletion is not: collecting a
     * trashed post's images means restoring it yields a document full of
     * dangling references and no way back.
     */
    await agedOrphan();
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_orphan' } }],
    });
    await ctx.db.execute(
      sql`UPDATE posts SET deleted_at = ${Date.now()} WHERE id = ${p.id}`,
    );
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps an image named by cover_image.blobId, which carries no scheme', async () => {
    // Rule 5's second half: a BARE id the scheme regex cannot see. Merged into
    // the scheme extractor, this reference disappears and the cover art of
    // every published post is deleted.
    await agedOrphan();
    const p = await post();
    await ctx.db.execute(sql`
      UPDATE posts
         SET cover_image = ${JSON.stringify({
           blobId: 'img_orphan',
           alt: '',
           focalPoint: '',
           width: 1,
           height: 1,
         })}::jsonb
       WHERE id = ${p.id}`);
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps everything when a NESTED node is unwalkable', async () => {
    /*
     * RULE 3, AND THE REASON IT IS PER-NODE. This document's top level is a
     * perfectly ordinary object, so a column-level `jsonb_typeof(content) <>
     * 'array'` guard sees nothing wrong with it — and `posts.content` is always
     * an object, so that guard matches every healthy row anyway and means
     * nothing.
     *
     * The `content: "oops"` five levels down is where the descent stops:
     * `jsonb_array_elements` cannot be handed a string, the CASE substitutes an
     * empty array, and everything below becomes invisible. Invisible reads as
     * unreferenced, and unreferenced reads as deletable.
     */
    await agedOrphan('img_a');
    await agedOrphan('img_b');
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [
        {
          type: 'section',
          content: [
            { type: 'weird', content: 'oops' },
            { type: 'image', attrs: { src: 'asset:img_a' } },
          ],
        },
      ],
    });
    // Not "the ids we managed to see", not "the ones below the break" —
    // EVERYTHING, including the image this document never mentions.
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps everything when a whole document is unwalkable', async () => {
    await agedOrphan();
    const p = await post();
    await setContent(p.id, { type: 'doc', content: 'words' });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps everything when a document is not an object at all', async () => {
    await agedOrphan();
    const p = await post();
    await setContent(p.id, 'a string where a document should be');
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('keeps everything when an unwalkable node is in a REVISION', async () => {
    await agedOrphan();
    const p = await post();
    await ctx.db.execute(sql`
      UPDATE revisions SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'weird', content: 42 }],
      })}::jsonb WHERE post_id = ${p.id}`);
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });

  it('an empty paragraph is walkable — the guard is not simply "content is absent"', async () => {
    // The other direction, and it matters: if a missing `content` key counted
    // as unwalkable, every ordinary document in the store would stop collection
    // forever and the sweep would silently become a no-op.
    await agedOrphan();
    const p = await post();
    await setContent(p.id, { type: 'doc', content: [{ type: 'paragraph' }] });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual(['img_orphan']);
  });
});

// ------------------------------------------------------------- quarantine

describe('the two-phase quarantine', () => {
  const long = () => Date.now() - 10 * SLOT_TTL_MS;

  it('an image unreferenced NOW but not for 24h is NOT collected', async () => {
    /*
     * RULE 2, and the reason a mark pass exists at all. This image satisfies
     * every age floor — created and committed ten days ago — and is referenced
     * by nothing at this instant. That is what a cut-and-paste between two
     * posts looks like for one autosave debounce, and deleting on it is how a
     * months-old image disappears out of a live document.
     */
    await seedImage({ id: 'img_cut', createdAt: long(), committedAt: long() });
    const now = Date.now();
    const mark = await markUnreferenced(ctx.db, now);
    expect(mark.unreferenced).toBe(1);
    expect(await unreferencedSince('img_cut')).toBe(now);

    expect((await collectOrphans(ctx.db, now)).collected).toEqual([]);
    // Still there an hour later. The clock, not the instant, is the authority.
    expect((await collectOrphans(ctx.db, now + HOUR)).collected).toEqual([]);
  });

  it('an image unreferenced continuously for 24h IS collected', async () => {
    await seedImage({ id: 'img_gone', createdAt: long(), committedAt: long() });
    const start = Date.now() - QUARANTINE_MS - HOUR;
    await markUnreferenced(ctx.db, start);
    expect(await unreferencedSince('img_gone')).toBe(start);

    const now = Date.now();
    // A second mark pass must NOT reset the clock, or nothing is ever collected.
    await markUnreferenced(ctx.db, now);
    expect(await unreferencedSince('img_gone')).toBe(start);

    expect((await collectOrphans(ctx.db, now)).collected.map((o) => o.id)).toEqual(['img_gone']);
  });

  it('an image re-referenced between passes has its clock CLEARED', async () => {
    await seedImage({ id: 'img_back', createdAt: long(), committedAt: long() });
    const start = Date.now() - QUARANTINE_MS - HOUR;
    await markUnreferenced(ctx.db, start);
    expect(await unreferencedSince('img_back')).toBe(start);

    // Pasted into a post before the delete pass runs.
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_back' } }],
    });

    const now = Date.now();
    const mark = await markUnreferenced(ctx.db, now);
    expect(mark.cleared).toBe(1);
    expect(await unreferencedSince('img_back')).toBeNull();
    expect((await collectOrphans(ctx.db, now)).collected).toEqual([]);
  });

  it('a stale mark cannot outvote a live reference in the delete pass', async () => {
    /*
     * The second half of rule 2. The mark may be hours old by the time the
     * delete pass runs, so the delete RE-DERIVES the reference set rather than
     * trusting the column. Here the mark is stale AND expired, and the image is
     * referenced — and it survives, with no intervening mark pass to save it.
     */
    await seedImage({
      id: 'img_live',
      createdAt: long(),
      committedAt: long(),
      unreferencedSince: Date.now() - 5 * QUARANTINE_MS,
    });
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_live' } }],
    });
    expect((await collectOrphans(ctx.db, Date.now())).collected).toEqual([]);
  });
});

// --------------------------------------------------------------- age floor

describe('the age floor', () => {
  it('an image committed one second ago and referenced by nothing is NOT collected', async () => {
    /*
     * THE age-floor test (Task 16, step 1). Between commit and the autosave that
     * references it, a good image is unreferenced by construction — 800 ms in
     * the editor, minutes during a migration. Note that this image is BACKDATED
     * past the quarantine as well, so the quarantine alone cannot be what saves
     * it: only the floor can.
     */
    const now = Date.now();
    await seedImage({
      id: 'img_fresh',
      createdAt: now - 1000,
      committedAt: now - 1000,
      unreferencedSince: now - 5 * QUARANTINE_MS,
    });
    expect((await collectOrphans(ctx.db, now)).collected).toEqual([]);
  });

  it('is anchored to committed_at, not created_at', async () => {
    /*
     * RULE 1, and it is invisible to every other test in this file. Both rows
     * were SLOT-issued ten days ago, so a `created_at`-only floor clears both.
     * One of them was committed one minute ago — it has existed as a
     * referenceable image for a minute, and it is exactly as fragile as the
     * image in the test above.
     */
    const now = Date.now();
    const slotIssued = now - 10 * SLOT_TTL_MS;
    const quarantined = now - 5 * QUARANTINE_MS;
    await seedImage({
      id: 'img_just_committed',
      createdAt: slotIssued,
      committedAt: now - 60_000,
      unreferencedSince: quarantined,
    });
    await seedImage({
      id: 'img_long_committed',
      createdAt: slotIssued,
      committedAt: slotIssued,
      unreferencedSince: quarantined,
    });

    expect((await collectOrphans(ctx.db, now)).collected.map((o) => o.id)).toEqual([
      'img_long_committed',
    ]);
  });

  it('an uncommitted row is floored on created_at, since it has no commit time', async () => {
    // `greatest(created_at, coalesce(committed_at, created_at))` — the coalesce
    // is what stops a NULL committed_at making the whole expression NULL, which
    // would make the predicate unknown and collect nothing, forever.
    const now = Date.now();
    await seedImage({
      id: 'img_never',
      createdAt: now - 10 * SLOT_TTL_MS,
      committedAt: null,
      unreferencedSince: now - 5 * QUARANTINE_MS,
    });
    expect((await collectOrphans(ctx.db, now)).collected.map((o) => o.id)).toEqual(['img_never']);
  });
});

describe('collectOrphans reports keys for best-effort R2 deletion', () => {
  it('returns the storage key of every row it removed', async () => {
    const long = Date.now() - 10 * SLOT_TTL_MS;
    await seedImage({ id: 'img_k', createdAt: long, committedAt: long });
    const now = Date.now() + 2 * QUARANTINE_MS;
    await markUnreferenced(ctx.db, now - QUARANTINE_MS - HOUR);
    const gone = await collectOrphans(ctx.db, now);
    // The row is deleted FIRST and the object afterwards (rule 6): a leaked
    // byte is acceptable, a row pointing at nothing is not.
    expect(gone.collected).toEqual([
      {
        id: 'img_k',
        ownerId: owner().id,
        storageKey: `images/${owner().id}/img_k`,
        byteSize: 1000,
        unreferencedSince: expect.any(Number),
      },
    ]);
    expect(gone.more).toBe(false);
    expect(await idsInStore()).toEqual([]);
  });
});

// ------------------------------------------------------- the commit-time quota

describe('the byte quota at commit time', () => {
  /*
   * `MAX_TOTAL_BYTES` was enforced only in the INSERT, against the size the
   * CLIENT DECLARED — and commit then REPLACES that number with the real one
   * from `headObject`. Declaring one byte per slot and uploading 12 MB into
   * each therefore walked straight through the ceiling the comment claimed.
   *
   * These call `commitImage` directly. There is no route, no pre-read and no
   * TypeScript check anywhere in the path, so the only thing that can refuse
   * the over-quota commit is the predicate in the statement.
   */
  it('refuses a commit whose CORRECTED size would cross the ceiling', async () => {
    await seedImage({
      id: 'img_full',
      committedAt: Date.now(),
      byteSize: MAX_TOTAL_BYTES - 100,
    });
    await seedImage({ id: 'img_liar', committedAt: null, byteSize: 1 });

    const row = await commitImage(ctx.db, owner().id, 'img_liar', {
      width: 10,
      height: 10,
      byteSize: 5000,
    });
    expect(row).toBeNull();

    // Untouched, not merely unreported: still unclaimed, still carrying the
    // declared size, so a retry after the writer frees space still works.
    const stored = await getImage(ctx.db, 'img_liar');
    expect(stored?.committedAt).toBeNull();
    expect(stored?.byteSize).toBe(1);
  });

  it('admits the same commit when it fits — the control', async () => {
    // Without this, a predicate that refused every commit would look correct.
    await seedImage({
      id: 'img_full',
      committedAt: Date.now(),
      byteSize: MAX_TOTAL_BYTES - 100,
    });
    await seedImage({ id: 'img_small', committedAt: null, byteSize: 1 });
    const row = await commitImage(ctx.db, owner().id, 'img_small', {
      width: 1,
      height: 1,
      byteSize: 50,
    });
    expect(row?.byteSize).toBe(50);
  });

  it('counts the row being committed once, not twice', async () => {
    /*
     * The subquery excludes THIS row. Without the exclusion the declared size
     * and the corrected size are both charged, and a writer sitting just under
     * the ceiling is refused a commit that fits.
     */
    await seedImage({
      id: 'img_fills_it',
      committedAt: null,
      byteSize: MAX_TOTAL_BYTES,
    });
    const row = await commitImage(ctx.db, owner().id, 'img_fills_it', {
      width: 1,
      height: 1,
      byteSize: MAX_TOTAL_BYTES,
    });
    expect(row).not.toBeNull();
  });

  it('is per user: another writer\'s bytes do not fill this one\'s quota', async () => {
    await seedImage({
      id: 'img_theirs',
      user: writer(),
      committedAt: Date.now(),
      byteSize: MAX_TOTAL_BYTES,
    });
    await seedImage({ id: 'img_mine', committedAt: null, byteSize: 1 });
    expect(
      await commitImage(ctx.db, owner().id, 'img_mine', {
        width: 1,
        height: 1,
        byteSize: 1000,
      }),
    ).not.toBeNull();
  });
});

// -------------------------------------------- a JSON null is an EMPTY node

describe('"content": null', () => {
  it('is walkable — a typed empty, not a document we failed to parse', async () => {
    /*
     * `node -> 'content' IS NOT NULL` is SQL-NULL and therefore TRUE for a JSON
     * null, so ONE `{"type":"paragraph","content":null}` anywhere in any post
     * or revision made every image referenced and halted ALL collection,
     * permanently and with no signal.
     *
     * The call is that jsonb null says "no children" exactly as the ABSENT key
     * does — and an absent key has always been walkable here, or every empty
     * paragraph in the store would stop the sweep. It carries nothing that
     * could be hidden below it, which is the difference from `"content":
     * "oops"`.
     */
    const long = Date.now() - 10 * SLOT_TTL_MS;
    await seedImage({ id: 'img_orphan', createdAt: long, committedAt: long });
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: null }],
    });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual(['img_orphan']);
    expect((await markUnreferenced(ctx.db, Date.now())).blocked).toBe(false);
  });

  it('a NON-null, non-array content is still unwalkable — nothing was loosened', async () => {
    const long = Date.now() - 10 * SLOT_TTL_MS;
    await seedImage({ id: 'img_orphan', createdAt: long, committedAt: long });
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'weird', content: 'oops' }],
    });
    expect(await sweep(Date.now() + 2 * QUARANTINE_MS)).toEqual([]);
  });
});

// ------------------------------------------------ saying that we are blocked

describe('blocked collection is reported, not silent', () => {
  it('markUnreferenced says so, and findUnwalkableDocs names the row', async () => {
    /*
     * The fail-safe DIRECTION is right and stays. What was wrong is that a
     * store whose collection had been dead for months answered exactly what a
     * healthy store with nothing to collect answers, and the owner had no way
     * to find the row to fix.
     */
    const long = Date.now() - 10 * SLOT_TTL_MS;
    await seedImage({ id: 'img_orphan', createdAt: long, committedAt: long });
    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'section', content: [{ type: 'weird', content: 3 }] }],
    });

    expect((await markUnreferenced(ctx.db, Date.now())).blocked).toBe(true);
    expect(await findUnwalkableDocs(ctx.db)).toEqual([{ source: 'post', id: p.id }]);
  });

  it('names a REVISION when that is where the bad node is', async () => {
    const p = await post();
    await ctx.db.execute(sql`
      UPDATE revisions SET content = ${JSON.stringify({
        type: 'doc',
        content: [{ type: 'weird', content: 42 }],
      })}::jsonb WHERE post_id = ${p.id}`);
    const found = await findUnwalkableDocs(ctx.db);
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('revision');
  });

  it('reports nothing on a healthy store', async () => {
    await post();
    expect((await markUnreferenced(ctx.db, Date.now())).blocked).toBe(false);
    expect(await findUnwalkableDocs(ctx.db)).toEqual([]);
  });
});

// ------------------------------------------------------- bounded, resumable

describe('the passes are bounded', () => {
  const long = () => Date.now() - 10 * SLOT_TTL_MS;

  it('the mark pass writes only rows whose state actually changed', async () => {
    /*
     * The UPDATE had NO WHERE CLAUSE: every images row was rewritten on every
     * call, to give almost all of them the value they already had. On a store
     * with real history that is the difference between a sweep that finishes
     * inside the function ceiling and one that 500s — which the client then
     * retries five times, each retry redoing the whole walk.
     */
    for (let i = 0; i < 5; i += 1) {
      await seedImage({ id: `img_${i}`, createdAt: long(), committedAt: long() });
    }
    const stamp = Date.now() - HOUR;
    const first = await markUnreferenced(ctx.db, stamp);
    expect(first.changed).toBe(5);
    expect(first.unreferenced).toBe(5);

    // Nothing has moved, so the second pass must write nothing at all.
    const second = await markUnreferenced(ctx.db, Date.now());
    expect(second.changed).toBe(0);
    expect(second.unreferenced).toBe(5);

    // And the clock is still the FIRST pass's — skipping the write is not the
    // same trick as `coalesce`, but it must have the same effect.
    expect(await unreferencedSince('img_0')).toBe(stamp);
  });

  it('the mark pass still clears a clock when a reference appears', async () => {
    // The control for the WHERE clause: it must not skip the rows that DO
    // change, in either direction.
    await seedImage({ id: 'img_x', createdAt: long(), committedAt: long() });
    await markUnreferenced(ctx.db, Date.now());
    expect(await unreferencedSince('img_x')).not.toBeNull();

    const p = await post();
    await setContent(p.id, {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'asset:img_x' } }],
    });
    const mark = await markUnreferenced(ctx.db, Date.now());
    expect(mark.changed).toBe(1);
    expect(mark.cleared).toBe(1);
    expect(await unreferencedSince('img_x')).toBeNull();
  });

  it('the delete pass takes a batch and says there is more', async () => {
    const stamped = Date.now() - 5 * QUARANTINE_MS;
    for (let i = 0; i < 3; i += 1) {
      await seedImage({
        id: `img_o${i}`,
        createdAt: long(),
        committedAt: long(),
        unreferencedSince: stamped + i,
      });
    }
    const first = await collectOrphans(ctx.db, Date.now(), 2);
    expect(first.collected).toHaveLength(2);
    expect(first.more).toBe(true);

    // Resumable: the caller comes back and the rest goes.
    const second = await collectOrphans(ctx.db, Date.now(), 2);
    expect(second.collected).toHaveLength(1);
    expect(second.more).toBe(false);
    expect(await idsInStore()).toEqual([]);
  });
});

// ------------------------------------------------------------------ dry run

describe('previewOrphans', () => {
  const long = () => Date.now() - 10 * SLOT_TTL_MS;

  it('lists exactly what a real run would take, and writes NOTHING', async () => {
    await seedImage({
      id: 'img_doomed',
      createdAt: long(),
      committedAt: long(),
      unreferencedSince: Date.now() - 5 * QUARANTINE_MS,
      byteSize: 4242,
    });
    await seedImage({ id: 'img_safe', createdAt: long(), committedAt: long() });

    const preview = await previewOrphans(ctx.db, Date.now());
    expect(preview.collected).toEqual([
      expect.objectContaining({ id: 'img_doomed', byteSize: 4242, ownerId: owner().id }),
    ]);
    expect(preview.blocked).toBe(false);

    // The preview did not start a clock on `img_safe`. A dry run that marked
    // would bring every image it listed 24 hours closer to deletion.
    expect(await unreferencedSince('img_safe')).toBeNull();
    expect(await idsInStore()).toEqual(['img_doomed', 'img_safe']);

    // And the real run takes precisely the previewed set.
    const real = await collectOrphans(ctx.db, Date.now());
    expect(real.collected.map((o) => o.id)).toEqual(['img_doomed']);
  });

  it('bounds the abandoned-slot list too, and says there is more', async () => {
    /*
     * The delete pass is capped because this route lives under the Vercel
     * function ceiling; a dry run that serialised every abandoned slot in a
     * store with tens of thousands of them into one JSON body would blow the
     * same ceiling on the route whose whole justification for batching is that
     * ceiling.
     */
    for (let i = 0; i < 4; i += 1) {
      await seedImage({
        id: `img_ab${i}`,
        createdAt: Date.now() - SLOT_TTL_MS - HOUR - i,
        committedAt: null,
      });
    }
    const preview = await previewOrphans(ctx.db, Date.now(), 2);
    expect(preview.swept).toHaveLength(2);
    expect(preview.more).toBe(true);
  });

  it('reports a blocked store rather than an empty list', async () => {
    await seedImage({
      id: 'img_doomed',
      createdAt: long(),
      committedAt: long(),
      unreferencedSince: Date.now() - 5 * QUARANTINE_MS,
    });
    const p = await post();
    await setContent(p.id, { type: 'doc', content: 'words' });

    const preview = await previewOrphans(ctx.db, Date.now());
    expect(preview.collected).toEqual([]);
    expect(preview.blocked).toBe(true);
  });
});
