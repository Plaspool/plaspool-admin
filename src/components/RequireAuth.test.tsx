import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';

/**
 * The guard, and specifically the two states a three-state session gets wrong.
 *
 * `offline` must paint the app, and `anonymous/expired` must leave the route
 * mounted underneath the prompt. Both are asserted on what is actually on
 * screen, because "the editor is still there" is the property — not "the
 * component returned children".
 */
const fixture = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const box = { session: { status: 'unknown' } as Record<string, unknown> };
  return {
    box,
    listeners,
    /** Push a new session the way the real store does, so React re-renders. */
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
}));

vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

vi.mock('../data/api', () => ({
  AUTH_EXPIRED_EVENT: 'auth-expired',
  api: { login: vi.fn() },
}));

import { logout } from '../data/session';
import { revalidate } from '../data/sync';
import { TooltipProvider } from './ui/Switch';
import { AppShell, SignOutButton } from './RequireAuth';

/**
 * jsdom has no `HTMLDialogElement.showModal` — measured in this environment,
 * not assumed: `document.createElement('dialog').showModal` is `undefined`.
 * `Dialog` calls it from an effect, so without this shim the confirmation
 * throws during commit, React tears the whole tree down, and every assertion in
 * the sign-out block fails with an empty document for a reason that has nothing
 * to do with the component under test.
 *
 * The prototype is patched rather than the spies being installed as the methods
 * themselves, so `vi.resetAllMocks()` cannot quietly remove the shim between
 * cases and bring the tear-down back.
 */
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
const showModal = vi.fn();
dialogProto.showModal = function (this: HTMLDialogElement) {
  showModal();
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

const WRITER = {
  id: 'u_writer',
  email: 'writer@test.local',
  displayName: 'A Writer',
  role: 'writer' as const,
};

/**
 * The app, as a data router — `useBlocker` requires one.
 *
 * `TooltipProvider` is not decoration. On every route that is not `/edit/:id`
 * or `/read/:id` the shell now draws the sidebar, whose collapsed icons are
 * wrapped in the app's `Tooltip`; Radix's tooltip THROWS when it cannot find a
 * provider above it, so without this wrapper the `/settings` cases fail on an
 * empty document for a reason that has nothing to do with the guard. `main.tsx`
 * has had the provider at the root all along.
 */
function mount(initial = '/edit/p_1') {
  const router = createMemoryRouter(
    [
      {
        element: <AppShell />,
        children: [
          {
            path: '/edit/:id',
            element: (
              <div>
                <p>THE EDITOR</p>
                <Link to="/settings">Settings</Link>
              </div>
            ),
          },
          { path: '/settings', element: <p>THE SETTINGS</p> },
        ],
      },
      /*
       * OUTSIDE the shell, exactly as in `main.tsx`. Sign-in is a route of its
       * own now rather than something the guard rendered in place, and putting
       * it inside `AppShell` here would send a refused boot straight back
       * through the guard that bounced it.
       */
      { path: '/login', element: <p>THE LOGIN PAGE</p> },
    ],
    { initialEntries: [initial] },
  );
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
  return router;
}

beforeEach(() => {
  cleanup();
  fixture.listeners.clear();
  vi.resetAllMocks();
  showModal.mockClear();
  fixture.box.session = { status: 'unknown' };
});

describe('what each session state renders', () => {
  it('renders nothing at all while the session is unknown', () => {
    mount();

    // NOT a login screen. `/auth/me` usually answers in milliseconds, and a
    // login form flashed at an already-signed-in writer reads as "you have
    // been logged out" — the most alarming thing this app could say to someone
    // who has not been.
    expect(screen.queryByText('THE EDITOR')).toBeNull();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('renders the route once the session is confirmed', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    mount();

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
  });

  it('an offline boot with a remembered user paints from cache, not a login form', async () => {
    fixture.box.session = { status: 'offline', user: WRITER };
    mount();

    // The writer on a plane. Their session was never refused — the question
    // never arrived — so the app they had yesterday is what they get.
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('an offline boot with no remembered user offers a retry, not a form it cannot honour', async () => {
    fixture.box.session = { status: 'offline', user: null };
    mount();

    expect(await screen.findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
  });

  it('a boot that was refused sends them to the sign-in route', async () => {
    fixture.box.session = { status: 'anonymous', reason: 'boot', user: null };
    const router = mount();

    expect(await screen.findByText('THE LOGIN PAGE')).toBeTruthy();
    expect(screen.queryByText('THE EDITOR')).toBeNull();
    expect(router.state.location.pathname).toBe('/login');
  });

  /**
   * The redirect must not cost the writer their destination.
   *
   * Sign-in used to render in place, so someone who opened `/settings` signed
   * out was already on `/settings` once they got through. A bare redirect
   * throws that away, so the route is carried in router state and `Login`
   * sends them on — this pins the half the guard is responsible for.
   */
  it('carries the route it bounced them off, so sign-in can send them back', async () => {
    fixture.box.session = { status: 'anonymous', reason: 'boot', user: null };
    const router = mount('/settings');

    await screen.findByText('THE LOGIN PAGE');
    expect((router.state.location.state as { from?: string } | null)?.from).toBe('/settings');
  });
});

describe('a session that expires mid-edit', () => {
  it('leaves the document on screen and puts the prompt over it', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    mount();
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();

    act(() => fixture.set({ status: 'anonymous', reason: 'expired', user: WRITER }));

    // Both. Unmounting the route here would throw away the TipTap buffer the
    // writer is looking at, which is the same loss as clearing the cache — by
    // a different route.
    expect(screen.getByText('THE EDITOR')).toBeTruthy();
    expect(screen.getByRole('region', { name: /session expired/i })).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it('names the account whose session ended', async () => {
    fixture.box.session = { status: 'anonymous', reason: 'expired', user: WRITER };
    mount();

    expect(await screen.findByText(new RegExp(WRITER.email))).toBeTruthy();
  });

  it('blocks navigation to any other route while the prompt is up', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    const router = mount();
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();

    act(() => fixture.set({ status: 'anonymous', reason: 'expired', user: WRITER }));
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));

    /*
     * The document already on screen was already on screen — nothing new is
     * exposed by leaving it there. That argument does not extend one route
     * further: without this, walking away from the prompt and clicking through
     * to another post is a way to read someone's library on a machine whose
     * session has ended.
     */
    expect(screen.queryByText('THE SETTINGS')).toBeNull();
    expect(screen.getByText('THE EDITOR')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/edit/p_1');
  });

  it('resumes the blocked navigation once the writer signs back in', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    const router = mount();
    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    act(() => fixture.set({ status: 'anonymous', reason: 'expired', user: WRITER }));
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));

    act(() => fixture.set({ status: 'authed', user: WRITER }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });
});

describe('the shell revalidates, except where the gate already has to', () => {
  it('does not re-fetch a post route the gate is about to fetch itself', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    mount('/edit/p_1');

    expect(await screen.findByText('THE EDITOR')).toBeTruthy();
    // `revalidate` would fetch the post and then throw away the one thing the
    // navigation needs — `ok` / `gone` / `offline`. `PostGate` makes that fetch
    // to branch on it, so calling both is two identical GETs of every post.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('revalidates every other route', async () => {
    fixture.box.session = { status: 'authed', user: WRITER };
    mount('/settings');

    expect(await screen.findByText('THE SETTINGS')).toBeTruthy();
    expect(revalidate).toHaveBeenCalledWith(WRITER.id, '/settings');
  });
});

describe('signing out', () => {
  it('asks before destroying unsent work, and names the count', async () => {
    vi.mocked(logout).mockResolvedValue({ status: 'needs-confirm', pending: 3 });
    render(<SignOutButton />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(showModal).toHaveBeenCalled());
    expect(screen.getByText(/3 changes have not reached the server/i)).toBeTruthy();
    expect(logout).toHaveBeenCalledTimes(1);
    // The count came back, nothing was destroyed, and the destructive call has
    // not been made — a `blocked` row exists nowhere else on earth.
    expect(logout).not.toHaveBeenCalledWith({ confirmed: true });
  });

  it('only proceeds once the human has confirmed', async () => {
    vi.mocked(logout).mockResolvedValue({ status: 'needs-confirm', pending: 1 });
    render(<SignOutButton />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await userEvent.click(await screen.findByRole('button', { name: /sign out anyway/i }));

    expect(logout).toHaveBeenLastCalledWith({ confirmed: true });
  });

  it('with nothing pending it signs out without a dialog', async () => {
    vi.mocked(logout).mockResolvedValue({ status: 'done' });
    render(<SignOutButton />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    // Asserted on the dialog never opening rather than on its text: the panel
    // is in the DOM either way and only `showModal` distinguishes "asked" from
    // "did not ask".
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(showModal).not.toHaveBeenCalled();
  });
});
