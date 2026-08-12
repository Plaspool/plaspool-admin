import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

/**
 * The settings screen, asserted on the things that are silent when wrong.
 *
 * Four of them are the whole reason this file exists:
 *
 * - **A mistyped current password must not look like a dead session.** The
 *   route answers 400 `detail: 'currentPassword'` precisely so it does not, and
 *   `api.ts` fires `auth-expired` — which raises the re-authentication overlay
 *   over the whole app — for every 401 it sees. If the form ever routes that
 *   case through a 401, or invents one, a typo signs the writer out of the
 *   screen they are typing into. The test watches the event.
 * - **The two untouchable rows must say WHY, and say different things.** A
 *   disabled button explains nothing, and "ask another owner" is useless advice
 *   on a blog with one owner.
 * - **Team is hidden from writers, not disabled.** `GET /api/users` is
 *   `requireOwner()`, so a rendered-but-disabled list is a 403 waiting to
 *   happen — and the list itself is every account's email address.
 * - **The minted invite URL is shown even when the mail went.** The token is
 *   minted once and stored as an HMAC; a screen that hid it on `emailed: true`
 *   would make a spam filter cost a real invitation.
 *
 * Everything talks to a stubbed `fetch` rather than a live server, deliberately:
 * the routes these components call belong to another workstream, and a suite
 * that went red when a colleague's migration was mid-flight would be a suite
 * nobody trusts. The stub answers the shapes copied out of
 * `server/routes/auth.ts`, `users.ts` and `categories.ts`.
 */

const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box = { session: { status: 'unknown' } as Record<string, unknown> };
  return {
    box,
    listeners,
    adopted: [] as unknown[],
    set(next: Record<string, unknown>) {
      box.session = next;
      for (const l of listeners) l();
    },
  };
});

vi.mock('../data/session', () => ({
  getSession: () => fixture.box.session,
  subscribe: (l: () => void) => {
    fixture.listeners.add(l);
    return () => fixture.listeners.delete(l);
  },
  initSession: vi.fn(),
  logout: vi.fn(),
  adoptUser: vi.fn(async (user: unknown) => {
    fixture.adopted.push(user);
  }),
}));

// `RequireAuth` (for `useSession`) pulls the sync layer in at module load, and
// nothing on this screen wants Dexie.
vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

import { ToastProvider } from '../components/Toast';
import { adoptUser } from '../data/session';
import type { SessionSummary } from '../data/api-account';
import type { TeamInvite, TeamUser } from '../data/api-team';
import type { CategorySummary } from '../data/api-categories';
import type { AuthUser } from '../data/types';
import SettingsRoute from './Settings';

/**
 * jsdom has no `HTMLDialogElement.showModal` — the same measurement
 * `src/components/RequireAuth.test.tsx` records, re-checked here rather than
 * assumed. `Dialog` calls it from an effect, so without the shim the rename and
 * disable confirmations throw during commit, React tears the tree down, and
 * every assertion in those blocks fails against an empty document for a reason
 * that has nothing to do with the component under test.
 *
 * The prototype is patched rather than the methods being spies, so a reset
 * between cases cannot quietly remove the shim and bring the tear-down back.
 */
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// ------------------------------------------------------------------ fixtures

const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const OWNER: AuthUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'owner@test.local',
  displayName: 'An Owner',
  role: 'owner',
};
const WRITER: AuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer',
};
const SECOND_OWNER: AuthUser = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'second@test.local',
  displayName: 'Second Owner',
  role: 'owner',
};

const sessionsFixture = (): SessionSummary[] => [
  {
    id: 's_here',
    createdAt: NOW - 3 * DAY,
    lastSeenAt: NOW - 60_000,
    expiresAt: NOW + 27 * DAY,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    current: true,
  },
  {
    id: 's_phone',
    createdAt: NOW - 10 * DAY,
    lastSeenAt: NOW - 2 * DAY,
    expiresAt: NOW + 20 * DAY,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    current: false,
  },
];

const userRow = (user: AuthUser, over: Partial<TeamUser> = {}): TeamUser => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
  createdAt: NOW - 200 * DAY,
  disabledAt: null,
  postCount: 3,
  ...over,
});

const invitesFixture = (): TeamInvite[] => [
  {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'new@test.local',
    role: 'writer',
    createdAt: NOW - DAY,
    expiresAt: NOW + 6 * DAY,
    acceptedAt: null,
    invitedBy: OWNER.id,
    invitedByName: 'An Owner',
    state: 'open',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    email: 'settled@test.local',
    role: 'writer',
    createdAt: NOW - 40 * DAY,
    expiresAt: NOW - 33 * DAY,
    acceptedAt: NOW - 39 * DAY,
    invitedBy: OWNER.id,
    invitedByName: 'An Owner',
    state: 'accepted',
  },
];

const categoriesFixture = (): CategorySummary[] => [
  { id: '66666666-6666-4666-8666-666666666666', name: 'Essays', count: 4, managed: true },
  { id: '77777777-7777-4777-8777-777777777777', name: 'Notes', count: 0, managed: true },
  { id: null, name: 'travel', count: 2, managed: false },
];

// -------------------------------------------------------------- fetch stub

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

const calls: Recorded[] = [];
let handlers: { method: string; path: RegExp; reply: (body: unknown) => Reply }[] = [];

/** Register a route. Later registrations win, so a test can override a default. */
function on(method: string, path: RegExp, reply: Reply | ((body: unknown) => Reply)): void {
  handlers.unshift({
    method,
    path,
    reply: typeof reply === 'function' ? reply : () => reply,
  });
}

const ok = (body: unknown): Reply => ({ status: 200, body });

/** Every request the screen made, in order. */
const sent = (method: string, path: string): Recorded[] =>
  calls.filter((c) => c.method === method && c.path === path);

function defaults(): void {
  handlers = [];
  on('GET', /^\/api\/auth\/sessions$/, () => ok({ items: sessionsFixture() }));
  on('GET', /^\/api\/categories$/, () => ok({ categories: categoriesFixture() }));
  on('GET', /^\/api\/invites/, () => ok({ items: invitesFixture() }));
  on('GET', /^\/api\/users$/, () =>
    ok({ items: [userRow(OWNER), userRow(SECOND_OWNER), userRow(WRITER)] }),
  );
}

/** Watches for the event that raises the app-wide re-authentication overlay. */
let authExpired: number;
const countAuthExpired = () => {
  authExpired += 1;
};

beforeEach(() => {
  cleanup();
  calls.length = 0;
  fixture.adopted.length = 0;
  fixture.listeners.clear();
  vi.mocked(adoptUser).mockClear();
  defaults();
  authExpired = 0;
  window.addEventListener('auth-expired', countAuthExpired);

  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'https://studio.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname + url.search;
    calls.push({
      method,
      path,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const handler = handlers.find((h) => h.method === method && h.path.test(path));
    const reply = handler
      ? handler.reply(calls[calls.length - 1]!.body)
      : { status: 404, body: { error: 'gone', requestId: 'req_stub' } };
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  window.removeEventListener('auth-expired', countAuthExpired);
});

function mount(user: AuthUser) {
  fixture.box.session = { status: 'authed', user };
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsRoute />
      </MemoryRouter>
    </ToastProvider>,
  );
}

/** The block a control lives in, so `getByRole` cannot reach across sections. */
const block = (title: string) =>
  screen.getByRole('heading', { name: title }).closest('.setblock') as HTMLElement;

/**
 * The open `<dialog>`, queried by element rather than by role.
 *
 * The shim above sets `open` directly, and whether that makes an implicit
 * `dialog` role visible to the accessibility-tree query is a jsdom detail this
 * suite has no reason to depend on. It also matters that queries are scoped to
 * it at all: the rename dialog's confirm button and the row button that opened
 * it are both called "Rename".
 */
const dialog = () => document.querySelector('dialog') as HTMLElement;

// --------------------------------------------------------------- the shell

describe('what each role is shown', () => {
  it('gives a writer the account and category sections and no team section', async () => {
    mount(WRITER);

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Categories' })).toBeTruthy();
    /*
     * Hidden, not disabled. A disabled list of every account's email address is
     * still a list of every account's email address, and `GET /api/users` is
     * `requireOwner()` — so a writer must not even ask.
     */
    expect(screen.queryByRole('heading', { name: 'Team' })).toBeNull();
    expect(sent('GET', '/api/users')).toHaveLength(0);
  });

  it('gives an owner the team section', async () => {
    mount(OWNER);

    expect(await screen.findByRole('heading', { name: 'Team' })).toBeTruthy();
    expect(sent('GET', '/api/users')).toHaveLength(1);
  });

  it('keeps the device settings and their footnote', async () => {
    mount(WRITER);

    expect(await screen.findByRole('heading', { name: 'Reading layout' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(screen.getByLabelText('Byline name')).toBeTruthy();
    expect(screen.getByText(/Settings live in this browser only/)).toBeTruthy();
    // The boundary the footnote now depends on: without it the sentence has the
    // account section in its scope too, where it is simply false.
    expect(screen.getByText('On this device')).toBeTruthy();
  });
});

// -------------------------------------------------------------- display name

describe('display name', () => {
  it('saves it and replaces the identity the rest of the app is holding', async () => {
    const renamed = { ...WRITER, displayName: 'A Renamed Writer' };
    on('PATCH', /^\/api\/auth\/me$/, () => ok({ user: renamed }));
    mount(WRITER);

    const input = screen.getByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, 'A Renamed Writer');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/updated on everything you have published/)).toBeTruthy();
    expect(sent('PATCH', '/api/auth/me')[0]?.body).toEqual({ displayName: 'A Renamed Writer' });
    /*
     * The session store holds the only stale copy after this PATCH — every post,
     * list and feed reads the name through a live JOIN. Missing this is a
     * sidebar showing the old name until a reload.
     */
    expect(fixture.adopted).toEqual([renamed]);
  });

  it('will not send an unchanged or blank name', async () => {
    mount(WRITER);
    await screen.findByRole('heading', { name: 'Account' });

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);

    const input = screen.getByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, '   ');

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    expect(sent('PATCH', '/api/auth/me')).toHaveLength(0);
  });

  it('puts the server refusal under the field', async () => {
    on('PATCH', /^\/api\/auth\/me$/, () => ({
      status: 400,
      body: { error: 'bad_request', detail: 'displayName', requestId: 'req_1' },
    }));
    mount(WRITER);

    const input = screen.getByLabelText('Display name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Something');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter the name to publish under.')).toBeTruthy();
  });
});

// ------------------------------------------------------------------ password

describe('changing the password', () => {
  async function fill(current: string, next: string, confirm: string) {
    await userEvent.type(screen.getByLabelText('Current password'), current);
    await userEvent.type(screen.getByLabelText('New password'), next);
    await userEvent.type(screen.getByLabelText('Confirm new password'), confirm);
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it('says how many other devices were signed out', async () => {
    on('POST', /^\/api\/auth\/change-password$/, () => ok({ ok: true, otherSessionsEnded: 2 }));
    mount(WRITER);

    await fill('seed-password', 'a-longer-passphrase', 'a-longer-passphrase');

    expect(
      await screen.findByText('Password changed. 2 other devices were signed out.'),
    ).toBeTruthy();
    expect(sent('POST', '/api/auth/change-password')[0]?.body).toEqual({
      currentPassword: 'seed-password',
      newPassword: 'a-longer-passphrase',
    });
  });

  it('does not claim devices were signed out when none were', async () => {
    on('POST', /^\/api\/auth\/change-password$/, () => ok({ ok: true, otherSessionsEnded: 0 }));
    mount(WRITER);

    await fill('seed-password', 'a-longer-passphrase', 'a-longer-passphrase');

    expect(
      await screen.findByText('Password changed. No other devices were signed in.'),
    ).toBeTruthy();
  });

  it('treats a wrong current password as a field error and never as a sign-out', async () => {
    on('POST', /^\/api\/auth\/change-password$/, () => ({
      status: 400,
      body: { error: 'bad_request', detail: 'currentPassword', requestId: 'req_2' },
    }));
    mount(WRITER);

    await fill('not-my-password', 'a-longer-passphrase', 'a-longer-passphrase');

    expect(await screen.findByText('That is not your current password.')).toBeTruthy();
    /*
     * The whole point of the route answering 400 rather than 401. `api.ts`
     * announces `auth-expired` for every 401 it sees, and that event raises the
     * re-authentication overlay across the app — so one typo here would look
     * exactly like the session dying mid-sentence.
     */
    expect(authExpired).toBe(0);
  });

  it('mirrors the ten-character rule without spending a request', async () => {
    mount(WRITER);

    await fill('seed-password', 'short', 'short');

    expect(
      await screen.findByText('Choose a password of at least 10 characters.'),
    ).toBeTruthy();
    expect(sent('POST', '/api/auth/change-password')).toHaveLength(0);
  });

  it('catches a mistyped confirmation before the server does', async () => {
    mount(WRITER);

    await fill('seed-password', 'a-longer-passphrase', 'a-longer-passphrasf');

    expect(await screen.findByText('These two do not match.')).toBeTruthy();
    expect(sent('POST', '/api/auth/change-password')).toHaveLength(0);
  });

  it('re-reads the sessions list, which the change has just emptied', async () => {
    on('POST', /^\/api\/auth\/change-password$/, () => ok({ ok: true, otherSessionsEnded: 1 }));
    mount(WRITER);
    await screen.findByText('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(sent('GET', '/api/auth/sessions')).toHaveLength(1);

    await fill('seed-password', 'a-longer-passphrase', 'a-longer-passphrase');

    await screen.findByText('Password changed. 1 other device was signed out.');
    expect(sent('GET', '/api/auth/sessions')).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ sessions

describe('the sessions list', () => {
  it('shows the raw user agent rather than a guess about it', async () => {
    mount(WRITER);

    expect(
      await screen.findByText('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
    ).toBeTruthy();
    expect(screen.getByText(/iPhone/)).toBeTruthy();
  });

  it('offers no revoke on the current session, and says where the right button is', async () => {
    mount(WRITER);
    const list = within(block('Where you are signed in'));

    const rows = await list.findAllByRole('listitem');
    const here = rows.find((r) => within(r).queryByText('This device'))!;
    /*
     * `DELETE /api/auth/sessions/:id` accepts the current session, deliberately.
     * Reaching it from here would end this session while walking past
     * `SignOutButton`, the only control that asks about unsent work first — and
     * a `pending` row is the last copy of words no server ever accepted.
     */
    expect(within(here).queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(within(here).getByText(/asks about work that has not reached the server/)).toBeTruthy();
  });

  it('revokes another session and re-reads the list', async () => {
    on('DELETE', /^\/api\/auth\/sessions\/s_phone$/, ok({ ok: true }));
    mount(WRITER);
    const list = within(block('Where you are signed in'));
    const rows = await list.findAllByRole('listitem');
    const phone = rows.find((r) => within(r).queryByText(/iPhone/))!;

    await userEvent.click(within(phone).getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('That sign-in was ended')).toBeTruthy();
    expect(sent('DELETE', '/api/auth/sessions/s_phone')).toHaveLength(1);
    expect(sent('GET', '/api/auth/sessions')).toHaveLength(2);
  });
});

// -------------------------------------------------------------------- team

describe('inviting somebody', () => {
  const minted = (emailed: boolean) => ({
    status: 201,
    body: {
      invite: {
        id: '88888888-8888-4888-8888-888888888888',
        email: 'new@test.local',
        role: 'writer',
        expiresAt: NOW + 7 * DAY,
        url: 'https://studio.test/#/accept-invite?token=the-only-copy',
      },
      emailed,
    },
  });

  it('shows the link even when the invitation was emailed', async () => {
    on('POST', /^\/api\/invites$/, minted(true));
    mount(OWNER);
    await screen.findByRole('heading', { name: 'Invite someone' });

    await userEvent.type(screen.getByLabelText('Email address'), 'new@test.local');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByText(/Emailed to new@test.local/)).toBeTruthy();
    /*
     * The token is minted once and stored as an HMAC, so this response is the
     * only copy that will ever exist. Hiding it because the mail went would make
     * one spam filter cost a real invitation.
     */
    expect(
      screen.getByLabelText<HTMLInputElement>('Invitation link').value,
    ).toBe('https://studio.test/#/accept-invite?token=the-only-copy');
  });

  it('says plainly when nothing was sent', async () => {
    on('POST', /^\/api\/invites$/, minted(false));
    mount(OWNER);
    await screen.findByRole('heading', { name: 'Invite someone' });

    await userEvent.type(screen.getByLabelText('Email address'), 'new@test.local');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByText(/no mail configured/)).toBeTruthy();
    expect(screen.getByLabelText('Invitation link')).toBeTruthy();
  });

  it('falls back to selecting the link when the clipboard is out of reach', async () => {
    on('POST', /^\/api\/invites$/, minted(true));
    mount(OWNER);
    await screen.findByRole('heading', { name: 'Invite someone' });
    await userEvent.type(screen.getByLabelText('Email address'), 'new@test.local');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    await screen.findByLabelText('Invitation link');

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    /*
     * jsdom has no `navigator.clipboard`, which is the same shape as an insecure
     * origin or a restrictive permissions policy. Reporting a copy that never
     * happened would lose the only copy of the token.
     */
    expect(await screen.findByText(/would not let us reach the clipboard/)).toBeTruthy();
  });

  it('names the address that already has an account', async () => {
    on('POST', /^\/api\/invites$/, () => ({
      status: 400,
      body: { error: 'bad_request', detail: 'email', requestId: 'req_3' },
    }));
    mount(OWNER);
    await screen.findByRole('heading', { name: 'Invite someone' });

    await userEvent.type(screen.getByLabelText('Email address'), 'writer@test.local');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(
      await screen.findByText('There is already an account for that address.'),
    ).toBeTruthy();
  });
});

describe('the invitations list', () => {
  it('shows outstanding ones, and the history only when asked', async () => {
    mount(OWNER);
    const invites = within(block('Invitations'));

    expect(await invites.findByText('new@test.local')).toBeTruthy();
    expect(invites.queryByText('settled@test.local')).toBeNull();

    await userEvent.click(screen.getByRole('switch', { name: 'Show accepted and expired' }));

    expect(await invites.findByText('settled@test.local')).toBeTruthy();
    // One request, filtered on this side: `state` is the server's verdict and
    // must not be re-derived against a clock that disagrees with it.
    expect(sent('GET', '/api/invites?include=accepted%2Cexpired')).toHaveLength(1);
  });

  it('revokes an outstanding one', async () => {
    on('DELETE', /^\/api\/invites\//, ok({ ok: true }));
    mount(OWNER);
    const invites = within(block('Invitations'));
    await invites.findByText('new@test.local');

    await userEvent.click(invites.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText(/invitation for new@test.local was revoked/)).toBeTruthy();
  });
});

describe('the people list', () => {
  it('explains why you cannot disable yourself', async () => {
    mount(OWNER);
    const people = within(block('People'));
    const rows = await people.findAllByRole('listitem');
    const self = rows.find((r) => within(r).queryByText('An Owner'))!;

    expect(within(self).queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(within(self).getByText(/cannot revoke your own access/)).toBeTruthy();
  });

  it('explains the last active owner differently, because the advice differs', async () => {
    // One owner, and it is the caller. The server checks this refusal BEFORE the
    // self one for exactly this reason: "ask another owner" leads nowhere here.
    on('GET', /^\/api\/users$/, () => ok({ items: [userRow(OWNER), userRow(WRITER)] }));
    mount(OWNER);
    const people = within(block('People'));
    const rows = await people.findAllByRole('listitem');
    const self = rows.find((r) => within(r).queryByText('An Owner'))!;

    expect(within(self).getByText(/promote somebody else first/)).toBeTruthy();
    expect(within(self).queryByText(/cannot revoke your own access/)).toBeNull();
  });

  it('disables somebody else behind a confirmation that counts their posts', async () => {
    on('POST', /\/disable$/, ok({ ok: true, sessionsEnded: 2 }));
    mount(OWNER);
    const people = within(block('People'));
    const rows = await people.findAllByRole('listitem');
    const writer = rows.find((r) => within(r).queryByText('A Writer'))!;

    await userEvent.click(within(writer).getByRole('button', { name: 'Disable' }));

    expect(await screen.findByText('Disable A Writer?')).toBeTruthy();
    expect(screen.getByText(/Their 3 posts stay where they are/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Disable account' }));

    expect(
      await screen.findByText('A Writer can no longer sign in — 2 devices were signed out'),
    ).toBeTruthy();
    expect(sent('POST', `/api/users/${WRITER.id}/disable`)).toHaveLength(1);
  });

  it('turns the server 409 back into the same sentence, for the race', async () => {
    on('POST', /\/disable$/, () => ({
      status: 409,
      body: {
        error: 'precondition_failed',
        operation: 'disable_last_owner',
        userId: SECOND_OWNER.id,
        requestId: 'req_4',
      },
    }));
    mount(OWNER);
    const people = within(block('People'));
    const rows = await people.findAllByRole('listitem');
    const other = rows.find((r) => within(r).queryByText('Second Owner'))!;

    await userEvent.click(within(other).getByRole('button', { name: 'Disable' }));
    await userEvent.click(screen.getByRole('button', { name: 'Disable account' }));

    expect(
      await screen.findByText('That is the last active owner. Promote somebody else first.'),
    ).toBeTruthy();
  });

  it('re-enables without promising the sessions back', async () => {
    on('GET', /^\/api\/users$/, () =>
      ok({ items: [userRow(OWNER), userRow(WRITER, { disabledAt: NOW - DAY })] }),
    );
    on('POST', /\/enable$/, ok({ ok: true }));
    mount(OWNER);
    const people = within(block('People'));
    const rows = await people.findAllByRole('listitem');
    const writer = rows.find((r) => within(r).queryByText('A Writer'))!;

    await userEvent.click(within(writer).getByRole('button', { name: 'Enable' }));

    expect(await screen.findByText('A Writer can sign in again')).toBeTruthy();
    expect(sent('POST', `/api/users/${WRITER.id}/enable`)).toHaveLength(1);
  });
});

// -------------------------------------------------------------- categories

describe('categories', () => {
  it('lists managed rows and legacy free text, with counts', async () => {
    mount(WRITER);
    const list = within(block('In use'));

    expect(await list.findByText('Essays')).toBeTruthy();
    expect(list.getByText('4 posts')).toBeTruthy();
    expect(list.getByText('free text')).toBeTruthy();
    // A row with no managed row behind it can only be adopted — there is
    // nothing to rename.
    const free = (await list.findAllByRole('listitem')).find(
      (r) => within(r).queryByText('travel'),
    )!;
    expect(within(free).getByRole('button', { name: 'Manage' })).toBeTruthy();
    expect(within(free).queryByRole('button', { name: /Rename/ })).toBeNull();
  });

  it('adopts a free-text name into the managed list', async () => {
    on('POST', /^\/api\/categories$/, () => ({
      status: 201,
      body: { category: { id: 'c_new', name: 'travel', count: 2, managed: true } },
    }));
    mount(WRITER);
    const list = within(block('In use'));
    const free = (await list.findAllByRole('listitem')).find(
      (r) => within(r).queryByText('travel'),
    )!;

    await userEvent.click(within(free).getByRole('button', { name: 'Manage' }));

    expect(await screen.findByText(/“travel” is now managed/)).toBeTruthy();
    expect(sent('POST', '/api/categories')[0]?.body).toEqual({ name: 'travel' });
  });

  it('refuses a duplicate by naming the row that already has it', async () => {
    on('POST', /^\/api\/categories$/, () => ({
      status: 409,
      body: {
        error: 'precondition_failed',
        operation: 'create',
        category: { id: 'c_1', name: 'Essays', count: 4, managed: true },
        requestId: 'req_5',
      },
    }));
    mount(WRITER);
    await screen.findByRole('heading', { name: 'Add a category' });

    await userEvent.type(screen.getByLabelText('Name'), 'essays');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('“Essays” already exists.')).toBeTruthy();
  });

  it('promises how many posts a rename moves, then reports what moved', async () => {
    on('PATCH', /^\/api\/categories\//, () => ok({
      category: { id: 'c_1', name: 'Long reads', count: 4, managed: true },
      movedPosts: 4,
    }));
    mount(WRITER);
    const list = within(block('In use'));
    const essays = (await list.findAllByRole('listitem')).find(
      (r) => within(r).queryByText('Essays'),
    )!;

    await userEvent.click(within(essays).getByRole('button', { name: /Rename/ }));

    // Promised before the click. A rename that quietly moved a different number
    // than the dialog said is what makes the count untrustworthy forever.
    expect(await screen.findByText('4 posts will move to the new name.')).toBeTruthy();

    const field = screen.getByLabelText('New name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Long reads');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('Renamed to “Long reads” — 4 posts moved')).toBeTruthy();
  });

  it('hides delete from a writer and explains the gap', async () => {
    mount(WRITER);
    const list = within(block('In use'));
    await list.findByText('Essays');

    expect(list.queryByRole('button', { name: 'Delete' })).toBeNull();
    // The absence is explained rather than left as a gap — the same treatment
    // the dashboard gives its owner-only empty-trash button.
    expect(screen.getByText(/Only the blog owner can delete one/)).toBeTruthy();
  });

  it('gives an owner a delete that asks where the posts go', async () => {
    on('DELETE', /^\/api\/categories\//, () => ok({ movedPosts: 4 }));
    mount(OWNER);
    const list = within(block('In use'));
    const essays = (await list.findAllByRole('listitem')).find(
      (r) => within(r).queryByText('Essays'),
    )!;

    await userEvent.click(within(essays).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/4 posts carry this name/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete category' }));

    expect(await screen.findByText('“Essays” deleted — 4 posts moved')).toBeTruthy();
    // `-` is the wire spelling of "uncategorised": a query parameter cannot
    // carry an empty string through `url()`, which drops empty values.
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('?reassign=-'))).toBe(true);
  });

  it('does not claim a reassignment when nothing carries the name', async () => {
    on('DELETE', /^\/api\/categories\//, () => ok({ movedPosts: 0 }));
    mount(OWNER);
    const list = within(block('In use'));
    const notes = (await list.findAllByRole('listitem')).find(
      (r) => within(r).queryByText('Notes'),
    )!;

    await userEvent.click(within(notes).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Nothing carries this name/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete category' }));

    expect(await screen.findByText('“Notes” deleted')).toBeTruthy();
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    // No `?reassign=` at all. Absent means "only delete if nothing uses it",
    // which is a different request from "move them to uncategorised".
    expect(deletes[0]!.path).not.toContain('reassign');
  });
});

// ------------------------------------------------------------ failure paths

describe('when a section cannot load', () => {
  it('says so in place and offers the request again', async () => {
    on('GET', /^\/api\/categories$/, () => ({
      status: 500,
      body: { error: 'internal', requestId: 'req_6' },
    }));
    mount(WRITER);

    expect(await screen.findByText(/Reference req_6/)).toBeTruthy();
    expect(sent('GET', '/api/categories')).toHaveLength(1);

    await userEvent.click(within(block('In use')).getByRole('button', { name: 'Try again' }));

    expect(sent('GET', '/api/categories')).toHaveLength(2);
  });
});

/*
 * WHAT IS DELIBERATELY NOT ASSERTED HERE: the two theme scopes and the 375px
 * layout.
 *
 * Both were checked, and neither is checkable in this harness. Vitest replaces
 * every CSS import with an empty string (`test.css` defaults to false), so
 * `./settings.css?raw` reads as `''` — a stylesheet assertion written against it
 * passes by having nothing to look at, which is worse than no assertion at all.
 * jsdom computes no layout either, so a width has nothing to overflow.
 *
 * The guarantee is structural instead: `settings.css` names no colour of its
 * own — every value comes from `tokens.css`, which declares all three theme
 * scopes — and the new row vocabulary stacks under `@media (max-width: 640px)`.
 * Confirming that on screen is a browser job, and it stays one.
 */
