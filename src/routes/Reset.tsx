import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../data/api';
import { ApiError, OfflineError } from '../data/errors';
import { BrandLogo } from '../components/BrandLogo';
import './auth.css';

/**
 * Choose a new password.
 *
 * Rendered OUTSIDE `RequireAuth` (see `main.tsx`): whoever opened this cannot
 * sign in, which is the whole reason they are here.
 *
 * The token arrives in `?token=`, which under a hash router means the search
 * string of the in-hash path — `RESET_PATH` in `server/routes/auth.ts` is
 * `/#/reset` precisely so that `useSearchParams` can see it, the same shape and
 * for the same reason as `/accept-invite`.
 *
 * IT DOES NOT SIGN YOU IN, and that is the server's decision, not an omission
 * here: `POST /auth/reset` sets no cookie and sweeps every existing session,
 * so that a token sitting in a mailbox cannot become a live session without the
 * new password being typed. There is no user to adopt; the writer goes to the
 * sign-in form and proves they know what they just chose.
 */

/**
 * `MIN_PASSWORD_LENGTH` in `server/repo/users.ts`, restated rather than
 * imported, exactly as `AcceptInvite.tsx` restates it: nothing in `src/` may
 * import from `server/`.
 *
 * THE SERVER IS STILL THE AUTHORITY — it answers 400 `detail: 'password'`
 * regardless, and that is handled below. This only spares a round trip.
 */
const MIN_PASSWORD_LENGTH = 10;

/**
 * `offerNew` is what puts a "/forgot" link inside the error, and it is set for
 * the dead-token case ALONE. Offering a fresh link beside "the two passwords do
 * not match" reads as though the link were the problem, and sends someone back
 * to their inbox to fix a typo they could have fixed in place.
 */
interface Failure {
  text: string;
  offerNew: boolean;
}

function messageFor(err: unknown): Failure {
  const plain = (text: string): Failure => ({ text, offerNew: false });
  if (err instanceof OfflineError) {
    return plain('Could not reach the server. Check your connection and try again.');
  }
  if (err instanceof ApiError) {
    if (err.status === 400) {
      /*
       * `detail` names the FIELD and never the value — the server refuses to
       * echo a password into a body that gets logged.
       */
      if (err.detail === 'password') {
        return plain(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      /*
       * The likely failure, by a distance: reset links are single-use and
       * short-lived, and the three ways to fail — expired, already spent,
       * mangled in transit — are one status with one `detail`, so the copy has
       * to cover all three and offer the way out rather than guess.
       */
      return {
        text: 'This reset link has expired or has already been used. Reset links work once, and not for long.',
        offerNew: true,
      };
    }
    if (err.status === 429) {
      const seconds = err.retryAfter;
      return plain(
        seconds
          ? `Too many attempts. Try again in ${Math.ceil(seconds)} seconds.`
          : 'Too many attempts. Try again shortly.',
      );
    }
    return plain(
      err.requestId
        ? `Something went wrong at our end. Reference ${err.requestId}.`
        : 'Something went wrong at our end. Please try again.',
    );
  }
  return plain('Something went wrong. Please try again.');
}

export default function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const id = useId();

  if (!token) {
    /*
     * No token at all is a link that lost its query string on the way here —
     * usually a mail client wrapping it across two lines. Saying so beats an
     * empty form that cannot succeed.
     */
    return (
      <div className="authpage">
        <div className="authpage__card empty">
          <h1 className="empty__title">This reset link is incomplete</h1>
          <p className="empty__body">
            The link needs the code it was sent with. Copy it from the original
            message and open it whole, or ask for a new one.
          </p>
          <Link className="btn btn--primary" to="/forgot">
            Send a new reset link
          </Link>
        </div>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError({
        text: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
        offerNew: false,
      });
      return;
    }
    if (password !== confirm) {
      setError({ text: 'The two passwords do not match.', offerNew: false });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      // Neither field keeps the password in state past this point.
      setPassword('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="authpage">
        <div className="authpage__card">
          <h1 className="authpage__title">
            <BrandLogo className="authpage__logo" />
          </h1>
          <p className="authpage__lede" role="status">
            Your password has been changed, and every session that was open
            elsewhere has been signed out. Sign in with the new one.
          </p>
          <Link className="btn btn--primary" to="/dashboard">
            Go to sign in
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
          Choose a new password. You will be asked to sign in with it
          afterwards, so pick something you can remember.
        </p>

        <form className="authform" onSubmit={submit} noValidate>
          <label className="label" htmlFor={`${id}-password`}>
            New password
          </label>
          <input
            id={`${id}-password`}
            className="input"
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            required
            autoFocus
            aria-describedby={`${id}-hint`}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="authform__hint" id={`${id}-hint`}>
            At least {MIN_PASSWORD_LENGTH} characters. Longer is better than
            stranger — a phrase you can remember beats a short scramble you
            cannot.
          </p>

          <label className="label authform__label" htmlFor={`${id}-confirm`}>
            New password again
          </label>
          <input
            id={`${id}-confirm`}
            className="input"
            type="password"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirm}
            required
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {error && (
            <p className="authform__error" id={`${id}-error`} role="alert">
              {error.text}
              {error.offerNew && (
                <>
                  {' '}
                  <Link to="/forgot">Ask for a new reset link.</Link>
                </>
              )}
            </p>
          )}

          <button
            className="btn btn--primary authform__submit"
            type="submit"
            disabled={busy || password === '' || confirm === ''}
          >
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </div>
    </div>
  );
}
