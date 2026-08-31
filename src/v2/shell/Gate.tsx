import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { adoptUser, getSession, subscribe } from '../../data/session';
import { api } from '../../data/api';
import { ApiError, OfflineError } from '../../data/errors';
import { brand } from '../../brand';
import { Button } from '../ui/primitives';
import { TextField } from '../ui/Field';
import { Shell } from './Shell';

/**
 * v2's auth gate. The sign-in below is v1's page restated in v2's system —
 * same artwork, same lede, same invitation framing, and the same error
 * taxonomy — with none of v1's CSS imported, so the two builds still cannot
 * bleed into each other.
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
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password do not match an account.';
    if (err.status === 429) {
      const seconds = err.retryAfter;
      return seconds
        ? `Too many attempts. Try again in ${Math.ceil(seconds)} seconds.`
        : 'Too many attempts. Try again shortly.';
    }
    if (err.status === 400) return 'That does not look like an email address.';
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

        {challenge ? (
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
            {/* v1's lede, kept word for word: the invitation sentence is doing
                real work — it is the whole answer to "where do I sign up?". */}
            <p className="signin__lede">
              Accounts here are by invitation only, so there is nothing to sign up for — if you are
              expecting an invitation, it arrives as a link.
            </p>

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

        <p className="signin__foot">
          Password resets and invitations run on the current admin while this design preview is up.
        </p>
      </div>
    </div>
  );
}
