import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth, requireOwner } from '../middleware/session';
import { readJson } from '../middleware/errors';
import { NotFoundError } from '../repo/errors';
import {
  acceptTransfer,
  cancelTransfer,
  pendingTransfer,
  proposeTransfer,
} from '../repo/ownership';
import type { PendingTransfer } from '../repo/ownership';
import { currentDb, currentUser } from '../app-env';
import type { AppEnv } from '../app-env';

/**
 * Handing the store to somebody else.
 *
 * ITS OWN ROUTER, AND NOT PART OF `routes/users.ts`, FOR ONE REASON: that
 * file's header promises "OWNER OR DEVELOPER, EVERY ROUTE" and attaches
 * `requireAdmin()` to each one. Two of the routes below must be callable by the
 * RECIPIENT, who is whatever they were before the transfer — a writer, very
 * possibly — so putting them there would either break that promise or lock the
 * feature's whole point behind a role its user does not have yet.
 *
 * WHAT GUARDS WHAT:
 *
 *   - proposing is `requireOwner()`. Only the owner can give away the store,
 *     and developers explicitly cannot: `canManage` already says a developer
 *     may not demote the owner, and proposing a transfer of the owner's role is
 *     that same act wearing a different verb.
 *   - accepting and declining are `requireAuth()` plus an identity check INSIDE
 *     the statement — `to_user_id = actor` on accept, "either party" on
 *     decline. The check is in the SQL rather than here so a future caller
 *     cannot reach the repo function and skip it.
 *   - reading is `requireAuth()`, answered only for someone the answer is
 *     about (see the route).
 *
 * There is at most one live proposal instance-wide, so nothing here takes a
 * transfer id from the caller: the id is a detail of the row, not an address
 * the client has to hold or could get wrong.
 */
export const routes = new Hono<AppEnv>();

const ProposeBody = z.object({ toUserId: z.string().uuid() }).strict();

/** The wire shape. Ids and names only — no tokens, nothing secret. */
function wire(t: PendingTransfer) {
  return {
    id: t.id,
    from: { id: t.fromUserId, displayName: t.fromName, email: t.fromEmail },
    to: { id: t.toUserId, displayName: t.toName, email: t.toEmail },
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
  };
}

/**
 * The live proposal, or `null`.
 *
 * ANSWERED ONLY FOR SOMEBODY IT CONCERNS. The two parties obviously need it —
 * the recipient's whole prompt to accept is built from this, and the sender's
 * "waiting for them" state with it. Admins get it too, because the team screen
 * shows a pending transfer beside the roles it is about to change.
 *
 * Everybody else gets `null` rather than a 403, and the difference matters:
 * a writer polling this is not doing anything wrong, and an error would be a
 * refusal for asking a question they are entitled to ask. What they are not
 * entitled to is the answer, which is a different thing and is what `null`
 * says. It also keeps this route from being a probe for "is the store changing
 * hands", which is exactly the sort of thing worth not broadcasting.
 */
routes.get('/ownership/transfer', requireAuth(), async (c) => {
  const me = currentUser(c);
  const live = await pendingTransfer(currentDb(c), Date.now());
  if (!live) return c.json({ transfer: null });

  const concerns =
    live.fromUserId === me.id ||
    live.toUserId === me.id ||
    me.role === 'owner' ||
    me.role === 'developer';

  return c.json({ transfer: concerns ? wire(live) : null });
});

/**
 * Propose it. Owner only.
 *
 * NOTHING MOVES HERE. The owner asked for the recipient to accept rather than
 * for the swap to happen on click, so this writes a proposal and no role
 * changes until `/accept`. A reader looking for where ownership actually moves
 * wants `acceptTransfer` in `server/repo/ownership.ts`.
 */
routes.post('/ownership/transfer', requireOwner(), async (c) => {
  const db = currentDb(c);
  const me = currentUser(c);
  const { toUserId } = await readJson(c, ProposeBody);

  const made = await proposeTransfer(db, {
    fromUserId: me.id,
    toUserId,
    now: Date.now(),
  });

  if (!made.ok) {
    /*
     * 409 in §8's `precondition_failed` envelope, with `operation` naming
     * which wall was hit — the same shape `routes/users.ts` uses, and for the
     * same reason: "somebody else already has a transfer pending" and "that
     * person cannot receive it" need different sentences on screen, and a
     * client telling them apart by parsing prose gets it wrong the first time
     * the prose changes.
     */
    return c.json(
      {
        error: 'precondition_failed',
        operation: made.reason,
        userId: toUserId,
        requestId: c.get('requestId') ?? '',
      },
      409,
    );
  }

  return c.json({ transfer: wire(made.transfer) }, 201);
});

/**
 * Accept it, and become the owner.
 *
 * `requireAuth()`, NOT `requireAdmin()` — the recipient holds whatever role
 * they had before, and requiring the one they are about to be granted would
 * make the feature impossible to use. The identity check is
 * `to_user_id = actor`, enforced inside the statement.
 *
 * A 404 covers every way this can fail — no live proposal, not yours, lapsed,
 * already spent, either party no longer eligible. They are one answer on
 * purpose: the caller learns "there is nothing here for you to accept", which
 * is true of all of them, and splitting them would let somebody probe for
 * proposals aimed at other people.
 */
routes.post('/ownership/transfer/accept', requireAuth(), async (c) => {
  const db = currentDb(c);
  const me = currentUser(c);

  const live = await pendingTransfer(db, Date.now());
  if (!live) throw new NotFoundError('transfer');

  const owner = await acceptTransfer(db, { id: live.id, actorId: me.id, now: Date.now() });
  if (!owner) throw new NotFoundError('transfer');

  /*
   * The caller's OWN new shape comes back, because the client has to repaint
   * itself: the person who sent this request as a writer is an owner by the
   * time it answers, and every surface they can reach just changed.
   */
  return c.json({ user: owner });
});

/**
 * Withdraw it — the sender changing their mind, or the recipient declining.
 *
 * ONE ROUTE FOR BOTH, because the row records the same outcome either way and
 * the statement already establishes that the caller is one of the two parties.
 * Splitting it would mean two routes with identical bodies and a comment
 * explaining that they are identical.
 */
routes.post('/ownership/transfer/decline', requireAuth(), async (c) => {
  const db = currentDb(c);
  const me = currentUser(c);

  const live = await pendingTransfer(db, Date.now());
  if (!live) throw new NotFoundError('transfer');

  if (!(await cancelTransfer(db, { id: live.id, actorId: me.id, now: Date.now() }))) {
    throw new NotFoundError('transfer');
  }
  return c.json({ ok: true });
});
