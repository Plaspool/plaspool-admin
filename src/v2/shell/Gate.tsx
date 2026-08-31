import { Suspense, lazy, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { adoptUser, getSession, subscribe } from '../../data/session';
import { api } from '../../data/api';
import { ApiError, OfflineError } from '../../data/errors';
import { brand } from '../../brand';
import { Button, Spinner } from '../ui/primitives';
import { TextField } from '../ui/Field';
import { Shell } from './Shell';

/**
 * Clerk is a LAZY CHUNK, rendered only when the publishable key was baked in —
 * a deployment without Clerk ships none of its code (see ClerkGate.tsx).
 */
const CLERK_KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ?? '';
const ClerkGate = lazy(() => import('./ClerkGate'));

/** The official four-colour G, inlined — Google's brand spec wants the real
 *  mark on a sign-in button, and an icon font would ship a whole set for one
 *  glyph. Sized to sit on the black button (`.signin__google`). */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

/**
 * v2's auth gate. The sign-in below keeps v1's error taxonomy with none of
 * v1's CSS imported, so the two builds cannot bleed into each other. The
 * invitation lede v1 carried was cut on the owner's instruction (2026-08-31):
 * the card is title, Google door, fields — short and simple.
 */
export function Gate() {
  const session = useSyncExternalStore(subscribe, getSession, getSession);

  /* `unknown` means `/auth/me` has not answered. Rendering nothing here is
     what keeps the sign-in form from flashing at somebody who is already
     signed in. */
  if (session.status === 'unknown') return null;

  if (session.status === 'authed' || session.status === 'offline') {
    const user = session.user;
    if (!user) return <SignIn />;
    return <Shell storeName={brand.name} userName={user.displayName || user.email} />;
  }

  return <SignIn prefill={session.user?.email ?? ''} />;
}

/**
 * WHAT A FAILED SIGN-IN IS ALLOWED TO SAY — copied from v1 verbatim, because
 * the wording is a security decision and not copy. The server answers
 * identically for an unknown email and a wrong password (same status, same
 * body, same scrypt cost): this is an invite-only instance, and knowing WHICH
 * addresses have accounts is most of what an attacker wants. A client that
 * split the two apart again would hand the enumeration oracle straight back.
 */
function messageFor(err: unknown): string {
  if (err instanceof OfflineError) {
    return 'Couldn’t reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password don’t match an account.';
    if (err.status === 429) {
      const seconds = err.retryAfter;
      return seconds
        ? `Too many attempts. Try again in ${Math.ceil(seconds)} seconds.`
        : 'Too many attempts. Try again shortly.';
    }
    if (err.status === 400) return 'That doesn’t look like an email address.';
    /* A 500's body carries nothing but the request id — quoting it is what
       makes the failure diagnosable from a bug report. */
    return err.requestId
      ? `Something went wrong at our end. Reference ${err.requestId}.`
      : 'Something went wrong at our end. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

function SignIn({ prefill = '' }: { prefill?: string }) {
  const [email, setEmail] = useState(prefill);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Non-null between the password verifying and the emailed code arriving —
     the ticket is the server's proof the first factor happened, so the code
     form never holds a password. */
  const [challenge, setChallenge] = useState<{ ticket: string } | null>(null);
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);
  /* 'clerk' swaps the card for Clerk's own flow (Google + whatever factors
     the Clerk dashboard demands). Only offered when the key was baked in. */
  const [mode, setMode] = useState<'password' | 'clerk'>('password');

  useEffect(() => {
    if (prefill) setEmail(prefill);
  }, [prefill]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      /* v1's rule, kept: the password never sits in component state after the
         attempt resolves, successful or not. */
      setPassword('');
      if (result.kind === 'code') {
        setChallenge({ ticket: result.ticket });
        setBusy(false);
        return;
      }
      /* `adoptUser`, not local state: it decides whether this is the same
         person coming back (keep everything) or a different one (clear the
         cache), and scopes the offline cache to this account. */
      await adoptUser(result.user);
    } catch (cause) {
      setError(messageFor(cause));
      setBusy(false);
    }
  }

  async function onSubmitCode(event: FormEvent) {
    event.preventDefault();
    if (busy || !challenge) return;
    setBusy(true);
    setError(null);
    try {
      const user = await api.loginCode(challenge.ticket, code.trim());
      setCode('');
      await adoptUser(user);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? 'That code didn’t work. It may have expired — codes last ten minutes.'
          : messageFor(cause),
      );
      setBusy(false);
    }
  }

  async function resend() {
    if (!challenge) return;
    setResent(true);
    try {
      await api.resendLoginCode(challenge.ticket);
    } catch {
      /* 202-or-nothing by design; the button's own state is the feedback. */
    }
  }

  return (
    <div className="signin">
      <div className="signin__col">
        {/* The lockup for LIGHT surfaces — this page is one. `alt` carries the
            name, so the brand is announced once, not once per element. */}
        {brand.assets.logoLight ? (
          <img className="signin__logo" src={brand.assets.logoLight} alt={brand.name} />
        ) : (
          <span style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)' }}>{brand.name}</span>
        )}

        {mode === 'clerk' && CLERK_KEY ? (
          <Suspense
            fallback={
              <div className="signin__card" role="status" style={{ display: 'grid', placeItems: 'center', minHeight: '12rem' }}>
                <Spinner large />
              </div>
            }
          >
            <ClerkGate publishableKey={CLERK_KEY} onBack={() => setMode('password')} />
          </Suspense>
        ) : challenge ? (
          <form className="signin__card" onSubmit={onSubmitCode} noValidate>
            <h1 className="signin__title">Check your email</h1>
            <p className="signin__lede">
              A six-digit code is on its way to <strong>{email.trim()}</strong>. Enter it here to
              finish signing in — it works once and expires in ten minutes.
            </p>

            <TextField
              label="Sign-in code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />

            {error ? (
              <p className="signin__error" role="alert">
                {error}
              </p>
            ) : null}

            <Button
              tone="primary"
              size="lg"
              type="submit"
              busy={busy}
              disabled={code.trim().length < 6}
              onClick={() => {}}
            >
              Verify code
            </Button>

            <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--s2)' }}>
              <Button
                tone="plain"
                type="button"
                onClick={() => {
                  setChallenge(null);
                  setCode('');
                  setError(null);
                  setResent(false);
                }}
              >
                Start over
              </Button>
              <Button tone="plain" type="button" disabled={resent} onClick={() => void resend()}>
                {resent ? 'Code re-sent' : 'Send a new code'}
              </Button>
            </div>
          </form>
        ) : (
          <form className="signin__card" onSubmit={onSubmit} noValidate>
            <h1 className="signin__title">Sign in</h1>

            {/* Google FIRST and black, with the real G — the owner's spec
                (2026-08-31 follow-up). The invitation lede that used to live
                here went with the same instruction: short and simple. */}
            {CLERK_KEY ? (
              <>
                <button type="button" className="signin__google" onClick={() => setMode('clerk')}>
                  <GoogleG />
                  Continue with Google
                </button>
                <div className="signin__or" aria-hidden="true">
                  or
                </div>
              </>
            ) : null}

            <TextField
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error ? (
              <p className="signin__error" role="alert">
                {error}
              </p>
            ) : null}

            <Button
              tone="primary"
              size="lg"
              type="submit"
              busy={busy}
              disabled={email.trim() === '' || password === ''}
              onClick={() => {}}
            >
              Sign in
            </Button>

          </form>
        )}
      </div>
    </div>
  );
}
