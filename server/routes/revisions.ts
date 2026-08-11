import { Hono } from 'hono';
import { z } from 'zod';
import { pathParam, readQuery, str } from '../middleware/errors';
import { requireAuth } from '../middleware/session';
import { assertAuthorized } from '../authorize';
import { getPost } from '../repo/posts';
import { getRevision, listRevisions, restoreRevision } from '../repo/revisions';
import { NotFoundError } from '../repo/errors';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import type { Db } from '../db/client';
import type { Post } from '../../shared/types';

/**
 * Revision history (spec §5.3).
 *
 * Three rules, each of which is a way history is lost when it is broken:
 *
 * - **a list never carries bodies.** `listRevisions` selects
 *   `REVISION_META_COLUMNS`, which enumerates `content` out. History is
 *   unbounded in rows AND each row holds a whole document, so a list that
 *   carried bodies would ship the entire document store to draw a sidebar.
 * - **restore writes forward.** It goes through `savePost`, so the version you
 *   were on before the restore is still in the list afterwards. Rewinding the
 *   pointer would make the one operation a writer reaches for when they are
 *   afraid of losing work the operation that loses it.
 * - **a revision is reached through its post.** `revId` arrives from a URL;
 *   restoring one without scoping the lookup to `post_id` would let anyone who
 *   can write to one post pull the title and body of any revision of any other
 *   post into it.
 */
export const routes = new Hono<AppEnv>();

const auth = requireAuth();

const PageQuery = z
  .object({
    cursor: str().optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

/** The post, or a 404 — absent and destroyed are the same answer (spec §8). */
async function requirePost(db: Db, id: string): Promise<Post> {
  const post = await getPost(db, id);
  if (!post) throw new NotFoundError(id);
  return post;
}

routes.get('/posts/:id/revisions', auth, async (c) => {
  const db = currentDb(c);
  // Read the post first so a caller cannot probe for post ids by watching the
  // difference between "no such post" and "no revisions".
  const post = await requirePost(db, pathParam(c, 'id'));
  assertAuthorized(post, currentUser(c), 'read');

  const { cursor, limit } = readQuery(c, PageQuery);
  return c.json(await listRevisions(db, post.id, cursor, limit));
});

/**
 * One full snapshot.
 *
 * THE POST IS FETCHED FOR THE PERMISSION DECISION, not for the body. Reads are
 * universal today (spec §6), so this second lookup can never change the answer
 * — and that is exactly why it is here: the day reads stop being universal,
 * this route already asks `authorize()` about the right resource instead of
 * being the one that silently kept serving.
 */
routes.get('/revisions/:revId', auth, async (c) => {
  const db = currentDb(c);
  const revId = pathParam(c, 'revId');
  const revision = await getRevision(db, revId);
  if (!revision) throw new NotFoundError(revId);
  assertAuthorized(await requirePost(db, revision.postId), currentUser(c), 'read');
  return c.json({ revision });
});

/**
 * Restore-forward: the snapshot becomes a NEW revision.
 *
 * No `baseRevision` in the body. A restore is a deliberate "put this back",
 * not an edit derived from a version the caller was looking at, so refusing it
 * because an autosave landed in between would mean the button fails exactly
 * when the editor is busiest. The write is still one CAS against whatever is
 * currently stored.
 */
routes.post('/posts/:id/revisions/:revId/restore', auth, async (c) => {
  const db = currentDb(c);
  const user = currentUser(c);
  const post = await requirePost(db, pathParam(c, 'id'));
  assertAuthorized(post, user, 'write');
  return c.json({
    post: await restoreRevision(db, post.id, pathParam(c, 'revId'), user),
  });
});
