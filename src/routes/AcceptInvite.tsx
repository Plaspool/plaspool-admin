import { useId, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../data/api';
import { ApiError, OfflineError } from '../data/errors';
import { adoptUser } from '../data/session';
import { BrandLogo } from '../components/BrandLogo';
import './auth.css';

/**
 * Claim an invitation.
 *
 * Rendered OUTSIDE `RequireAuth` (see `main.tsx`), because the whole point of
 * this screen is that the person opening it has no account yet. It ends by
 * calling `adoptUser`, since `POST /auth/accept-invite` sets the session cookie
 * on the way out — accepting an invite signs you in.
 *
 * The token arrives in `?token=`, which under a hash router means the search
 * string of the in-hash path. `INVITE_PATH` is `/#/accept-invite` precisely so
 * that it lands there; the old path form is rewritten by the bootstrap in
 * `main.tsx` before the router mounts. See plan §0 F3 — every invite link the
 * server minted before that change put the token where nothing could read it.
 */

/**
 * `MIN_PASSWORD_LENGTH` in `server/repo/users.ts`, restated rather than
 * imported: nothing in `src/` may import from `server/`, which pulls in
 * `node:crypto` and the environment loader.
 *
 * THE SERVER IS STILL THE AUTHORITY. This only decides whether to spend a
 * round trip, and the 400 it is mirroring is handled below regardless — so if
 * the two ever drift, the failure is one wasted request with a correct message,
 * not an account created under a rule the server does not enforce.
 */
const MIN_PASSWORD_LENGTH = 10;

function messageFor(err: unknown): string {
  if (err instanceof OfflineError) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 400) {
      /*
       * `detail` names the FIELD and never the value — the server refuses to
       * echo a password into a response body that gets logged. Four fields
       * reach here (`server/middleware/errors.ts`), and "invite" is the one
       * that is not the writer's fault.
       */
      if (err.detail === 'password') {
        return `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
      }
      if (err.detail === 'displayName') return 'Please enter the name to publish under.';
      if (err.detail === 'email') return 'There is already an account for that email address.';
      return 'This invitation is no longer valid. It may have expired, or already been used. Ask for a new one.';
    }
    if (err.status === 429) {
      return 'Too many attempts from this connection. Try again shortly.';
    }
    return err.requestId
      ? `Something went wrong at our end. Reference ${err.requestId}.`
      : 'Something went wrong at our end. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  if (!token) {
    /*
     * No token at all is almost always a link that lost its query string on
     * the way here — a mail client wrapping it, or the pre-F3 path form
     * arriving somewhere the bootstrap could not rewrite. Saying so is more
     * useful than an empty form that cannot succeed.
     */
    return (
      <div className="authpage">
        <div className="authpage__card empty">
          <h1 className="empty__title">This invitation link is incomplete</h1>
          <p className="empty__body">
            The link needs the code it was sent with. Copy it from the original
            message and open it whole, or ask for a new invitation.
          </p>
        </div>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await api.acceptInvite({
        token,
        password,
        displayName: displayName.trim(),
      });
      setPassword('');
      await adoptUser(user);
      /*
       * `replace`, so Back cannot return to a form whose token has now been
       * claimed — the second submission would 400 with "invite", which reads
       * like the invitation was broken rather than already used.
       */
      navigate('/', { replace: true });
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <div className="authpage">
      <div className="authpage__card">
        <h1 className="authpage__title">
          <BrandLogo className="authpage__logo" />
        </h1>
        <p className="authpage__lede">
          You have been invited to write here. Choose how your name appears on
          what you publish, and a password to sign in with.
        </p>

        <form className="authform" onSubmit={submit} noValidate>
          <label className="label" htmlFor={`${id}-name`}>
            Name to publish under
          </label>
          <input
            id={`${id}-name`}
            className="input"
            type="text"
            name="displayName"
            autoComplete="name"
            maxLength={200}
            value={displayName}
            required
            autoFocus
            onChange={(e) => setDisplayName(e.target.value)}
          />

          <label className="label authform__label" htmlFor={`${id}-password`}>
            Password
          </label>
          <input
            id={`${id}-password`}
            className="input"
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            required
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="authform__hint" id={`${id}-hint`}>
            At least {MIN_PASSWORD_LENGTH} characters. Longer is better than
            stranger — a phrase you can remember beats a short scramble you
            cannot.
          </p>

          {error && (
            <p className="authform__error" id={`${id}-error`} role="alert">
              {error}
            </p>
          )}

          <button
            className="btn btn--primary authform__submit"
            type="submit"
            disabled={busy || displayName.trim() === '' || password === ''}
          >
            {busy ? 'Creating your account…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
