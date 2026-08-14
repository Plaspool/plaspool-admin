import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../data/api';
import { ApiError, OfflineError } from '../data/errors';
import { BrandLogo } from '../components/BrandLogo';
import './auth.css';

/**
 * Ask for a password reset link.
 *
 * Rendered OUTSIDE `RequireAuth` (see `main.tsx`) for the obvious reason: a
 * writer who cannot sign in has no session, and the guard would answer this
 * screen with the very form they are stuck on.
 */

/**
 * WHAT A SUCCESSFUL REQUEST IS ALLOWED TO SAY.
 *
 * `POST /api/auth/forgot` answers 202 for every address alike — the route does
 * not tell this client whether an account was found, and `api.forgotPassword`
 * deliberately returns nothing for a caller to branch on. The confirmation
 * below therefore has to be phrased conditionally. "We've emailed you a link"
 * would undo, from the one layer nobody audits for it, the enumeration defence
 * the server pays for on every request.
 */
const SENT_MESSAGE =
  "If there's an account for that address, a reset link is on its way. It expires " +
  'shortly, so open it when you get it.';

function messageFor(err: unknown): string {
  if (err instanceof OfflineError) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 429) {
      const seconds = err.retryAfter;
      return seconds
        ? `Too many requests for a reset link. Try again in ${Math.ceil(seconds)} seconds.`
        : 'Too many requests for a reset link. Try again shortly.';
    }
    /*
     * 501 is about the DEPLOYMENT, not the address: no mailer is configured, so
     * nothing was sent and nothing will be. The route checks this before it
     * looks the account up, precisely so the answer is the same for everybody —
     * showing the reassuring "on its way" copy here would leave someone waiting
     * for mail that cannot arrive.
     */
    if (err.status === 501) {
      return 'This deployment cannot send email, so reset links are unavailable here. Ask whoever runs it to reset your password directly.';
    }
    if (err.status === 400) return 'That does not look like an email address.';
    return err.requestId
      ? `Something went wrong at our end. Reference ${err.requestId}.`
      : 'Something went wrong at our end. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(messageFor(err));
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <div className="authpage">
        <div className="authpage__card">
          <h1 className="authpage__title">
            <BrandLogo className="authpage__logo" />
          </h1>
          <p className="authpage__lede" role="status">
            {SENT_MESSAGE}
          </p>
          <Link className="btn btn--ghost btn--sm" to="/dashboard">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="authpage">
      <div className="authpage__card">
        <h1 className="authpage__title">
          <BrandLogo className="authpage__logo" />
        </h1>
        <p className="authpage__lede">
          Give us the address you sign in with and we will send a link that lets
          you choose a new password.
        </p>

        <form className="authform" onSubmit={submit} noValidate>
          <label className="label" htmlFor={`${id}-email`}>
            Email
          </label>
          <input
            id={`${id}-email`}
            className="input"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            required
            autoFocus
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />

          {error && (
            <p className="authform__error" id={`${id}-error`} role="alert">
              {error}
            </p>
          )}

          <button
            className="btn btn--primary authform__submit"
            type="submit"
            disabled={busy || email.trim() === ''}
          >
            {busy ? 'Sending…' : 'Send a reset link'}
          </button>
        </form>

        <Link className="btn btn--ghost btn--sm" to="/dashboard">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
