import { Suspense, lazy, useSyncExternalStore } from 'react';
import { getSession, subscribe } from '../../data/session';
import { brand } from '../../brand';
import { Spinner } from '../ui/primitives';
import { Shell } from './Shell';

/**
 * v2's auth gate — CLERK AND NOTHING ELSE since 2026-09-01.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT WENT. This screen used to carry an email
 * and password form, a six-digit code form for the emailed second factor, and
 * a "Continue with Google" button that swapped the card for Clerk's. The owner
 * chose to make Clerk the only door: Clerk holds passwords, Google and every
 * second factor in its own dashboard, so keeping our copies meant two of
 * everything — two password stores, two 2FA systems, and a shopper-facing
 * complaint that signing in with Google showed you a sign-in screen and then
 * another sign-in screen. The server's password routes went in the same
 * change; there is nothing left for a form here to POST to.
 *
 * CLERK IS STILL A LAZY CHUNK. A deployment with no publishable key ships none
 * of Clerk's code — it now also has no way in, which is why the missing-key
 * branch below is a stated refusal rather than a blank card.
 */
const CLERK_KEY = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ?? '';
const ClerkGate = lazy(() => import('./ClerkGate'));

export function Gate() {
  const session = useSyncExternalStore(subscribe, getSession, getSession);

  /* `unknown` means `/auth/me` has not answered. Rendering nothing here is
     what keeps the sign-in screen from flashing at somebody who is already
     signed in. */
  if (session.status === 'unknown') return null;

  if (session.status === 'authed' || session.status === 'offline') {
    const user = session.user;
    if (!user) return <SignIn />;
    return <Shell storeName={brand.name} userName={user.displayName || user.email} />;
  }

  return <SignIn />;
}

/**
 * THE ONLY REMAINING FAILURE THIS SCREEN OWNS is a deployment that was built
 * without `VITE_CLERK_PUBLISHABLE_KEY`.
 *
 * It is worth a real card rather than an empty page because the value bakes at
 * BUILD time (CLAUDE.md §5): changing it in the Vercel dashboard does nothing
 * until the next deploy, so whoever meets this needs to be told to redeploy
 * and not to go hunting for a broken session. Every other sign-in failure —
 * a wrong password, a dead factor, an uninvited account — belongs to Clerk or
 * to `ClerkGate`, and both say so themselves.
 */
function NotConfigured() {
  return (
    <div className="signin__card stack">
      <h1 className="signin__title">Sign-in isn’t set up</h1>
      <p className="signin__lede">
        This copy of the admin was built without its sign-in key, so there is no way to sign
        in yet. A developer needs to set <code>VITE_CLERK_PUBLISHABLE_KEY</code> and deploy
        again — the value is read when the site is built, so changing it alone won’t fix this.
      </p>
    </div>
  );
}

function SignIn() {
  return (
    <div className="signin">
      <div className="signin__col">
        {/* The lockup for LIGHT surfaces — this page is one. `alt` carries the
            name, so the brand is announced once, not once per element. */}
        {brand.assets.logoLight ? (
          <img className="signin__logo" src={brand.assets.logoLight} alt={brand.name} />
        ) : (
          <span style={{ fontSize: 'var(--t-2xl)', fontWeight: 'var(--w-bold)' }}>{brand.name}</span>
        )}

        {CLERK_KEY ? (
          <Suspense
            fallback={
              <div
                className="signin__card"
                role="status"
                style={{ display: 'grid', placeItems: 'center', minHeight: '12rem' }}
              >
                <Spinner large />
              </div>
            }
          >
            <ClerkGate publishableKey={CLERK_KEY} />
          </Suspense>
        ) : (
          <NotConfigured />
        )}
      </div>
    </div>
  );
}
