import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ClerkProvider, SignIn, useAuth, useClerk } from '@clerk/clerk-react';
import { apiFetch } from '../data/api';
import { ApiError } from '../data/errors';
import { adoptUser, getSession, subscribe } from '../data/session';
import { BrandLogo } from '../components/BrandLogo';
import type { AuthUser } from '../data/types';
import './auth.css';

/**
 * Sign in — CLERK AND NOTHING ELSE since 2026-09-01.
 *
 * WHAT THIS FILE USED TO BE: an email and password form, plus a six-digit code
 * form for the emailed second factor, plus a link to `/forgot`. All three are
 * gone because the ROUTES they posted to are gone — the owner made Clerk the
 * only door, so `POST /api/auth/login`, `/auth/login/code`, `/auth/forgot`,
 * `/auth/reset` and `/auth/accept-invite` no longer exist on the server.
 *
 * THIS IS THE v1 BUILD, AND IT IS DELIBERATELY A COPY, NOT AN IMPORT. v2 has
 * its own `src/v2/shell/ClerkGate.tsx` doing the same job against v2's classes
 * and tokens. Importing across the boundary is what PR #75 established you do
 * NOT do: v1 owns `auth.css` and v2 owns `shell.css`, and a shared component
 * would drag one build's stylesheet into the other. The two are ~60 lines of
 * the same flow rendered in two different design systems; if you change the
 * exchange contract, change both.
 *
 * `SignInForm` STAYS AN EXPORT because `RequireAuth` renders it as the
 * mid-session re-auth prompt over a live editor. It no longer takes props —
 * there is no email to prefill or lock when Clerk owns the form.
 */

const CLERK_KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ?? '';

/**
 * The exchange: a Clerk session becomes the ordinary `__Host-studio_session`
 * cookie, and every screen past this one sees one session system.
 *
 * Clerk says WHO you are and deliberately not WHAT you may do — the role, the
 * revoked flag and the invite list live in our database, and the exchange is
 * where the verified identity meets them. A 403 is `not_invited`: the account
 * is real and this store has never heard of it, or its invitation is spent or
 * expired.
 */
function Exchange() {
  const { isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const [state, setState] = useState<'idle' | 'exchanging' | 'not_invited' | 'failed'>('idle');
  const started = useRef(false);

  useEffect(() => {
    if (!isSignedIn || started.current) return;
    started.current = true;
    setState('exchanging');
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error('no clerk token');
        const res = await apiFetch<{ user: AuthUser }>('/auth/clerk/exchange', {
          method: 'POST',
          body: { token },
        });
        await adoptUser(res.user);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403) setState('not_invited');
        else setState('failed');
      }
    })();
  }, [isSignedIn, getToken]);

  if (!isSignedIn) return <SignIn routing="virtual" />;

  if (state === 'not_invited') {
    return (
      <div className="authform">
        <p className="authform__lede">
          That account signed in fine, but it is not on this store&rsquo;s team. Accounts here
          are by invitation only, so ask an owner or developer to invite this address and then
          sign in again. If you were invited a while ago, the invitation may have run out.
        </p>
        <button
          type="button"
          className="btn btn--primary authform__submit"
          onClick={() => {
            started.current = false;
            setState('idle');
            void signOut();
          }}
        >
          Use a different account
        </button>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="authform">
        <p className="authform__error" role="alert">
          You signed in, but this admin could not finish setting up your session.
        </p>
        <button
          type="button"
          className="btn btn--primary authform__submit"
          onClick={() => {
            started.current = false;
            setState('idle');
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="authform" role="status">
      <p className="authform__lede">Signing you in&hellip;</p>
    </div>
  );
}

/**
 * The form, wherever it is needed: its own page below, or the re-auth prompt
 * inside `RequireAuth`.
 *
 * A MISSING KEY GETS A STATED REFUSAL, not a blank panel. `VITE_*` values bake
 * at BUILD time (CLAUDE.md §5), so setting one in the dashboard changes
 * nothing until the next deploy — which is the one thing whoever meets this
 * needs to be told.
 */
export function SignInForm() {
  if (!CLERK_KEY) {
    return (
      <div className="authform">
        <p className="authform__error" role="alert">
          This copy of the admin was built without its sign-in key, so there is no way to sign
          in. A developer needs to set VITE_CLERK_PUBLISHABLE_KEY and deploy again.
        </p>
      </div>
    );
  }
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <Exchange />
    </ClerkProvider>
  );
}

export default function Login() {
  const session = useSyncExternalStore(subscribe, getSession, getSession);
  const location = useLocation();

  /*
   * Already signed in: go where they were headed. Unchanged from the password
   * era — signed out, sign in, land back on the screen that sent you here.
   */
  if (session.status !== 'unknown' && session.status !== 'anonymous') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/' ? from : '/dashboard'} replace />;
  }

  return (
    <div className="authpage">
      <div className="authpage__card">
        {/* The logo inside the heading, exactly as the dashboard masthead does
            it: the artwork carries its own `alt`, so a screen reader hears the
            publication once rather than once for the image and again for a
            heading beside it. */}
        <h1 className="authpage__title">
          <BrandLogo className="authpage__logo" />
        </h1>
        <p className="authpage__lede">
          Sign in to write. Accounts here are by invitation only, so there is
          nothing to sign up for — if you are expecting an invitation, it
          arrives as a link.
        </p>
        <SignInForm />
      </div>
    </div>
  );
}
