import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The per-district delivery board, pinned on the two wire behaviours checkout
 * prices real orders by (CLAUDE.md's ledger for this screen):
 *
 *  - **`rateMinor: null` clears the override while an ABSENT key leaves it.**
 *    The server's PUT treats the two differently on purpose — `null` means
 *    "back to the state's zone rate", a missing key means "don't touch it" —
 *    and JSON is the only layer where that distinction can quietly die
 *    (`undefined` serialises to nothing). So BOTH saves are asserted key by
 *    key: the delivers flip must not carry `rateMinor` at all, and the clear
 *    must carry a real `null`.
 *  - **A CAS miss re-reads the board instead of retrying blind.** The 409
 *    means another tab moved the row; the only honest recovery is a fresh
 *    read, never the same write again with a guessed revision.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 */

import { ToastHost } from '../ui/Toast';
import type { ShopDeliveryArea, ShopShippingZone } from '../../data/api-shop';
import type { ServiceArea } from '../../data/api-marketing';
import DeliveryAreas from './DeliveryAreas';

/**
 * What jsdom does not implement and the shared table chrome needs the moment
 * it mounts — the same three blocks `MarketingRewards.test.tsx` and the
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

/** GETs of exactly this path — the re-read counter. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

const AREAS = '/api/marketing/areas';
const DELIVERY = '/api/shop/admin/delivery-areas';
const ZONES = '/api/shop/admin/shipping-zones';

const district = (key: string, name: string): ServiceArea => ({
  id: `area_${key}`,
  key,
  region: 'Lagos',
  name,
  active: true,
  seeded: false,
  revision: 1,
  needsAction: 0,
  open: 0,
  loadUnits: 0,
  oldestAgeMs: null,
});

const ikeja = district('ikeja', 'Ikeja');
const yaba = district('yaba', 'Yaba');

/* Zones match on the address's REGION, and exactly one fallback must exist —
   so the fixture carries both a named zone and the fallback, like the store. */
const lagosZone: ShopShippingZone = {
  id: 'zone_lag',
  label: 'Lagos zone',
  countries: ['NG'],
  regions: ['Lagos'],
  taxRateBps: 750,
  taxLabel: 'VAT',
  shippingTaxable: false,
  isFallback: false,
  position: 0,
  /* ₦10,000 in minor units — 100 per naira. */
  options: [
    { id: 'opt_std', zoneId: 'zone_lag', label: 'Standard', amountMinor: 1_000_000, estimate: '1–2 days', position: 0 },
  ],
};
const restZone: ShopShippingZone = {
  id: 'zone_rest',
  label: 'Everywhere else',
  countries: ['NG'],
  regions: [],
  taxRateBps: 750,
  taxLabel: 'VAT',
  shippingTaxable: false,
  isFallback: true,
  position: 1,
  options: [
    { id: 'opt_rest', zoneId: 'zone_rest', label: 'Standard', amountMinor: 1_000_000, estimate: '3–5 days', position: 0 },
  ],
};

function withBoard(opinions: ShopDeliveryArea[]): void {
  when(AREAS, { areas: [ikeja, yaba], outOfArea: { needsAction: 0, open: 0 } });
  when(DELIVERY, { items: opinions });
  when(ZONES, { items: [lagosZone, restZone] });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/orders/delivery']}>
        <DeliveryAreas />
      </MemoryRouter>
    </ToastHost>,
  );
}

// ============================================================================

describe('the delivery areas board', () => {
  it('clears the override with an explicit null and leaves it by omission', async () => {
    const user = userEvent.setup();
    /* Ikeja has BOTH a delivers flag and a rate override on one row — the only
       shape that can prove the two travel independently. ₦2,500, minor units. */
    let row: ShopDeliveryArea = {
      id: 'da_ik',
      areaKey: 'ikeja',
      delivers: true,
      rateMinor: 250_000,
      revision: 3,
    };
    withBoard([row]);
    when(`${DELIVERY}/ikeja`, (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      row = {
        ...row,
        ...('delivers' in body ? { delivers: body.delivers as boolean } : {}),
        ...('rateMinor' in body ? { rateMinor: body.rateMinor as number | null } : {}),
        revision: row.revision + 1,
      };
      return { body: { area: row } };
    });
    mount();

    // SAVE ONE — the delivers flip. The override key must not ride along.
    const toggle = await screen.findByRole('switch', { name: 'Delivers to Ikeja' });
    expect(toggle).toHaveProperty('checked', true);
    await user.click(toggle);

    await waitFor(() => expect(bodiesOf(`${DELIVERY}/ikeja`, 'PUT')).toHaveLength(1));
    const flip = bodiesOf(`${DELIVERY}/ikeja`, 'PUT')[0]!;
    expect(flip).toEqual({ delivers: false, expectedRevision: 3 });
    /* Said twice on purpose: an ABSENT `rateMinor` is what leaves the override
       standing, and `toEqual` alone would not survive the fixture and the
       payload gaining the key together. */
    expect(flip).not.toHaveProperty('rateMinor');
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Delivers to Ikeja' })).toHaveProperty(
        'checked',
        false,
      ),
    );

    // SAVE TWO — the clear. `null` on the wire, never a missing key.
    await user.click(screen.getByRole('button', { name: 'Delivery rate for Ikeja' }));
    await user.click(await screen.findByRole('button', { name: 'Use the state price' }));

    await waitFor(() => expect(bodiesOf(`${DELIVERY}/ikeja`, 'PUT')).toHaveLength(2));
    const clear = bodiesOf(`${DELIVERY}/ikeja`, 'PUT')[1]!;
    /* `expectedRevision: 4` is the first save's answer — the screen adopted
       the server's row rather than re-sending the revision it started with. */
    expect(clear).toEqual({ rateMinor: null, expectedRevision: 4 });
    expect(clear).toHaveProperty('rateMinor', null);
    expect(clear).not.toHaveProperty('delivers');
  });

  it('re-reads the board after a CAS miss instead of retrying blind', async () => {
    const user = userEvent.setup();
    withBoard([{ id: 'da_ik', areaKey: 'ikeja', delivers: true, rateMinor: null, revision: 3 }]);
    when(
      `${DELIVERY}/ikeja`,
      { error: 'stale_write', expected: 3, actual: 5, requestId: 'req_cas' },
      409,
    );
    mount();

    const toggle = await screen.findByRole('switch', { name: 'Delivers to Ikeja' });
    expect(reads(DELIVERY)).toBe(1);
    await user.click(toggle);

    // The miss is reported…
    await screen.findByText(/Stale write/);
    // …and answered with a FRESH READ of both halves of the join.
    await waitFor(() => expect(reads(DELIVERY)).toBe(2));
    expect(reads(AREAS)).toBe(2);
    // One write went out and none followed it — no blind retry with a guess.
    expect(bodiesOf(`${DELIVERY}/ikeja`, 'PUT')).toHaveLength(1);
    // The failed write never moved the screen: the re-read row is what shows.
    expect(screen.getByRole('switch', { name: 'Delivers to Ikeja' })).toHaveProperty(
      'checked',
      true,
    );
  });
});
