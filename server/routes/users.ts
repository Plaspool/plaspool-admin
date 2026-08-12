import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireOwner } from '../middleware/session';
import {
  countActiveOwners,
  disableUser,
  enableUser,
  findUserById,
  listUsers,
} from '../repo/users';
import { NotFoundError } from '../repo/errors';
import { uuidParam } from './auth';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';

/**
 * The team surface (HANDOFF §2 A2): who has an account, and whether they can
 * still use it.
 *
 * OWNER ONLY, EVERY ROUTE. Spec §6 already reserves invites, export and destroy
 * for the owner; revoking a colleague's access belongs in the same set, and the
 * list itself is the email address of every person with a login — which is
 * exactly what the whole of `server/routes/auth.ts` is written to keep an
 * attacker from assembling.
 *
 * `requireOwner()` IS ATTACHED PER ROUTE, never as `routes.use('*', …)`. The
 * long version is in `server/routes/posts.ts`: `app.route('/api', users)`
 * flattens this router into the parent, so a blanket `use` here becomes
 * `use('/api/*')` there and answers 401 for paths this file has never heard of.
 */
export const routes = new Hono<AppEnv>();

/**
 * The 409 refusals, in the envelope §8 gives `precondition_failed`.
 *
 * A DIFFERENT `operation` FOR EACH, which is the whole reason they are not one
 * refusal: the screen has to say "you cannot disable yourself" or "this is the
 * last owner — promote somebody first", and a client that had to tell them
 * apart by parsing prose would get it wrong the first time the prose changed.
 *
 * Built with `c.json` rather than thrown, because the §8 mapper in
 * `server/middleware/errors.ts` renders `PreconditionFailedError` with a `post`
 * attached and there is no post here — the same reason
 * `server/shop/cart/routes/checkout.ts` writes its two refusals out by hand.
 * `requestId` is added explicitly for the same reason
 * `server/shop/cart/routes/errors.ts` adds it: every other error body in this
 * app carries one, and a response that quietly did not would break the one
 * thread between what the caller saw and what the log holds.
 */
function refuse(
  c: Context<AppEnv>,
  operation: 'disable_self' | 'disable_last_owner',
  userId: string,
): Response {
  return c.json(
    {
      error: 'precondition_failed',
      operation,
      // The subject, so a list screen can mark the right row without matching
      // on the operation and re-deriving which id it had asked about.
      userId,
      requestId: c.get('requestId') ?? '',
    },
    409,
  );
}

// -------------------------------------------------------------------- list

routes.get('/users', requireOwner(), async (c) =>
  c.json({ items: await listUsers(currentDb(c)) }),
);

// ---------------------------------------------------------- disable/enable

/**
 * Revoke an account: mark it disabled AND destroy every session it holds.
 *
 * The work is `disableUser` in `server/repo/users.ts`, which has been correct
 * and covered by its own suite since it was written and — until this route —
 * was called by nothing outside that suite. Everything here is the two refusals
 * around it.
 *
 * IDEMPOTENT. Disabling an already-disabled user is a 200 with `sessionsEnded:
 * 0`: `disableUser`'s `COALESCE` keeps the original disable time and the DELETE
 * finds nothing left to sweep. A 409 for "already disabled" would make the
 * ordinary double-click an error, and the state the caller asked for is the
 * state they get.
 */
routes.post('/users/:id/disable', requireOwner(), async (c) => {
  const db = currentDb(c);
  const actor = currentUser(c);
  const id = uuidParam(c, 'id');

  // Read first, so an id that names nobody is a 404 rather than a silent
  // no-op reported as success.
  const target = await findUserById(db, id);
  if (!target) throw new NotFoundError(id);

  /*
   * THE LAST ACTIVE OWNER, AND IT IS CHECKED BEFORE THE SELF CHECK ON PURPOSE.
   *
   * Invites, exports, destroys and this very route are all owner-only, so
   * disabling the last one locks the door from the inside with everybody
   * outside it; recovery means running `scripts/set-owner-password.ts --apply`
   * against the production database.
   *
   * WHY THE ORDER MATTERS, spelled out because it is not obvious and the other
   * way round looked fine. `requireOwner()` means the actor is always an ACTIVE
   * owner, so if the target is also an active owner and is not the actor, there
   * are at least two of them and this can never fire. The only request that
   * reaches it is an owner disabling THEMSELVES on a blog with one owner —
   * which the self check below would otherwise have caught first, and answered
   * with the less useful of the two messages. "You cannot disable yourself"
   * suggests asking a colleague to do it; on a one-owner blog there is no
   * colleague, and "this is the last owner — promote somebody first" is the
   * sentence that actually leads somewhere.
   *
   * Phrased as the INVARIANT (an instance never reaches zero active owners)
   * rather than as an identity comparison, so it stays correct if the guard on
   * this route is ever loosened — at which point the unreachable branch above
   * becomes reachable and is already right.
   *
   * The count is only taken when the target is an active owner: a writer, or an
   * owner already disabled, cannot be the one holding the door open. The
   * residual race — two owners disabling each other in the same instant — is
   * written up on `countActiveOwners`; closing it needs a transaction, and the
   * Neon HTTP driver throws on `transaction()`.
   */
  if (target.user.role === 'owner' && target.disabledAt == null) {
    if ((await countActiveOwners(db)) <= 1) return refuse(c, 'disable_last_owner', id);
  }

  /*
   * YOURSELF. Not because it is unsafe — `disableUser` would do it perfectly
   * well — but because the outcome is that the person who clicked is signed out
   * by their own action and cannot sign back in, with no undo on the screen
   * they were just looking at. Another owner can do it for them, deliberately:
   * revocation is a thing done TO an account, and making it need a second
   * person is most of what stops it happening by mis-click.
   */
  if (target.user.id === actor.id) return refuse(c, 'disable_self', id);

  // The count is in the body because "signed out 3 devices" is the only
  // feedback that distinguishes revoking a live account from tidying a dormant
  // one, and the caller cannot compute it — those sessions are gone.
  return c.json({ ok: true, sessionsEnded: await disableUser(db, id) });
});

/**
 * Reinstate an account.
 *
 * DELIBERATELY NOT THE MIRROR OF DISABLE, and `enableUser` says why: disabling
 * destroys the sessions, so enabling restores the ability to log in and nothing
 * more. The cookie on the laptop that prompted the revocation does not come
 * back — that is the entire point of destroying the rows rather than shadowing
 * them behind `disabled_at`.
 *
 * Idempotent, and no refusals: there is no state in which restoring somebody's
 * access locks anybody out.
 */
routes.post('/users/:id/enable', requireOwner(), async (c) => {
  const id = uuidParam(c, 'id');
  if (!(await enableUser(currentDb(c), id))) throw new NotFoundError(id);
  return c.json({ ok: true });
});
