import { useEffect, useRef, useState } from 'react';
import { ClerkProvider, SignIn, useAuth, useClerk } from '@clerk/clerk-react';
import { apiFetch } from '../../data/api';
import { adoptUser } from '../../data/session';
import { ApiError } from '../../data/errors';
import { Button } from '../ui/primitives';
import type { AuthUser } from '../../data/types';

/**
 * THE SIGN-IN SCREEN. Not "the Clerk half" any more — since 2026-09-01 there
 * is no other half (see `Gate.tsx` for what was removed and why).
 *
 * THE FLOW: Clerk's own `<SignIn>` runs everything a credential touches —
 * Google, password, and whatever second factors the Clerk dashboard demands.
 * Once a Clerk session exists, its token is traded at
 * `POST /api/auth/clerk/exchange` for the ordinary `__Host-studio_session`
 * cookie, and `adoptUser` proceeds from there. Every screen past this one sees
 * one session system, one cookie, one middleware; Clerk stops at the door.
 *
 * WHY THE EXCHANGE STILL MATTERS NOW THAT CLERK IS THE ONLY DOOR. Clerk says
 * who you are. It does not say what you may do here, and it must not: the
 * role, the revoked flag and the invite list all live in our database, and the
 * exchange is where a verified identity is checked against them. A page that
 * trusted a Clerk session directly would let any Google account in the world
 * read this admin.
 *
 * `not_invited` IS THE HONEST END of a Google account that verified fine and
 * this store has never heard of — and, since the same change, of one whose
 * invite has already been spent or has run out. This instance stays
 * invite-only; the screen says to ask an admin rather than pretending the
 * login failed.
 */

function Exchange() {
  const { isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const [state, setState] = useState<'idle' | 'exchanging' | 'not_invited' | 'failed'>('idle');
  const started = useRef(false);

  useEffect(() => {
    if (!isSignedIn || started.current) return;
    started.current = true;
    setState('exchanging');
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error('no clerk token');
        const res = await apiFetch<{ user: AuthUser }>('/auth/clerk/exchange', {
          method: 'POST',
          body: { token },
        });
        await adoptUser(res.user);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 403) setState('not_invited');
        else setState('failed');
      }
    })();
  }, [isSignedIn, getToken]);

  if (!isSignedIn) {
    return (
      <div className="stack" style={{ alignItems: 'center' }}>
        <SignIn routing="virtual" />
      </div>
    );
  }

  if (state === 'not_invited') {
    return (
      <div className="signin__card stack">
        <h1 className="signin__title">Not on the team yet</h1>
        <p className="signin__lede">
          That account signed in fine, but it isn’t on this store’s team. Accounts are by
          invitation only, so ask an owner or developer to invite this address, then sign in
          again. If you were invited a while ago, the invitation may have run out — ask for a
          new one.
        </p>
        <Button
          onClick={() => {
            started.current = false;
            setState('idle');
            void signOut();
          }}
        >
          Use a different account
        </Button>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="signin__card stack">
        <h1 className="signin__title">That didn’t go through</h1>
        <p className="signin__lede">
          You signed in, but this admin couldn’t finish setting up your session. Try again in a
          moment.
        </p>
        <Button
          tone="primary"
          onClick={() => {
            started.current = false;
            setState('idle');
          }}
        >
          Try again
        </Button>
        <Button
          tone="plain"
          onClick={() => {
            started.current = false;
            setState('idle');
            void signOut();
          }}
        >
          Use a different account
        </Button>
      </div>
    );
  }

  return (
    <div className="signin__card stack" role="status">
      <h1 className="signin__title">Signing you in…</h1>
      <p className="signin__lede">Confirming your account with the store.</p>
    </div>
  );
}

export default function ClerkGate({ publishableKey }: { publishableKey: string }) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <Exchange />
    </ClerkProvider>
  );
}
