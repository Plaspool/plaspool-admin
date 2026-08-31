import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { requireAdmin } from '../middleware/session';
import { ForbiddenError, readJson } from '../middleware/errors';
import {
  countActiveOwners,
  disableUser,
  enableUser,
  findUserById,
  listUsers,
  setTwoFactorEmail,
  setUserRole,
} from '../repo/users';
import { NotFoundError } from '../repo/errors';
import { uuidParam } from './auth';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';
import { ASSIGNABLE_ROLES, canAssign, canManage } from '../../shared/roles';

/**
 * The team surface (HANDOFF §2 A2, widened by migration 0680): who has an
 * account, what they are, and whether they can still use it.
 *
 * OWNER OR DEVELOPER, EVERY ROUTE — `requireAdmin()`. The list is the email
 * address of every person with a login, which is exactly what the whole of
 * `server/routes/auth.ts` is written to keep an attacker from assembling, and
 * managing it is the two trusted tiers' work. WHO those tiers may aim an
 * action at is a second, per-target question, answered by `canManage` /
 * `canAssign` from `shared/roles.ts` — the seniority table the team screen
 * displays is the one this file enforces:
 *
 *   - the owner manages everyone but themselves;
 *   - a developer manages everyone except the owner and other developers, and
 *     may hand out any role below developer;
 *   - `owner` is not a value anything here can write, in either direction.
 *
 * `requireAdmin()` IS ATTACHED PER ROUTE, never as `routes.use('*', …)`. The
 * long version is in `server/routes/posts.ts`: `app.route('/api', users)`
 * flattens this router into the parent, so a blanket `use` here becomes
 * `use('/api/*')` and answers 401 for paths this file has never heard of.
 */
export const routes = new Hono<AppEnv>();

/**
 * The 409 refusals, in the envelope §8 gives `precondition_failed`.
 *
 * A DIFFERENT `operation` FOR EACH, which is the whole reason they are not one
 * refusal: the screen has to say "you cannot disable yourself" or "developers
 * cannot remove other developers", and a client that had to tell them apart by
 * parsing prose would get it wrong the first time the prose changed.
 */
type Refusal =
  | 'disable_self'
  | 'disable_last_owner'
  /** A developer aiming at the owner or a fellow developer. */
  | 'manage_peer'
  | 'role_self'
  /** The owner's role is immutable in both directions. */
  | 'role_owner';

function refuse(c: Context<AppEnv>, operation: Refusal, userId: string): Response {
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

const RoleBody = z
  .object({
    /** `owner` is deliberately not in the enum — a body naming it is a 400,
     * the same wall `InviteBody` builds. */
    role: z.enum(ASSIGNABLE_ROLES),
  })
  .strict();

const TwoFactorBody = z.object({ enabled: z.boolean() }).strict();

// -------------------------------------------------------------------- list

routes.get('/users', requireAdmin(), async (c) =>
  c.json({ items: await listUsers(currentDb(c)) }),
);

// ---------------------------------------------------------- disable/enable

/**
 * Revoke an account: mark it disabled AND destroy every session it holds.
 *
 * IDEMPOTENT. Disabling an already-disabled user is a 200 with `sessionsEnded:
 * 0`: `disableUser`'s `COALESCE` keeps the original disable time and the DELETE
 * finds nothing left to sweep. A 409 for "already disabled" would make the
 * ordinary double-click an error, and the state the caller asked for is the
 * state they get.
 */
routes.post('/users/:id/disable', requireAdmin(), async (c) => {
  const db = currentDb(c);
  const actor = currentUser(c);
  const id = uuidParam(c, 'id');

  // Read first, so an id that names nobody is a 404 rather than a silent
  // no-op reported as success.
  const target = await findUserById(db, id);
  if (!target) throw new NotFoundError(id);

  /*
   * THE SENIORITY RULE BEFORE THE IDENTITY RULES: a developer aiming at the
   * owner or a fellow developer is refused whoever the target IS, so the two
   * identity refusals below can keep reasoning about owners and selves without
   * developers in the sentence.
   */
  if (!canManage(actor.role, target.user.role)) return refuse(c, 'manage_peer', id);

  /*
   * THE LAST ACTIVE OWNER, AND IT IS CHECKED BEFORE THE SELF CHECK ON PURPOSE.
   *
   * Team management is owner/developer work, so disabling the last active
   * owner locks the singular account out from the inside; recovery means
   * running `scripts/set-owner-password.ts --apply` against the production
   * database.
   *
   * Phrased as the INVARIANT (an instance never reaches zero active owners)
   * rather than as an identity comparison, so it stays correct as the guard on
   * this route evolves. The only caller that can reach it today is the owner
   * disabling themselves — `canManage` already refused every developer — and
   * "this is the last owner" is the sentence that actually leads somewhere,
   * where "you cannot disable yourself" suggests asking a colleague the
   * one-owner instance does not have.
   */
  if (target.user.role === 'owner' && target.disabledAt == null) {
    if ((await countActiveOwners(db)) <= 1) return refuse(c, 'disable_last_owner', id);
  }

  /*
   * YOURSELF. Not because it is unsafe — `disableUser` would do it perfectly
   * well — but because the outcome is that the person who clicked is signed out
   * by their own action and cannot sign back in, with no undo on the screen
   * they were just looking at. Another admin can do it for them, deliberately:
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
 * THE SENIORITY RULE APPLIES HERE TOO: reinstating an account is managing it,
 * and a developer must not be able to re-arm a developer the owner revoked.
 */
routes.post('/users/:id/enable', requireAdmin(), async (c) => {
  const db = currentDb(c);
  const id = uuidParam(c, 'id');
  const target = await findUserById(db, id);
  if (!target) throw new NotFoundError(id);
  if (!canManage(currentUser(c).role, target.user.role)) return refuse(c, 'manage_peer', id);
  if (!(await enableUser(db, id))) throw new NotFoundError(id);
  return c.json({ ok: true });
});

// -------------------------------------------------------------------- role

/**
 * Change what an account is.
 *
 * TWO WALLS AND A TABLE. The Zod enum refuses `owner` as an input (400), the
 * repo statement refuses to touch the owner row however this route evolves,
 * and between them `canManage`/`canAssign` decide the actor's reach: the owner
 * re-roles anyone but themselves to anything assignable; a developer re-roles
 * the four lower roles among themselves and may not mint developers.
 */
routes.patch('/users/:id/role', requireAdmin(), async (c) => {
  const db = currentDb(c);
  const actor = currentUser(c);
  const id = uuidParam(c, 'id');
  const body = await readJson(c, RoleBody);
  const next = body.role;

  const target = await findUserById(db, id);
  if (!target) throw new NotFoundError(id);
  /* Your own role is the one thing you must not hold the pen for — an owner
   * demoting themselves orphans the instance, and anybody else self-editing
   * is escalation or a foot-gun. Another admin does it. */
  if (target.user.id === actor.id) return refuse(c, 'role_self', id);
  if (target.user.role === 'owner') return refuse(c, 'role_owner', id);
  if (!canManage(actor.role, target.user.role) || !canAssign(actor.role, next)) {
    return refuse(c, 'manage_peer', id);
  }

  const updated = await setUserRole(db, id, next);
  // The statement refuses owners and misses deletions identically; both were
  // ruled out above, so a null here is the row vanishing mid-flight.
  if (!updated) throw new NotFoundError(id);
  return c.json({ ok: true, user: updated });
});

// -------------------------------------------------------------- two-factor

/**
 * Turn the emailed login code on or off for one account.
 *
 * SELF-SERVICE IS ALLOWED — hardening your own account needs nobody's
 * signature — and for OTHER people the seniority rule applies: weakening the
 * owner's login is not a developer's call.
 */
routes.patch('/users/:id/two-factor', requireAdmin(), async (c) => {
  const db = currentDb(c);
  const actor = currentUser(c);
  const id = uuidParam(c, 'id');
  const { enabled } = await readJson(c, TwoFactorBody);

  const target = await findUserById(db, id);
  if (!target) throw new NotFoundError(id);
  if (target.user.id !== actor.id && !canManage(actor.role, target.user.role)) {
    throw new ForbiddenError();
  }

  if (!(await setTwoFactorEmail(db, id, enabled))) throw new NotFoundError(id);
  return c.json({ ok: true, enabled });
});
