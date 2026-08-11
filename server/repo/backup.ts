import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  POST_COLUMNS,
  REVISION_COLUMNS,
  postColumns,
  rowToPost,
  rowToRevision,
} from './mapping';
import type { Post, Revision } from '../../shared/types';

/**
 * The two whole-store queries backup needs (spec §5.5).
 *
 * In their own file rather than in `posts.ts`/`revisions.ts` because they are
 * the only unpaginated reads in the application and they belong together with
 * the reason they are allowed to be: this is the escape hatch, and an escape
 * hatch that hands back page one of your writing is not one.
 *
 * COLUMNS ARE STILL ENUMERATED. `content_text` and the generated `search`
 * tsvector are storage details that are not on `Post`, and a `SELECT *` here
 * would put both in a file the writer is told is their backup — the tsvector
 * being an unbounded blob of lexemes and positions.
 */

export interface StoreDump {
  posts: Post[];
  revisions: Revision[];
}

/**
 * THE DOCUMENTED CEILING (spec §5.6).
 *
 * This is deliberately not paginated and deliberately not capped. A cap would
 * silently truncate a backup, which is data loss in the one feature that exists
 * to prevent it — a writer cannot tell a complete bundle from a clipped one by
 * looking at it. The real ceiling is the function's memory and response limits,
 * and spec §5.6 already says so: per-post migration exists precisely because
 * one bundle does not fit through a 4.5 MB request, and this route is the
 * file-restore path, not the migration path.
 */
export async function exportAll(db: Db): Promise<StoreDump> {
  const posts = await db.execute(sql`
    SELECT ${sql.raw(postColumns('p'))}, u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id
     ORDER BY p.created_at ASC, p.id ASC`);

  const revisions = await db.execute(sql`
    SELECT ${sql.raw(REVISION_COLUMNS.join(', '))}
      FROM revisions
     ORDER BY post_id ASC, revision ASC`);

  return {
    posts: posts.rows.map((row) => rowToPost(row, String(row.author_name))),
    revisions: revisions.rows.map(rowToRevision),
  };
}

/**
 * Which of these ids the store already holds.
 *
 * Import PRESERVES incoming post ids (spec §5.5) and treats a collision as
 * "already imported, skip", so this is what makes re-importing the same bundle
 * — or importing it from a second device — idempotent rather than duplicating.
 *
 * One statement with `= ANY`, not a loop of existence checks: a bundle is
 * hundreds of posts and a round trip each would dominate the whole import.
 */
export async function existingPostIds(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.execute(sql`
    SELECT id FROM posts WHERE id = ANY(${sql.param(ids)}::text[])`);
  return new Set(res.rows.map((row) => String(row.id)));
}

/** Re-exported so a caller does not have to reach into `./mapping` for it. */
export { POST_COLUMNS };
