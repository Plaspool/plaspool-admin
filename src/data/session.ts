import { api, AUTH_EXPIRED_EVENT } from './api';
import { clearCache } from './cache';
import { ApiError } from './errors';
import { countPending } from './pending';
import { setActiveUser } from './posts';
import { replayPending } from './sync';
import type { AuthUser } from './types';

/**
 * WHO IS SIGNED IN, AND — MUCH MORE IMPORTANTLY — WHEN THE CACHE MAY BE THROWN
 * AWAY (plan §2.2 I3).
 *
 * This module is small and almost all of it is about one decision. Everything
 * else in the cutover can be wrong and cost a request; this can be wrong and
 * cost a writer their library, because `clearCache` deletes the row
 * `Editor.tsx:48` is live-querying and the frozen `if (!post)` branch at
 * `:355` then tells the writer their post "may have been permanently deleted
 * from this browser".
 *
 * So the rule is stated once, here, and the four states exist to serve it:
 *
 *   **Only an authoritative answer clears the cache.**
 *
 * An authoritative answer is a server that replied and said "you are not this
 * user". Three events qualify and nothing else does:
 *
 *   1. a boot where `/auth/me` answers **401**, before anything paints;
 *   2. `/auth/me` confirming a **different user id** than this device holds;
 *   3. **explicit logout.**
 *
 * A request that never reached a server is not one of them. That is the whole
 * reason `offline` is a state and not a flavour of `anonymous`: a writer on a
 * plane boots from the service-worker shell, `api.me()`'s fetch gets no answer,
 * and treating that as "no session" would clear `posts`, `postList`,
 * `revisions` and every unsent-work overlay — and then render a login screen
 * that cannot be satisfied without the network. One dropped connection and a
 * local-first app has eaten everything. Before this cutover that writer worked
 * normally; after it they must too.
 */

// ------------------------------------------------------------------- state

export type SessionStatus = 'unknown' | 'authed' | 'anonymous' | 'offline';

export type Session =
  /** Booting. Render nothing — see `RequireAuth`. */
  | { status: 'unknown' }
  | { status: 'authed'; user: AuthUser }
  /**
   * The server ANSWERED and refused. `reason` is not cosmetic — the two cases
   * get different screens and different guarantees:
   *
   * - `boot` — `/auth/me` 401'd before anything painted. The cache is already
   *   cleared, nothing of the previous user is on screen, and the full login
   *   screen is correct.
   * - `expired` — a 401 arrived MID-SESSION, with a document open. Nothing is
   *   cleared, the route stays mounted, and the prompt renders over it. `user`
   *   is whoever was signed in, so the prompt can name them and pre-fill the
   *   email.
   */
  | { status: 'anonymous'; reason: 'boot' | 'expired'; user: AuthUser | null }
  /**
   * The request got no answer. `user` is this device's last confirmed user, if
   * it has one — without it there is nothing to scope the cache by (I2) and
   * nothing can paint.
   */
  | { status: 'offline'; user: AuthUser | null };

let session: Session = { status: 'unknown' };

const listeners = new Set<() => void>();

export function getSession(): Session {
  return session;
}

/** Store subscription for `useSession`. Returns its own unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setSession(next: Session): Session {
  session = next;
  for (const listener of listeners) listener();
  return next;
}

// ------------------------------------------------- the remembered identity

/**
 * The last user `/auth/me` confirmed ON THIS DEVICE.
 *
 * This exists for exactly one arm: an offline boot. The cache is user-scoped
 * (I2), so painting it needs an id, and the only id available when no request
 * can be made is the one the last successful boot wrote down. It is a cache
 * key, never a permission: nothing is authorised by it, every write still goes
 * to a server that checks the cookie, and the rows it unlocks are rows this
 * same user put there.
 *
 * Written on every confirmed identity and erased by the two events that end
 * one — a boot 401 and logout — so "the next person opens the app" finds no id
 * to paint by even before the clear.
 */
const REMEMBERED_KEY = 'blog-admin:session-user';

function readRemembered(): AuthUser | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthUser>;
    // A hand-edited or half-written value must not become a user id that
    // scopes cache reads. Anything short of the whole shape is no user.
    if (typeof parsed?.id !== 'string' || parsed.id === '') return null;
    return {
      id: parsed.id,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      role: parsed.role === 'owner' ? 'owner' : 'writer',
    };
  } catch {
    /*
     * No storage (private mode, disabled, or the node test environment) means
     * no remembered id, which costs an offline boot its cache and costs
     * nothing else. Deliberately NOT an in-memory fallback: one that survived
     * only until reload would make this arm work in a test and fail on a
     * plane, which is the worst of both.
     */
    return null;
  }
}

function remember(user: AuthUser | null): void {
  try {
    if (user) localStorage.setItem(REMEMBERED_KEY, JSON.stringify(user));
    else localStorage.removeItem(REMEMBERED_KEY);
  } catch {
    /* see `readRemembered` — losing this costs an offline boot its cache */
  }
}

/**
 * "SOMEBODY DELIBERATELY SIGNED OUT AND CLERK HAS NOT BEEN TOLD YET."
 *
 * THE BUG THIS EXISTS FOR, because it is not obvious and it shipped. Clerk is
 * the only auth: our `POST /auth/logout` destroys the session row and clears
 * `__Host-studio_session`, and then `Gate` renders the sign-in screen — which
 * is `ClerkGate`, which sees a Clerk session that is STILL LIVE and trades it
 * for a brand-new cookie on the spot. Sign out cleared everything it owned and
 * the screen signed the person straight back in. From the outside, the button
 * did nothing.
 *
 * Clearing this side is not enough because the two sessions are separate:
 * Clerk's lives on `clerk.plaspool.com` and outlives anything we delete. So
 * logout leaves this marker, and `ClerkGate` — the one place in the app that is
 * guaranteed to have Clerk loaded — reads it, calls Clerk's `signOut()`, and
 * clears it. That ends the Clerk session for real rather than merely declining
 * to use it once.
 *
 * `localStorage` AND NOT `sessionStorage`, deliberately: a person who signs out
 * and closes the tab must not have the next tab silently re-exchange the Clerk
 * session that survived. It is cleared the moment Clerk has actually been
 * signed out, so it cannot strand anybody.
 */
const SIGNED_OUT_KEY = 'blog-admin:clerk-signout-pending';

export function markClerkSignOutPending(): void {
  try {
    localStorage.setItem(SIGNED_OUT_KEY, '1');
  } catch {
    /* No storage means the marker cannot be left. `logout()` still asks the
       already-loaded Clerk to sign out below, which covers the ordinary case;
       what is lost is the guarantee after a reload. */
  }
}

export function clerkSignOutPending(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearClerkSignOutPending(): void {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* nothing to clear if there was nowhere to write it */
  }
}

// ------------------------------------------------------------------ replay

let replaySettled: Promise<void> = Promise.resolve();

/**
 * Resolves once this boot's `replayPending` has settled — success, failure or
 * nothing to do.
 *
 * `PostGate` awaits this before it releases the editor (plan §3). Without the
 * wait, the editor opens on the server's version of a post while the writer's
 * newer, unsent words sit in a `pending` row nothing has looked at yet, and the
 * first autosave writes the old text over the new.
 *
 * It never rejects. A replay that failed is a replay that left its rows exactly
 * where they were, which is the outcome `pending` exists to guarantee; making
 * callers handle a rejection would only give them a way to get it wrong.
 */
export function whenReplayed(): Promise<void> {
  return replaySettled;
}

function startReplay(userId: string): void {
  replaySettled = replayPending(userId).then(
    () => undefined,
    () => undefined,
  );
}

// -------------------------------------------------------------- confirming

/**
 * Adopt a confirmed identity: `/auth/me` at boot, or a successful login or
 * invite acceptance.
 *
 * `setActiveUser` happens HERE and before the state flips, because
 * `src/data/posts.ts` cannot take a user id — `useAutosave.ts:85` and
 * `Editor.tsx:379` are frozen and pass none — so it reads an ambient one this
 * module owns. `RequireAuth` renders no route until the status leaves
 * `unknown`, which is what makes "before any route renders" true rather than
 * hopeful.
 */
export async function adoptUser(user: AuthUser): Promise<Session> {
  /*
   * A DIFFERENT USER IS AN AUTHORITATIVE ANSWER, and one of the three events
   * that may clear. The previous id is whichever we have: the live session's
   * when re-authenticating, this device's remembered one at boot.
   *
   * `keepPending` because `pending` is cleared only on explicit logout (§2.1's
   * store table). Those rows are keyed by `[postId+ownerUserId]`, so the
   * arriving user cannot read or replay them (I4), and deleting them would
   * destroy the previous writer's only copy of words that never reached a
   * server — on the say-so of someone else logging in.
   */
  const previous = session.status === 'unknown' ? readRemembered() : sessionUser();
  if (previous && previous.id !== user.id) await clearCache({ keepPending: true });

  remember(user);
  setActiveUser(user.id);
  const next = setSession({ status: 'authed', user });
  startReplay(user.id);
  return next;
}

/** The user attached to the current state, whatever the state is. */
function sessionUser(): AuthUser | null {
  return session.status === 'unknown' ? null : (session.user ?? null);
}

// -------------------------------------------------------------------- boot

/**
 * In-flight boot, shared. `main.tsx` starts one and the offline screen's
 * "Try again" starts another; two concurrent `/auth/me` calls would race to
 * write the state and could leave `offline` winning after `authed`.
 */
let booting: Promise<Session> | null = null;

/**
 * Ask the server who this is, and decide from the ANSWER — not from its
 * absence.
 *
 * Re-runnable: the offline screen retries with it, and the `online` event
 * handler installed by `startSessionWatch` calls it when connectivity comes
 * back.
 */
export function initSession(): Promise<Session> {
  if (booting) return booting;
  booting = (async () => {
    try {
      setSession({ status: 'unknown' });
      const remembered = readRemembered();
      try {
        return await adoptUser(await api.me());
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          /*
           * THE ONE PLACE A 401 CLEARS ANYTHING. The server answered, before a
           * single row was painted, that this browser holds no session — the
           * shared-machine case spec §7 names. It is strictly earlier than a
           * mid-session 401 would have caught it and it costs nothing on
           * screen, because nothing is on screen yet.
           */
          await clearCache({ keepPending: true });
          remember(null);
          setActiveUser('');
          return setSession({ status: 'anonymous', reason: 'boot', user: null });
        }
        /*
         * EVERYTHING ELSE IS `offline`, INCLUDING A 500 AND A 429.
         *
         * The test is not "was it a network error" but "did a server
         * authoritatively say you are not this user", and only a 401 does. A
         * gateway returning HTML, a cold database timing out, a rate limiter —
         * none of them know who this is, so none of them may empty a writer's
         * library. The cost of being wrong in this direction is one stale
         * screen and a banner; in the other it is everything.
         */
        setActiveUser(remembered?.id ?? '');
        return setSession({ status: 'offline', user: remembered });
      }
    } finally {
      booting = null;
    }
  })();
  return booting;
}

// --------------------------------------------------------- mid-session 401

/**
 * A 401 arrived while the app was running. **THIS CLEARS NOTHING.**
 *
 * Plan §2.2 I3, and the reasoning is worth keeping next to the code: the row a
 * clear would delete is the one the frozen editor is live-querying, and its
 * `if (!post)` branch replaces 900 words on screen with "This post no longer
 * exists. It may have been permanently deleted from this browser." Ghost — the
 * bar this part of the app claims to beat — shows a re-auth modal over the
 * document. Clearing here would be strictly worse than the thing being beaten.
 *
 * `activeUser` is deliberately left alone too. The writer keeps typing, every
 * failed save queues a `pending` row, and that row must be keyed to the user
 * who wrote it; resetting the ambient id to `''` would file their paragraphs
 * under nobody and no screen would ever list them again.
 *
 * Exported rather than kept private because it is the rule, not the plumbing:
 * the DOM listener in `startSessionWatch` is one caller and `session.test.ts`
 * is the other, and the client suites run under node where there is no window
 * to dispatch an event into.
 */
export function noteAuthExpired(): void {
  /*
   * Only a live session can expire. `api.ts` announces `auth-expired` for
   * EVERY 401 it sees, including the 401 from a wrong password on the login
   * screen — without this guard that failed attempt would rewrite the boot
   * screen into the mid-session prompt while the writer is typing into it.
   */
  if (session.status !== 'authed') return;
  setSession({ status: 'anonymous', reason: 'expired', user: session.user });
}

// ------------------------------------------------------------------ logout

export type LogoutOutcome =
  /**
   * Unsent work would be destroyed. The caller must show a confirmation naming
   * `pending` and call again with `confirmed: true`.
   */
  | { status: 'needs-confirm'; pending: number }
  | { status: 'done' };

/**
 * The third authoritative event, and the only one that deletes `pending`.
 *
 * Logout is the one moment a writer says "take my work off this machine", so
 * unlike every other path here it is allowed to destroy unsent words — which
 * is exactly why it asks first. A `queued` row is a paragraph that never
 * reached the server, an `unresolved` one is a version only a human can pick
 * between, and a `blocked` one exists nowhere else at all. Signing out of a
 * shared machine with three of those in the drawer, with no warning, is the
 * data-loss bug this whole part of the plan is written against.
 *
 * The count is passed back rather than the rows: the confirmation names a
 * number, and `#/recover` is where the rows themselves are dealt with.
 */
export async function logout(opts: { confirmed?: boolean } = {}): Promise<LogoutOutcome> {
  const userId = sessionUser()?.id ?? readRemembered()?.id ?? '';
  const pending = userId ? await countPending(userId) : 0;
  if (pending > 0 && !opts.confirmed) return { status: 'needs-confirm', pending };

  /*
   * The cookie first, and its failure is swallowed on purpose. `POST
   * /auth/logout` is not behind `requireAuth` for the same reason
   * (`server/routes/auth.ts`): a logout that refuses to finish leaves the
   * session alive, which is the one outcome logout exists to prevent. If the
   * network is down the local half still happens — the person in front of the
   * machine asked for their work to be gone from it, and honouring half of
   * that is worse than honouring the destructive half.
   */
  await api.logout().catch(() => undefined);

  /*
   * AND CLERK'S SESSION, which our cookie has nothing to do with. The marker
   * is set FIRST and unconditionally: whether or not Clerk happens to be
   * loaded in this tab right now, `ClerkGate` must find it on the way to the
   * sign-in screen (see `markClerkSignOutPending`).
   */
  markClerkSignOutPending();

  /*
   * If Clerk is already loaded — which it is whenever this tab did the
   * sign-in — end it here and now rather than a render later. Purely a
   * narrowing of the window in which a closed tab could leave the Clerk
   * session alive; the marker above is what makes it correct.
   */
  const clerk = (globalThis as { Clerk?: { signOut?: () => Promise<unknown> } }).Clerk;
  if (typeof clerk?.signOut === 'function') {
    await clerk.signOut().then(clearClerkSignOutPending, () => undefined);
  }

  await clearCache();
  remember(null);
  setActiveUser('');
  setSession({ status: 'anonymous', reason: 'boot', user: null });
  return { status: 'done' };
}

// ---------------------------------------------------------------- watchers

/**
 * Wire the two window events this module reacts to. Called once from
 * `main.tsx`; returns its own teardown so a test or a future host can unwire.
 *
 * `online` re-boots only from `offline`. Firing it in any other state would
 * turn a flaky connection into a stream of `/auth/me` calls, and — worse —
 * `navigator.onLine` is true for a machine on a captive-portal wifi with no
 * route to anywhere, so it is a hint to retry and never evidence about the
 * session.
 */
export function startSessionWatch(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onExpired = () => noteAuthExpired();
  const onOnline = () => {
    if (session.status === 'offline') void initSession();
  };
  window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
  window.addEventListener('online', onOnline);
  return () => {
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
    window.removeEventListener('online', onOnline);
  };
}
