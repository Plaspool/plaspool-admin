import type { OpsAlert } from './alerts';

/**
 * The browser notification — the third of the three ways a paid order reaches
 * somebody, beside the email and the bell.
 *
 * THERE IS NO WEB PUSH HERE, ON PURPOSE. Push needs a VAPID key pair and a
 * subscription store; the keys are an owner console action nobody can take on
 * anyone's behalf, so the case this cannot cover — the admin closed, the phone
 * in a pocket — is covered by the ORDER EMAIL instead. What is left is still
 * worth having on its own: the shop's machine has this tab open all day, and a
 * notification is the thing that makes somebody look at it. Every path here
 * degrades quietly, and an admin who never grants permission loses nothing but
 * the pop-up.
 *
 * NOTHING IN THIS FILE THROWS. It is called from the bell's refresh, which
 * runs on a timer and whose failure state is a screen-wide error boundary — so
 * an old browser, an insecure origin, a permission revoked between the check
 * and the call, or a service worker that has gone away all have to end as
 * `false` rather than as an exception travelling up through a `setInterval`.
 */

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

/**
 * The app icon, the same file the manifest points at.
 *
 * A notification with no icon still shows — the browser falls back to its own
 * badge — so a missing or renamed file here costs an icon and never a
 * notification.
 */
const ICON = '/brand/icon-192.png';

/**
 * An alert's `to` is a ROUTER path; the service worker needs a URL.
 *
 * THE ADMIN IS HASH-ROUTED — `createHashRouter` in `main.tsx`, and the
 * manifest's own `start_url` is `/#/home` for the same reason — so
 * `/orders/ord_1` is a fragment and not a path. Handed to the worker as it
 * stands, `clients.openWindow` asks the server for `/orders/ord_1`, the SPA
 * fallback serves the shell, and the router lands on the default route: a
 * notification that names an order and then does not open it, which is the
 * one failure worse than not notifying at all.
 */
function routeUrl(to: string): string {
  return `/#${to}`;
}

/** `NotificationPermission` is a three-member union everywhere it is
 *  implemented, but it arrives off a global this file has just proved it
 *  cannot trust, so anything unrecognised is read as "not asked yet". */
function normalise(state: unknown): NotifyPermission {
  return state === 'granted' || state === 'denied' ? state : 'default';
}

export function notifyPermission(): NotifyPermission {
  try {
    /* `typeof` rather than `'Notification' in window`: on iOS Safari before 16.4
       the constructor is genuinely absent, and on a page served over plain HTTP
       reading it can throw rather than answer. */
    if (typeof Notification === 'undefined') return 'unsupported';
    return normalise(Notification.permission);
  } catch {
    return 'unsupported';
  }
}

/**
 * Ask. ONLY EVER FROM A USER GESTURE — every browser refuses (and Chrome
 * permanently denies) a request that did not come out of a click, so the one
 * caller is the opt-in row in the alerts panel and it calls this straight out
 * of `onClick`.
 *
 * Answers with the permission as it stands AFTER the prompt, whatever the
 * prompt returned: Safari answered the callback form for years before it grew
 * the promise, and that form resolves to `undefined`. Reading the property
 * back is the one shape that is right for both.
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const before = notifyPermission();
  if (before !== 'default') return before;
  try {
    const answer: unknown = await Notification.requestPermission();
    if (typeof answer === 'string') return normalise(answer);
  } catch {
    /* A browser that refuses to be asked leaves the permission where it was. */
  }
  return notifyPermission();
}

/**
 * Raise one alert as a notification. `false` means it did not show, which is
 * never worth telling anybody: the same alert is already in the bell.
 */
export async function showAlertNotification(alert: OpsAlert): Promise<boolean> {
  if (notifyPermission() !== 'granted') return false;

  const options: NotificationOptions = {
    body: alert.body,
    /* THE SAME ORDER NEVER STACKS TWO NOTIFICATIONS. The tag collapses a
       repeat onto the one already on screen, and the bell polls — a refresh
       that raced another one must not leave two copies of one order sitting
       in the tray for somebody to work through twice. */
    tag: alert.id,
    /* What the service worker's notificationclick handler routes off, ON THE
       REGISTRATION PATH ONLY (it reads `data.url` and falls back to `/`). The
       constructor below never fires that event and carries its own click
       handler instead. A notification that opens the admin on its home screen
       makes the reader go hunting for the order it had just told them about. */
    data: { url: routeUrl(alert.to) },
    icon: ICON,
  };

  try {
    /* `registration.showNotification` IS THE ONLY FORM ANDROID HAS: Chrome
       there throws `Illegal constructor` for `new Notification(...)`, because
       a notification that outlives the page must be raised through the
       service worker. So the registration is tried first, and the constructor
       is the fallback for a page that has no worker at all — a dev server, or
       a browser that declined to register one. */
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration && typeof registration.showNotification === 'function') {
      await registration.showNotification(alert.title, options);
      return true;
    }
    const notification = new Notification(alert.title, options);
    /* THIS ONE IS CLICKED IN THE PAGE, NOT IN THE WORKER, and that is why it
       needs a handler of its own. A notification raised by the constructor is
       non-persistent: it dispatches `click` on the instance here and never
       fires `notificationclick` in the service worker, so the `data.url`
       above is inert on this path and a tap would do nothing at all — the
       failure `routeUrl` calls worse than not notifying. The handler makes
       both paths keep the same promise: go to the order, bring the window
       forward, and take the pop-up off the tray so a second tap cannot
       happen.

       THE NAVIGATION GOES FIRST because it is the promise and the other two
       are courtesies — `window.focus()` is ignored by several browsers and
       jsdom does not implement it at all, and a throw there must not cost the
       reader the order. Setting the hash rather than assigning
       `routeUrl(...)` keeps whatever path the admin is served on, and the
       router does the rest. */
    notification.onclick = () => {
      try {
        window.location.hash = alert.to;
        window.focus();
        notification.close();
      } catch {
        /* The same rule as the catch below: this runs inside a handler the
           browser calls, and an exception there is nobody's to see. */
      }
    };
    return true;
  } catch {
    /* Permission revoked mid-flight, a worker that has gone, or a browser that
       simply says no. The bell still carries the alert and the email has
       already gone out; this was the third of three, not the only one. */
    return false;
  }
}
