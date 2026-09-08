import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The order-notifications screen, pinned on the two things it can get wrong
 * where nobody would notice for weeks.
 *
 *  - **The body it PATCHes.** This is the only screen whose whole job is a
 *    write to a route written in another session, and every field in it is
 *    optional on the wire — so a misspelt key is not a 400, it is a switch
 *    that silently never moves. `expectedRevision` is the same: sent as the
 *    wrong number it is a permanent 409, sent not at all it is two people
 *    overwriting each other. Asserted key by key against the pinned contract.
 *  - **A LOST CAS LOADS THEIRS AND SAYS SO.** No other v2 screen does this
 *    yet, and the tempting repair — re-send with the fresh revision — erases
 *    somebody's change with a click this person never made and tells nobody
 *    it happened. The refusal has to end with their version on screen and a
 *    sentence explaining why the switch moved back.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason every v2 suite
 * gives: the path, the method and the body are the three things most likely to
 * be silently wrong against a backend written in another session, and a mocked
 * module asserts none of them.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'owner@plaspool.com',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'writer',
    },
  },
}));

vi.mock('../../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import { ToastHost } from '../ui/Toast';
import SettingsNotifications from './SettingsNotifications';

/**
 * What jsdom does not implement and the v2 chrome touches. `ResizeObserver` is
 * the load-bearing one across these suites; the tag box's suggestion pop rides
 * `Float`, which measures its anchor on open.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
dialogProto.showModal = function (this: HTMLDialogElement) {
  this.open = true;
};
dialogProto.close = function (this: HTMLDialogElement) {
  this.open = false;
};

// --------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/** Register a route. Anything unregistered answers 404 `gone`, like the app. */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** The body of the last request to a path with this method. */
function sent(pathname: string, method: string): Record<string, unknown> {
  const call = [...calls]
    .reverse()
    .find((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method);
  if (call === undefined) throw new Error(`no ${method} to ${pathname}`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  handlers.clear();
  calls = [];
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input), 'https://studio.test');
      calls.push({ path: url.pathname + url.search, init });
      const handler = handlers.get(url.pathname);
      const answer = handler
        ? handler(url, init)
        : { status: 404, body: { error: 'gone', requestId: 'req_test' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fixture.session.user.role = 'owner';
});

// -------------------------------------------------------------- the harness

const PATH = '/api/shop/admin/notification-settings';

interface Row {
  orderRecipients: string[];
  notifyTeam: boolean;
  notifyOnOrder: boolean;
  revision: number;
  updatedAt: number;
  updatedBy: string | null;
}

const rowOf = (over: Partial<Row> = {}): Row => ({
  orderRecipients: ['warehouse@plaspool.com'],
  notifyTeam: true,
  notifyOnOrder: true,
  revision: 4,
  updatedAt: 1_756_000_000_000,
  updatedBy: 'u_owner',
  ...over,
});

/** The GET, and the PATCH that shares its path. `read` is a function so a
 *  test can move the server's row under the screen mid-run. */
function withSettings(read: () => Row, write?: Responder): void {
  when(PATH, (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { settings: read() } }
      : (write ??
          ((_u, i) => {
            const patch = JSON.parse(String(i.body)) as Partial<Row>;
            return { body: { settings: { ...read(), ...patch, revision: read().revision + 1 } } };
          }))(url, init),
  );
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/notifications']}>
        <SettingsNotifications />
      </MemoryRouter>
    </ToastHost>,
  );
}

const master = () => screen.findByRole('switch', { name: 'Email us when an order comes in' });
const team = () =>
  screen.findByRole('switch', { name: 'Everyone on the team who handles orders' });
const saveButton = () => screen.getByRole('button', { name: 'Save' });

// ============================================================================

describe('the order notifications screen', () => {
  it('reads the settings off the pinned path and shows them as they stand', async () => {
    withSettings(() => rowOf());
    mount();

    expect(((await master()) as HTMLInputElement).checked).toBe(true);
    expect(((await team()) as HTMLInputElement).checked).toBe(true);
    // The hand-typed address arrives as a chip, not as an empty box.
    expect(screen.getByText('warehouse@plaspool.com')).toBeTruthy();

    expect(calls[0]!.path).toBe(PATH);
    expect(calls[0]!.init.method ?? 'GET').toBe('GET');
  });

  it('sends back the revision it loaded, and every field key by key', async () => {
    const user = userEvent.setup();
    withSettings(() => rowOf());
    mount();

    await user.click(await team());

    const box = screen.getByLabelText('Other addresses');
    await user.type(box, 'orders@plaspool.com{Enter}');

    await user.click(saveButton());

    await waitFor(() => expect(sent(PATH, 'PATCH')).toBeTruthy());
    /* THE PINNED CONTRACT, WHOLE. Every field is optional on the wire, so a
       misspelt key here is a switch that silently never moves rather than a
       400 anybody would see. */
    expect(sent(PATH, 'PATCH')).toEqual({
      expectedRevision: 4,
      notifyOnOrder: true,
      notifyTeam: false,
      orderRecipients: ['warehouse@plaspool.com', 'orders@plaspool.com'],
    });
  });

  it('a lost race loads THEIRS and says so, rather than overwriting it', async () => {
    const user = userEvent.setup();
    /* The server's row moves under the screen — somebody in another tab
       switched the team off and the revision went to 5. */
    let current = rowOf();
    withSettings(
      () => current,
      () => ({
        status: 409,
        body: { error: 'stale_write', expected: 4, actual: 5, post: null, requestId: 'req_test' },
      }),
    );
    mount();

    // This person switches the MASTER off and presses Save.
    await user.click(await master());
    current = rowOf({ notifyTeam: false, revision: 5 });
    await user.click(saveButton());

    // Their version is on screen, named plainly rather than as a toast that
    // scrolls away before anybody reads it.
    expect(
      await screen.findByText('Somebody else changed this while you had it open'),
    ).toBeTruthy();

    await waitFor(async () => expect(((await team()) as HTMLInputElement).checked).toBe(false));
    /* AND THE EDIT IS GONE, deliberately: the master is back ON because that
       is what the server says, not left off because that is what was clicked.
       Re-sending with revision 5 would have erased the other tab's change. */
    expect(((await master()) as HTMLInputElement).checked).toBe(true);
  });

  it('refuses exactly what the server refuses, beside the box rather than as a 400', async () => {
    const user = userEvent.setup();
    withSettings(() => rowOf({ orderRecipients: [] }));
    mount();
    await master();

    const box = screen.getByLabelText('Other addresses');
    await user.type(box, 'warehouse{Enter}');

    /* `plausibleAddress` in the repo refuses this, so Save has to be blocked
       here — an address that silently never delivers is the exact failure
       this whole feature exists to prevent, and a 400 arriving after the
       press names a field rather than the entry that caused it. */
    expect(
      await screen.findByText('“warehouse” is not an email address, so nothing would reach it.'),
    ).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

    // And the rule is no STRICTER than the server's: a real address clears it.
    await user.click(screen.getByRole('button', { name: 'Remove tag warehouse' }));
    await user.type(box, 'warehouse@plaspool.com{Enter}');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('says out loud when the master switch is off', async () => {
    withSettings(() => rowOf({ notifyOnOrder: false }));
    mount();

    expect(await screen.findByText('Nobody is emailed when an order comes in')).toBeTruthy();
    // And it does not pretend the other two channels went with it.
    expect(
      screen.getByText('Orders still arrive and still show in the bell. Only the email is switched off.'),
    ).toBeTruthy();
  });

  it('names the configuration that looks on and sends to nobody', async () => {
    /* The team switched off with no hand-typed addresses. Every control on the
       screen reads as correct and not one order email goes anywhere — the
       exact quiet failure this whole feature exists to prevent. */
    withSettings(() => rowOf({ notifyTeam: false, orderRecipients: [] }));
    mount();

    expect(await screen.findByText('This is on, but there is nobody to send to')).toBeTruthy();
    // And it is not confused with the master switch being off, which is a
    // deliberate choice rather than an accident.
    expect(screen.queryByText('Nobody is emailed when an order comes in')).toBeNull();
  });

  it('a scoped role sees the closed door and never asks the server', async () => {
    /* A content writer holds neither `settings` nor the admin tier, so the
       PATCH would 403 and the GET is gated on the same prefix. Rendering a
       screen of controls that all refuse is worse than saying so once. */
    fixture.session.user.role = 'writer';
    withSettings(() => rowOf());
    mount();

    expect(screen.getByText('Only the owner and developers can change this')).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
