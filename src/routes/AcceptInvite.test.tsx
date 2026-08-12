import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Claiming an invitation.
 *
 * The route is entered the way a real invite link enters it — through the
 * search string of the in-hash path — because that is the whole of F3: the
 * server used to mint `/accept-invite?token=…`, the hash router never looked at
 * `location.search`, and every invite it could issue was unredeemable.
 */
vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: { acceptInvite: vi.fn() },
}));

vi.mock('../data/session', () => ({ adoptUser: vi.fn() }));

import { api } from '../data/api';
import { ApiError } from '../data/errors';
import { adoptUser } from '../data/session';
import AcceptInvite from './AcceptInvite';

const USER = {
  id: 'u_new',
  email: 'invited@test.local',
  displayName: 'Newly Invited',
  role: 'writer' as const,
};

/**
 * `/accept-invite?token=…` is what `location.hash.substring(1)` parses to for
 * the URL the server now mints (`INVITE_PATH = '/#/accept-invite'`), so this is
 * the location the router really hands this component.
 */
function open(search = '?token=tok_abc123') {
  return render(
    <MemoryRouter initialEntries={[`/accept-invite${search}`]}>
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/" element={<p>THE DASHBOARD</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * `delay: null` removes user-event's inter-keystroke wait. With it, typing two
 * long strings four times over pushed this file past the 5 s test timeout on a
 * loaded machine — a red bar with no failing assertion in it.
 */
const type = (el: HTMLElement, text: string) =>
  userEvent.setup({ delay: null }).type(el, text);

async function fillIn(name = 'Newly Invited', password = 'a-long-enough-password') {
  await type(screen.getByLabelText(/name to publish under/i), name);
  await type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: /create account/i }));
}

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('the token', () => {
  it('is read from the query string of the in-hash path', async () => {
    vi.mocked(api.acceptInvite).mockResolvedValue(USER);
    open('?token=tok_abc123');

    await fillIn();

    expect(api.acceptInvite).toHaveBeenCalledWith({
      token: 'tok_abc123',
      password: 'a-long-enough-password',
      displayName: 'Newly Invited',
    });
  });

  it('says so when the link arrived without one', () => {
    open('');

    // Almost always a link that lost its query string on the way — a mail
    // client wrapping it, or the pre-F3 path form. An empty form that cannot
    // succeed teaches the invitee nothing.
    expect(screen.getByText(/invitation link is incomplete/i)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});

describe('accepting', () => {
  it('signs in with the session the response carries and leaves the form behind', async () => {
    vi.mocked(api.acceptInvite).mockResolvedValue(USER);
    open();

    await fillIn();

    // `POST /auth/accept-invite` sets the session cookie on the way out, so
    // accepting an invitation IS signing in.
    await waitFor(() => expect(adoptUser).toHaveBeenCalledWith(USER));
    // `replace`, so Back cannot return to a form whose token is now spent — the
    // second attempt 400s and reads as though the invitation was broken.
    expect(await screen.findByText('THE DASHBOARD')).toBeTruthy();
  });

  it('refuses a short password without spending a request on it', async () => {
    open();

    await fillIn('Newly Invited', 'short');

    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 10 characters/i);
    /*
     * `accept:<ip>` is rate-limited and `limit()` runs before the body is even
     * parsed, so a refusal the client could have made itself still costs the
     * invitee one of their attempts.
     */
    expect(api.acceptInvite).not.toHaveBeenCalled();
  });

  it('translates the four things a 400 can mean', async () => {
    const cases: [string, RegExp][] = [
      ['invite', /no longer valid/i],
      ['password', /at least 10 characters/i],
      ['displayName', /name to publish under/i],
      ['email', /already an account/i],
    ];
    for (const [detail, expected] of cases) {
      cleanup();
      vi.mocked(api.acceptInvite).mockRejectedValue(
        new ApiError({ status: 400, code: 'bad_request', detail }),
      );
      open();
      await fillIn();
      expect((await screen.findByRole('alert')).textContent).toMatch(expected);
    }
  });

  it('cannot be submitted without a name', async () => {
    open();

    await userEvent.type(screen.getByLabelText('Password'), 'a-long-enough-password');

    // The server refuses an empty display name too; catching it here saves a
    // rate-limited round trip for a mistake that is visible on screen.
    expect(screen.getByRole('button', { name: /create account/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
