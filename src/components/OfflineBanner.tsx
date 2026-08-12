import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * Offline, and the two things it genuinely costs (plan §7, §8.2).
 *
 * WHAT THIS IS NOT: a "you have been disconnected, nothing will be saved"
 * warning. Every keystroke is still accepted, `useAutosave` still fires, the
 * save still fails, and `savePost`'s catch block writes both a `pending` row
 * and the overlay the frozen editor hydrates from — so the words survive the
 * failure, the reload, and the flight. Saying otherwise would be false and
 * would make writers stop typing, which is the actual cost of a scary banner.
 *
 * So the banner states the exceptions instead, and there are exactly two:
 *
 *  - **a new post cannot be started.** `createPost` is a plain `POST /posts`
 *    and there is deliberately no pending path for it: a pending row is keyed
 *    by `postId`, and a post the server has never issued has no id to key by.
 *    Ghost cannot do this offline either; the difference is that this says so
 *    before the click rather than after it.
 *  - **a picture cannot be added.** `storeImageFile` uploads to object storage
 *    (`src/data/images.ts`), and `pending` holds patches, not bytes. The file
 *    is still on the writer's disk, which is why a clear refusal beats a
 *    silent one.
 *
 * `navigator.onLine` is a HINT AND NEVER EVIDENCE. It is true on a machine
 * attached to a captive-portal wifi with no route anywhere, and `session.ts`
 * already treats it that way — it re-boots on `online` rather than believing
 * it. Nothing here decides anything about the session, the cache or a request;
 * it decides what the screen says and which button is offered.
 */

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

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;

  return (
    /*
     * `role="status"`, not `alert`. Nothing is wrong and nothing needs doing,
     * so it is announced politely rather than interrupting whatever a screen
     * reader is in the middle of — which, on this app, is usually a document.
     */
    <div className="notice notice--warn" role="status">
      <div>
        <WifiOff className="ui-ic" aria-hidden="true" />{' '}
        <strong>You&rsquo;re offline.</strong> Keep writing — every change is
        kept on this device and sent to the blog as soon as the connection is
        back. Two things need it in the meantime:{' '}
        <strong>starting a new post</strong> and{' '}
        <strong>adding a picture</strong>.
      </div>
    </div>
  );
}
