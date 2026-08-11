import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { savePost } from './posts';
import {
  REVISION_COLUMNS,
  REVISION_META_COLUMNS,
  rowToRevision,
  rowToRevisionMeta,
} from './mapping';
import { pageLimit, encodeCursor, requireCursor } from './cursor';
import { NotFoundError } from './errors';
import type { AuthUser, Post, Revision, RevisionMeta } from '../../shared/types';

/**
 * Re-exported so the plan's `server/repo/revisions.ts#RevisionMeta` import path
 * resolves. It is DEFINED in `shared/types.ts`, next to `ListPost`, because it
 * is a projection of the domain model rather than a server detail — the
 * revision panel needs the same shape after Project C's cutover, and a second
 * declaration on this side is exactly the duplication the shared module exists
 * to prevent.
 */
export type { RevisionMeta } from '../../shared/types';

/**
 * Revision history (spec §5.3).
 *
 * Three rules hold this file together, and each of them is a way history is
 * lost when it is broken:
 *
 * - A LIST NEVER CARRIES BODIES. `content` is enumerated out of
 *   `REVISION_META_COLUMNS`, so no list query can return it by accident.
 * - RESTORE WRITES FORWARD. It goes through `savePost`, which bumps the
 *   revision and appends — it never rewinds the pointer, so the version you
 *   were on before the restore is still in the list afterwards.
 * - PRUNE ORDERS BY `revision`, NEVER `created_at`.
 */

// ---------------------------------------------------------------------- list

/**
 * Newest first, keyset-paginated.
 *
 * The cursor keys on `(revision, id)`. `revision` alone would do — it is UNIQUE
 * per post by the schema's own constraint, which is the same fact `pruneAutosaves`
 * relies on — but the row comparison costs nothing and keeps one cursor codec
 * across this and `listPosts`, so an undecodable cursor is handled in one place.
 */
export async function listRevisions(
  db: Db,
  postId: string,
  cursor?: string,
  limit?: number,
): Promise<{ items: RevisionMeta[]; nextCursor: string | null }> {
  const size = pageLimit(limit);
  const after = cursor === undefined ? null : requireCursor(cursor);
  const keyset = after
    ? sql`AND (revision, id) < (${after.sortValues[0]}, ${after.id})`
    : sql``;

  /*
   * `size + 1` rather than a second COUNT: the extra row is the only evidence
   * needed for "is there another page", and asking for a count would mean a
   * second scan of an unbounded table on every page.
   */
  const res = await db.execute(sql`
    SELECT ${sql.raw(REVISION_META_COLUMNS.join(', '))}
      FROM revisions
     WHERE post_id = ${postId} ${keyset}
     ORDER BY revision DESC, id DESC
     LIMIT ${size + 1}`);

  const rows = res.rows.slice(0, size);
  const items = rows.map(rowToRevisionMeta);
  const more = res.rows.length > size;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: more && last ? encodeCursor([last.revision], last.id) : null,
  };
}

// ----------------------------------------------------------------------- get

/** One full snapshot, document and all. */
export async function getRevision(db: Db, revId: string): Promise<Revision | null> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(REVISION_COLUMNS.join(', '))}
      FROM revisions WHERE id = ${revId}`);
  const row = res.rows[0];
  return row ? rowToRevision(row) : null;
}

// ------------------------------------------------------------------- restore

/**
 * Restore-forward: the snapshot is written as a NEW revision (spec §5.3).
 *
 * Never a rewind. Rewinding the pointer would make everything after the
 * restored version unreachable, so the one operation a writer reaches for when
 * they are afraid of losing work would be the operation that loses it. Going
 * through `savePost` also means the restored document is validated, derivation
 * is recomputed from it, and the CAS is the same one every other write uses.
 *
 * SCOPED TO THE POST, and that is a permission boundary as much as a
 * correctness one: `revId` arrives from a URL, and looking it up without
 * `post_id` would let anyone who can write to one post pull the title and body
 * of any revision of any other post into it.
 */
export async function restoreRevision(
  db: Db,
  postId: string,
  revId: string,
  actor: AuthUser,
): Promise<Post> {
  const res = await db.execute(sql`
    SELECT ${sql.raw(REVISION_COLUMNS.join(', '))}
      FROM revisions WHERE id = ${revId} AND post_id = ${postId}`);
  const row = res.rows[0];
  if (!row) throw new NotFoundError(revId);
  const snapshot = rowToRevision(row);

  return savePost(
    db,
    postId,
    {
      title: snapshot.title,
      subtitle: snapshot.subtitle,
      content: snapshot.content,
    },
    {
      actor,
      // 'manual', so a restore checkpoint is never reclaimed by pruning.
      kind: 'manual',
      note: `Restored revision ${snapshot.revision}`,
    },
  );
}

// --------------------------------------------------------------------- prune

/** `src/data/posts.ts:193` — all manual/publish/status snapshots survive. */
export const AUTOSAVE_KEEP = 30;

/**
 * Bound autosave history without losing a meaningful checkpoint.
 *
 * ORDER BY `revision DESC`, NEVER `created_at DESC`. `created_at` is
 * epoch-milliseconds taken from a single `now` per statement, so a burst of
 * autosaves — which is exactly what an editor produces — ties on it. `ORDER BY
 * created_at DESC LIMIT 30` over a tied set is a nondeterministic choice, which
 * means an older revision can survive while a newer one is deleted: the client's
 * `light.sort((a,b) => b.createdAt - a.createdAt)` has the same defect.
 * `revision` is UNIQUE per post by the schema's own constraint, so ordering on
 * it is total and the kept set is the same on every run.
 *
 * The pointer is excluded explicitly. A row the post itself names is not
 * history, it is the current version, and deleting it would leave the post
 * unable to show where it came from.
 *
 * One statement, and not wired into `savePost`: pruning is O(history) and the
 * write path is the typing path. The client throttles it to one save in ten for
 * that reason; here it is the route layer's to schedule.
 */
export async function pruneAutosaves(db: Db, postId: string): Promise<number> {
  const res = await db.execute(sql`
    WITH gone AS (
      DELETE FROM revisions
       WHERE post_id = ${postId}
         AND kind = 'autosave'
         AND revision IS DISTINCT FROM (SELECT revision FROM posts WHERE id = ${postId})
         AND id NOT IN (
           SELECT id FROM revisions
            WHERE post_id = ${postId} AND kind = 'autosave'
            ORDER BY revision DESC
            LIMIT ${AUTOSAVE_KEEP})
      RETURNING id
    )
    SELECT count(*)::int AS n FROM gone`);
  return Number(res.rows[0].n);
}
