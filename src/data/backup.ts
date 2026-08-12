import { api } from './api';
import { db } from './db';
import { docToText, isValidDoc } from './doc';
import { ApiError } from './errors';
import { imageIdsOf, importForeignBundle, type MigrationReport, type ProgressFn } from './migrate';
import { createDraftShape } from './posts';
import { BUNDLE_FORMAT, BUNDLE_FORMAT_PREFIX } from './types';
import type {
  AuthUser,
  Bundle,
  BundleImage,
  DocNode,
  ListPost,
  Post,
  Revision,
  StatusFilter,
} from './types';

/**
 * The escape hatch, rebuilt for a world with a server in it (plan §8.1, F12).
 *
 * WHAT THIS FILE USED TO DO AND WHY IT HAD TO CHANGE. It read `db.posts`,
 * `db.revisions` and `db.images` directly and wrote them back with `bulkAdd`.
 * After the cutover both halves are broken in ways nothing on screen would
 * show:
 *
 * - **Export** would carry only the posts whose bodies happened to be in the
 *   cache — i.e. the ones the writer had opened — under a toast reading
 *   "Exported N posts with images and history". The number would be right and
 *   the claim false, and the storage-emergency "Export now" button fires
 *   exactly when the cache is least complete.
 * - **Import** would `bulkAdd` rows into a cache store with no `ownerUserId`
 *   and no `postList` projection: invisible in the grid it had just claimed to
 *   fill, deleted by the next `clearCache`, and never sent anywhere.
 *
 * So there are now THREE exports, and which one you want depends on where the
 * words actually live:
 *
 * | source | route | why |
 * |---|---|---|
 * | the blog, as owner | `GET /api/export` | server-side and complete |
 * | the blog, as writer | rebuilt here from `GET /posts` + `/posts/:id` + revisions | `GET /api/export` is `requireOwner()` and there is no writer-scoped route, so leaving it there takes the backup escape hatch away from every non-owner |
 * | this device only | `localPosts` / `localRevisions` / `images` | the pre-backend corpus, which exists nowhere else — this is now the local export's real job |
 *
 * And **import routes through `src/data/migrate.ts`'s pipeline**, not through
 * Dexie, so an imported bundle lands on the server where the app can see it.
 * A foreign bundle carries its pictures as base64 in `bundle.images` rather
 * than as `db.images` rows, and `importForeignBundle` is the arm that decodes
 * and uploads each one before the rewrite — without it every picture in an
 * imported bundle is silently dropped.
 */

// ------------------------------------------------------------------ exports

export { BUNDLE_FORMAT };
export type { Bundle, BundleImage };

/** `MAX_PAGE_LIMIT` in `server/repo/cursor.ts`. A larger value is a 400. */
const PAGE_LIMIT = 100;

/** The same non-negotiable bound `sync.ts` puts on a cursor walk. */
const MAX_PAGES = 200;

/**
 * `server/repo/query.ts` pushes `deleted_at IS NULL` for every status except
 * `trash`, so one pass would silently omit the trash from a backup — the one
 * place a writer looks for something they deleted by accident.
 */
const LIST_VIEWS: StatusFilter[] = ['all', 'trash'];

/** How far a writer-side export has got. Sequential, so this is honest. */
export interface ExportProgress {
  posts: number;
  total: number;
}

export type ExportProgressFn = (progress: ExportProgress) => void;

/**
 * Everything this account can get out of the blog.
 *
 * The owner path is one request. The writer path is one request per post plus
 * one per revision, which is slow and is the point: a backup that only the
 * owner can take is not an escape hatch, it is a permission. Ghost's export is
 * admin-only too, so this is ahead of that bar rather than level with it.
 */
export async function exportBundle(
  user: AuthUser,
  onProgress?: ExportProgressFn,
): Promise<Bundle> {
  if (user.role === 'owner') {
    try {
      return await api.exportAll();
    } catch (err) {
      /*
       * A 403 here means the role this device is holding is stale — the
       * session says owner and the server disagrees. Falling through to the
       * writer rebuild gets the words out either way, which is the entire
       * purpose of this function; refusing would strand someone on the
       * strength of a cached field.
       *
       * A 429 is deliberately NOT caught. `GET /export` is 5/hour and the
       * fallback is hundreds of requests, so "wait twelve minutes" must not be
       * turned into a stampede by an error handler.
       */
      if (!(err instanceof ApiError) || err.status !== 403) throw err;
    }
  }
  return exportAsWriter(onProgress);
}

/**
 * The same `Bundle` shape, assembled from routes every writer already has.
 *
 * Sequential rather than pooled, and that is a choice about who pays: an
 * export is a background chore the writer started deliberately, so the polite
 * version — one request at a time, nothing queued behind it — costs them
 * minutes and costs the server nothing. `syncRevisions` pools because a writer
 * is waiting on the History panel; nobody is waiting on this.
 */
async function exportAsWriter(onProgress?: ExportProgressFn): Promise<Bundle> {
  const rows = await listEveryPost();
  const posts: Post[] = [];
  const revisions: Revision[] = [];

  onProgress?.({ posts: 0, total: rows.length });
  for (const row of rows) {
    let post: Post;
    try {
      post = await api.getPost(row.id);
    } catch (err) {
      /*
       * A post listed a moment ago and gone now was destroyed between the two
       * requests. Skipping it is right: there is nothing to carry, and failing
       * the whole export over one row would mean a library with any churn in
       * it can never be backed up.
       */
      if (err instanceof ApiError && err.status === 404) continue;
      throw err;
    }
    posts.push(post);
    revisions.push(...(await revisionsOf(post.id)));
    onProgress?.({ posts: posts.length, total: rows.length });
  }

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    posts,
    revisions,
    /*
     * `images: []`, MATCHING `GET /api/export` EXACTLY. The bytes live in
     * object storage now, and a post's document references them by id, so a
     * bundle restored into this deployment finds every picture where it left
     * it. The cost is stated rather than hidden: this bundle carried into a
     * DIFFERENT deployment restores the words and not the pictures. The bundle
     * that does carry bytes is `exportLocalBundle`, because that corpus is the
     * only one whose bytes exist nowhere but here.
     */
    images: [],
  };
}

/** Every id in both status views, in the order the server returns them. */
async function listEveryPost(): Promise<ListPost[]> {
  const rows: ListPost[] = [];
  const seen = new Set<string>();
  for (const status of LIST_VIEWS) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await api.listPosts({ status, cursor, limit: PAGE_LIMIT });
      for (const item of res.items) {
        // The two views are disjoint by construction, but a post trashed
        // between the two walks would appear in both — and a duplicated id is
        // a 400 from `POST /import`, i.e. a bundle that cannot be restored.
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        rows.push(item);
      }
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  }
  return rows;
}

/**
 * Every snapshot of one post, bodies included.
 *
 * Paged rather than one-shot, unlike `syncRevisions`, which is happy with the
 * newest hundred because it is feeding a panel. A backup that quietly stops at
 * the page boundary is a backup that loses history nobody knows is missing.
 */
async function revisionsOf(postId: string): Promise<Revision[]> {
  const out: Revision[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const listing = await api.listRevisions(postId, cursor, PAGE_LIMIT);
    for (const meta of listing.items) {
      try {
        out.push(await api.getRevision(meta.id));
      } catch (err) {
        // The server prunes autosaves to the newest 30, so a body can genuinely
        // disappear between the listing and the fetch. Same rule as `sync.ts`.
        if (err instanceof ApiError && err.status === 404) continue;
        throw err;
      }
    }
    if (!listing.nextCursor) break;
    cursor = listing.nextCursor;
  }
  return out;
}

/**
 * The pre-backend library, bytes and all.
 *
 * THIS IS THE ONE EXPORT THAT CANNOT BE RECREATED FROM ANYWHERE ELSE, which is
 * what the local export is FOR now that the account's posts have a server. A
 * `localPosts` row that was never migrated exists in exactly one browser
 * profile on one machine; `#/migrate` is how it gets to the blog and this is
 * how it gets onto a disk in the meantime.
 *
 * **Every blob in `db.images` is carried, not only the referenced ones.** An
 * unreferenced blob costs bytes in a file; a dropped one is gone. The store
 * means exactly one thing after the cutover — the pre-backend image library,
 * bytes no server has — so there is nothing else in it to exclude.
 */
export async function exportLocalBundle(): Promise<Bundle> {
  const [rows, revisions, images] = await Promise.all([
    db.localPosts.toArray(),
    db.localRevisions.toArray(),
    db.images.toArray(),
  ]);

  return {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    /*
     * Rebuilt through `createDraftShape` rather than spread, so `migratedAt` —
     * a field the v1→v2 upgrade adds and only this browser cares about — does
     * not travel. `BundlePost` is `.strict()`, and a bundle carrying a field
     * the import route has never heard of is a 400 that burns one of five
     * hourly slots before the body is even read (F8).
     */
    posts: rows.map((row) => createDraftShape(row)),
    revisions,
    images: await Promise.all(images.map(toBundleImage)),
  };
}

async function toBundleImage(img: {
  id: string;
  type: string;
  width: number;
  height: number;
  blob: Blob;
}): Promise<BundleImage> {
  return {
    id: img.id,
    type: img.type,
    width: img.width,
    height: img.height,
    data: await blobToBase64(img.blob),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // Chunked so a multi-megabyte image doesn't blow the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---------------------------------------------------------------- downloads

export function download(filename: string, contents: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

/** The account's posts. Returns how many are in the file. */
export async function downloadJSONBundle(
  user: AuthUser,
  onProgress?: ExportProgressFn,
): Promise<number> {
  const bundle = await exportBundle(user, onProgress);
  download(`blog-admin-backup-${stamp()}.json`, JSON.stringify(bundle), 'application/json');
  return bundle.posts.length;
}

/**
 * The pre-backend corpus. A DIFFERENT FILENAME, deliberately: these two
 * bundles look identical from the outside and restoring the wrong one is the
 * mistake a shared prefix invites.
 */
export async function downloadLocalBundle(): Promise<number> {
  const bundle = await exportLocalBundle();
  download(`blog-admin-this-device-${stamp()}.json`, JSON.stringify(bundle), 'application/json');
  return bundle.posts.length;
}

// ------------------------------------------------------------------ imports

export class ImportError extends Error {}

/**
 * A bundle, or a sentence explaining why the file is not one.
 *
 * The prefix rather than the exact format string, so a v1 bundle written by an
 * older build of this app is still recognisable as one of ours — the same
 * check `server/routes/backup.ts` makes.
 */
export function parseBundle(json: string): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ImportError('That file isn’t valid JSON.');
  }
  const bundle = parsed as Partial<Bundle> | null;
  if (
    !bundle ||
    typeof bundle.format !== 'string' ||
    !bundle.format.startsWith(BUNDLE_FORMAT_PREFIX) ||
    !Array.isArray(bundle.posts)
  ) {
    // Deliberately not naming the publication. `data/` is the layer that lifts
    // onto a server almost unchanged (ARCHITECTURE §1), and importing the brand
    // here would tie it to one deployment's identity for the sake of one noun.
    throw new ImportError('That doesn’t look like a backup file from this app.');
  }
  return {
    format: bundle.format,
    exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : '',
    posts: bundle.posts,
    revisions: Array.isArray(bundle.revisions) ? bundle.revisions : [],
    images: Array.isArray(bundle.images) ? bundle.images : [],
  };
}

/**
 * Fill in whatever a hand-written or older bundle left out.
 *
 * `BundlePost` is `.strict()` AND complete, so a post missing `excerptSource`
 * or `template` is a Zod issue rather than a defaulted field — and a Zod issue
 * reaches the writer as a developer's sentence about a post they can see is
 * fine. `createDraftShape` is the function the rest of the app already uses to
 * answer "what is a post with these bits filled in", so it answers here too.
 *
 * THE DOCUMENT IS THE EXCEPTION. `createDraftShape` substitutes `EMPTY_DOC`
 * for anything unparseable, which would turn "this post cannot be imported"
 * into "this post imported, empty" — silently, with a success toast over it.
 * A broken document is passed through untouched so `checkUploadable` refuses
 * it and the review screen lists it with the reason.
 */
function normalise(raw: Post): Post {
  const shaped = createDraftShape(raw);
  if (isValidDoc(raw?.content)) return shaped;
  return { ...shaped, content: raw?.content as DocNode };
}

/**
 * Import a bundle by UPLOADING it, which is the only way it can ever be seen.
 *
 * Everything hard about this lives in `src/data/migrate.ts` and is shared with
 * `#/migrate`: local validation against the server's own Zod schema before a
 * byte is sent (because `limit()` runs before `readJson`, so a refused body
 * still burns one of five hourly slots), image upload through the slot/commit
 * path with `assetMap` making a resumed run free, the `asset:` rewrite done in
 * memory, batching at 25 posts or 1.5 MB, and a halving retry on a surprise
 * 400 or 422 so one bad post does not take twenty-four good ones with it.
 *
 * The report is returned rather than reduced to a count. "Imported 12 posts"
 * over a bundle of 14 is the shape of answer this project keeps finding in its
 * own defect log; the two that did not go are the interesting part.
 */
export async function importBundle(
  userId: string,
  json: string,
  onProgress?: ProgressFn,
): Promise<MigrationReport> {
  const bundle = parseBundle(json);
  return importForeignBundle(
    userId,
    { ...bundle, posts: bundle.posts.map(normalise) },
    onProgress,
  );
}

/**
 * How many distinct pictures a bundle is carrying, for the screen that offers
 * the import. Reads the documents rather than `bundle.images.length`, because
 * the answer a writer wants is "how many of my pictures come with it", and a
 * bundle can hold blobs nothing references.
 */
export function bundleImageCount(bundle: Bundle): number {
  const referenced = new Set(bundle.posts.flatMap((p) => imageIdsOf(p)));
  const carried = new Set((bundle.images ?? []).map((i) => i.id));
  return [...referenced].filter((id) => carried.has(id)).length;
}

// ------------------------------------------------------------------- plain

/** A plain-text fallback that is readable without any tooling at all. */
export function postToPlainText(post: Post): string {
  return [post.title || 'Untitled', post.subtitle, '', docToText(post.content)]
    .filter((s) => s !== undefined)
    .join('\n');
}
