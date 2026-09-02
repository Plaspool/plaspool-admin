import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

/**
 * The sign-in screen, and specifically THE ONE IT GOT WRONG.
 *
 * SIGN OUT DID NOTHING, and this file exists because nothing caught it. Clerk
 * is the only auth, so `logout()` destroys our session row, clears
 * `__Host-studio_session` and hands over to this screen — which found Clerk's
 * OWN session still alive, exchanged it on sight, and put the person straight
 * back into the admin. Every server test passed: the logout route did its job
 * perfectly, and the defect lived in what happened one render later. There was
 * no test for this component at all.
 *
 * The two sessions are separate and live on separate domains, so ending ours
 * says nothing about Clerk's. `logout()` leaves a marker; this component is the
 * only place in the app guaranteed to have Clerk loaded, so it is where the
 * marker has to be honoured.
 *
 * `fetch` IS STUBBED RATHER THAN `apiFetch`, for the reason the marketing
 * suites give: the path and the method are what a mocked module stops
 * asserting, and "did it call the exchange" is the entire question here.
 */

const clerk = vi.hoisted(() => ({
  isSignedIn: true,
  signOut: vi.fn(async () => undefined),
  getToken: vi.fn(async () => 'clerk-token'),
}));

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => children,
  SignIn: () => <div data-testid="clerk-signin">Clerk sign-in</div>,
  useAuth: () => ({ isSignedIn: clerk.isSignedIn, getToken: clerk.getToken }),
  useClerk: () => ({ signOut: clerk.signOut }),
}));

/* `adoptUser` is the only part of the session module stubbed: it writes the
   offline cache, which is not what this file is about. The sign-out marker
   helpers are the REAL ones — they are the thing under test. */
const adoptUser = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../data/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../data/session')>()),
  adoptUser,
}));

const { markClerkSignOutPending, clerkSignOutPending } = await import('../../data/session');
const ClerkGate = (await import('./ClerkGate')).default;

let calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls = [];
  clerk.isSignedIn = true;
  clerk.signOut.mockClear();
  clerk.getToken.mockClear();
  adoptUser.mockClear();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase() });
      return new Response(JSON.stringify({ user: { id: 'u_1', email: 'a@b.c' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () => render(<ClerkGate publishableKey="pk_test_x" />);
const exchanges = () => calls.filter((c) => c.url.includes('/auth/clerk/exchange'));

describe('the sign-in screen', () => {
  it('trades a live Clerk session for our own — the ordinary arrival', async () => {
    mount();
    await waitFor(() => expect(exchanges()).toHaveLength(1));
    expect(exchanges()[0].method).toBe('POST');
    await waitFor(() => expect(adoptUser).toHaveBeenCalledTimes(1));
    expect(clerk.signOut).not.toHaveBeenCalled();
  });

  it('signs OUT of Clerk instead of exchanging, when a sign-out is pending', async () => {
    /*
     * THE REGRESSION. Without the marker check this mount exchanges the
     * surviving Clerk session and the person is back in the admin one render
     * after clicking Sign out.
     */
    markClerkSignOutPending();
    mount();

    await waitFor(() => expect(clerk.signOut).toHaveBeenCalledTimes(1));
    expect(exchanges()).toHaveLength(0);
    expect(adoptUser).not.toHaveBeenCalled();
  });

  it('clears the marker once Clerk is actually signed out, so nobody is stranded', async () => {
    /*
     * A marker that outlived the sign-out would refuse every future exchange
     * and make the admin permanently unenterable — a worse bug than the one it
     * fixes, and silent in exactly the same way.
     */
    markClerkSignOutPending();
    mount();
    await waitFor(() => expect(clerk.signOut).toHaveBeenCalled());
    await waitFor(() => expect(clerkSignOutPending()).toBe(false));
  });

  it('shows Clerk its own form when there is no Clerk session to trade', async () => {
    clerk.isSignedIn = false;
    mount();
    expect(await screen.findByTestId('clerk-signin')).toBeTruthy();
    expect(exchanges()).toHaveLength(0);
  });
});
