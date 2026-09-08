import { shopApi } from '../../data/api-shop';

/**
 * WEB PUSH, FROM THE BROWSER'S SIDE — the subscription that lets a phone buzz
 * with the admin closed.
 *
 * `notify.ts` beside this file raises notifications from the RUNNING page and
 * is what fires while somebody is looking at a screen. This is the other half,
 * and the only one that survives the tab being shut: the browser holds a
 * subscription with its own push service, and `server/shop/notifications/
 * push.ts` sends through it when an order is paid.
 *
 * ═══════════════════ THE TWO PERMISSIONS ARE ONE PERMISSION ═══════════════════
 * `Notification.requestPermission()` and `pushManager.subscribe()` both ask for
 * the same grant, so subscribing after the person has already allowed
 * notifications raises no second prompt. That is why `enablePush` does not ask
 * again: it would be a dialog the browser answers itself, and on a denial it
 * would look like the app asking twice.
 *
 * ═══════════════════ EVERYTHING HERE DEGRADES ═══════════════════
 * No service worker, no PushManager, no VAPID key on the server, permission
 * refused — each is an ordinary answer and none is an error. The email still
 * arrives and the bell still fills; this is the channel that makes the phone
 * buzz, not the one that makes the shop work.
 */

/** What this device can do about push, as one word the UI can switch on. */
export type PushState =
  /** This browser has no service worker or no PushManager. On iOS that means
   *  "not from a Safari tab" rather than "never" — see `isIosBrowser`. */
  | 'unsupported'
  /** iOS, in a browser tab. Web Push exists there ONLY for a site added to the
   *  Home Screen, so this is a step away rather than a dead end — and it needs
   *  its own state because the instructions are completely different. */
  | 'needs-install'
  /** The deployment has no VAPID keys. The owner sets three variables. */
  | 'not-configured'
  /** No service worker is registered, so there is nothing to subscribe THROUGH.
   *
   *  ITS OWN STATE BECAUSE IT USED TO BE SILENT, and that silence is what made
   *  the button look broken on production: `enablePush` returned 'off' — the
   *  state it started in — so the screen reported nothing at all, and the
   *  person pressed a button that by every visible sign did nothing. The
   *  worker registers on the window `load` event, so pressing quickly enough
   *  after a cold load lands exactly here. */
  | 'no-worker'
  /** Available, and this device is not registered. */
  | 'off'
  /** Registered — the shop can reach this device. */
  | 'on'
  /** The person refused notifications. Only their browser settings can undo it,
   *  which is why this is its own state and not a kind of `off`. */
  | 'blocked';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

/**
 * The registration, or `null` if there is not one yet.
 *
 * `getRegistration()` and NEVER `ready`. `navigator.serviceWorker.ready` is a
 * promise that never settles when no worker has been registered — in dev, where
 * `main.tsx` registers only in PROD, awaiting it hangs the caller forever with
 * no error and no timeout. Asked this way, "there is no worker" is an answer.
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The registration, REGISTERING IT IF NOBODY HAS YET.
 *
 * THE FIX FOR A BUTTON THAT DID NOTHING. `main.tsx` registers the worker on the
 * window `load` event, so there is a window after a cold load in which
 * `getRegistration()` is legitimately empty — and pressing "Turn on for this
 * device" inside it used to return the state it started in, so the screen said
 * nothing and the button looked broken. It looked broken on production
 * specifically, because a host somebody visits rarely is the one whose worker
 * has not settled, while a host they hammer all day always has one.
 *
 * `register()` rather than awaiting `navigator.serviceWorker.ready`: `ready`
 * never settles when nothing has been registered, so waiting on it turns a
 * missing worker into a hang with no error. `register` is idempotent — handed
 * a URL that is already registered it resolves with the existing registration —
 * so this closes the race instead of racing it.
 *
 * PROD ONLY, matching `main.tsx`. A worker in dev serves yesterday's bundle
 * back to Vite and fights HMR, and quietly installing one from a settings
 * screen would be a genuinely confusing way to discover that.
 */
async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await registration();
  if (existing !== null) return existing;
  if (!import.meta.env.PROD) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/**
 * iOS, in a browser tab rather than an installed app.
 *
 * EVERY BROWSER ON iOS IS SAFARI UNDERNEATH, so Chrome and Firefox there behave
 * identically — and none of them exposes `PushManager` to a tab. Apple gives
 * Web Push only to a site added to the Home Screen. That makes "unsupported"
 * the wrong word: the capability is one step away, and the step is nothing like
 * the one every other platform needs.
 *
 * iPadOS reports itself as a Mac deliberately, so the user agent alone sends
 * every iPad down the desktop branch; a touch screen is what separates them.
 */
function isIosBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  /* Already installed? Then it is not this case — an installed iOS app DOES get
     push, and telling somebody to install what they are standing in is absurd. */
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayMode =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return !standalone && !displayMode;
}

/**
 * The VAPID key as `subscribe` wants it — raw bytes, not the base64url string
 * the server sends.
 *
 * `applicationServerKey` takes a BufferSource. Handed the string, Chrome throws
 * `InvalidCharacterError` from inside `subscribe()`, which reads as a malformed
 * key rather than as the wrong type. The padding and the two substitutions are
 * base64url → base64; `atob` understands only the latter.
 */
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  /* Built over an explicit ArrayBuffer so the type is `Uint8Array<ArrayBuffer>`
     rather than `<ArrayBufferLike>`, which `applicationServerKey` refuses —
     BufferSource excludes SharedArrayBuffer, and the bare constructor admits
     it. */
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * The permission, read through a call rather than inline.
 *
 * NOT COSMETIC. `Notification.permission` is a live property, but TypeScript
 * narrows it after an early `=== 'denied'` return and then calls every later
 * comparison impossible — which is wrong here, because `pushManager.subscribe`
 * ASKS, and the answer can be `denied` on the line after the one that said it
 * was not. Going through a function is what keeps the runtime truth checkable.
 */
function currentPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission;
}

/** What this device's push looks like right now. Asks the server whether push
 *  exists at all, so a deployment with no keys says so rather than offering a
 *  button that cannot work. */
export async function pushState(signal?: AbortSignal): Promise<PushState> {
  /* iOS FIRST, because on a Safari tab `supported()` is false and would answer
     "this browser cannot", which is untrue and unhelpful — the browser can, as
     soon as the site is on the Home Screen. */
  if (isIosBrowser()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (currentPermission() === 'denied') return 'blocked';

  let configured = false;
  try {
    configured = (await shopApi.pushKey(signal)).configured;
  } catch {
    /* A refusal or an outage is not "unsupported". Reporting `off` keeps the
       control visible and lets the attempt produce a real error the person can
       read, rather than hiding the feature over a transient 500. */
    return 'off';
  }
  if (!configured) return 'not-configured';

  /* READ-ONLY here — this runs on every mount and must not install a worker as
     a side effect of looking. `enablePush` is where a press may create one. */
  const reg = await registration();
  if (reg === null) return 'no-worker';
  const existing = await reg.pushManager.getSubscription();
  return existing === null ? 'off' : 'on';
}

/**
 * Register this device.
 *
 * @returns the state it ended in, so a caller can render the outcome without a
 * second round trip. `blocked` means the person refused and the browser will
 * not ask again.
 *
 * IT SUBSCRIBES FIRST AND TELLS THE SERVER SECOND, and the order matters. A row
 * written before the browser agreed would claim a device that can receive
 * nothing, and every future order would pay for a push to it until a 410 pruned
 * it. The reverse — a subscription the server never hears about — is recovered
 * on the next call, because `subscribe()` returns the existing one.
 */
export async function enablePush(): Promise<PushState> {
  if (isIosBrowser()) return 'needs-install';
  if (!supported()) return 'unsupported';
  if (currentPermission() === 'denied') return 'blocked';

  try {
    const { publicKey, configured } = await shopApi.pushKey();
    if (!configured || publicKey === null) return 'not-configured';

    /* REGISTERS ONE IF THERE IS NONE, rather than giving up. This is the line
       that used to return 'off' — the state the caller was already in — which
       is how a press produced no notification, no error and no change on
       screen. See `ensureRegistration`. */
    const reg = await ensureRegistration();
    if (reg === null) return 'no-worker';

    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        /* REQUIRED TO BE TRUE, and not a choice we get to make: Chrome refuses
           the subscription outright without it. It is the promise that every
           push shows the person something, which the worker's push handler
           keeps even for an unreadable payload. */
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'off';

    await shopApi.pushSubscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      userAgent: navigator.userAgent.slice(0, 400),
    });
    return 'on';
  } catch {
    /* A refusal arrives here as a DOMException from `subscribe`, not as a
       rejected permission prompt, because the two grants are one. */
    if (currentPermission() === 'denied') return 'blocked';
    return 'off';
  }
}

/**
 * Forget this device, on the browser AND on the server.
 *
 * BOTH HALVES, and the server first. Unsubscribing locally alone would leave a
 * row the shop keeps pushing to — the person turned it off and their phone
 * keeps buzzing, which is the worst of the failures available here. The reverse
 * leaves a dead row that the first 404 prunes on its own.
 */
export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  try {
    const reg = await registration();
    const subscription = reg === null ? null : await reg.pushManager.getSubscription();
    if (subscription !== null) {
      await shopApi.pushUnsubscribe(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe().catch(() => false);
    }
  } catch {
    /* Nothing here is worth surfacing: the person asked for silence and the
       worst case is a row a 404 removes at the next order. */
  }
  return currentPermission() === 'denied' ? 'blocked' : 'off';
}
