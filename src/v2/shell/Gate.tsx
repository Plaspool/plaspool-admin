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

  useEffect(() => {
    if (prefill) setEmail(prefill);
  }, [prefill]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(email.trim(), password);
      /* `adoptUser`, not local state: it decides whether this is the same
         person coming back (keep everything) or a different one (clear the
         cache), and scopes the offline cache to this account. */
      await adoptUser(user);
      /* v1's rule, kept: the password never sits in component state after the
         attempt resolves, successful or not. */
      setPassword('');
    } catch (cause) {
      setError(messageFor(cause));
      setBusy(false);
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

        <p className="signin__foot">
          Password resets and invitations run on the current admin while this design preview is up.
        </p>
      </div>
    </div>
  );
}
