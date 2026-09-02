import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The team screen, pinned on the one thing that makes it dangerous to get
 * wrong: SENIORITY. `shared/roles.ts` is the table both sides read, and this
 * suite drives the UI half of it with a DEVELOPER viewer — the role with
 * reach over some rows and not others — so every assertion about absence is
 * provably `canManage`/`canAssign` and not an empty screen:
 *
 *  - no ⋯ at all on the owner's row or a fellow developer's, while the
 *    writer's row keeps a full menu in the same render;
 *  - your own row has no ⋯ AT ALL: its one item was the emailed sign-in
 *    code, which went with Clerk becoming the only auth, and neither re-role
 *    nor disable was ever offered on yourself;
 *  - the re-role picker lists what the viewer may HAND OUT, so a developer
 *    sees no "Developer" card while the owner does;
 *  - the refusals the table cannot predict (two admins racing) arrive as 409
 *    codes and surface as their own honest sentences, never the code.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-team`, per the section's canonical
 * harness (`src/routes/MarketingRewards.test.tsx`): the path, the method and
 * the body are what a backend integration gets silently wrong, and a mocked
 * module asserts none of them.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_dev',
      email: 'dele@plaspool.com',
      displayName: 'Dele Dev',
      role: 'developer' as
        | 'owner'
        | 'developer'
        | 'writer'
        | 'supply_chain'
        | 'support'
        | 'marketing',
    },
  },
}));

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { ToastHost } from '../ui/Toast';
import type { TeamInvite, TeamUser } from '../../data/api-team';
import { ALL_ROLES, ROLE_INFO } from '../../../shared/roles';
import SettingsTeam from './SettingsTeam';

/** The harness's standard jsdom shims — `ResizeObserver` is the one the v2
 *  table chrome actually constructs. */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** Every body sent to this exact path with this method, oldest first. */
const bodiesOf = (pathname: string, method: string): Record<string, unknown>[] =>
  calls
    .filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

/** No write has gone to this path yet — the question has not been answered. */
function sentNothing(pathname: string): boolean {
  return !calls.some(
    (c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET',
  );
}

beforeEach(() => {
  handlers.clear();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({ path: url.pathname + url.search, init });
      const handler = handlers.get(url.pathname);
      const answer = handler
        ? handler(url, init)
        : { status: 404, body: { error: 'gone', requestId: 'req_test' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fixture.session.user = {
    id: 'u_dev',
    email: 'dele@plaspool.com',
    displayName: 'Dele Dev',
    role: 'developer',
  };
});

// -------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0);
const DAY = 86_400_000;

const USERS = '/api/users';
const INVITES = '/api/invites';
const TRANSFER = '/api/ownership/transfer';

const member = (over: Partial<TeamUser> & Pick<TeamUser, 'id' | 'email' | 'role'>): TeamUser => ({
  displayName: '',
  createdAt: NOW - 90 * DAY,
  disabledAt: null,
  postCount: 0,
  ...over,
});

/* The four seniority shapes a developer viewer can face, all in one list:
   the owner (above them), a fellow developer (a peer), themselves, and a
   writer (within reach). Plus one disabled row for the way back in. */
const owner = member({
  id: 'u_owner',
  email: 'amara@plaspool.com',
  displayName: 'Amara Owner',
  role: 'owner',
  createdAt: NOW - 400 * DAY,
});
const devViewer = member({
  id: 'u_dev',
  email: 'dele@plaspool.com',
  displayName: 'Dele Dev',
  role: 'developer',
});
const devPeer = member({
  id: 'u_dev2',
  email: 'tunde@plaspool.com',
  displayName: 'Tunde Dev',
  role: 'developer',
});
const writer = member({
  id: 'u_writer',
  email: 'wole@plaspool.com',
  displayName: 'Wole Writer',
  role: 'writer',
  postCount: 7,
});
const suspended = member({
  id: 'u_support',
  email: 'sade@plaspool.com',
  displayName: 'Sade Support',
  role: 'support',
  disabledAt: NOW - 5 * DAY,
});

const openInvite: TeamInvite = {
  id: 'inv_open',
  email: 'bisi@plaspool.com',
  role: 'marketing',
  createdAt: NOW - DAY,
  expiresAt: NOW + 6 * DAY,
  acceptedAt: null,
  invitedBy: 'u_owner',
  invitedByName: 'Amara Owner',
  state: 'open',
};

/** The one-shot mint `POST /api/invites` answers — the url is the only copy. */
const minted = {
  invite: {
    id: 'inv_new',
    email: 'ada@plaspool.com',
    role: 'supply_chain',
    expiresAt: NOW + 7 * DAY,
    url: 'https://admin.plaspool.com/#/accept-invite?token=tok_minted_once',
  },
  emailed: false,
};

/** The list routes, and the POST that shares the invites path. */
function withTeam(
  users: TeamUser[],
  invites: TeamInvite[] = [],
  transfer: unknown = null,
): void {
  when(USERS, { items: users });
  when(INVITES, (_url, init) =>
    (init.method ?? 'GET') === 'GET' ? { body: { items: invites } } : { status: 201, body: minted },
  );
  /* The screen asks on every load. Stubbed for every case rather than only the
     transfer ones, because an unstubbed endpoint is a rejected promise and the
     screen's own resilience to that is a separate question from what each of
     these tests is about. */
  when(TRANSFER, (_url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { transfer } }
      : { status: 201, body: { transfer } },
  );
  when(`${TRANSFER}/decline`, { ok: true });
  when(`${TRANSFER}/accept`, { user: { id: 'u_writer', role: 'owner' } });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/team']}>
        <SettingsTeam />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Open a member row's ⋯ menu and hand back the portaled panel. */
async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
}

// ============================================================================

describe('the team screen', () => {
  it('refuses the whole route to a non-admin, and asks the server for nothing', async () => {
    fixture.session.user = {
      id: 'u_writer',
      email: 'wole@plaspool.com',
      displayName: 'Wole Writer',
      role: 'writer',
    };
    withTeam([owner, writer]);
    mount();

    expect(await screen.findByText('Only the owner and developers can change this')).toBeTruthy();
    // Not a hidden screen over a live fetch — the list was never requested.
    expect(calls.some((c) => c.path.split('?')[0] === USERS)).toBe(false);
    expect(calls.some((c) => c.path.split('?')[0] === INVITES)).toBe(false);
  });

  it('renders members with role labels and statuses — and the roles card', async () => {
    withTeam([owner, devViewer, writer, suspended], [openInvite]);
    mount();

    const rowOf = async (title: string) => {
      const cell = await screen.findByText(title);
      const row = cell.closest('tr');
      if (row === null) throw new Error(`no row for ${title}`);
      return row as HTMLElement;
    };

    // The role column speaks ROLE_INFO's labels, not wire values.
    const ownerRow = await rowOf('Amara Owner');
    expect(within(ownerRow).getByText('Owner')).toBeTruthy();
    expect(within(ownerRow).getByText('Active')).toBeTruthy();

    const writerRow = await rowOf('Wole Writer');
    expect(within(writerRow).getByText('Content writer')).toBeTruthy();

    // A disabled row says so, and says WHEN.
    const suspendedRow = await rowOf('Sade Support');
    expect(within(suspendedRow).getByText('Disabled')).toBeTruthy();
    expect(within(suspendedRow).getByText(/since /)).toBeTruthy();

    // The open invite is listed with its role's label and a revoke control.
    const invitesCard = screen.getByText('Invites').closest('section');
    if (invitesCard === null) throw new Error('no invites card');
    expect(within(invitesCard as HTMLElement).getByText('bisi@plaspool.com')).toBeTruthy();
    expect(within(invitesCard as HTMLElement).getByText(/Marketing · expires/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Revoke invite for bisi@plaspool.com' }),
    ).toBeTruthy();

    /* The owner's explicit ask: what each role ENTAILS, all six, in the words
       of ROLE_INFO itself — the same table the server enforces. */
    const rolesCard = screen.getByText('What each role can do').closest('section');
    if (rolesCard === null) throw new Error('no roles card');
    for (const role of ALL_ROLES) {
      expect(within(rolesCard as HTMLElement).getByText(ROLE_INFO[role].label)).toBeTruthy();
    }
    expect((rolesCard as HTMLElement).textContent).toContain('Exactly one per store.');
  });

  it('shows a developer no actions on the owner or a peer, one action on themselves, and no Developer card when re-roling', async () => {
    const user = userEvent.setup();
    withTeam([owner, devViewer, devPeer, writer]);
    mount();

    await screen.findByText('Wole Writer');

    /* ABSENT, not disabled — `canManage(developer, owner)` and
       `canManage(developer, developer)` are both false, so neither row offers
       a ⋯ at all. The writer's row has one in the same render, so the absence
       is seniority's and not the column's. */
    expect(screen.queryByRole('button', { name: 'Actions for Amara Owner' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for Tunde Dev' })).toBeNull();

    /*
     * YOUR OWN ROW HAS NO ⋯ EITHER, and this assertion changed shape rather
     * than being deleted. Self-service used to mean one item — the emailed
     * sign-in code — and Clerk owns factors now, so nothing is left: you may
     * not re-role yourself and you may not disable yourself. A ⋯ that opens
     * an empty popover is the same broken promise as one over a guaranteed
     * refusal, so the button must be absent, not merely empty.
     */
    expect(screen.queryByRole('button', { name: 'Actions for Dele Dev' })).toBeNull();

    // The writer is within reach — full menu, and the re-role picker opens…
    const writerMenu = await openMenu(user, 'Wole Writer');
    expect(within(writerMenu).getByRole('menuitem', { name: /Disable account/ })).toBeTruthy();
    await user.click(within(writerMenu).getByRole('menuitem', { name: /Change role/ }));

    /* …listing ONLY what a developer may hand out (`canAssign`): the four
       roles below developer, and never Developer itself. */
    const dialog = await screen.findByRole('dialog', { name: /Change Wole Writer/ });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(within(dialog).getByRole('radio', { name: /^Content writer/ })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /^Supply chain/ })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /^Support/ })).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: /^Marketing/ })).toBeTruthy();
    expect(within(dialog).queryByRole('radio', { name: /Developer/ })).toBeNull();
  });

  it('changes a role over the wire: PATCH /api/users/:id/role with the picked role', async () => {
    const user = userEvent.setup();
    withTeam([owner, devViewer, writer]);
    when(`${USERS}/${writer.id}/role`, (_url, init) => ({
      body: { ok: true, user: { ...writer, ...(JSON.parse(String(init.body)) as object) } },
    }));
    mount();

    const menu = await openMenu(user, 'Wole Writer');
    await user.click(within(menu).getByRole('menuitem', { name: /Change role/ }));
    const dialog = await screen.findByRole('dialog', { name: /Change Wole Writer/ });

    // Their current role arrives preselected, and confirming it is inert.
    expect(
      (within(dialog).getByRole('radio', { name: /^Content writer/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(dialog).getByRole('button', { name: 'Change role' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(within(dialog).getByRole('radio', { name: /^Support/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Change role' }));

    await waitFor(() => expect(bodiesOf(`${USERS}/${writer.id}/role`, 'PATCH')).toHaveLength(1));
    // KEY BY KEY — the body is the role and nothing else.
    expect(bodiesOf(`${USERS}/${writer.id}/role`, 'PATCH')[0]).toEqual({ role: 'support' });
    expect(await screen.findByText('Wole Writer is now a Support')).toBeTruthy();
  });

  it('mints an invite: POST {email, role}, then keeps the modal open on the one-shot URL', async () => {
    const user = userEvent.setup();
    fixture.session.user = {
      id: 'u_owner',
      email: 'amara@plaspool.com',
      displayName: 'Amara Owner',
      role: 'owner',
    };
    withTeam([owner, devViewer, writer]);
    mount();

    await user.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite member' });

    // Writer is the default; the OWNER's picker does list Developer (canAssign).
    expect(
      (within(dialog).getByRole('radio', { name: /^Content writer/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(dialog).getByRole('radio', { name: /^Developer/ })).toBeTruthy();

    await user.type(within(dialog).getByLabelText('Email'), 'ada@plaspool.com');
    await user.click(within(dialog).getByRole('radio', { name: /^Supply chain/ }));

    // The mint has NOT happened while the form is still open.
    expect(sentNothing(INVITES)).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Create invite' }));

    await waitFor(() => expect(bodiesOf(INVITES, 'POST')).toHaveLength(1));
    expect(bodiesOf(INVITES, 'POST')[0]).toEqual({ email: 'ada@plaspool.com', role: 'supply_chain' });

    /* The modal STAYS OPEN on the minted URL — it contains the raw token and
       is shown exactly once, so closing on success would destroy the only
       copy. `emailed: false` gets the send-it-yourself sentence. */
    const receipt = await screen.findByRole('dialog', { name: 'Invite created' });
    const link = within(receipt).getByLabelText('Invite link') as HTMLInputElement;
    expect(link.value).toBe('https://admin.plaspool.com/#/accept-invite?token=tok_minted_once');
    expect(link.readOnly).toBe(true);
    expect(within(receipt).getByText('The email didn’t send. Give them this link instead.')).toBeTruthy();
  });

  it('confirms a disable, POSTs it, and shows a manage_peer 409 as the honest sentence', async () => {
    const user = userEvent.setup();
    withTeam([owner, devViewer, writer]);
    /* The race the table cannot predict: between load and click, the owner
       promoted Wole — the server refuses the stale aim with `manage_peer`. */
    when(`${USERS}/${writer.id}/disable`, {
      error: 'precondition_failed',
      operation: 'manage_peer',
      userId: writer.id,
      requestId: 'req_test',
    }, 409);
    mount();

    const menu = await openMenu(user, 'Wole Writer');
    await user.click(within(menu).getByRole('menuitem', { name: /Disable account/ }));

    // The modal ASKS, and names the destructive half: sessions are destroyed.
    const dialog = await screen.findByRole('dialog', { name: 'Disable Wole Writer?' });
    expect(dialog.textContent).toContain('signed out everywhere the moment you confirm, on every device they use');
    // The irreversible thing has NOT happened while the question is open.
    expect(sentNothing(`${USERS}/${writer.id}/disable`)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Disable account' }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path === `${USERS}/${writer.id}/disable` && c.init.method === 'POST',
        ),
      ).toBe(true),
    );
    /* The 409 code surfaces as its own sentence — the honest one about
       seniority — never as "precondition_failed" or a generic failure. */
    expect(
      await screen.findByText(
        "Developers can't remove or change the owner or other developers.",
      ),
    ).toBeTruthy();
  });
});

describe('handing the store over', () => {
  const offer = {
    id: 't_1',
    from: { id: 'u_owner', displayName: 'Amara Owner', email: 'amara@plaspool.com' },
    to: { id: 'u_writer', displayName: 'Wole Writer', email: 'wole@plaspool.com' },
    createdAt: NOW - 3_600_000,
    expiresAt: NOW + 7 * DAY,
  };

  const asOwner = () => {
    fixture.session.user = {
      id: 'u_owner',
      email: 'amara@plaspool.com',
      displayName: 'Amara Owner',
      role: 'owner',
    };
  };

  it('offers “Make owner…” to the OWNER only, and only on somebody else', async () => {
    /*
     * `requireOwner()` on the route, and `canManage` already says a developer
     * may not demote the owner — proposing to move the owner's role is that
     * same act under another verb. Hidden rather than disabled, the rule the
     * missing ⋯ already follows.
     */
    const user = userEvent.setup();
    withTeam([owner, devViewer, writer, suspended], [openInvite]);
    mount();

    // The default viewer here is the DEVELOPER: no such item anywhere.
    const devMenu = await openMenu(user, 'Wole Writer');
    expect(within(devMenu).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
  });

  it('shows it to the owner, and asks rather than transferring', async () => {
    const user = userEvent.setup();
    asOwner();
    withTeam([owner, devViewer, writer]);
    mount();

    const menu = await openMenu(user, 'Wole Writer');
    await user.click(within(menu).getByRole('menuitem', { name: 'Make owner…' }));

    /*
     * THE DIALOG HAS TO SAY WHAT ACTUALLY HAPPENS. Nothing moves until the
     * recipient accepts, and the sender becomes a developer rather than losing
     * access — a dialog that promised the transfer outright would be describing
     * the feature the owner explicitly did not ask for.
     */
    const dialog = await screen.findByRole('dialog', { name: /Ask Wole Writer to take over/ });
    expect(within(dialog).getByText(/have to accept/i)).toBeTruthy();
    expect(within(dialog).getByText(/you become a developer/i)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Ask them' }));

    await waitFor(() => expect(bodiesOf(TRANSFER, 'POST')).toHaveLength(1));
    // KEY BY KEY — the recipient's id and nothing else.
    expect(bodiesOf(TRANSFER, 'POST')[0]).toEqual({ toUserId: 'u_writer' });
  });

  it('tells the sender it is waiting, and lets them withdraw', async () => {
    const user = userEvent.setup();
    asOwner();
    withTeam([owner, devViewer, writer], [], offer);
    mount();

    expect(await screen.findByText(/has been asked to take over as owner/i)).toBeTruthy();
    /* And the row action is gone while one is live — the server refuses a
       second with `already_pending`, so offering the control would be a
       control in front of a guaranteed refusal. */
    const menu = await openMenu(user, 'Wole Writer');
    expect(within(menu).queryByRole('menuitem', { name: /Make owner/ })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === `${TRANSFER}/decline` && c.init.method === 'POST'),
      ).toHaveLength(1),
    );
  });

  it('shows a bystanding admin whose store is moving, with no controls', async () => {
    /* A developer is not a party. They still need to know the roles below are
       about to change — but withdrawing is the sender's to do. */
    withTeam([owner, devViewer, writer], [], offer);
    mount();

    expect(await screen.findByText(/has asked/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });
});
