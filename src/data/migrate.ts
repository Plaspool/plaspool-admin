import { api } from './api';
import { cachePost } from './cache';
import { db, type LocalPost } from './db';
import { ASSET_SCHEME, imageIdFromSrc } from './doc';
import { ApiError } from './errors';
import { ImageError, prepareForUpload, uploadPrepared } from './images';
import { BundlePost, type BundlePostInput } from '../../shared/bundle';
import { checkPostMeta, utf8Bytes, validateDoc } from '../../shared/validate';
import { BUNDLE_FORMAT } from './types';
import type { Bundle, DocNode, Post } from './types';

/**
 * Moving the pre-backend library onto the blog (plan §6.4).
 *
 * READ `server/routes/backup.ts`'s `/import` HANDLER BEFORE CHANGING ANYTHING
 * HERE. Three of its properties dictate the whole shape of this file:
 *
 * 1. **It is rate limited to five requests per hour**, `BACKUP_LIMIT` in
 *    `server/repo/ratelimit.ts`, and `limit()` runs BEFORE `readJson` — so a
 *    body the route refuses with a 400 or a 422 **still burns a slot**. Five
 *    bad batches and the hour's budget is gone with nothing migrated.
 * 2. **It throws on the FIRST offending post**, so one bad document kills its
 *    whole 25-post batch, not just itself.
 * 3. **`BundlePost` is `.strict()`**, and a `localPosts` row is a `Post` plus
 *    the `migratedAt` field the v1→v2 upgrade stamps on it. The measured result
 *    of spreading the store row into a bundle post is
 *    `unrecognized_keys: ['migratedAt']` → a 400, i.e. failure mode 1.
 *
 * Together those make step 0 — validate every document locally, with the
 * SERVER'S OWN schema, and exclude the failures from every batch — the load
 * bearing part of this module rather than belt-and-braces. It is why
 * `shared/bundle.ts` exists.
 *
 * THE OTHER RULE THAT DECIDES THE SHAPE: `localPosts` is never rewritten and
 * never deleted by migration. The rewritten document is built in memory and
 * sent; the store row keeps pointing at the local blobs. A failure anywhere
 * after the rewrite therefore cannot leave the only copy of a post pointing at
 * bytes that were never committed. The row is only ever *stamped*, with
 * `migratedAt`, and only after `GET /posts/:id` has confirmed the post is on
 * the server.
 */

// --------------------------------------------------------------------- types

/** A post that cannot be uploaded, and the reason, for the review screen. */
export interface ExcludedPost {
  id: string;
  title: string;
  /** `validateDoc`'s reason, a Zod issue code, or one of the words below. */
  reason: string;
  /** The field or document path the failure names, when it names one. */
  path?: string;
}

/** A post that was sent and refused, after the batch was split down to it. */
export interface FailedPost {
  id: string;
  title: string;
  detail: string;
}

export interface ImageTally {
  /** Uploaded by this run. */
  uploaded: number;
  /** Already in `assetMap` from an earlier run — no slot burned. */
  reused: number;
  /** Referenced by a document with no blob left in `db.images`. */
  missing: number;
  /** The upload was attempted and refused. */
  failed: number;
}

export type StopReason = 'rate_limited' | 'offline' | 'error';

export interface MigrationStopInfo {
  reason: StopReason;
  /** Seconds, from the 429. Only ever set for `rate_limited`. */
  retryAfter?: number;
  detail?: string;
}

export interface MigrationReport {
  /** Ids the server confirmed by `GET /posts/:id`. These are stamped. */
  confirmed: string[];
  excluded: ExcludedPost[];
  failed: FailedPost[];
  images: ImageTally;
  /**
   * Snapshots left behind. `POST /import` does not restore revisions
   * (`server/routes/backup.ts`) and `createPost` writes the literal revision 1,
   * so every migrated post lands with one snapshot and no history. Counted
   * rather than dropped silently — F4.
   */
  revisionsNotCarried: number;
  stoppedBy: MigrationStopInfo | null;
}

export interface MigrationProgress {
  phase: 'preparing' | 'uploading' | 'confirming' | 'done';
  postsPrepared: number;
  postsTotal: number;
  imagesDone: number;
  imagesTotal: number;
  postsConfirmed: number;
}

export type ProgressFn = (progress: MigrationProgress) => void;

/**
 * Where the posts and their image bytes come from, and what to do once the
 * server confirms one.
 *
 * The indirection exists for exactly one reason and it is not generality: a
 * FOREIGN bundle carries its images as base64 in `bundle.images` rather than as
 * `db.images` rows, so without a second source every picture in an imported
 * bundle is silently dropped on the rewrite. Both callers are in this file.
 */
export interface MigrationSource {
  posts: Post[];
  /** The bytes for a local image id, or `null` when they are gone. */
  loadImage(localId: string): Promise<Blob | null>;
  /** Runs once `GET /posts/:id` has proved the post is on the server. */
  confirm(post: Post): Promise<void>;
  /** How many snapshots this source is not carrying. */
  countRevisions(postIds: string[]): Promise<number>;
}

// ------------------------------------------------------------------ step zero

/**
 * The bundle post, built from an EXPLICIT FIELD ALLOW-LIST.
 *
 * Never `{ ...row }`. A `localPosts` row carries `migratedAt`, `BundlePost` is
 * `.strict()`, and the measured result is a 400 that burns one of five hourly
 * slots before the body is even read. Spreading would also mean any field a
 * future local-only feature adds becomes a 400 nobody predicted — the failure
 * arrives in production, an hour's budget at a time.
 *
 * The sixteen fields below are exactly the ones `toPartial` in
 * `server/routes/backup.ts` HONOURS. `authorId`, `authorName`, `revision`,
 * `wordCount` and `readingTime` are declared by `BundlePost` and deliberately
 * ignored by the route — the importing session is the author and the counts are
 * re-derived — so sending them would add payload against the 1.5 MB batch bound
 * and a validation surface, in exchange for nothing.
 */
export function toBundlePost(post: Post, content: DocNode): BundlePostInput {
  return {
    id: post.id,
    title: post.title,
    subtitle: post.subtitle,
    slug: post.slug ?? null,
    excerpt: post.excerpt,
    excerptSource: post.excerptSource,
    content,
    coverImage: post.coverImage ?? null,
    category: post.category,
    tags: post.tags,
    template: post.template ?? null,
    status: post.status,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    publishedAt: post.publishedAt ?? null,
    deletedAt: post.deletedAt ?? null,
  };
}

/**
 * Would the server take this post? Answered locally, before a single byte is
 * uploaded, by running the three things the route runs: the shared Zod body
 * schema, `validateDoc` and `checkPostMeta`.
 *
 * Returns `null` for "yes". Anything else is listed as "can't be uploaded" with
 * its reason and EXCLUDED from every batch — because the route throws on the
 * first offender and would otherwise take the other twenty-four posts in the
 * batch down with it.
 */
export function checkUploadable(post: Post, content: DocNode): Omit<ExcludedPost, 'id' | 'title'> | null {
  const doc = validateDoc(content);
  if (!doc.ok) return { reason: doc.violation.reason, path: doc.violation.path };

  const meta = checkPostMeta(post);
  if (meta) return { reason: meta.reason, path: meta.path };

  /*
   * The schema LAST, because the two validators above give a reason a writer
   * can act on ("too_large", naming `title`) and a Zod issue is a developer's
   * sentence. Anything that reaches here is a shape problem — a field holding
   * the wrong type, a NUL byte Postgres cannot store — rather than a size or a
   * document problem.
   */
  const parsed = BundlePost.safeParse(toBundlePost(post, content));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { reason: issue?.code ?? 'invalid', path: issue?.path.join('.') || undefined };
  }
  return null;
}

// --------------------------------------------------------------- the rewrite

/** Every local image id a post references: inline images, then the cover. */
export function imageIdsOf(post: Post): string[] {
  const ids: string[] = [];
  const walk = (node: DocNode | undefined) => {
    if (!node) return;
    if (node.type === 'image') {
      const id = imageIdFromSrc(node.attrs?.src);
      if (id) ids.push(id);
    }
    node.content?.forEach(walk);
  };
  walk(post.content);
  if (post.coverImage?.blobId) ids.push(post.coverImage.blobId);
  return [...new Set(ids)];
}

/**
 * The document with every mapped image id rewritten to `asset:<assetId>`.
 *
 * IN MEMORY, AND NOTHING WRITES IT BACK. `localPosts` keeps the `idb:` ids and
 * the local blobs they name, so if the upload, the batch or the confirmation
 * fails at any point after this, the only copy of the post still points at
 * bytes that exist. An id with no mapping — because its blob is gone, or its
 * upload failed — is left exactly as it was rather than dropped: the words
 * around it are what matter, and a `<figure>` that renders "Image unavailable"
 * loses strictly less than deleting the node would.
 */
export function rewriteDoc(node: DocNode, map: Map<string, string>): DocNode {
  const next: DocNode = { ...node };
  if (node.type === 'image') {
    const id = imageIdFromSrc(node.attrs?.src);
    const assetId = id ? map.get(id) : undefined;
    if (assetId) next.attrs = { ...node.attrs, src: `${ASSET_SCHEME}${assetId}` };
  }
  if (node.content) next.content = node.content.map((child) => rewriteDoc(child, map));
  return next;
}

function rewriteCover(post: Post, map: Map<string, string>): Post['coverImage'] {
  const cover = post.coverImage;
  if (!cover?.blobId) return cover ?? null;
  const assetId = map.get(cover.blobId);
  /*
   * `blobId` STAYS BARE. It is the field the server's orphan sweep reads as
   * `cover_image->>'blobId'`, and `acquireImageURL` takes a bare id on both
   * sides of the cutover — prefixing it with `asset:` would break the sweep's
   * match and the resolver at once.
   */
  return assetId ? { ...cover, blobId: assetId } : cover;
}

// ----------------------------------------------------------------- batching

/**
 * 25 posts or 1.5 MB serialised, whichever binds first.
 *
 * The byte bound is the one that matters: 25 posts of 500 KB is a 12 MB request
 * body, and the count bound alone would send it. A single post over the limit
 * is still sent alone rather than excluded — `MAX_DOC_BYTES` is 2 MB, so a
 * legitimate document can exceed 1.5 MB and refusing it here would invent a
 * limit the server does not have.
 */
export const MAX_BATCH_POSTS = 25;
export const MAX_BATCH_BYTES = 1_500_000;

export function batchPosts(posts: BundlePostInput[]): BundlePostInput[][] {
  const batches: BundlePostInput[][] = [];
  let current: BundlePostInput[] = [];
  let bytes = 0;
  for (const post of posts) {
    const size = utf8Bytes(JSON.stringify(post));
    if (current.length && (current.length >= MAX_BATCH_POSTS || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(post);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * A condition that ends the run rather than one post.
 *
 * Thrown rather than returned so it cannot be dropped on the floor by the
 * recursive split below, which has three call sites per level.
 */
class MigrationStop extends Error {
  readonly info: MigrationStopInfo;
  constructor(info: MigrationStopInfo) {
    super(info.detail ?? info.reason);
    this.name = 'MigrationStop';
    this.info = info;
  }
}

// ------------------------------------------------------------------- engine

/**
 * The whole pipeline, for one source.
 *
 * Order is the contract: nothing is uploaded before step 0 has run over every
 * post, and nothing is stamped before the server has been asked for it back.
 */
export async function migrate(
  userId: string,
  source: MigrationSource,
  onProgress?: ProgressFn,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    confirmed: [],
    excluded: [],
    failed: [],
    images: { uploaded: 0, reused: 0, missing: 0, failed: 0 },
    revisionsNotCarried: 0,
    stoppedBy: null,
  };

  // ---- step 0: validate everything, locally, before uploading a single byte
  const seen = new Set<string>();
  const candidates: Post[] = [];
  for (const post of source.posts) {
    if (seen.has(post.id)) {
      // `POST /import` answers 400 `posts.id` for a duplicated id and takes the
      // whole batch with it, so the duplicate is excluded here instead.
      report.excluded.push({ id: post.id, title: post.title, reason: 'duplicate_id' });
      continue;
    }
    seen.add(post.id);
    const problem = checkUploadable(post, post.content);
    if (problem) {
      report.excluded.push({ id: post.id, title: post.title, ...problem });
      continue;
    }
    candidates.push(post);
  }

  const progress: MigrationProgress = {
    phase: 'preparing',
    postsPrepared: 0,
    postsTotal: candidates.length,
    imagesDone: 0,
    imagesTotal: 0,
    postsConfirmed: 0,
  };
  const tick = () => onProgress?.({ ...progress });

  const allIds = candidates.flatMap(imageIdsOf);
  progress.imagesTotal = new Set(allIds).size;
  tick();

  // ---- steps 1–3: images, then the rewrite, per post
  const prepared: BundlePostInput[] = [];
  const byId = new Map(candidates.map((p) => [p.id, p]));
  const assets = new Map<string, string>();
  let imageStop: MigrationStopInfo | null = null;

  for (const post of candidates) {
    try {
      for (const localId of imageIdsOf(post)) {
        if (assets.has(localId)) continue;
        const assetId = await ensureAsset(localId, source, report.images);
        if (assetId) assets.set(localId, assetId);
        progress.imagesDone += 1;
        tick();
      }
    } catch (err) {
      /*
       * A stop in the IMAGE phase does not discard the posts already prepared.
       * `IMAGE_SLOT_LIMIT` is 120/hour and a large library will meet it, so
       * "stop and report progress" has to mean the posts whose pictures are
       * already committed still get sent — one import slot buys up to
       * twenty-five of them, and the resumed run re-uploads nothing because
       * `assetMap` remembers.
       */
      imageStop = err instanceof MigrationStop ? err.info : { reason: 'error', detail: String(err) };
      break;
    }

    const content = rewriteDoc(post.content, assets);
    const rewritten: Post = { ...post, content, coverImage: rewriteCover(post, assets) };
    /*
     * VALIDATED AGAIN, ON WHAT IS ACTUALLY SENT. Step 0 checked the stored
     * document; this checks the rewritten one. They differ by exactly the image
     * srcs, and an `asset:` id that failed `IMAGE_ID` would be a 422 that costs
     * a rate-limit slot to discover. Cheap, and it closes the only gap between
     * "we validated it" and "we sent it".
     */
    const problem = checkUploadable(rewritten, content);
    if (problem) {
      report.excluded.push({ id: post.id, title: post.title, ...problem });
    } else {
      prepared.push(toBundlePost(rewritten, content));
    }
    progress.postsPrepared += 1;
    tick();
  }

  // ---- steps 4–7: batch, send, split on a permanent refusal
  progress.phase = 'uploading';
  tick();

  const sent: string[] = [];
  try {
    for (const batch of batchPosts(prepared)) {
      sent.push(...(await sendBatch(batch, byId, report)));
    }
  } catch (err) {
    if (!(err instanceof MigrationStop)) throw err;
    report.stoppedBy = err.info;
  }

  // ---- step 5: confirm by reading each id back, then stamp
  progress.phase = 'confirming';
  tick();

  for (const id of sent) {
    try {
      const post = await api.getPost(id);
      await cachePost(userId, post);
      await source.confirm(post);
      report.confirmed.push(id);
      progress.postsConfirmed += 1;
      tick();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        /*
         * The import reported success and the post is not there. That is not a
         * case any known code path produces, which is exactly why it is read
         * back: a counter in a response body proves the server parsed the
         * request, and reading the id proves the post exists.
         */
        report.failed.push({
          id,
          title: byId.get(id)?.title ?? id,
          detail: 'the blog accepted the upload but the post is not there',
        });
        continue;
      }
      report.stoppedBy = report.stoppedBy ?? stopInfoFor(err);
      break;
    }
  }

  if (!report.stoppedBy && imageStop) report.stoppedBy = imageStop;
  report.revisionsNotCarried = await source.countRevisions(report.confirmed);

  progress.phase = 'done';
  tick();
  return report;
}

/**
 * One image: mapped already, or uploaded now.
 *
 * `assetMap` IS CHECKED FIRST AND THAT IS WHAT MAKES A RESUMED RUN CHEAP. Image
 * uploads are bounded by `IMAGE_SLOT_LIMIT` (120/hour), so a library that takes
 * three runs to migrate would otherwise burn the same slots three times and
 * never finish. It is also why the mapping is written the moment the commit
 * succeeds rather than at the end of the post.
 *
 * Returns the asset id, or `null` when this image cannot be carried — the post
 * still migrates, with its src left alone.
 */
async function ensureAsset(
  localId: string,
  source: MigrationSource,
  tally: ImageTally,
): Promise<string | null> {
  const known = await db.assetMap.get(localId);
  if (known) {
    tally.reused += 1;
    return known.assetId;
  }

  const blob = await source.loadImage(localId);
  if (!blob) {
    // The document names an image whose bytes are not in this browser. Nothing
    // can be uploaded and nothing is lost by saying so — the post is the words.
    tally.missing += 1;
    return null;
  }

  try {
    const assetId = await uploadPrepared(await prepareForUpload(blob));
    await db.assetMap.put({ localId, assetId });
    tally.uploaded += 1;
    return assetId;
  } catch (err) {
    if (err instanceof ImageError && (err.status === 429 || err.status === 0)) {
      // The budget is gone, or the network is. Both are "come back later", and
      // both must stop the run rather than mark 400 images as broken.
      throw new MigrationStop({
        reason: err.status === 429 ? 'rate_limited' : 'offline',
        retryAfter: err.retryAfter,
        detail: err.message,
      });
    }
    tally.failed += 1;
    return null;
  }
}

/**
 * Send one batch, splitting it in half on a permanent refusal until the refusal
 * belongs to a single post.
 *
 * WHY SPLIT AT ALL, given that step 0 already ran the server's own schema and
 * both validators: because a 400 or a 422 that gets here is by definition
 * something step 0 did not predict, and without the split one surprise takes
 * twenty-four innocent posts with it — `server/routes/backup.ts` throws on the
 * first offender. The cost is rate-limit slots (log₂ n extra requests, each one
 * burning a slot even though it failed, F8), which is why the split is the
 * fallback and step 0 is the mechanism.
 */
async function sendBatch(
  posts: BundlePostInput[],
  byId: Map<string, Post>,
  report: MigrationReport,
): Promise<string[]> {
  try {
    await api.importBundle({
      format: BUNDLE_FORMAT,
      exportedAt: new Date().toISOString(),
      posts,
    });
    return posts.map((p) => p.id);
  } catch (err) {
    // 429 first: it is also `transient`, and reading it as merely retryable
    // would lose the `retryAfter` the resumed run needs.
    if (err instanceof ApiError && err.status === 429) {
      throw new MigrationStop({
        reason: 'rate_limited',
        retryAfter: err.retryAfter,
        detail: err.detail,
      });
    }
    if (err instanceof ApiError && (err.status === 400 || err.status === 422)) {
      if (posts.length === 1) {
        const id = posts[0].id;
        report.failed.push({
          id,
          title: byId.get(id)?.title ?? id,
          detail: err.detail ?? err.code,
        });
        return [];
      }
      const mid = Math.ceil(posts.length / 2);
      const head = await sendBatch(posts.slice(0, mid), byId, report);
      const tail = await sendBatch(posts.slice(mid), byId, report);
      return [...head, ...tail];
    }
    throw new MigrationStop(stopInfoFor(err));
  }
}

function stopInfoFor(err: unknown): MigrationStopInfo {
  if (err instanceof ApiError) {
    if (err.status === 429) return { reason: 'rate_limited', retryAfter: err.retryAfter };
    if (err.transient) return { reason: 'offline', detail: err.message };
    return { reason: 'error', detail: err.detail ?? err.message };
  }
  return { reason: 'error', detail: err instanceof Error ? err.message : String(err) };
}

// ------------------------------------------------------- the local-post source

/**
 * What the migration screen shows before the button.
 *
 * The survey runs step 0's checks and nothing else — no network, no uploads —
 * so the screen can list what will go, what cannot, and why, before the writer
 * has committed to anything.
 */
export interface MigrationSurvey {
  /** Un-migrated and uploadable, newest first. */
  pending: LocalPost[];
  /** Already confirmed on the server by an earlier run. */
  migrated: LocalPost[];
  /** Un-migrated and refused by step 0. */
  excluded: (ExcludedPost & { updatedAt: number })[];
  /** Distinct local image ids the pending posts reference. */
  imageCount: number;
  /** Snapshots that will not be carried (F4). */
  revisionCount: number;
}

export async function surveyLocalPosts(): Promise<MigrationSurvey> {
  const rows = await db.localPosts.toArray();
  rows.sort((a, b) => b.updatedAt - a.updatedAt);

  const pending: LocalPost[] = [];
  const migrated: LocalPost[] = [];
  const excluded: (ExcludedPost & { updatedAt: number })[] = [];

  for (const row of rows) {
    if (row.migratedAt != null) {
      migrated.push(row);
      continue;
    }
    const problem = checkUploadable(row, row.content);
    if (problem) {
      excluded.push({ id: row.id, title: row.title, updatedAt: row.updatedAt, ...problem });
      continue;
    }
    pending.push(row);
  }

  const imageIds = new Set(pending.flatMap(imageIdsOf));
  const revisionCount = await countLocalRevisions(pending.map((p) => p.id));
  return { pending, migrated, excluded, imageCount: imageIds.size, revisionCount };
}

async function countLocalRevisions(postIds: string[]): Promise<number> {
  if (!postIds.length) return 0;
  return db.localRevisions.where('postId').anyOf(postIds).count();
}

/**
 * Stamp one row as migrated, and touch nothing else on it.
 *
 * A read-modify-`put` inside one transaction rather than `Table.update`, and
 * the reason is a type error rather than a semantic one: Dexie's `UpdateSpec`
 * expands into a mapped type of dotted key paths, `DocNode` is recursive, and
 * TypeScript 6 reports TS2615 on `content` for ANY update to this table —
 * including this one, which does not mention `content`. Spelling the whole row
 * keeps the write type-checked against `LocalPost` instead of casting the check
 * away. The `get` is inside the transaction, so it cannot resurrect a row
 * something else deleted in between.
 */
async function stampMigrated(postId: string): Promise<void> {
  await db.transaction('rw', db.localPosts, async () => {
    const row = await db.localPosts.get(postId);
    if (!row) return;
    await db.localPosts.put({ ...row, migratedAt: Date.now() });
  });
}

/**
 * Migrate the pre-backend library.
 *
 * `confirm` STAMPS AND DOES NOT DELETE. Retiring the local copies is a separate,
 * explicit action (`retireLocalCopies`) that only becomes available once every
 * post is stamped — see plan §6.4's "retire" line. A migration that deleted as
 * it went would, on any partial failure, leave a library half in one place and
 * half in another with nothing able to tell which.
 */
export async function migrateLocalPosts(
  userId: string,
  onProgress?: ProgressFn,
): Promise<MigrationReport> {
  /*
   * EVERY UN-MIGRATED ROW, not `surveyLocalPosts().pending`. The survey applies
   * step 0's checks to decide what to SHOW; the run has to apply them itself,
   * because a post the survey filtered out would otherwise be absent from
   * `report.excluded` too — silently missing from the result screen rather than
   * listed with the reason it cannot be uploaded.
   */
  const rows = await db.localPosts.toArray();
  const pending = rows.filter((row) => row.migratedAt == null);
  pending.sort((a, b) => b.updatedAt - a.updatedAt);

  return migrate(
    userId,
    {
      posts: pending,
      async loadImage(localId) {
        return (await db.images.get(localId))?.blob ?? null;
      },
      async confirm(post) {
        await stampMigrated(post.id);
      },
      countRevisions: countLocalRevisions,
    },
    onProgress,
  );
}

/**
 * Migrate a bundle written by another device or another deployment.
 *
 * THE IMAGES ARE THE WHOLE REASON THIS IS NOT JUST `api.importBundle(bundle)`.
 * A bundle carries its pictures as base64 in `bundle.images` and the import
 * route restores none of them (`server/routes/backup.ts` counts them in
 * `ignored`), so handing the bundle straight to the route drops every picture
 * in it and rewrites nothing. Here each one is decoded to a `Blob` and uploaded
 * through the same slot/commit path as everything else, before the rewrite.
 */
export function importForeignBundle(
  userId: string,
  bundle: Bundle,
  onProgress?: ProgressFn,
): Promise<MigrationReport> {
  const images = new Map((bundle.images ?? []).map((img) => [img.id, img]));
  return migrate(
    userId,
    {
      posts: bundle.posts ?? [],
      async loadImage(localId) {
        const img = images.get(localId);
        if (!img) return null;
        try {
          return base64ToBlob(img.data, img.type);
        } catch {
          // A corrupt base64 payload is one lost picture, not a lost bundle.
          return null;
        }
      },
      // Nothing local to stamp: these rows are not in `localPosts`, and the
      // caller keeps the file.
      async confirm() {},
      async countRevisions() {
        return bundle.revisions?.length ?? 0;
      },
    },
    onProgress,
  );
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ------------------------------------------------------------------- retiring

/**
 * Whether "remove the local copies" may be offered at all.
 *
 * Every `localPosts` row stamped, and there is at least one — never "nothing
 * left to check, so yes". A library where one post failed step 0 forever is
 * exactly the library whose local copy must not be removed.
 */
export async function canRetireLocalCopies(): Promise<boolean> {
  const total = await db.localPosts.count();
  if (total === 0) return false;
  const unstamped = await db.localPosts.filter((p) => p.migratedAt == null).count();
  return unstamped === 0;
}

/**
 * Delete the local copies, once every post is on the server.
 *
 * THE IMAGE RULE IS THE CAREFUL ONE. A blob is deleted only if `assetMap` says
 * it was uploaded AND committed, and only if no surviving `localPosts` row
 * still references it. `assetMap` itself is kept: it costs two short strings
 * per image and it is what makes a re-import idempotent.
 *
 * Refuses rather than partially deleting if anything is still un-migrated, so
 * this cannot become the operation that removes the only copy of a post the
 * server never accepted.
 */
export async function retireLocalCopies(): Promise<{
  posts: number;
  revisions: number;
  images: number;
}> {
  if (!(await canRetireLocalCopies())) {
    throw new Error('Refusing to remove local copies: not every post is on the blog yet.');
  }

  const rows = await db.localPosts.toArray();
  const ids = rows.map((r) => r.id);
  const referenced = new Set(rows.flatMap(imageIdsOf));

  const uploaded = await db.assetMap.toArray();
  const removable = uploaded.map((m) => m.localId).filter((id) => referenced.has(id));

  const revisions = await db.localRevisions.where('postId').anyOf(ids).primaryKeys();

  await db.transaction('rw', db.localPosts, db.localRevisions, db.images, async () => {
    await db.localPosts.bulkDelete(ids);
    await db.localRevisions.bulkDelete(revisions as string[]);
    await db.images.bulkDelete(removable);
  });

  return { posts: ids.length, revisions: revisions.length, images: removable.length };
}
