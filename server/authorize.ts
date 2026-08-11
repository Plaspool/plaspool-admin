import { ForbiddenError } from './middleware/errors';
import type { AuthUser, ListPost, Post } from '../shared/types';

/**
 * Authorization, in ONE function called by every route (spec §6).
 *
 * Not scattered through handlers, and that is the whole design. A permission
 * rule inlined into a handler is a rule that exists once per handler: the next
 * route is written by copying the one above it, the copy is subtly different,
 * and the difference is invisible until somebody edits a post they did not
 * write. Here there is one table, one place to read it, and one place to change
 * it.
 *
 * THE THREE RULES:
 *
 * - **read** — every authenticated user reads everything. This is one shared
 *   blog with an invite-only writer list, not a multi-tenant host; drafts are
 *   visible to colleagues by design, and the dashboard is built around that.
 * - **write** — author or owner. A writer owns their own drafts; the owner can
 *   fix anything, which is what makes the owner role useful at all.
 * - **destroy** — owner only.
 *
 * **The destroy rule is the one place spec §5.2 and spec §6 disagree**, and
 * this file follows §6. §5.2's table annotates `DELETE /posts/:id` with
 * "destroy — author or owner"; §6, which is the section that defines
 * authorization and names this function, says "Destroy, empty-trash and invite
 * management are owner-only". §6 wins because it is the normative statement and
 * because of what the operation is: `destroyPost` is the only irreversible
 * action in the application and it CASCADEs away every revision, so a writer
 * who mistakes it for "trash" loses history nobody can restore. Trash is the
 * reversible door a writer already has. Recorded here rather than resolved
 * silently, because a later reader will find §5.2 and think this is a bug.
 */
export type Action = 'read' | 'write' | 'destroy';

/**
 * `ListPost` as well as `Post`: a list response carries no `content`, and the
 * only field a permission decision reads is `authorId`. Typing this to `Post`
 * would force a caller holding a list projection to fetch the document just to
 * ask whether it may edit it.
 */
export function authorize(
  post: Pick<Post | ListPost, 'authorId'>,
  user: AuthUser,
  action: Action,
): boolean {
  if (action === 'read') return true;
  if (action === 'destroy') return user.role === 'owner';
  return post.authorId === user.id || user.role === 'owner';
}

/**
 * The same decision, as a 403.
 *
 * Exists so no handler writes `if (!authorize(...)) throw new ForbiddenError()`
 * — which is the shape that gets copied without the `!` exactly once.
 */
export function assertAuthorized(
  post: Pick<Post | ListPost, 'authorId'>,
  user: AuthUser,
  action: Action,
): void {
  if (!authorize(post, user, action)) throw new ForbiddenError();
}
