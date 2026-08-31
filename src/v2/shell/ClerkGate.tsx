import { useEffect, useRef, useState } from 'react';
import { ClerkProvider, SignIn, useAuth, useClerk } from '@clerk/clerk-react';
import { apiFetch } from '../../data/api';
import { adoptUser } from '../../data/session';
import { ApiError } from '../../data/errors';
import { Button } from '../ui/primitives';
import type { AuthUser } from '../../data/types';

/**
 * The Clerk half of the sign-in screen (owner's 2026-08-31 batch), and it is a
 * LAZY CHUNK on purpose: `Gate.tsx` renders it only when
 * `VITE_CLERK_PUBLISHABLE_KEY` was baked into the bundle, so a deployment
 * without Clerk ships no Clerk code to the browser at all.
 *
 * THE FLOW: Clerk's own `<SignIn>` runs Google (and whatever factors the
 * Clerk dashboard demands — that is where the owner turns Clerk 2FA on);
 * once a Clerk session exists, the token is traded at
 * `POST /api/auth/clerk/exchange` for the ordinary `__Host-studio_session`
 * cookie, and `adoptUser` proceeds exactly as a password login would. The
 * admin has ONE session system; Clerk is a front door, not a second house.
 *
 * `not_invited` IS THE HONEST END of a Google account that verified fine but
 * is not on the team list — this instance stays invite-only, and the screen
 * says to ask an admin rather than pretending the login failed.
 */

function Exchange({ onBack }: { onBack: () => void }) {
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
        <Button tone="plain" onClick={onBack}>
          Back to password sign-in
        </Button>
      </div>
    );
  }

  if (state === 'not_invited') {
    return (
      <div className="signin__card stack">
        <h1 className="signin__title">Not on the team yet</h1>
        <p className="signin__lede">
          That Google account signed in fine, but it isn’t on this store’s team. Accounts
          are by invitation only, so ask an owner or developer to invite this address, then try
          again.
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
        <Button tone="plain" onClick={onBack}>
          Back to password sign-in
        </Button>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="signin__card stack">
        <h1 className="signin__title">That didn’t go through</h1>
        <p className="signin__lede">
          Google signed you in, but this admin couldn’t finish setting up your session. Try again,
          or sign in with your password instead.
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
        <Button tone="plain" onClick={onBack}>
          Back to password sign-in
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

export default function ClerkGate({
  publishableKey,
  onBack,
}: {
  publishableKey: string;
  onBack: () => void;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <Exchange onBack={onBack} />
    </ClerkProvider>
  );
}
