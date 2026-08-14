import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, Copy, Pencil } from 'lucide-react';
import { Select } from '../components/ui/Select';
import { Switch } from '../components/ui/Switch';
import { Spinner } from '../components/ui/Feedback';
import { useDelayed } from '../components/ui/useDelayed';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { useSession } from '../components/RequireAuth';
import { relative } from '../components/PostCard';
import { accountApi, MIN_PASSWORD_LENGTH, type SessionSummary } from '../data/api-account';
import {
  refusalOf,
  teamApi,
  type MintedInvite,
  type TeamInvite,
  type TeamUser,
} from '../data/api-team';
import { categoriesApi, type CategorySummary } from '../data/api-categories';
import { ApiError, OfflineError, PreconditionFailedError } from '../data/errors';
import { adoptUser } from '../data/session';
import { TEMPLATES, useSettings, type ReadingTemplate, type ThemeSetting } from '../data/settings';
import type { AuthUser } from '../data/types';
import './settings.css';

/**
 * Settings, which is now two screens wearing one coat.
 *
 * The bottom half is the original one: four layout cards, a theme, two
 * switches and a byline, all of them `localStorage` and all of them honest
 * about it in the footnote. Nothing there has moved — the group label above it
 * exists precisely so that footnote still has an unambiguous subject now that
 * there is something else on the page for it to be read against.
 *
 * The top half talks to the server (HANDOFF §3 B2). Three sections, three
 * different audiences:
 *
 * - **Account** — yours, always visible.
 * - **Team** — owner-only, and HIDDEN rather than disabled. That is this app's
 *   existing rule for owner-only surfaces (`Dashboard.tsx:1093` hides the empty
 *   trash button and explains its absence), and the "explain the gap" half of
 *   it does not apply here: a writer is not missing a control they might expect,
 *   they are being kept away from the email address of every person with a
 *   login — which is most of what `server/routes/auth.ts` is written to stop an
 *   attacker assembling. `GET /api/users` is `requireOwner()`, so rendering it
 *   disabled would be a list-shaped 403 waiting to happen.
 * - **Categories** — every writer, except DELETE, which is owner-only on the
 *   route because it rewrites `posts.category` on posts the caller did not
 *   write. That button IS explained rather than left as a gap, because a writer
 *   who can rename and cannot delete would otherwise just think it was missing.
 *
 * Every section loads on mount and reloads after its own mutations rather than
 * patching a local copy. The lists are small by construction — an invite-only
 * blog's accounts, invites and category vocabulary — so a re-read costs one
 * request and buys the guarantee that what is on screen is what the server
 * holds, which matters most on exactly the rows a mutation just changed.
 */

/** A tiny wireframe of each layout, drawn in CSS — no screenshots to go stale. */
function TemplatePreview({ id }: { id: ReadingTemplate }) {
  return (
    <div className={`tpv tpv--${id}`} aria-hidden="true">
      {id === 'editorial' && <span className="tpv__cover" />}
      {id === 'technical' ? (
        <span className="tpv__split">
          <span className="tpv__rail">
            <span className="tpv__line tpv__line--xs" />
            <span className="tpv__line tpv__line--xs" />
            <span className="tpv__line tpv__line--xs" />
          </span>
          <span className="tpv__col">
            <span className="tpv__title" />
            <span className="tpv__line" />
            <span className="tpv__line" />
            <span className="tpv__line tpv__line--short" />
          </span>
        </span>
      ) : (
        <>
          <span className="tpv__title" />
          {id !== 'minimal' && <span className="tpv__sub" />}
          {id === 'magazine' && <span className="tpv__cover tpv__cover--wide" />}
          <span className="tpv__line" />
          <span className="tpv__line" />
          <span className="tpv__line tpv__line--short" />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ shared plumbing

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** "1 post" / "4 posts", because "1 posts" is the thing everybody notices. */
const posts = (n: number): string => (n === 1 ? '1 post' : `${n} posts`);

/**
 * An error, as a sentence for a person.
 *
 * Modelled on `AcceptInvite.tsx`'s, including the rule it is built on: a 400's
 * `detail` names the FIELD and never the value, so a caller that wants to put a
 * message under a specific input branches on `detail` itself and only falls
 * through to here for the ones it does not recognise.
 */
function messageFor(err: unknown): string {
  if (err instanceof OfflineError) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session ended. Sign in again to continue.';
    if (err.status === 403) return 'Only the blog owner can do that.';
    if (err.status === 404) return 'That is no longer there — the list has moved on.';
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (err.status === 400) {
      return err.detail
        ? `That was refused because of the ${err.detail} field.`
        : 'That request was refused.';
    }
    return err.requestId
      ? `Something went wrong at our end. Reference ${err.requestId}.`
      : 'Something went wrong at our end. Please try again.';
  }
  return 'Something went wrong. Please try again.';
}

interface Remote<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-read from the server. Every mutation on this page ends in one. */
  reload: () => void;
}

/**
 * One section's server data.
 *
 * WRITTEN AS A HOOK RATHER THAN THREE COPIES OF THE SAME EFFECT because the
 * part that is easy to get wrong is the same every time and is invisible when
 * it is wrong: `apiFetch` turns an aborted request into an `OfflineError` —
 * `fetch` rejects, and the catch there cannot tell a cancelled request from a
 * dropped connection — so a section unmounted mid-flight would otherwise paint
 * "could not reach the server" on its way out, or set state on a component that
 * is gone. The `live` flag decides that, not the error class.
 *
 * `load` is captured in a ref that is refreshed BEFORE the fetching effect
 * runs, so a caller may pass an inline arrow without re-firing the request on
 * every render — which is what a plain dependency on it would do.
 */
function useRemote<T>(load: (signal: AbortSignal) => Promise<T>): Remote<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const latest = useRef(load);
  // Declared first, so on any render it has already run by the time the effect
  // below is considered. Effects fire in declaration order.
  useEffect(() => {
    latest.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setLoading(true);
    latest.current(controller.signal).then(
      (value) => {
        if (!live) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(messageFor(err));
        setLoading(false);
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [nonce]);

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * A block inside a section: a titled, bordered card.
 *
 * The `settings__rows` container the original screen uses is a list of rows and
 * nothing else; these carry forms and lists that need a heading of their own
 * without becoming a second `<h2>` in the section.
 */
function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="setblock">
      <div className="setblock__head">
        <h3 className="setblock__title">{title}</h3>
        {hint && <p className="setblock__hint">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * The three states a loaded list has, in one place.
 *
 * The spinner is delayed by the same 250 ms every other loader in this app uses
 * (`useDelayed`): these routes usually answer faster than a blink, and a
 * spinner that appears and vanishes reads as a glitch rather than as loading.
 */
function ListState({
  remote,
  empty,
  children,
}: {
  remote: Remote<unknown>;
  empty: string;
  children: ReactNode;
}) {
  const spin = useDelayed(remote.loading);
  if (remote.loading) {
    return <p className="setempty">{spin ? <Spinner /> : null}</p>;
  }
  if (remote.error) {
    return (
      <p className="setempty setempty--err" role="alert">
        {remote.error}{' '}
        <button className="btn btn--ghost btn--sm" onClick={remote.reload}>
          Try again
        </button>
      </p>
    );
  }
  const list = Array.isArray(remote.data) ? remote.data : [];
  if (list.length === 0) return <p className="setempty">{empty}</p>;
  return <>{children}</>;
}

// ------------------------------------------------------------------ account

/**
 * Your name, on everything you have ever published, changed in one statement.
 *
 * NOTHING NEEDS RE-FETCHING AFTERWARDS EXCEPT THE SESSION. `posts` has no
 * `author_name` column — the four queries that produce one read
 * `u.display_name` through a live JOIN — so every list, the export bundle and
 * the public feed carry the new name the moment the PATCH commits. The one
 * stale copy left in the app is the `AuthUser` the session store is holding,
 * which is what the sidebar's identity block renders from.
 *
 * `adoptUser` is how that copy is replaced, and it is safe here for a reason
 * worth stating: its destructive arm fires only when the incoming id differs
 * from the one this device holds, and this is the same account. The replay it
 * starts is the same one every login starts — a no-op when nothing is queued,
 * and the right thing when something is.
 */
function DisplayNameRow({ user }: { user: AuthUser }) {
  const { notify } = useToast();
  const [value, setValue] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const trimmed = value.trim();
  const dirty = trimmed !== '' && trimmed !== user.displayName;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    try {
      await adoptUser(await accountApi.updateDisplayName(trimmed));
      notify('Your name is updated on everything you have published');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400 && err.detail === 'displayName'
          ? 'Enter the name to publish under.'
          : messageFor(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings__row">
      <div>
        <p className="settings__label">Display name</p>
        <p className="settings__hint">
          Your byline, stored with your account rather than with this browser —
          so it is the same everywhere you sign in.
        </p>
      </div>
      <form className="setinline" onSubmit={save} noValidate>
        <span className="setinline__ctl">
          <input
            id={`${id}-name`}
            className="input settings__input"
            value={value}
            maxLength={200}
            aria-label="Display name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn btn--primary btn--sm" type="submit" disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </span>
        {error && (
          <p className="seterr" id={`${id}-err`} role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * Change the password from inside the session, which is the path the reset flow
 * deliberately is not.
 *
 * THE WRONG-CURRENT-PASSWORD CASE IS A 400 AND NOT A 401, and this form is the
 * reason the server chose that. `api.ts` announces `auth-expired` for every
 * 401, which raises the re-authentication overlay over whatever is on screen —
 * so a 401 here would make one typo look exactly like a dead session, on the
 * one screen where the writer is in the middle of proving they know their
 * password. `detail` names the field and the message goes under that field.
 *
 * The ten-character floor is mirrored client-side for the same reason
 * `AcceptInvite` mirrors it: to save a round trip, never to be the authority.
 * `assertCredentials` inside `changePassword` is the authority, and its 400
 * `detail: 'password'` is handled below regardless.
 */
function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const { notify } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    current?: string;
    next?: string;
    confirm?: string;
    form?: string;
  }>({});
  const id = useId();

  const ready = current !== '' && next !== '' && confirm !== '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;

    if (next.length < MIN_PASSWORD_LENGTH) {
      setErrors({ next: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }
    if (next !== confirm) {
      setErrors({ confirm: 'These two do not match.' });
      return;
    }

    setBusy(true);
    setErrors({});
    try {
      const { otherSessionsEnded } = await accountApi.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      /*
       * Cleared before anything else, including before the toast. Three
       * password values sitting in component state after a successful change
       * are three values a later render, a devtools inspection or an
       * error-reporting hook could pick up, and none of them are needed again.
       */
      setCurrent('');
      setNext('');
      setConfirm('');
      notify(
        otherSessionsEnded === 0
          ? 'Password changed. No other devices were signed in.'
          : otherSessionsEnded === 1
            ? 'Password changed. 1 other device was signed out.'
            : `Password changed. ${otherSessionsEnded} other devices were signed out.`,
      );
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.detail === 'currentPassword') {
        setErrors({ current: 'That is not your current password.' });
      } else if (err instanceof ApiError && err.status === 400 && err.detail === 'password') {
        setErrors({ next: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.` });
      } else {
        setErrors({ form: messageFor(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block
      title="Password"
      hint={
        <>
          Changing it signs out every other device and leaves this one signed
          in. A phrase you can remember beats a short scramble you cannot.
        </>
      }
    >
      <form className="setform" onSubmit={submit} noValidate>
        <div className="setfield">
          <label className="label" htmlFor={`${id}-current`}>
            Current password
          </label>
          <input
            id={`${id}-current`}
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            aria-invalid={errors.current ? true : undefined}
            aria-describedby={errors.current ? `${id}-current-err` : undefined}
            onChange={(e) => setCurrent(e.target.value)}
          />
          {errors.current && (
            <p className="seterr" id={`${id}-current-err`} role="alert">
              {errors.current}
            </p>
          )}
        </div>

        <div className="setfield">
          <label className="label" htmlFor={`${id}-new`}>
            New password
          </label>
          <input
            id={`${id}-new`}
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            aria-invalid={errors.next ? true : undefined}
            aria-describedby={errors.next ? `${id}-new-err` : `${id}-new-hint`}
            onChange={(e) => setNext(e.target.value)}
          />
          {errors.next ? (
            <p className="seterr" id={`${id}-new-err`} role="alert">
              {errors.next}
            </p>
          ) : (
            <p className="sethint" id={`${id}-new-hint`}>
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          )}
        </div>

        <div className="setfield">
          <label className="label" htmlFor={`${id}-confirm`}>
            Confirm new password
          </label>
          <input
            id={`${id}-confirm`}
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? `${id}-confirm-err` : undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {errors.confirm && (
            <p className="seterr" id={`${id}-confirm-err`} role="alert">
              {errors.confirm}
            </p>
          )}
        </div>

        {errors.form && (
          <p className="seterr" role="alert">
            {errors.form}
          </p>
        )}

        <div className="setform__actions">
          <button className="btn btn--primary" type="submit" disabled={!ready || busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Block>
  );
}

/**
 * Where this account is signed in.
 *
 * THE CURRENT ROW HAS NO REVOKE BUTTON, AND THAT IS NOT SQUEAMISHNESS.
 * `DELETE /api/auth/sessions/:id` accepts it — deliberately, so nobody has to
 * learn a rule — but reaching it from here would end this session while
 * skipping `SignOutButton`, which is the only control in the app that asks
 * about unsent work first. Those `pending` rows are the last copy of words no
 * server ever accepted, and a button that silently walked past that question
 * would be a second way to destroy them. So the row says where the right button
 * is instead.
 *
 * The user-agent string is shown whole and unparsed, exactly as the server
 * stores it. A "Chrome on macOS" guess is a confident sentence about a
 * self-declared field, and being wrong about which device somebody is about to
 * sign out is worse than being ugly about it.
 */
function SessionsList({ remote }: { remote: Remote<SessionSummary[]> }) {
  const { notify } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function revoke(session: SessionSummary) {
    setBusyId(session.id);
    try {
      await accountApi.revokeSession(session.id);
      notify('That sign-in was ended');
    } catch (err) {
      notify(messageFor(err), { tone: 'danger' });
    } finally {
      setBusyId(null);
      remote.reload();
    }
  }

  return (
    <Block
      title="Where you are signed in"
      hint="Each row is one browser holding a live session. Ending one takes effect immediately."
    >
      <ListState remote={remote} empty="No other sign-ins.">
        <ul className="setlist">
          {(remote.data ?? []).map((s) => (
            <li className="setitem" key={s.id}>
              <div className="setitem__main">
                <p className="setitem__name">
                  Last used {relative(s.lastSeenAt)}
                  {s.current && <span className="chip chip--published">This device</span>}
                </p>
                <p className="setitem__meta">
                  Signed in {relative(s.createdAt)} · expires {dateOf(s.expiresAt)}
                </p>
                {s.userAgent && <p className="setua">{s.userAgent}</p>}
              </div>
              <div className="setitem__acts">
                {s.current ? (
                  <p className="setitem__why">
                    Sign this one out from the sidebar — that button asks about
                    work that has not reached the server yet.
                  </p>
                ) : (
                  <button
                    className="btn btn--ghost btn--sm"
                    disabled={busyId === s.id}
                    onClick={() => void revoke(s)}
                  >
                    Sign out
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ListState>
    </Block>
  );
}

function AccountSection({ user }: { user: AuthUser }) {
  const sessions = useRemote((signal) => accountApi.listSessions(signal));

  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2 className="settings__h">Account</h2>
        <p className="settings__desc">
          Signed in as {user.email}. Everything in this section is stored with
          your account, so it follows you to every browser you use.
        </p>
      </div>
      <div className="settings__stack">
        <div className="settings__rows">
          <DisplayNameRow user={user} />
        </div>
        {/* A password change ends every other session, so the list below it is
            stale the instant this succeeds. */}
        <PasswordForm onChanged={sessions.reload} />
        <SessionsList remote={sessions} />
      </div>
    </section>
  );
}

// --------------------------------------------------------------------- team

/**
 * Mint an invitation, and show the link whatever happened to the email.
 *
 * THE LINK IS ALWAYS SHOWN, INCLUDING WHEN THE MAIL WENT. The token is minted
 * exactly once and stored only as an HMAC, so this response is the only copy
 * that will ever exist — hiding it on `emailed: true` would mean a message lost
 * to a spam filter costs a real invitation rather than a copy-paste.
 */
function InviteForm({ onInvited }: { onInvited: () => void }) {
  const { notify } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'writer'>('writer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || email.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const result = await teamApi.createInvite(email.trim(), role);
      setMinted(result);
      setEmail('');
      onInvited();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400 && err.detail === 'email'
          ? 'There is already an account for that address.'
          : messageFor(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    try {
      /*
       * Deliberately NOT `navigator.clipboard?.writeText` — the optional call
       * would resolve to `undefined` where the API is missing and this would
       * report a copy that never happened. Letting it throw is what routes a
       * browser without clipboard access (an insecure origin, a permissions
       * policy, jsdom) into the honest fallback below.
       */
      await navigator.clipboard.writeText(url);
      notify('Invitation link copied');
    } catch {
      urlRef.current?.select();
      notify('This browser would not let us reach the clipboard — the link is selected, so copy it', {
        tone: 'danger',
      });
    }
  }

  return (
    <Block
      title="Invite someone"
      hint="Accounts exist only by invitation. The link works once and expires in seven days."
    >
      <form className="setform" onSubmit={submit} noValidate>
        <div className="setfield">
          <label className="label" htmlFor={`${id}-email`}>
            Email address
          </label>
          <input
            id={`${id}-email`}
            className="input"
            type="email"
            autoComplete="off"
            value={email}
            placeholder="them@example.com"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="setfield">
          {/* A `<span>` and not a `<label>`: Radix renders the trigger as a
              button, which a label cannot be `for`. The trigger carries the
              same word as its `aria-label`, exactly as the existing theme and
              sort controls on this screen do. */}
          <span className="label">Role</span>
          <Select<'owner' | 'writer'>
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: 'writer', label: 'Writer — writes and publishes their own posts' },
              { value: 'owner', label: 'Owner — everything, including this screen' },
            ]}
          />
        </div>

        {error && (
          <p className="seterr" id={`${id}-err`} role="alert">
            {error}
          </p>
        )}

        <div className="setform__actions">
          <button
            className="btn btn--primary"
            type="submit"
            disabled={busy || email.trim() === ''}
          >
            {busy ? 'Creating…' : 'Create invitation'}
          </button>
        </div>
      </form>

      {minted && (
        <div className="setmint" role="status">
          <p className="setmint__said">
            {minted.emailed
              ? `Emailed to ${minted.invite.email}. The link is here too, in case it never arrives.`
              : `Nothing was sent — this deployment has no mail configured. Send ${minted.invite.email} this link yourself; it is the only copy.`}
          </p>
          <div className="setcopy">
            <input
              ref={urlRef}
              className="input setcopy__url"
              readOnly
              value={minted.invite.url}
              aria-label="Invitation link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className="btn btn--outline btn--sm"
              type="button"
              onClick={() => void copyLink(minted.invite.url)}
            >
              <Copy className="ui-ic" aria-hidden="true" />
              Copy
            </button>
          </div>
          <p className="sethint">Expires {dateOf(minted.invite.expiresAt)}.</p>
        </div>
      )}
    </Block>
  );
}

/**
 * Invitations, outstanding by default.
 *
 * THE WHOLE HISTORY IS FETCHED AND THE TOGGLE FILTERS IT, rather than the
 * toggle re-requesting with `?include=accepted,expired`. The history is a
 * superset of the default list on an invite-only blog — tens of rows at the
 * outside — so one request buys an instant toggle and removes a second loading
 * state from a list an owner is scanning. `state` comes from the server and is
 * never re-derived here: it was computed from the same `Date.now()` the route's
 * own filter used, and a clock on this side disagrees with that for any row
 * within seconds of expiry.
 */
function InvitesList({ remote }: { remote: Remote<TeamInvite[]> }) {
  const { notify } = useToast();
  const [history, setHistory] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const all = remote.data ?? [];
  const shown = history ? all : all.filter((i) => i.state === 'open');

  async function revoke(invite: TeamInvite) {
    setBusyId(invite.id);
    try {
      await teamApi.revokeInvite(invite.id);
      notify(`The invitation for ${invite.email} was revoked`);
    } catch (err) {
      notify(messageFor(err), { tone: 'danger' });
    } finally {
      setBusyId(null);
      remote.reload();
    }
  }

  return (
    <Block
      title="Invitations"
      hint="Revoking one kills the link immediately, whether or not it has been opened."
    >
      <div className="setbar">
        <span className="settings__hint">
          {history ? 'Every invitation ever sent.' : 'Outstanding invitations.'}
        </span>
        <span className="setbar__ctl">
          <Switch
            label="Show accepted and expired"
            checked={history}
            onChange={setHistory}
          />
          <span className="sethint">Show accepted and expired</span>
        </span>
      </div>
      <ListState
        remote={{ ...remote, data: shown }}
        empty={history ? 'No invitations have ever been sent.' : 'No invitations are outstanding.'}
      >
        <ul className="setlist">
          {shown.map((i) => (
            <li className="setitem" key={i.id}>
              <div className="setitem__main">
                <p className="setitem__name">
                  {i.email}
                  <span className="chip">{i.role}</span>
                  {i.state !== 'open' && (
                    <span className={`chip chip--${i.state === 'accepted' ? 'published' : 'archived'}`}>
                      {i.state}
                    </span>
                  )}
                </p>
                <p className="setitem__meta">
                  Invited by {i.invitedByName} {relative(i.createdAt)} ·{' '}
                  {i.state === 'accepted' && i.acceptedAt
                    ? `accepted ${relative(i.acceptedAt)}`
                    : `expires ${dateOf(i.expiresAt)}`}
                </p>
              </div>
              <div className="setitem__acts">
                {i.state === 'open' && (
                  <button
                    className="btn btn--danger btn--sm"
                    disabled={busyId === i.id}
                    onClick={() => void revoke(i)}
                  >
                    Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ListState>
    </Block>
  );
}

/**
 * Who has an account, and whether they can still use it.
 *
 * TWO ROWS ARE UNTOUCHABLE AND EACH SAYS WHY IN ITS OWN WORDS. A disabled
 * button explains nothing — the person looking at it has to guess whether it is
 * broken, whether they lack permission, or whether the app is thinking — and
 * these two have genuinely different answers. "You cannot revoke your own
 * access" points at a colleague; on a blog with one owner there is no
 * colleague, and "promote somebody else first" is the sentence that actually
 * leads somewhere.
 *
 * The last-owner test is computed from the same list the server would count, so
 * the two agree except across a race: two owners disabling each other in the
 * same instant. The 409 handler turns that race back into the same sentence
 * rather than a generic failure, which is the whole reason the route answers
 * with a named `operation` instead of prose.
 */
function UsersList({ me, remote }: { me: AuthUser; remote: Remote<TeamUser[]> }) {
  const { notify } = useToast();
  const [confirming, setConfirming] = useState<TeamUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const all = remote.data ?? [];
  const activeOwners = all.filter((u) => u.role === 'owner' && u.disabledAt === null).length;

  async function disable(user: TeamUser) {
    setBusyId(user.id);
    setRefusal(null);
    try {
      const { sessionsEnded } = await teamApi.disableUser(user.id);
      notify(
        sessionsEnded === 0
          ? `${user.displayName} can no longer sign in`
          : sessionsEnded === 1
            ? `${user.displayName} can no longer sign in — 1 device was signed out`
            : `${user.displayName} can no longer sign in — ${sessionsEnded} devices were signed out`,
      );
    } catch (err) {
      const refused = refusalOf(err);
      setRefusal(
        refused === 'disable_self'
          ? 'You cannot disable your own account. Another owner has to do it.'
          : refused === 'disable_last_owner'
            ? 'That is the last active owner. Promote somebody else first.'
            : messageFor(err),
      );
    } finally {
      setBusyId(null);
      remote.reload();
    }
  }

  async function enable(user: TeamUser) {
    setBusyId(user.id);
    setRefusal(null);
    try {
      await teamApi.enableUser(user.id);
      // Deliberately not "welcome back": the sessions destroyed on the way down
      // do not return, and promising more than the route does is how a support
      // question gets written.
      notify(`${user.displayName} can sign in again`);
    } catch (err) {
      setRefusal(messageFor(err));
    } finally {
      setBusyId(null);
      remote.reload();
    }
  }

  return (
    <Block
      title="People"
      hint="Disabling revokes access and signs out every device. Their posts stay exactly where they are."
    >
      {refusal && (
        <p className="seterr seterr--block" role="alert">
          {refusal}
        </p>
      )}
      <ListState remote={remote} empty="Nobody else has an account yet.">
        <ul className="setlist">
          {all.map((u) => {
            const disabled = u.disabledAt !== null;
            const isSelf = u.id === me.id;
            const lastOwner = !disabled && u.role === 'owner' && activeOwners <= 1;
            return (
              <li className="setitem" key={u.id}>
                <div className="setitem__main">
                  <p className="setitem__name">
                    {u.displayName}
                    <span className="chip">{u.role}</span>
                    {disabled && <span className="chip chip--archived">disabled</span>}
                  </p>
                  <p className="setitem__meta">
                    {u.email} · {posts(u.postCount)} · joined {dateOf(u.createdAt)}
                    {disabled && u.disabledAt ? ` · disabled ${relative(u.disabledAt)}` : ''}
                  </p>
                </div>
                <div className="setitem__acts">
                  {disabled ? (
                    <button
                      className="btn btn--outline btn--sm"
                      disabled={busyId === u.id}
                      onClick={() => void enable(u)}
                    >
                      Enable
                    </button>
                  ) : lastOwner ? (
                    /*
                     * BEFORE THE SELF CHECK, in the server's own order and for
                     * the server's own reason (`server/routes/users.ts`): the
                     * only row that is both is an owner looking at themselves
                     * on a one-owner blog, and "ask another owner" is advice
                     * with nobody at the end of it. "Promote somebody first" is
                     * the sentence that leads somewhere. Getting this order
                     * backwards is invisible until the day it is the only
                     * message somebody sees.
                     */
                    <p className="setitem__why">
                      The last active owner. Disabling them would lock the blog
                      from the inside — promote somebody else first.
                    </p>
                  ) : isSelf ? (
                    <p className="setitem__why">
                      You cannot revoke your own access — another owner has to do
                      it, which is most of what stops it happening by mis-click.
                    </p>
                  ) : (
                    <button
                      className="btn btn--danger btn--sm"
                      disabled={busyId === u.id}
                      onClick={() => setConfirming(u)}
                    >
                      Disable
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </ListState>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void disable(confirming);
        }}
        title={confirming ? `Disable ${confirming.displayName}?` : 'Disable account'}
        description={
          confirming ? (
            <>
              They lose access immediately and every device they are signed in on
              is signed out. Their {posts(confirming.postCount)} stay where they
              are. Enabling the account again restores the ability to sign in —
              it does not bring those sessions back.
            </>
          ) : undefined
        }
        confirmLabel="Disable account"
        danger
      />
    </Block>
  );
}

function TeamSection({ me }: { me: AuthUser }) {
  const users = useRemote((signal) => teamApi.listUsers(signal));
  const invites = useRemote((signal) => teamApi.listInvites(true, signal));

  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2 className="settings__h">Team</h2>
        <p className="settings__desc">
          Only owners see this section. Everything in it is owner-only on the
          server too, so nothing here is a control a writer is being teased with.
        </p>
      </div>
      <div className="settings__stack">
        <InviteForm onInvited={invites.reload} />
        <InvitesList remote={invites} />
        <UsersList me={me} remote={users} />
      </div>
    </section>
  );
}

// --------------------------------------------------------------- categories

/** The refused category a 409 carries, when it carries one. */
function refusedCategory(err: unknown): CategorySummary | null {
  if (!(err instanceof PreconditionFailedError)) return null;
  const body = err.body as { category?: CategorySummary } | undefined;
  return body?.category ?? null;
}

/**
 * Where a delete's posts should go.
 *
 * RADIX REFUSES AN EMPTY-STRING ITEM VALUE, and "uncategorised" IS the empty
 * string on this route — so every option carries a one-character tag and the
 * name is everything after it. A bare sentinel word instead would collide the
 * day somebody creates a category actually called that, which is the kind of
 * bug that only appears in somebody else's data.
 */
const UNCATEGORISED_OPTION = 'u';
const nameOption = (name: string): string => `n:${name}`;
const optionName = (option: string): string =>
  option === UNCATEGORISED_OPTION ? '' : option.slice(2);

/**
 * The managed category list.
 *
 * A ROW WITH A NULL `id` IS LEGACY FREE TEXT AND CANNOT BE RENAMED OR DELETED,
 * because there is no row to rename — it is a value some post carries. The
 * "Manage" button is the bridge: it POSTs the name, which creates the managed
 * row around the posts already using it, and the count comes back unchanged.
 *
 * DELETE IS OWNER-ONLY ON THE ROUTE, so for a writer the button is absent and
 * its absence is explained rather than left as a gap — the same treatment
 * `Dashboard.tsx` gives the owner-only empty-trash button. A confirmation
 * dialog in front of a guaranteed 403 is the app asking "are you sure?" about
 * something it is not allowed to do.
 */
function CategoriesSection({ canDelete }: { canDelete: boolean }) {
  const { notify } = useToast();
  const remote = useRemote((signal) => categoriesApi.list(signal));
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<CategorySummary | null>(null);
  const [deleting, setDeleting] = useState<CategorySummary | null>(null);
  const id = useId();

  const all = remote.data ?? [];

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await categoriesApi.create(name.trim());
      setName('');
      notify(`“${name.trim()}” is now a managed category`);
      remote.reload();
    } catch (err) {
      const existing = refusedCategory(err);
      setError(existing ? `“${existing.name}” already exists.` : messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function adopt(category: CategorySummary) {
    setBusy(true);
    setError(null);
    try {
      await categoriesApi.create(category.name);
      notify(`“${category.name}” is now managed — it can be renamed and merged`);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
      remote.reload();
    }
  }

  return (
    <section className="settings__section">
      <div className="settings__section-head">
        <h2 className="settings__h">Categories</h2>
        <p className="settings__desc">
          The list every post's Details panel and the dashboard filter choose
          from. Counts include drafts, because this is the writing side.
          {!canDelete && ' Only the blog owner can delete one.'}
        </p>
      </div>

      <div className="settings__stack">
        <Block
          title="Add a category"
          hint="A name already typed on a post can be added here too — it adopts the posts that carry it."
        >
          <form className="setform" onSubmit={create} noValidate>
            <div className="setfield">
              <label className="label" htmlFor={`${id}-cat`}>
                Name
              </label>
              <span className="setinline__ctl">
                <input
                  id={`${id}-cat`}
                  className="input"
                  value={name}
                  maxLength={200}
                  placeholder="Essays"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-cat-err` : undefined}
                  onChange={(e) => setName(e.target.value)}
                />
                <button
                  className="btn btn--primary btn--sm"
                  type="submit"
                  disabled={busy || name.trim() === ''}
                >
                  Add
                </button>
              </span>
              {error && (
                <p className="seterr" id={`${id}-cat-err`} role="alert">
                  {error}
                </p>
              )}
            </div>
          </form>
        </Block>

        <Block title="In use">
          <ListState remote={remote} empty="Nothing is categorised yet.">
            <ul className="setlist">
              {all.map((c) => (
                <li className="setitem" key={c.id ?? `free:${c.name}`}>
                  <div className="setitem__main">
                    <p className="setitem__name">
                      {c.name}
                      {!c.managed && <span className="chip chip--draft">free text</span>}
                    </p>
                    <p className="setitem__meta">
                      <span className="setcount">{posts(c.count)}</span>
                      {!c.managed && ' · typed on a post before this list existed'}
                    </p>
                  </div>
                  <div className="setitem__acts">
                    {c.id === null ? (
                      /* Uncategorised posts are not a row here at all — the
                         route's `used` CTE excludes `category = ''` — so every
                         unmanaged row is a real name somebody typed, and every
                         one of them can be adopted. */
                      <button
                        className="btn btn--outline btn--sm"
                        disabled={busy}
                        onClick={() => void adopt(c)}
                      >
                        Manage
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setRenaming(c)}
                        >
                          <Pencil className="ui-ic" aria-hidden="true" />
                          Rename
                        </button>
                        {canDelete && (
                          <button
                            className="btn btn--danger btn--sm"
                            onClick={() => setDeleting(c)}
                          >
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </ListState>

          {deleting && (
            <DeletePanel
              category={deleting}
              others={all.filter((c) => c.name !== deleting.name)}
              onClose={() => setDeleting(null)}
              onDone={remote.reload}
            />
          )}
        </Block>
      </div>

      <RenameDialog
        category={renaming}
        onClose={() => setRenaming(null)}
        onDone={remote.reload}
      />
    </section>
  );
}

/**
 * Rename, which is also a merge.
 *
 * THE COUNT IS PROMISED BEFORE THE CLICK AND REPORTED AFTER IT. `movedPosts`
 * comes back from the route for exactly this: a rename that quietly moved a
 * different number of posts than the dialog said it would is what makes the
 * count untrustworthy forever. Renaming onto a name that already has a managed
 * row is refused with a 409 rather than silently merging two managed rows.
 */
function RenameDialog({
  category,
  onClose,
  onDone,
}: {
  category: CategorySummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { notify } = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  // Re-seeded whenever a different row opens the dialog, so it never opens on
  // the previous row's half-typed name.
  useEffect(() => {
    setValue(category?.name ?? '');
    setError(null);
  }, [category]);

  async function submit() {
    if (!category?.id || busy) return;
    const next = value.trim();
    if (next === '' || next === category.name) return;
    setBusy(true);
    setError(null);
    try {
      const { movedPosts } = await categoriesApi.rename(category.id, next);
      notify(
        movedPosts === 0
          ? `Renamed to “${next}”`
          : `Renamed to “${next}” — ${posts(movedPosts)} moved`,
      );
      onDone();
      onClose();
    } catch (err) {
      const clash = refusedCategory(err);
      setError(clash ? `“${clash.name}” already exists.` : messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={category !== null}
      onClose={onClose}
      title={category ? `Rename “${category.name}”` : 'Rename category'}
      description={
        category
          ? category.count === 0
            ? 'No posts carry this name yet, so nothing will move.'
            : `${posts(category.count)} will move to the new name.`
          : undefined
      }
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || value.trim() === '' || value.trim() === category?.name}
            onClick={() => void submit()}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </>
      }
    >
      <label className="label" htmlFor={`${id}-rename`}>
        New name
      </label>
      <input
        id={`${id}-rename`}
        className="input"
        value={value}
        maxLength={200}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      {error && (
        <p className="seterr" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/**
 * Delete, with somewhere for the posts to go.
 *
 * INLINE AND NOT A `Dialog`, AND THE REASON IS MECHANICAL RATHER THAN
 * AESTHETIC. `Dialog` is a native `<dialog>` opened with `showModal()`, which
 * puts it in the browser's top layer; `Select` is Radix, which portals its
 * popup to `document.body`. A portal into the ordinary document paints BENEATH
 * a top-layer element, so the reassign picker would open behind the very dialog
 * that asked the question — unclickable, and invisible in exactly the moment
 * somebody is about to move other people's posts. The panel below sits in the
 * page, where both work.
 *
 * Omitting the reassign parameter entirely is a different request from sending
 * an empty one: absent means "only delete if nothing uses it" and is the
 * refusal path, while empty means "make them uncategorised", which is a real
 * choice somebody may want.
 */
function DeletePanel({
  category,
  others,
  onClose,
  onDone,
}: {
  category: CategorySummary;
  others: CategorySummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { notify } = useToast();
  const [target, setTarget] = useState(UNCATEGORISED_OPTION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!category.id || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { movedPosts } = await categoriesApi.remove(
        category.id,
        // Only when there is something to move. With no posts on it, sending a
        // target would claim a reassignment that did not happen.
        category.count === 0 ? undefined : optionName(target),
      );
      notify(
        movedPosts === 0
          ? `“${category.name}” deleted`
          : `“${category.name}” deleted — ${posts(movedPosts)} moved`,
      );
      onDone();
      onClose();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setdanger" role="group" aria-label={`Delete ${category.name}`}>
      <p className="setdanger__title">Delete “{category.name}”?</p>
      {category.count === 0 ? (
        <p className="sethint">Nothing carries this name, so nothing moves.</p>
      ) : (
        <>
          <p className="sethint">
            {posts(category.count)} carry this name. Choose where they go — the
            category itself is gone either way, and nothing here can be undone.
          </p>
          <Select<string>
            label="Move those posts to"
            value={target}
            onChange={setTarget}
            options={[
              { value: UNCATEGORISED_OPTION, label: 'Uncategorised' },
              ...others.map((c) => ({ value: nameOption(c.name), label: c.name })),
            ]}
          />
        </>
      )}
      {error && (
        <p className="seterr" role="alert">
          {error}
        </p>
      )}
      <div className="setform__actions">
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void remove()}>
          {busy ? 'Deleting…' : 'Delete category'}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- screen

export default function SettingsRoute() {
  const [settings, update] = useSettings();
  const session = useSession();
  /*
   * `offline` carries this device's last confirmed user, which is enough to
   * decide what to RENDER — the server still decides what may happen. `unknown`
   * never reaches here (`RequireAuth` paints nothing until the session
   * resolves) and is handled anyway rather than asserted away.
   */
  const user = session.status === 'unknown' ? null : session.user;
  const isOwner = user?.role === 'owner';

  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="settings">
      {/*
        "Back", NOT "Posts". Settings is reachable from the sidebar on every
        screen in the app, so labelling the exit "Posts" was a promise the button
        only kept for the one caller who happened to arrive from the dashboard —
        and it read as navigation to a section rather than as a way out of this
        one. `navigate(-1)` with a fallback is the pattern the editor already
        uses: return to wherever you actually came from, and fall back to the
        dashboard for a pasted link with no history behind it.
      */}
      <header className="settings__bar">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            if (location.key === 'default') navigate('/dashboard');
            else navigate(-1);
          }}
        >
          <ChevronLeft className="ui-ic" aria-hidden="true" />
          Back
        </button>
        <span className="settings__title">Settings</span>
        <span aria-hidden="true" />
      </header>

      <main className="settings__page">
        {user && <AccountSection user={user} />}
        {user && isOwner && <TeamSection me={user} />}
        <CategoriesSection canDelete={Boolean(isOwner)} />

        {/*
          The boundary the footnote at the bottom depends on. Before this screen
          grew an account, "Settings live in this browser only" had the whole
          page as its subject and was true of all of it; now it is true of
          exactly what follows this line, and saying where that starts is
          cheaper — and far harder to get wrong later — than rewording a
          sentence three other screens' expectations are built on.
        */}
        <p className="settings__grouplabel">On this device</p>

        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Reading layout</h2>
            <p className="settings__desc">
              How an article is presented in the reader and in preview. Changing
              this never touches what you wrote — only how it's laid out.
            </p>
          </div>

          <div
            className="tplgrid"
            role="radiogroup"
            aria-label="Reading layout"
          >
            {TEMPLATES.map((t) => {
              const active = settings.template === t.id;
              return (
                <button
                  key={t.id}
                  role="radio"
                  aria-checked={active}
                  className={`tplcard${active ? ' is-active' : ''}`}
                  onClick={() => update({ template: t.id })}
                >
                  <TemplatePreview id={t.id} />
                  <span className="tplcard__body">
                    <span className="tplcard__name">
                      {t.name}
                      {active && <Check className="ui-ic tplcard__check" aria-hidden="true" />}
                    </span>
                    <span className="tplcard__desc">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Appearance</h2>
          </div>
          <div className="settings__rows">
            <div className="settings__row">
              <div>
                <p className="settings__label">Theme</p>
                <p className="settings__hint">
                  Match your system, or pin one.
                </p>
              </div>
              <Select<ThemeSetting>
                label="Theme"
                value={settings.theme}
                onChange={(v) => update({ theme: v })}
                options={[
                  { value: 'system', label: 'Match system' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>

            <div className="settings__row">
              <div>
                <p className="settings__label">Reading progress bar</p>
                <p className="settings__hint">
                  A thin indicator across the top of an article.
                </p>
              </div>
              <Switch
                label="Reading progress bar"
                checked={settings.readingProgress}
                onChange={(v) => update({ readingProgress: v })}
              />
            </div>

            <div className="settings__row">
              <div>
                <p className="settings__label">Show reading time</p>
                <p className="settings__hint">
                  Estimated minutes, on cards and bylines.
                </p>
              </div>
              <Switch
                label="Show reading time"
                checked={settings.showReadingTime}
                onChange={(v) => update({ showReadingTime: v })}
              />
            </div>
          </div>
        </section>

        <section className="settings__section">
          <div className="settings__section-head">
            <h2 className="settings__h">Author</h2>
          </div>
          <div className="settings__rows">
            <div className="settings__row">
              <div>
                <p className="settings__label">Byline name</p>
                <p className="settings__hint">Printed on every article.</p>
              </div>
              <input
                className="input settings__input"
                value={settings.authorName}
                maxLength={60}
                aria-label="Byline name"
                onChange={(e) => update({ authorName: e.target.value })}
              />
            </div>
          </div>
        </section>

        <p className="settings__footnote">
          Settings live in this browser only.{' '}
          {/* TODO(backend): sync to the user document; see ARCHITECTURE.md. */}
          They are not part of an export, because they describe this device
          rather than your writing.
        </p>
      </main>
    </div>
  );
}
