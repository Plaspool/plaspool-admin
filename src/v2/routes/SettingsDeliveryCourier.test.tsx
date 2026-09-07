import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * DELIVERY COURIER — `/settings/delivery-courier`, the screen that decides who
 * carries a parcel and therefore whether pressing Book spends real money.
 *
 * Three behaviours are pinned here because each of them, wrong, is expensive
 * rather than merely ugly:
 *
 *  - **The Terminal warning modal GATES the PATCH.** Terminal books real
 *    couriers against a real wallet, and the owner's rule (spec §5.3) is that
 *    nobody switches it on without first reading what it needs. So selecting
 *    the card sends NOTHING: the choice does not even move until the modal is
 *    confirmed, and backing out leaves By hand selected. A modal that merely
 *    narrates a save that already happened is not a warning.
 *  - **A courier with no credentials is a DISABLED card that names its env
 *    vars.** The server would answer `provider_not_configured`, but a switch
 *    that flips and then bounces teaches nothing; the card says which variables
 *    the deployment is missing, which is the only action that fixes it.
 *  - **Terminal without a ship-from address is refused HERE, before the
 *    request.** The server refuses it too (409 `ship_from_incomplete`), and
 *    that stays the authority — but the fields are on screen, so the round trip
 *    buys nothing and the refusal reads better attached to the form.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 *
 * NO `@testing-library/jest-dom` IN THIS REPO (see `QtyStepper.test.tsx`), so
 * the text assertions read `.textContent` rather than `toHaveTextContent` — an
 * unknown matcher here is an "Invalid Chai property", not a failing assertion.
 */

import { ToastHost } from '../ui/Toast';
/* The screen gates on the settings domain (owner/developer) — the same
 * graceful absence Team and Shipping render. The suite drives it as the owner. */
const sessionFixture = {
  session: {
    status: 'authed' as const,
    user: {
      id: 'u_owner',
      email: 'owner@plaspool.com',
      displayName: 'Owner',
      role: 'owner' as import('../../../shared/roles').Role,
    },
  },
};

vi.mock('../../data/session', () => ({
  getSession: () => sessionFixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));

import SettingsDeliveryCourier from './SettingsDeliveryCourier';

/**
 * What jsdom does not implement and the shared table/menu chrome needs the
 * moment it mounts — the same three blocks `MarketingRewards.test.tsx` and the
 * returns suites carry, plus the `<dialog>` shim for parity with them.
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

/** Every body sent to this exact path with this method, oldest first. */
const bodiesOf = (pathname: string, method: string): Record<string, unknown>[] =>
  calls
    .filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === method)
    .map((c) => JSON.parse(String(c.init.body)) as Record<string, unknown>);

beforeEach(() => {
  handlers.clear();
  calls = [];
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
  vi.restoreAllMocks();
});

// -------------------------------------------------------------- the harness

const SETTINGS = '/api/shop/admin/logistics/settings';
const REGISTER = '/api/shop/admin/logistics/webhooks/register';

const baseSettings = {
  provider: 'manual',
  shipFrom: null,
  packaging: { name: 'Spool box', lengthCm: 22, widthCm: 22, heightCm: 8, weightKg: 0.25 },
  revision: 3,
  updatedAt: 1_757_000_000_000,
  providers: {
    fez: { configured: true, environment: 'sandbox', webhookUrl: 'https://admin.dev.plaspool.com/api/shop/logistics/fez/webhook' },
    terminal: { configured: true, environment: 'sandbox', webhookUrl: 'https://admin.dev.plaspool.com/api/shop/logistics/terminal/webhook' },
  },
  variantsMissingWeight: 7,
  variantsTotal: 12,
  recentWebhooks: [],
};

const shipFrom = {
  name: 'PlaSpool', phone: '+2348012345678', email: 'ops@plaspool.com', line1: '12 Recycle Way',
  city: 'Gwarinpa', region: 'FCT', postalCode: '900108', countryCode: 'NG',
};

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/delivery-courier']}>
        <SettingsDeliveryCourier />
      </MemoryRouter>
    </ToastHost>,
  );
}

async function fillShipFrom(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Name'), shipFrom.name);
  await user.type(screen.getByLabelText('Phone'), shipFrom.phone);
  await user.type(screen.getByLabelText('Email'), shipFrom.email);
  await user.type(screen.getByLabelText('Address line 1'), shipFrom.line1);
  await user.type(screen.getByLabelText('City'), shipFrom.city);
  await user.type(screen.getByLabelText('State'), shipFrom.region);
  await user.type(screen.getByLabelText('Postal code'), shipFrom.postalCode);
}

describe('Settings → Delivery courier', () => {
  it('shows the three choices with By hand selected and each courier’s environment', async () => {
    when(SETTINGS, baseSettings);
    mount();
    const group = await screen.findByRole('radiogroup', { name: 'Courier' });
    expect(within(group).getByRole('radio', { name: /By hand/ })).toBeTruthy();
    expect((within(group).getByRole('radio', { name: /By hand/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(group).getByRole('radio', { name: /Fez Delivery/ })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: /Terminal Africa/ })).toBeTruthy();
    expect(screen.getAllByText(/Sandbox · connected/).length).toBe(2);
  });

  it('switches a courier card off when the server has no credentials, and says which env vars', async () => {
    when(SETTINGS, { ...baseSettings, providers: { ...baseSettings.providers, terminal: { configured: false, environment: 'sandbox', webhookUrl: 'x' } } });
    mount();
    const radio = (await screen.findByRole('radio', { name: /Terminal Africa/ })) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText(/add TERMINAL_SECRET_KEY, then redeploy/)).toBeTruthy();
  });

  it('saves Fez with the expected revision and the ship-from address', async () => {
    const user = userEvent.setup();
    when(SETTINGS, (_url, init) =>
      (init.method ?? 'GET') === 'PATCH'
        ? { body: { ...baseSettings, provider: 'fez', shipFrom, revision: 4 } }
        : { body: baseSettings },
    );
    mount();
    await user.click(await screen.findByRole('radio', { name: /Fez Delivery/ }));
    await fillShipFrom(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(SETTINGS, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(SETTINGS, 'PATCH')[0]).toEqual({
      expectedRevision: 3,
      provider: 'fez',
      shipFrom,
      packaging: baseSettings.packaging,
    });
    expect(await screen.findByText('Delivery courier saved')).toBeTruthy();
  });

  it('puts a warning modal in front of Terminal and sends NOTHING until it is confirmed', async () => {
    const user = userEvent.setup();
    when(SETTINGS, (_url, init) =>
      (init.method ?? 'GET') === 'PATCH'
        ? { body: { ...baseSettings, provider: 'terminal', shipFrom, revision: 4 } }
        : { body: baseSettings },
    );
    mount();
    await user.click(await screen.findByRole('radio', { name: /Terminal Africa/ }));
    const modal = await screen.findByRole('dialog', { name: 'Before you switch on Terminal Africa' });
    expect(within(modal).getByText(/7 of 12 have none/)).toBeTruthy();
    expect(bodiesOf(SETTINGS, 'PATCH')).toHaveLength(0);

    // Backing out leaves By hand selected.
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
    expect((screen.getByRole('radio', { name: /By hand/ }) as HTMLInputElement).checked).toBe(true);

    // Confirming selects Terminal; Save then sends provider: 'terminal'.
    await user.click(screen.getByRole('radio', { name: /Terminal Africa/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Before you switch on Terminal Africa' })).getByRole('button', { name: 'Switch to Terminal' }));
    expect((screen.getByRole('radio', { name: /Terminal Africa/ }) as HTMLInputElement).checked).toBe(true);
    await fillShipFrom(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodiesOf(SETTINGS, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(SETTINGS, 'PATCH')[0]).toMatchObject({ expectedRevision: 3, provider: 'terminal' });
  });

  it('refuses Terminal client-side while the ship-from address is empty', async () => {
    const user = userEvent.setup();
    when(SETTINGS, baseSettings);
    mount();
    await user.click(await screen.findByRole('radio', { name: /Terminal Africa/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch to Terminal' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Fill in the ship-from address before switching to Terminal Africa.',
    );
    expect(bodiesOf(SETTINGS, 'PATCH')).toHaveLength(0);
  });

  it('explains a stale revision instead of a code', async () => {
    const user = userEvent.setup();
    when(SETTINGS, (_url, init) =>
      (init.method ?? 'GET') === 'PATCH' ? { status: 409, body: { error: 'stale_write', expected: 3, actual: 4 } } : { body: baseSettings },
    );
    mount();
    await user.click(await screen.findByRole('radio', { name: /Fez Delivery/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone else changed this — reload and try again.',
    );
  });

  it('connects a webhook and lists recent updates', async () => {
    const user = userEvent.setup();
    when(SETTINGS, {
      ...baseSettings,
      provider: 'fez',
      recentWebhooks: [
        { id: 'wh_1', provider: 'fez', providerRef: 'ASAC27012319', rawStatus: 'Dispatched', verified: true, applied: 'applied', receivedAt: Date.now() - 60_000 },
      ],
    });
    when(REGISTER, { ok: true });
    mount();
    expect(await screen.findByText('ASAC27012319')).toBeTruthy();
    expect(screen.getByText('Dispatched')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect webhook for Fez Delivery' }));
    await waitFor(() => expect(bodiesOf(REGISTER, 'POST')).toEqual([{ provider: 'fez' }]));
    expect(await screen.findByText('Fez Delivery will now send updates here')).toBeTruthy();
  });

  it('refuses a role without the settings domain', async () => {
    sessionFixture.session = { ...sessionFixture.session, user: { ...sessionFixture.session.user, role: 'supply_chain' as never } };
    when(SETTINGS, baseSettings);
    mount();
    expect(await screen.findByText('Only the owner and developers can change this')).toBeTruthy();
    expect(calls.filter((c) => c.path.startsWith(SETTINGS))).toHaveLength(0);
    sessionFixture.session = { ...sessionFixture.session, user: { ...sessionFixture.session.user, role: 'owner' as never } };
  });
});
