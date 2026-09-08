/**
 * CAN THIS BROWSER INSTALL THE ADMIN, AND HAS IT ALREADY?
 *
 * A store in the shape of `src/data/session` — a `getInstallState`/`subscribe`
 * pair, read through `useSyncExternalStore` — rather than a hook holding the
 * event in state, and that is the whole reason this file exists separately
 * from `InstallButton.tsx`.
 *
 * `beforeinstallprompt` FIRES ONCE, EARLY, AND IS NOT REPLAYED. Chrome raises
 * it as soon as it has read the manifest and seen a service worker, which on a
 * warm load is well before `/auth/me` has answered — and until it answers, the
 * Gate renders nothing at all, so there is no Shell and no button to hear it.
 * A listener registered inside the component would miss it on every boot but
 * the slowest, and the symptom is an admin that simply never offers to
 * install, on a machine where it could. So the listener is registered at
 * MODULE scope, on import, and holds the event until something asks for it.
 *
 * THE EVENT IS SINGLE-USE. `prompt()` may be called once; a second call on the
 * same event is refused, so it is dropped the moment it is spent — accepted or
 * dismissed alike — and the button goes away with it until the next load. That
 * is honest rather than tidy: keeping the button after a dismissal would leave
 * a control that can no longer do anything.
 *
 * `ios` IS NOT AN ERROR STATE. No browser on iOS implements
 * `beforeinstallprompt` at all — not Safari, and not Chrome or Firefox there,
 * which are Safari underneath. The only route is Share → Add to Home Screen,
 * which we cannot trigger and can only describe, so it is a state of its own
 * with its own instructions rather than a silence.
 */

/** Chrome's event, which TypeScript's DOM library does not describe. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallStatus =
  /** Running as an installed app already. Nothing to offer. */
  | 'installed'
  /** The browser handed us a prompt and it is unspent. One tap installs. */
  | 'ready'
  /** iOS: no prompt exists, so the Share menu steps are the offer. */
  | 'ios'
  /** No prompt, not iOS — a desktop Firefox, an unsupported browser, or a
   *  Chrome that has not decided we are installable. Offer nothing. */
  | 'unavailable';

export interface InstallState {
  status: InstallStatus;
}

let deferred: BeforeInstallPromptEvent | null = null;
/* The snapshot is CACHED and replaced only when the status really changes.
   `useSyncExternalStore` re-reads it on every render and loops forever if a
   fresh object comes back each time. */
let state: InstallState = { status: 'unavailable' };

const listeners = new Set<() => void>();

/**
 * Standalone means the window has no browser chrome — it was launched from a
 * home screen or a launcher.
 *
 * Two readings because the platforms disagree: `display-mode` is the
 * manifest's own answer and is what Android and desktop Chrome report, while
 * iOS matches nothing and sets a non-standard `navigator.standalone` instead.
 */
function isStandalone(): boolean {
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  ) {
    return true;
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  /* iPadOS 13 and later report themselves as a Mac, deliberately, so the user
     agent alone would send every iPad down the desktop branch and offer it
     nothing. A touch screen is what separates the two. */
  return /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
}

function read(): InstallStatus {
  if (typeof window === 'undefined') return 'unavailable';
  /* Installed wins over everything, including a held prompt: a browser tab and
     the installed window can both be open, and the installed one must not
     offer to install itself. */
  if (isStandalone()) return 'installed';
  if (deferred) return 'ready';
  if (isIos()) return 'ios';
  return 'unavailable';
}

function sync(): void {
  const next = read();
  if (next === state.status) return;
  state = { status: next };
  for (const listener of listeners) listener();
}

export function getInstallState(): InstallState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  /* THE RE-READ HAPPENS AFTER THE LISTENER IS IN, and the order is the whole
     point. The module is evaluated once per page load and this component can
     mount minutes later — in a window the reader has since installed from, or
     before the browser had decided anything. So a new subscriber re-reads the
     environment; one media query is cheaper than a timer. Syncing BEFORE the
     add would emit to nobody, and React checks the snapshot just before it
     subscribes, never after, so the change would sit unseen until the next
     unrelated one. */
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Show the browser's own install dialog and wait for the answer.
 *
 * Resolves `true` only if they went through with it. Every other outcome —
 * dismissed, nothing held, a browser that refused the call — is `false` and is
 * not an error worth showing anybody: they either see the app on their home
 * screen or they do not.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  /* Cleared BEFORE the await, not after. Two taps on the button while the
     dialog is opening would otherwise both reach `prompt()`, and the second
     call throws. */
  deferred = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome === 'accepted';
  } catch {
    return false;
  } finally {
    sync();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    /* Without this, Chrome on Android shows its own mini-infobar over the
       bottom of the app — an install offer we did not draw, in the middle of
       whatever screen the reader is on. Preventing it is what moves the offer
       into our own control. */
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    sync();
  });

  /* Fires after an install completes, in the tab that asked for it. The
     prompt is spent by then either way; this is what takes the button away
     when somebody installs from the browser's own menu instead of ours. */
  window.addEventListener('appinstalled', () => {
    deferred = null;
    sync();
  });

  if (typeof window.matchMedia === 'function') {
    const standalone = window.matchMedia('(display-mode: standalone)');
    /* Safari only grew `addEventListener` on a media query list in 14, and
       jsdom's implementation has come and gone. Neither is worth a crash on
       boot for a listener that only sharpens an edge case. */
    if (typeof standalone.addEventListener === 'function') {
      standalone.addEventListener('change', sync);
    }
  }

  sync();
}
