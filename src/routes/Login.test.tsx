import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in form.
 *
 * Most of what matters here is what the screen is NOT allowed to say. The
 * server answers identically for an unknown email and a wrong password, at
 * identical cost, because this is an invite-only instance where knowing which
 * addresses have accounts is most of what an attacker wants — and a client that
 * split those back apart would hand the enumeration oracle straight back from
 * the one layer nobody audits for it.
 */
vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: { login: vi.fn() },
}));

/*
 * `getSession`/`subscribe` as well as `adoptUser`: the page reads the session
 * itself now, because signing in is what navigates away and only the page —
 * never `SignInForm`, which is also the mid-session re-auth prompt — is allowed
 * to do that. Pinned to a refused boot so these cases render the form; the
 * redirect on success is `Login`'s own concern and is covered in
 * `RequireAuth.test.tsx` from the guard's side.
 */
vi.mock('../data/session', () => {
  /*
   * ONE frozen object, returned by identity. `useSyncExternalStore` compares
   * snapshots by reference and re-renders when they differ, so a `getSession`
   * that builds a fresh literal per call is an infinite loop — React bails out
   * with "Maximum update depth exceeded" and every case in this file fails at
   * once, pointing at `Login` rather than at the mock. The real `session.ts`
   * holds one module-level value for exactly the same reason.
   */
  const REFUSED_BOOT = { status: 'anonymous', reason: 'boot', user: null };
  return {
    adoptUser: vi.fn(),
    getSession: () => REFUSED_BOOT,
    subscribe: () => () => {},
  };
});

import { api } from '../data/api';
import { ApiError, AuthExpiredError, OfflineError } from '../data/errors';
import { adoptUser } from '../data/session';
import Login, { SignInForm } from './Login';

const WRITER = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer' as const,
};

/** `delay: null` — see the note in AcceptInvite.test.tsx; typing is the slow part. */
const type = (el: HTMLElement, text: string) =>
  userEvent.setup({ delay: null }).type(el, text);

/**
 * The PAGE needs a router; the FORM deliberately does not.
 *
 * `Login` reads `useLocation` so it can send the writer back to whatever route
 * the guard bounced them off, which means it can only ever be a route. The
 * re-auth case below renders `SignInForm` bare on purpose — that one renders
 * over a live editor inside `RequireAuth`, and keeping it router-free here is
 * what stops a `<Link>` or a hook creeping into the shared half.
 */
const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );

async function signIn(email = 'writer@test.local', password = 'a-long-password') {
  if (email) await type(screen.getByLabelText('Email'), email);
  await type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('signing in', () => {
  it('sends the credentials and adopts the session it gets back', async () => {
    vi.mocked(api.login).mockResolvedValue(WRITER);
    renderLogin();

    await signIn('  writer@test.local  ');

    // Trimmed, because a pasted address routinely carries a trailing space and
    // the server compares lowercased-and-trimmed on its side.
    expect(api.login).toHaveBeenCalledWith('writer@test.local', 'a-long-password');
    // `adoptUser` and not local state: it decides whether this is the same
    // person coming back (keep the cache) or a different one (clear it), sets
    // the ambient user id `posts.ts` writes under, and starts the replay.
    await waitFor(() => expect(adoptUser).toHaveBeenCalledWith(WRITER));
  });

  it('cannot be submitted with an empty field', async () => {
    renderLogin();

    expect(screen.getByRole('button', { name: /sign in/i })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Email'), 'writer@test.local');
    expect(screen.getByRole('button', { name: /sign in/i })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    expect(screen.getByRole('button', { name: /sign in/i })).toHaveProperty('disabled', false);
  });
});

describe('what a refusal is allowed to say', () => {
  it('a 401 blames the pair, never one half of it', async () => {
    vi.mocked(api.login).mockRejectedValue(new AuthExpiredError());
    renderLogin();

    await signIn();

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/do not match an account/i);
    // Either of these would turn the form into a user-enumeration oracle.
    expect(error.textContent).not.toMatch(/no such|unknown|not found|wrong password/i);
  });

  it('a 429 says how long, when the server said', async () => {
    vi.mocked(api.login).mockRejectedValue(
      new ApiError({ status: 429, code: 'rate_limited', retryAfter: 42 }),
    );
    renderLogin();

    await signIn();

    expect((await screen.findByRole('alert')).textContent).toMatch(/42 seconds/);
  });

  it('an unreachable server is not a rejected password', async () => {
    vi.mocked(api.login).mockRejectedValue(new OfflineError());
    renderLogin();

    await signIn();

    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/could not reach the server/i);
    expect(error.textContent).not.toMatch(/match an account/i);
  });

  it('a 500 quotes the request id, which is all the server gives back', async () => {
    vi.mocked(api.login).mockRejectedValue(
      new ApiError({ status: 500, code: 'internal', requestId: 'req_9f3' }),
    );
    renderLogin();

    await signIn();

    // The server logs the detail beside this id rather than returning it, so
    // quoting it is the whole of what makes the failure diagnosable from a bug
    // report.
    expect((await screen.findByRole('alert')).textContent).toMatch(/req_9f3/);
  });

  it('lets the writer try again after a failure', async () => {
    vi.mocked(api.login).mockRejectedValueOnce(new AuthExpiredError());
    renderLogin();
    await signIn();
    await screen.findByRole('alert');

    vi.mocked(api.login).mockResolvedValue(WRITER);
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(adoptUser).toHaveBeenCalled());
  });
});

describe('the re-auth form', () => {
  it('knows who you are and does not make you retype it', async () => {
    vi.mocked(api.login).mockResolvedValue(WRITER);
    render(<SignInForm initialEmail={WRITER.email} lockEmail />);

    expect(screen.getByLabelText('Email')).toHaveProperty('readOnly', true);
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(api.login).toHaveBeenCalledWith(WRITER.email, 'a-long-password');
  });
});
