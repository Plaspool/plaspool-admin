import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The browser notification helper, pinned on the three ways it can fail
 * INVISIBLY — every one of which ends with an order nobody was told about.
 *
 *  - **It must never throw.** It is called from the bell's poll, inside a
 *    `setInterval`, on a screen whose failure state is the shell's error
 *    boundary. A browser without `Notification`, a page on plain HTTP, a
 *    permission revoked between the check and the call and Android's
 *    `Illegal constructor` all have to come home as `false`.
 *  - **`registration.showNotification` is the only form Android has**, and the
 *    constructor is the only form a page with no service worker has. Getting
 *    that order backwards is a feature that works on the developer's laptop
 *    and on no phone in the shop.
 *  - **The click has to land on the order, on BOTH paths.** `data.url` is what
 *    the service worker's notificationclick handler routes off; a notification
 *    raised by the constructor never fires that event at all and needs a click
 *    handler of its own. Either one missing is a pop-up that names an order and
 *    then opens the admin's home screen, leaving the reader to go hunting for
 *    the thing it had just told them about.
 *
 * NAMED `.test.tsx` for the same reason `alerts.test.tsx` is: `notify.ts`
 * reads `navigator` and the `Notification` global, and the `client` node
 * project has neither.
 */

import { notifyPermission, requestNotifyPermission, showAlertNotification } from './notify';
import type { OpsAlert } from './alerts';

const ORDER: OpsAlert = {
  id: 'order-ord_1',
  source: 'Orders',
  title: 'Order 2026-000123-A — ₦12,500.00',
  body: 'buyer@example.com paid. Nothing sent out yet.',
  at: 1_756_000_000_000,
  to: '/orders/ord_1',
  tone: 'info',
  signature: 'paid',
};

/**
 * What `new Notification(...)` was handed, per test — and the instance it made,
 * because on the constructor path the click handler hangs off THAT rather than
 * off the service worker.
 */
interface Constructed {
  title: string;
  options?: NotificationOptions;
  /** Assigned by `showAlertNotification`; a real one is `null` until it is. */
  onclick: (() => void) | null;
  close: () => void;
}

let constructed: Constructed[] = [];

/**
 * The `Notification` global, which jsdom does not implement at all — so its
 * ABSENCE is the honest default here, and every test that wants one installs
 * it. `permission` is a plain static so a test can move it mid-run, the way a
 * real prompt does.
 *
 * THE INSTANCE CARRIES `onclick` AND `close` BECAUSE A REAL ONE DOES. A fake
 * without them would let a handler that calls `close()` pass here and throw in
 * a browser, which is the whole class of bug this file exists to catch.
 */
function installNotification(permission: string, onRequest?: () => unknown) {
  class FakeNotification implements Constructed {
    static permission = permission;
    static requestPermission = vi.fn(async () => onRequest?.());
    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
      constructed.push(this);
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return FakeNotification;
}

/** A constructor that refuses, which is what Chrome on Android does: a
 *  persistent notification may only be raised through the worker. */
function installRefusingConstructor(permission: string) {
  class Refusing {
    static permission = permission;
    static requestPermission = vi.fn(async () => permission);
    constructor() {
      throw new TypeError('Illegal constructor');
    }
  }
  vi.stubGlobal('Notification', Refusing);
}

/**
 * `navigator.serviceWorker` is not implemented by jsdom either, and
 * `vi.stubGlobal('navigator', …)` would replace the whole object every other
 * jsdom API hangs off — so the one property is defined and deleted instead.
 */
function installRegistration(registration: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => registration },
  });
}

beforeEach(() => {
  constructed = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if ('serviceWorker' in navigator) {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  }
});

// ============================================================================

describe('what the browser will allow', () => {
  it('a browser with no Notification at all is “unsupported”, not “denied”', () => {
    /* jsdom has none, which is the point: the two must not be collapsed. The
       opt-in row offers itself on `default` and hides on both of the others,
       and an old browser that gets offered a permission it cannot grant is a
       button that does nothing when pressed. */
    expect(notifyPermission()).toBe('unsupported');
  });

  it('reads granted and denied through, and anything else as “not asked yet”', () => {
    installNotification('granted');
    expect(notifyPermission()).toBe('granted');

    installNotification('denied');
    expect(notifyPermission()).toBe('denied');

    installNotification('default');
    expect(notifyPermission()).toBe('default');

    // The global is not this app's to trust — `shopFetch` is not the only
    // unchecked assertion in the client.
    installNotification('something-else-entirely');
    expect(notifyPermission()).toBe('default');
  });
});

describe('asking for permission', () => {
  it('does not ask again once the answer is in', async () => {
    const denied = installNotification('denied');
    await expect(requestNotifyPermission()).resolves.toBe('denied');
    expect(denied.requestPermission).not.toHaveBeenCalled();

    const granted = installNotification('granted');
    await expect(requestNotifyPermission()).resolves.toBe('granted');
    expect(granted.requestPermission).not.toHaveBeenCalled();
  });

  it('asks while the answer is still open, and reports what came back', async () => {
    const fake = installNotification('default', () => 'granted');
    await expect(requestNotifyPermission()).resolves.toBe('granted');
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reads the permission back when the prompt answers nothing', async () => {
    /* Safari answered the callback form for years before it grew the promise,
       and that form resolves to `undefined`. Taking the return value alone
       would call every one of those grants a refusal. */
    const fake = installNotification('default', () => {
      fake.permission = 'granted';
      return undefined;
    });
    await expect(requestNotifyPermission()).resolves.toBe('granted');
  });

  it('a browser that refuses to be asked leaves the permission where it was', async () => {
    installNotification('default', () => {
      throw new Error('no');
    });
    await expect(requestNotifyPermission()).resolves.toBe('default');
  });
});

describe('raising one', () => {
  it('goes through the service worker when there is one — the only form Android has', async () => {
    installNotification('granted');
    const showNotification = vi.fn(async () => {});
    installRegistration({ showNotification });

    await expect(showAlertNotification(ORDER)).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = showNotification.mock.calls[0] as unknown as [
      string,
      NotificationOptions,
    ];
    expect(title).toBe('Order 2026-000123-A — ₦12,500.00');
    expect(options.body).toBe('buyer@example.com paid. Nothing sent out yet.');
    // The tag is what stops one order stacking two pop-ups across two polls.
    expect(options.tag).toBe('order-ord_1');
    /* What the worker's notificationclick handler routes off, and the app is
       HASH-ROUTED: a bare /orders/ord_1 would ask the server for a path it
       does not serve, and the SPA fallback would open the default screen. */
    expect(options.data).toEqual({ url: '/#/orders/ord_1' });
    // And the constructor was not touched — on Android it would have thrown.
    expect(constructed).toEqual([]);
  });

  it('falls back to the constructor on a page with no worker', async () => {
    installNotification('granted');

    await expect(showAlertNotification(ORDER)).resolves.toBe(true);

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.title).toBe('Order 2026-000123-A — ₦12,500.00');
    expect(constructed[0]!.options?.tag).toBe('order-ord_1');
    expect(constructed[0]!.options?.data).toEqual({ url: '/#/orders/ord_1' });
  });

  it('the constructed one carries its own click handler — the worker never sees it', async () => {
    /* A non-persistent notification dispatches `click` on the INSTANCE and
       never fires `notificationclick`, so `data.url` cannot route this one.
       Without a handler here the pop-up names an order and then does nothing
       when it is tapped, which `notify.ts` calls worse than not notifying. */
    installNotification('granted');
    window.location.hash = '#/home';

    await expect(showAlertNotification(ORDER)).resolves.toBe(true);

    const raised = constructed[0]!;
    expect(typeof raised.onclick).toBe('function');

    raised.onclick!();

    expect(window.location.hash).toBe('#/orders/ord_1');
    // And it leaves the tray, so a stale pop-up cannot be tapped a second time.
    expect(raised.close).toHaveBeenCalledTimes(1);
  });

  it('raises nothing at all until the permission is granted', async () => {
    installNotification('default');
    await expect(showAlertNotification(ORDER)).resolves.toBe(false);

    installNotification('denied');
    await expect(showAlertNotification(ORDER)).resolves.toBe(false);

    expect(constructed).toEqual([]);
  });

  it('a constructor that refuses is a false, never a throw', async () => {
    /* Chrome on Android, and any browser that revokes the permission between
       the check above and the call below. This runs inside the bell's poll:
       an exception here is the whole shell behind an error boundary. */
    installRefusingConstructor('granted');
    await expect(showAlertNotification(ORDER)).resolves.toBe(false);
  });

  it('a worker whose showNotification rejects is a false too', async () => {
    installNotification('granted');
    installRegistration({
      showNotification: async () => {
        throw new Error('worker is gone');
      },
    });
    await expect(showAlertNotification(ORDER)).resolves.toBe(false);
  });

  it('on a browser with no Notification the whole path is a quiet no', async () => {
    await expect(showAlertNotification(ORDER)).resolves.toBe(false);
  });
});
