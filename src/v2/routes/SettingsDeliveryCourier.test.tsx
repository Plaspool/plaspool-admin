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
const DIAG = '/api/shop/admin/logistics/diagnostics';

const baseSettings = {
  provider: 'manual',
  shipFrom: null,
  packaging: { name: 'Spool box', lengthCm: 22, widthCm: 22, heightCm: 8, weightKg: 0.25 },
  revision: 3,
  updatedAt: 1_757_000_000_000,
  providers: {
    fez: { configured: true, webhookReady: true, environment: 'sandbox', webhookUrl: 'https://admin.dev.plaspool.com/api/shop/logistics/fez/webhook' },
    terminal: { configured: true, webhookReady: true, environment: 'sandbox', webhookUrl: 'https://admin.dev.plaspool.com/api/shop/logistics/terminal/webhook' },
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

  /*
   * "Connected" is two facts. Fez books with FEZ_USER_ID + FEZ_PASSWORD but
   * VERIFIES its callbacks with FEZ_SECRET_KEY, so a deployment holding only
   * the first two can send parcels and can never hear back — and the card used
   * to say "Sandbox · connected" and offer Connect webhook regardless.
   */
  it('says when a courier can be booked but cannot report back, and refuses to Connect', async () => {
    when(SETTINGS, {
      ...baseSettings,
      providers: {
        ...baseSettings.providers,
        fez: { ...baseSettings.providers.fez, webhookReady: false },
      },
    });
    mount();
    expect(
      await screen.findByText(
        'Bookings will work, but Fez cannot send status updates until FEZ_SECRET_KEY is set on this server.',
      ),
    ).toBeTruthy();
    /* Booking still works, so the card is NOT switched off and both couriers
       still read as connected — this warning is about the other direction. */
    expect((screen.getByRole('radio', { name: /Fez Delivery/ }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByText(/Sandbox · connected/).length).toBe(2);

    expect((screen.getByRole('button', { name: 'Connect webhook for Fez Delivery' }) as HTMLButtonElement).disabled).toBe(true);
    /* Terminal's one key does both jobs, so it is untouched. */
    expect((screen.getByRole('button', { name: 'Connect webhook for Terminal Africa' }) as HTMLButtonElement).disabled).toBe(false);
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

  it('keeps what you have typed when you connect a webhook, and still refreshes the list', async () => {
    const user = userEvent.setup();
    /* The second read carries a row the first did not: pressing Connect has
       to pick that up WITHOUT re-adopting the form the operator is mid-way
       through — the ship-from address is usually the reason they came here. */
    let reads = 0;
    when(SETTINGS, () => ({
      body:
        reads++ === 0
          ? baseSettings
          : {
              ...baseSettings,
              recentWebhooks: [
                { id: 'wh_1', provider: 'fez', providerRef: 'ASAC27012319', rawStatus: 'Dispatched', verified: true, applied: 'applied', receivedAt: 1_757_000_000_000 },
              ],
            },
    }));
    when(REGISTER, { ok: true });
    mount();
    await user.type(await screen.findByLabelText('Name'), shipFrom.name);
    await user.click(screen.getByRole('button', { name: 'Connect webhook for Fez Delivery' }));

    await waitFor(() => expect(bodiesOf(REGISTER, 'POST')).toEqual([{ provider: 'fez' }]));
    expect(await screen.findByText('ASAC27012319')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(shipFrom.name);
  });

  /**
   * ═════════════════════════════════════════════════════════════════════════
   * TEST THIS COURIER — the four questions that used to need a throwaway
   * script, as four buttons.
   *
   * `POST /admin/logistics/diagnostics` answers **200 for a refusal**: a
   * courier saying no is what the operator pressed the button to find out, so
   * every outcome below is rendered, none of them is an error banner about the
   * request, and nothing here retries.
   *
   * The one that earns the panel is the price check. Terminal accepts 46
   * cities in Lagos and 10 in Abuja and refuses every other name — so a real
   * Abuja order is usually refused, and until now the only way to discover the
   * list was to fail a live booking. The refusal is printed VERBATIM and the
   * names Terminal offered are printed under it: that is how an operator
   * learns "Gwarinpa" is not a city here and "Maitama" is.
   * ═════════════════════════════════════════════════════════════════════════
   */
  describe('Test this courier', () => {
    /** A saved, switched-on Terminal — the panel only appears for a courier that is set up. */
    const onTerminal = { ...baseSettings, provider: 'terminal', shipFrom };

    it('asks the courier whether the credentials work, and prints what it said', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, {
        check: 'connection',
        ok: true,
        summary: 'Terminal Africa accepted the credentials (sandbox).',
        detail: { provider: 'terminal', environment: 'sandbox', response: { probe: 'GET /webhooks', webhooks: 2 } },
      });
      mount();
      await user.click(await screen.findByRole('button', { name: 'Check the connection' }));

      await waitFor(() => expect(bodiesOf(DIAG, 'POST')).toHaveLength(1));
      expect(bodiesOf(DIAG, 'POST')[0]).toEqual({ check: 'connection', provider: 'terminal' });
      const out = await screen.findByRole('status', { name: 'Check the connection — result' });
      await waitFor(() =>
        expect(out.textContent).toContain('Terminal Africa accepted the credentials (sandbox).'),
      );
    });

    it('prices a made-up address and lists what came back', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, {
        check: 'quote',
        ok: true,
        summary: '2 options, cheapest ₦3,676.90 (GIG Logistics)',
        detail: {
          provider: 'terminal',
          weightKg: 1.5,
          shipmentId: 'SH-1',
          options: [
            { id: 'RT-1', carrier: 'GIG Logistics', label: 'GIG Logistics · Standard', amountMinor: 367690, currency: 'NGN', eta: '2 days' },
            { id: 'RT-2', carrier: 'Kwik Delivery', label: 'Kwik Delivery · Same day', amountMinor: 520000, currency: 'NGN', eta: 'Today' },
          ],
        },
      });
      mount();
      await user.type(await screen.findByLabelText('Test address line'), '1 Test Close');
      await user.type(screen.getByLabelText('Test city'), 'Maitama');
      await user.type(screen.getByLabelText('Test postal code'), '900001');
      await user.type(screen.getByLabelText('Test weight in grams'), '1500');
      await user.click(screen.getByRole('button', { name: 'Ask for a test price' }));

      await waitFor(() => expect(bodiesOf(DIAG, 'POST')).toHaveLength(1));
      /* The state defaults from the ship-from address the shop actually saved,
         because that is the half of the pair the courier prices against. */
      expect(bodiesOf(DIAG, 'POST')[0]).toEqual({
        check: 'quote',
        provider: 'terminal',
        to: { line1: '1 Test Close', city: 'Maitama', region: 'FCT', postalCode: '900001' },
        weightGrams: 1500,
      });

      const out = await screen.findByRole('status', { name: 'Ask for a test price — result' });
      expect(await within(out).findByText('GIG Logistics · Standard')).toBeTruthy();
      expect(within(out).getByText('₦3,676.90')).toBeTruthy();
      expect(within(out).getByText('₦5,200.00')).toBeTruthy();
      expect(within(out).getByText('2 days')).toBeTruthy();
    });

    it('prints a refusal in the courier’s own words, with the names it will accept', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, {
        check: 'quote',
        ok: false,
        summary: 'Delivery Address - Invalid city, please select a city from the list of cities',
        detail: {
          provider: 'terminal',
          weightGrams: 1000,
          code: 'provider_rejected',
          status: 400,
          accepted: ['Abaji', 'Bwari', 'Gwagwalada', 'Maitama'],
        },
      });
      mount();
      await user.type(await screen.findByLabelText('Test address line'), '1 Test Close');
      await user.type(screen.getByLabelText('Test city'), 'Gwarinpa');
      await user.click(screen.getByRole('button', { name: 'Ask for a test price' }));

      await waitFor(() => expect(bodiesOf(DIAG, 'POST')).toHaveLength(1));
      expect(bodiesOf(DIAG, 'POST')[0]).toEqual({
        check: 'quote',
        provider: 'terminal',
        to: { line1: '1 Test Close', city: 'Gwarinpa', region: 'FCT' },
      });

      const out = await screen.findByRole('status', { name: 'Ask for a test price — result' });
      await waitFor(() =>
        expect(out.textContent).toContain(
          'Delivery Address - Invalid city, please select a city from the list of cities',
        ),
      );
      /* THE WHOLE POINT OF THE CHECK: the names nobody could otherwise find. */
      expect(within(out).getByText('Maitama')).toBeTruthy();
      expect(within(out).getByText('Gwagwalada')).toBeTruthy();
    });

    it('signs an update the way the courier would and posts it at our own address', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, {
        check: 'webhook_self_test',
        ok: false,
        summary: 'Your webhook address refused a correctly signed update (401 bad_signature).',
        detail: { provider: 'terminal', url: 'https://admin.dev.plaspool.com/api/shop/logistics/terminal/webhook', status: 401 },
      });
      mount();
      await user.click(await screen.findByRole('button', { name: 'Send a test update to this admin' }));

      await waitFor(() => expect(bodiesOf(DIAG, 'POST')).toHaveLength(1));
      expect(bodiesOf(DIAG, 'POST')[0]).toEqual({ check: 'webhook_self_test', provider: 'terminal' });
      const out = await screen.findByRole('status', { name: 'Send a test update to this admin — result' });
      await waitFor(() =>
        expect(out.textContent).toContain(
          'Your webhook address refused a correctly signed update (401 bad_signature).',
        ),
      );
    });

    /* `provider_simulate` names a draft shipment, and the only place to get one
       is a price check that succeeded — so the button cannot be pressed before
       there is something to press it about. */
    it('keeps “Ask the courier to send one” disabled until a test price has produced a draft', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, (_url, init) =>
        (JSON.parse(String(init.body)) as { check: string }).check === 'quote'
          ? {
              body: {
                check: 'quote',
                ok: true,
                summary: '1 option, cheapest ₦3,500.00 (GIG Logistics)',
                detail: {
                  provider: 'terminal',
                  shipmentId: 'SH-1',
                  options: [{ id: 'RT-1', carrier: 'GIG Logistics', label: 'GIG Logistics · Standard', amountMinor: 350000, currency: 'NGN' }],
                },
              },
            }
          : {
              body: {
                check: 'provider_simulate',
                ok: false,
                summary: 'Terminal Africa queued the simulation, but its delivery log answered: An unknown error occurred, please try again',
                detail: {
                  provider: 'terminal',
                  shipmentId: 'SH-1',
                  simulate: { ok: true, message: 'Webhook simulation queued' },
                  deliveries: { ok: false, message: 'An unknown error occurred, please try again', count: null },
                },
              },
            },
      );
      mount();
      const simulate = (await screen.findByRole('button', { name: 'Ask the courier to send one' })) as HTMLButtonElement;
      expect(simulate.disabled).toBe(true);

      await user.type(screen.getByLabelText('Test address line'), '1 Test Close');
      await user.type(screen.getByLabelText('Test city'), 'Maitama');
      await user.click(screen.getByRole('button', { name: 'Ask for a test price' }));
      await waitFor(() => expect(simulate.disabled).toBe(false));

      await user.click(simulate);
      await waitFor(() => expect(bodiesOf(DIAG, 'POST')).toHaveLength(2));
      expect(bodiesOf(DIAG, 'POST')[1]).toEqual({
        check: 'provider_simulate',
        provider: 'terminal',
        shipmentId: 'SH-1',
      });

      /* BOTH LEGS. The pair — "queued" from the simulator and an error from
         their own delivery log — is the evidence for the support ticket, and
         either half alone reads as the opposite of the truth. */
      const out = await screen.findByRole('status', { name: 'Ask the courier to send one — result' });
      await waitFor(() => expect(out.textContent).toContain('Webhook simulation queued'));
      expect(out.textContent).toContain('An unknown error occurred, please try again');
    });

    /* Not a diagnostic outcome at all — a request that cannot be run. The
       fields it is about are on THIS screen, so it says so and marks them. */
    it('points a price check with no ship-from address at the card above', async () => {
      const user = userEvent.setup();
      when(SETTINGS, { ...baseSettings, provider: 'terminal', shipFrom: { ...shipFrom, postalCode: '' } });
      when(DIAG, () => ({ status: 409, body: { error: 'ship_from_incomplete', missing: ['postalCode'] } }));
      mount();
      await user.type(await screen.findByLabelText('Test address line'), '1 Test Close');
      await user.type(screen.getByLabelText('Test city'), 'Maitama');
      await user.click(screen.getByRole('button', { name: 'Ask for a test price' }));

      const out = await screen.findByRole('status', { name: 'Ask for a test price — result' });
      await waitFor(() => expect(out.textContent).toContain('ship-from address'));
      /* Marked on the field itself, not merely named in a sentence. */
      expect(screen.getByLabelText('Postal code').getAttribute('aria-invalid')).toBe('true');
    });

    it('names the missing env vars when the courier is not set up on this server', async () => {
      const user = userEvent.setup();
      when(SETTINGS, onTerminal);
      when(DIAG, () => ({ status: 409, body: { error: 'provider_not_configured', provider: 'terminal' } }));
      mount();
      await user.click(await screen.findByRole('button', { name: 'Check the connection' }));
      const out = await screen.findByRole('status', { name: 'Check the connection — result' });
      await waitFor(() => expect(out.textContent).toContain('TERMINAL_SECRET_KEY'));
    });

    it('offers nothing to test while the shop ships by hand', async () => {
      when(SETTINGS, baseSettings);
      mount();
      await screen.findByRole('radiogroup', { name: 'Courier' });
      expect(screen.queryByRole('button', { name: 'Check the connection' })).toBeNull();
    });
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
