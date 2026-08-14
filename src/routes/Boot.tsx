import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../components/RequireAuth';
import { whenSplashDone } from '../components/splash';

/**
 * The index route: a gateway, not a screen.
 *
 * It renders nothing. The opening sequence is an overlay mounted at module
 * scope in `main.tsx` — before React exists, so there is no blank frame between
 * the document painting and the animation starting — and this component's only
 * job is to decide where the person underneath it should end up.
 *
 * OUTSIDE `RequireAuth`, necessarily: the whole point is that it runs before
 * anyone knows who this is, and the guard would send an unauthenticated visitor
 * to `/login` before the sequence had played a frame.
 *
 * IT WAITS FOR BOTH the sequence and the session, and the order matters. React
 * Router unmounts this route the instant it navigates, and the redirect changes
 * the URL under the overlay; doing that while the animation is still running is
 * how you get a splash that fades to reveal a screen it never introduced. So
 * the redirect is held until `whenSplashDone()` resolves, which is also the
 * moment the overlay has removed itself from the DOM.
 *
 * `offline` deliberately routes to `/dashboard` rather than to sign-in. A
 * writer whose `/auth/me` never reached a server has not been signed out, and
 * `RequireAuth` already draws the two honest answers for that state — the app
 * from cache, or the offline notice when this device has no identity to paint
 * by. Sending them to a login form they cannot satisfy without a network is the
 * one thing that must not happen here.
 */
export default function Boot() {
  const session = useSession();
  const [sequenceDone, setSequenceDone] = useState(false);

  useEffect(() => {
    let alive = true;
    void whenSplashDone().then(() => {
      if (alive) setSequenceDone(true);
    });
    // The promise cannot be cancelled, so the flag is what stops a resolve
    // arriving after unmount from setting state on a dead component.
    return () => {
      alive = false;
    };
  }, []);

  // Nothing at all until both answers are in. There is an overlay on top of
  // this; anything rendered here would only be seen through its fade.
  if (!sequenceDone || session.status === 'unknown') return null;

  return <Navigate to={session.status === 'anonymous' ? '/login' : '/dashboard'} replace />;
}
