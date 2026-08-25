/**
 * v2 port: shim, not a copy. The copied SaveIndicator imports only `useOnline`
 * from '../components/OfflineBanner'; the banner component itself (and its
 * lucide icon) is v1 chrome and stays there. Everything below is verbatim from
 * src/components/OfflineBanner.tsx.
 */
import { useSyncExternalStore } from 'react';

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * `!== false` rather than a truthiness test, because a platform that does not
 * report connectivity at all leaves `onLine` undefined — and telling someone
 * who is online that they are not is a worse answer than saying nothing.
 */
function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * `useSyncExternalStore` rather than `useState` + two `addEventListener`s in an
 * effect: the events fire on `window`, outside React, and every consumer must
 * agree on the answer within one render. The third argument is the
 * server/no-DOM snapshot and is deliberately `true` — see `isOnline`.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}
