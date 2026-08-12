import { useId, useState, type FormEvent } from 'react';
import { api } from '../data/api';
import { ApiError, OfflineError } from '../data/errors';
import { adoptUser } from '../data/session';
import { BrandLogo } from '../components/BrandLogo';
import './auth.css';

/**
 * Sign in.
 *
 * The form is a separate export from the page because the same form is the
 * mid-session re-auth prompt (`RequireAuth`), where it renders over a live
 * editor rather than on a page of its own. One implementation, so the two can
 * never disagree about what a 429 means or which errors are worth showing.
 */

/**
 * WHAT A FAILED SIGN-IN IS ALLOWED TO SAY.
 *
 * `server/routes/auth.ts` answers identically for an unknown email and a wrong
 * password — same status, same body, and deliberately the same scrypt cost —
 * because this is an invite-only instance where knowing WHICH addresses have
 * accounts is most of what an attacker wants. A client that helpfully split
 * that back into "no such account" and "wrong password" would hand the
 * enumeration oracle straight back, from the one place nobody thinks to audit.
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
    /*
     * A 500's body carries nothing but the request id — the server logs the
     * detail beside the same id rather than returning it — so quoting it is
     * the whole of what makes the failure diagnosable from a bug report.
     */
    return err.requestId
      ? `Something went wrong at our end. Reference ${err.requestId}.`
      : 'Something went wrong at our end. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

export function SignInForm({
  initialEmail = '',
  lockEmail = false,
  submitLabel = 'Sign in',
}: {
  initialEmail?: string;
  /** Re-auth knows who you are; retyping your own address proves nothing. */
  lockEmail?: boolean;
  submitLabel?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(email.trim(), password);
      /*
       * `adoptUser` and not a local setState: it is what decides whether this
       * is the same person coming back (keep everything) or a different one
       * (clear the cache), sets the ambient user id `src/data/posts.ts` reads,
       * and starts the replay of whatever went unsent.
       */
      await adoptUser(user);
      // The password never goes back into a controlled input's state after
      // this point, successful or not.
      setPassword('');
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <form className="authform" onSubmit={submit} noValidate>
      <label className="label" htmlFor={`${errorId}-email`}>
        Email
      </label>
      <input
        id={`${errorId}-email`}
        className="input"
        type="email"
        name="email"
        autoComplete="username"
        value={email}
        readOnly={lockEmail}
        required
        autoFocus={!lockEmail}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label className="label authform__label" htmlFor={`${errorId}-password`}>
        Password
      </label>
      <input
        id={`${errorId}-password`}
        className="input"
        type="password"
        name="password"
        autoComplete="current-password"
        value={password}
        required
        autoFocus={lockEmail}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && (
        <p className="authform__error" id={errorId} role="alert">
          {error}
        </p>
      )}

      <button
        className="btn btn--primary authform__submit"
        type="submit"
        disabled={busy || email.trim() === '' || password === ''}
      >
        {busy ? 'Signing in…' : submitLabel}
      </button>
    </form>
  );
}

export default function Login() {
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
