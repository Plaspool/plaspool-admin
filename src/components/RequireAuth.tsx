import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate, Outlet, useBlocker, useLocation } from 'react-router-dom';
import { LogOut, WifiOff } from 'lucide-react';
import {
  getSession,
  initSession,
  logout,
  subscribe,
  type Session,
} from '../data/session';
import { revalidate } from '../data/sync';
import { ConfirmDialog } from './Dialog';
import { Sidebar, SidebarCounts } from './Sidebar';
import { SignInForm } from '../routes/Login';
import '../routes/auth.css';

/**
 * The guard, and the shell it lives in.
 *
 * Four session states reach here and each gets a different answer. The two
 * that matter are the ones a three-state design gets wrong:
 *
 * - **`offline`** paints the app from cache. It is NOT a login screen. A
 *   writer whose `/auth/me` never reached a server has not been signed out;
 *   they have no network, and the app they had yesterday is on this disk.
 * - **`anonymous` with `reason: 'expired'`** renders the prompt OVER the route
 *   that is already mounted, keeps every child alive, and blocks navigation.
 *   Unmounting the editor here would throw away the TipTap buffer the writer
 *   is looking at, and clearing anything would trip the frozen `if (!post)`
 *   branch that says the post was permanently deleted (plan §2.2 I3).
 */

/**
 * The session as a React value.
 *
 * `useSyncExternalStore` rather than a context provider because the store is a
 * plain module — `session.ts` is imported by `main.tsx` before React mounts, so
 * that it can call `setActiveUser` before any route renders, and a provider
 * could not have been read that early.
 */
export function useSession(): Session {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  /**
   * NAVIGATION IS BLOCKED WHILE A SESSION IS EXPIRED, and that is a security
   * property rather than a nicety.
   *
   * The prompt is rendered over the current route because the document on
   * screen was already on screen — nothing new is exposed by leaving it there.
   * That argument does not extend one route further: without this, walking
   * away from the prompt and clicking through to the dashboard would be a way
   * to read someone's whole library on a machine whose session has ended.
   *
   * `useBlocker` needs a data router, which `createHashRouter` is.
   */
  const expired = session.status === 'anonymous' && session.reason === 'expired';
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      expired && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    // Signing back in resumes whatever the writer was trying to do, rather
    // than silently swallowing the click they made a minute ago.
    if (!expired && blocker.state === 'blocked') blocker.proceed();
  }, [expired, blocker]);

  if (session.status === 'unknown') {
    /*
     * Nothing at all, deliberately. `/auth/me` usually answers in a few
     * milliseconds and a login screen flashed at an already-signed-in writer
     * reads as "you have been logged out" — the single most alarming thing
     * this app could say to someone who has not been.
     */
    return null;
  }

  if (session.status === 'anonymous' && session.reason === 'boot') {
    /*
     * The cache was cleared before anything painted, so there is no route
     * underneath worth preserving — which is what makes a REDIRECT safe here
     * and unsafe two arms down, where `expired` renders over a live editor.
     *
     * Sign-in used to render in place, and that had one property worth keeping:
     * a writer who opened `/settings` signed out landed back on `/settings`
     * afterwards. A bare redirect loses the destination, so it is carried in
     * router state and `Login` sends them on. `replace`, so the back button
     * does not walk into the guard again and bounce straight back out.
     */
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (session.status === 'offline' && !session.user) {
    /*
     * Offline AND this device has never confirmed a user, so there is no id to
     * scope the cache by (I2) and genuinely nothing to show. A login form
     * would be a lie: signing in needs the network that is missing.
     */
    return <OfflineBoot />;
  }

  return (
    <>
      {children}
      {expired && <ReauthPrompt session={session} />}
    </>
  );
}

/**
 * The app shell: the guard, the routes, and one revalidation per navigation.
 *
 * **Post routes are deliberately excluded from the revalidation here.**
 * `revalidate()` would fetch `/edit/:id` perfectly well and then throw away
 * the one thing that navigation needs — whether the post is `ok`, `gone` or
 * unreachable. `PostGate` has to make that fetch itself to branch on the
 * answer (plan §3 arms 4–6), so calling both would mean two identical GETs of
 * every post and two revision walks, with the gate's copy being the only one
 * anybody read.
 */
const POST_ROUTE = /^\/(edit|read)\/[^/]+$/;

export function AppShell() {
  const session = useSession();
  const { pathname } = useLocation();
  const userId = session.status === 'unknown' ? '' : (session.user?.id ?? '');

  useEffect(() => {
    if (!userId || POST_ROUTE.test(pathname)) return;
    // Total by construction — `revalidate` swallows everything, because a
    // background refresh of data already on screen has no error surface of its
    // own and an offline boot must paint rather than complain.
    void revalidate(userId, pathname);
  }, [userId, pathname]);

  /**
   * THE TWO POST ROUTES GET NO SHELL, and `POST_ROUTE` is reused rather than
   * copied because the set really is the same one: `/edit/:id` and `/read/:id`
   * are the routes where a document is the interface. The editor and the
   * reader draw their own bars for that reason, `.editor__page` does its own
   * width arithmetic against the viewport, and a 56px rail inset would fight
   * both. The two rules arrive at the same list from different directions —
   * one about double-fetching, one about chrome — and a third post route would
   * want both answers, so they are deliberately not allowed to drift apart.
   */
  const chromeless = POST_ROUTE.test(pathname);

  return (
    <RequireAuth>
      {chromeless ? (
        <Outlet />
      ) : (
        /*
          The counts provider wraps BOTH the rail and the outlet, because the
          dashboard publishes into it and the rail reads it — a provider inside
          either one would put the two on opposite sides of the boundary.
        */
        <SidebarCounts>
        <div className="shell">
          <Sidebar
            user={session.status === 'unknown' ? null : (session.user ?? null)}
            /*
             * The existing button, not a second one. It owns the unsent-work
             * confirmation (`session.logout()` refuses to proceed without
             * `confirmed`), and the label is passed as markup so the collapsed
             * rail can show a glyph while the word stays in the accessibility
             * tree — `sidebar.css` clips it rather than removing it.
             */
            signOut={
              <SignOutButton
                className="sidebar__item sidebar__item--signout"
                label={
                  <>
                    <LogOut className="ui-ic sidebar__icon" aria-hidden="true" />
                    <span className="sidebar__label">Sign out</span>
                  </>
                }
              />
            }
          />
          <div className="shell__main">
            <Outlet />
          </div>
        </div>
        </SidebarCounts>
      )}
    </RequireAuth>
  );
}

/**
 * The mid-session prompt.
 *
 * A panel and not a modal scrim, and the difference is the point: the writer
 * must be able to keep typing while it is up. Every keystroke still autosaves,
 * every save still fails with a 401, and every failure lands in `pending` —
 * which is the mechanism that makes an expired session cost nothing. A scrim
 * that swallowed keystrokes would turn a recoverable session expiry into
 * fifteen minutes of lost writing, and it is what "we show a modal" usually
 * means in practice.
 */
function ReauthPrompt({
  session,
}: {
  session: Extract<Session, { status: 'anonymous' }>;
}) {
  return (
    <div className="reauth" role="region" aria-label="Session expired">
      <div className="reauth__panel">
        <h2 className="reauth__title">Your session ended</h2>
        <p className="reauth__body">
          {session.user
            ? `Sign in again as ${session.user.email} to keep saving.`
            : 'Sign in again to keep saving.'}{' '}
          Nothing has been lost — everything you type is kept on this device
          until it can be sent.
        </p>
        {/* No props since Clerk became the only door: there is no address to
            prefill or lock when Clerk owns the form. */}
        <SignInForm />
        <div className="reauth__alt">
          <SignOutButton
            className="btn btn--ghost btn--sm"
            label="Sign out on this device"
          />
        </div>
      </div>
    </div>
  );
}

/** Offline with no identity to paint by. The only honest offer is to retry. */
function OfflineBoot() {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="authpage">
      <div className="authpage__card empty">
        <WifiOff className="ui-ic authpage__mark" aria-hidden="true" />
        <h1 className="empty__title">You&rsquo;re offline</h1>
        <p className="empty__body">
          This browser has no saved copy of your posts yet, and signing in needs
          a connection. Nothing has been lost.
        </p>
        <button
          className="btn btn--primary"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void initSession().finally(() => setRetrying(false));
          }}
        >
          {retrying ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </div>
  );
}

/**
 * Sign out, having asked about unsent work first.
 *
 * The confirmation is not politeness. Logout is the only path in the app that
 * deletes `pending` rows, and those rows are the last copy of words no server
 * ever accepted — a `blocked` one exists nowhere else at all. `session.logout`
 * refuses to proceed without `confirmed`, so this component cannot skip the
 * question by accident and neither can a future caller.
 */
export function SignOutButton({
  className = 'btn btn--ghost',
  label = 'Sign out',
}: {
  className?: string;
  /**
   * `ReactNode` rather than `string` so the sidebar can pass an icon beside
   * the word. The word itself must stay in the markup wherever this is used —
   * it is the button's accessible name, and every caller that hides it
   * visually is responsible for hiding it in a way screen readers ignore.
   */
  label?: ReactNode;
}) {
  const [confirming, setConfirming] = useState<number | null>(null);

  return (
    <>
      <button
        className={className}
        onClick={async () => {
          const outcome = await logout();
          if (outcome.status === 'needs-confirm') setConfirming(outcome.pending);
        }}
      >
        {label}
      </button>
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => void logout({ confirmed: true })}
        title="Sign out and delete unsent work?"
        description={
          <>
            {confirming === 1
              ? '1 change has not reached the server yet'
              : `${confirming} changes have not reached the server yet`}
            . Signing out removes them from this device, and they exist nowhere
            else. You can review them on the recovery screen first.
          </>
        }
        confirmLabel="Sign out anyway"
        danger
      />
    </>
  );
}
