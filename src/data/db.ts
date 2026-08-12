import Dexie, { type Table } from 'dexie';
import type { ListPost, Post, PostPatch, Revision, StoredImage } from './types';

/**
 * FOUR KINDS OF ROW, and telling them apart is the whole design (plan §2.1).
 *
 * `posts` and `revisions` are a **cache** of what the server holds, scoped to
 * one user and thrown away when the session changes. `localPosts` and
 * `localRevisions` are the **pre-backend library** — posts written into this
 * browser before it had an account to write them to, which for anything never
 * uploaded is the writer's ONLY copy. They are not cache and nothing in
 * `cache.ts` may delete them.
 *
 * Two earlier versions of this plan blurred that line and both died of it: v1
 * put list projections into `posts` and painted empty documents over real
 * posts, and v2 stamped the pre-backend rows with an owner, which made an
 * ordinary logout delete the writer's entire library.
 */

/**
 * A cached server post. Full `Post` — **never a row without `content`** — plus
 * the two fields the cache itself owns.
 *
 * `src/routes/Editor.tsx` is frozen: `:48` live-queries `db.posts.get(id)` and
 * `:105–126` hydrates the TipTap buffer exactly once per id, guarded by
 * `loadedId === post.id`, so a later, better row can never re-hydrate. A row
 * here without `content` therefore paints an empty document over a real post
 * and the writer's first keystroke autosaves it. `cache.ts` enforces this at
 * every write; the type is the second line of defence, not the first.
 *
 * Both extra fields are OPTIONAL, and for the same reason `Revision.authorId`
 * is optional in `shared/types.ts`: the type must not lie about rows that
 * already exist. `src/data/posts.ts` and `src/data/backup.ts` still write plain
 * `Post` rows into this store until Task 19 repoints them at the API, and a
 * required field here would only move that lie behind a `!`. A row with no
 * `ownerUserId` is invisible to every user-scoped reader in `cache.ts`, which
 * is the safe direction to fail.
 */
export type CachedPost = Post & {
  /** `users.id` this row was fetched for. See I2 — nothing paints unscoped. */
  ownerUserId?: string;
  /**
   * Set when this row carries the writer's unsent words — the overlay written
   * by a failed save (plan §2.3). A row carrying it is replaced only by a
   * STRICTLY higher revision, so a background revalidation that returns the
   * unchanged server row cannot erase recovered work.
   */
  pendingAt?: number | null;
};

/**
 * A cached list projection. `ListPost` has no `content` by construction
 * (`Omit<Post, 'content'>`), which is exactly why these rows live in their own
 * store rather than in `posts`: `GET /api/posts` never returns bodies, and a
 * list response that could reach the editor's store is the v1 defect.
 */
export type CachedListPost = ListPost & { ownerUserId: string };

/**
 * A cached revision body. Full `Revision` only, for the same reason as
 * `CachedPost` and more sharply: `src/editor/RevisionPanel.tsx:41` is frozen
 * and auto-selects `revisions[0]`, then renders `selected.content` through
 * `DocRenderer`, whose `doc.content ?? []` throws on an undefined `doc`.
 * `ownerUserId` is optional for the same pre-cutover-writers reason.
 */
export type CachedRevision = Revision & { ownerUserId?: string };

/**
 * A post from the pre-backend library. `migratedAt` is stamped only once the
 * server has confirmed the upload by returning the post (plan §6.4 step 5);
 * until then this row is the only copy and migration never rewrites it.
 */
export type LocalPost = Post & { migratedAt: number | null };

/**
 * Where an unsent write stops. THREE terminal states, not two — `blocked` is
 * the arm without which a permanent 422 (see §9's `MAX_CONTENT_TEXT_BYTES`) is
 * a silent black hole: retried on every boot, never marked, therefore never
 * listed by `#/recover` and never shown by `PostGate`, while the editor simply
 * never saves and says nothing about it.
 */
export type PendingState =
  /** Retryable — offline, 5xx, 429. Replay will try again. */
  | 'queued'
  /** Replay hit a 409: the post moved on and two versions exist. A human chooses. */
  | 'unresolved'
  /** Replay hit a permanent 4xx. Listed with the server's reason, and exportable. */
  | 'blocked';

/** One post's unsent write, for one user. See `src/data/pending.ts`. */
export interface PendingWrite {
  postId: string;
  /** `users.id` this patch belongs to. Half of the primary key — see below. */
  ownerUserId: string;
  patch: PostPatch;
  /** The revision the failed save was based on, for a rebase or a diff. */
  baseRevision: number | null;
  /**
   * Per-row monotonic counter, bumped on every queued write. A save's success
   * path may only delete a row whose `seq` is not newer than the one that save
   * carried — see `clearPendingAfterSave`.
   */
  seq: number;
  state: PendingState;
  /** The server's reason, for a `blocked` row's listing on `#/recover`. */
  detail?: string;
  /** The field path a 422 named, when it named one. */
  path?: string;
  updatedAt: number;
}

/** Local image id → server asset id. Makes image migration idempotent. */
export interface AssetMapping {
  localId: string;
  assetId: string;
}

export class StudioDB extends Dexie {
  posts!: Table<CachedPost, string>;
  postList!: Table<CachedListPost, string>;
  revisions!: Table<CachedRevision, string>;
  localPosts!: Table<LocalPost, string>;
  localRevisions!: Table<Revision, string>;
  pending!: Table<PendingWrite, [string, string]>;
  assetMap!: Table<AssetMapping, string>;
  images!: Table<StoredImage, string>;

  constructor() {
    super('publishing-studio');
    this.version(1).stores({
      posts: 'id, status, updatedAt, publishedAt, deletedAt, category, slug',
      revisions: 'id, postId, [postId+revision], createdAt',
      images: 'id, createdAt',
    });
    this.version(2)
      .stores({
        posts:
          'id, status, updatedAt, publishedAt, deletedAt, category, slug, ownerUserId, pendingAt',
        postList:
          'id, status, updatedAt, publishedAt, deletedAt, category, slug, ownerUserId',
        revisions: 'id, postId, [postId+revision], createdAt, ownerUserId',
        localPosts:
          'id, status, updatedAt, publishedAt, deletedAt, category, slug, migratedAt',
        localRevisions: 'id, postId, [postId+revision], createdAt',
        // COMPOUND PRIMARY KEY, and it is not cosmetic. Measured under this
        // repo's own dexie 4.4.4 + fake-indexeddb: with `postId` alone as the
        // key, `put({postId:'p_9', ownerUserId:'A'})` followed by
        // `put({postId:'p_9', ownerUserId:'B'})` leaves ONE row and A's unsent
        // words are gone with no error and nothing to recover them from. I4 —
        // "B's editor never replays A's patch" — cannot be expressed without
        // this, which is why every reader in `pending.ts` takes a user id.
        pending: '[postId+ownerUserId], postId, ownerUserId, state, updatedAt',
        assetMap: 'localId, assetId',
        images: 'id, createdAt',
      })
      .upgrade(async (tx) => {
        // The v1 rows predate accounts entirely: they are the writer's
        // PRE-BACKEND library and, for anything never uploaded, the only copy
        // that exists anywhere. They move wholesale into stores the cache
        // machinery cannot reach, rather than being stamped with whichever
        // account happens to log in first — that was v2's idea and it made an
        // ordinary logout delete the lot.
        //
        // Copy first, delete second. The two halves run inside one IndexedDB
        // versionchange transaction, so a crash between them rolls the whole
        // upgrade back and the next boot starts again from intact v1 rows;
        // `bulkPut` rather than `bulkAdd` so that re-run overwrites the copy
        // instead of failing on a duplicate key. There is no ordering here in
        // which the rows exist nowhere.
        const posts = await tx.table<Post>('posts').toArray();
        await tx
          .table<LocalPost>('localPosts')
          .bulkPut(posts.map((p) => ({ ...p, migratedAt: null })));
        const revisions = await tx.table<Revision>('revisions').toArray();
        await tx.table<Revision>('localRevisions').bulkPut(revisions);
        await tx.table('posts').clear();
        await tx.table('revisions').clear();
      });
  }
}

export const db = new StudioDB();

/**
 * Storage health. IndexedDB can be unavailable (private mode, disabled
 * storage) or full. Silently swallowing that would mean a writer typing for an
 * hour into a store that never accepted a single write, so it is surfaced.
 */
export type StorageStatus =
  | { ok: true; usage?: number; quota?: number }
  | { ok: false; reason: 'blocked' | 'unavailable' | 'full'; detail: string };

export async function checkStorage(): Promise<StorageStatus> {
  try {
    // db.open() NEVER settles while an upgrade is blocked by another tab, so
    // awaiting it bare meant the "another tab is holding the database" notice
    // could never render — the user just watched skeletons forever.
    await Promise.race([
      db.open(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('blocked: database did not open')), 3000),
      ),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const reason = /blocked|version/i.test(detail) ? 'blocked' : 'unavailable';
    return { ok: false, reason, detail };
  }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.usage && est.usage / est.quota > 0.95) {
      return {
        ok: false,
        reason: 'full',
        detail: 'Local storage for this site is almost full.',
      };
    }
    return { ok: true, usage: est?.usage, quota: est?.quota };
  } catch {
    return { ok: true };
  }
}

// A blocked upgrade otherwise hangs every query forever with no explanation.
db.on('blocked', () => {
  console.warn('IndexedDB upgrade blocked by another tab holding the old version.');
});

/** Cheap, collision-resistant, sortable-ish id. No dependency needed. */
export function newId(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
