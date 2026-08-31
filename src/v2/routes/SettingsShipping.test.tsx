import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The zones screen — now `/settings/shipping`, moved whole from the one-page
 * `/settings` — pinned on the two behaviours checkout's pricing depends on
 * (CLAUDE.md's ledger for this screen):
 *
 *  - **The only fallback zone cannot be deleted, and the UI says so by
 *    ABSENCE.** Exactly one fallback must exist — the server refuses to delete
 *    or demote the last one — so the fallback's row offers no Delete at all,
 *    and its edit modal pins the fallback flag rather than letting the press
 *    bounce off a 409. The named zone keeps both controls, in the same tests,
 *    so the absence is provably the fallback's and not the menu's.
 *  - **Tax round-trips between stored bps and typed percent.** The column
 *    stores basis points; the person types a percent. A stored 750 must read
 *    as 7.5, and a typed 12.5 must travel as 1250 — each direction wrong by
 *    a factor of 100 is the failure that ships quietly.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, for the reason the rewards
 * suite gives: the path, the method and the body are the three things most
 * likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
 */

import { ToastHost } from '../ui/Toast';
import type { ShopShippingZone } from '../../data/api-shop';
/* The screen now gates on the settings domain (owner/developer) — the same
 * graceful absence Team renders. The suite drives it as the owner. */
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

import SettingsShipping from './SettingsShipping';

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

const ZONES = '/api/shop/admin/shipping-zones';

/* Zones match on the address's REGION — Lagos and the fallback are both NG —
   and exactly one fallback exists, which is the row under test. 750 bps is
   7.5%, the VAT rate migration 0560 seeded. Money in minor units. */
const namedZone: ShopShippingZone = {
  id: 'zone_lag',
  label: 'Lagos deliveries',
  countries: ['NG'],
  regions: ['Lagos'],
  taxRateBps: 750,
  taxLabel: 'VAT',
  shippingTaxable: false,
  isFallback: false,
  position: 0,
  options: [
    { id: 'opt_lag', zoneId: 'zone_lag', label: 'Standard', amountMinor: 1_000_000, estimate: '1–2 days', position: 0 },
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

function withZones(): void {
  when(ZONES, { items: [namedZone, restZone] });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/settings/shipping']}>
        <SettingsShipping />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** Open a zone row's ⋯ menu and hand back the portaled panel. */
async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  zoneLabel: string,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${zoneLabel}` }));
  return screen.findByRole('menu');
}

// ============================================================================

describe('the zones screen', () => {
  it('offers no Delete on the only fallback zone’s row', async () => {
    const user = userEvent.setup();
    withZones();
    mount();

    const fallbackMenu = await openMenu(user, 'Everywhere else');
    /* The menu rendered — Edit and Delivery options are there — so the missing
       Delete is a decision, not an empty panel. */
    expect(within(fallbackMenu).getByRole('menuitem', { name: /Edit zone/ })).toBeTruthy();
    expect(within(fallbackMenu).getByRole('menuitem', { name: /Delivery options/ })).toBeTruthy();
    /* ABSENT, not disabled: the server refuses to delete the last fallback,
       and a control in front of a guaranteed 409 is a promise nobody keeps. */
    expect(within(fallbackMenu).queryByRole('menuitem', { name: /Delete zone/ })).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    // The named zone still offers it — the absence is the fallback's alone.
    const namedMenu = await openMenu(user, 'Lagos deliveries');
    expect(within(namedMenu).getByRole('menuitem', { name: /Delete zone/ })).toBeTruthy();
  });

  it('pins the fallback flag in the only fallback’s edit modal', async () => {
    const user = userEvent.setup();
    withZones();
    when(`${ZONES}/${restZone.id}`, (_url, init) => ({
      body: { zone: { ...restZone, ...(JSON.parse(String(init.body)) as object) } },
    }));
    mount();

    const menu = await openMenu(user, 'Everywhere else');
    await user.click(within(menu).getByRole('menuitem', { name: /Edit zone/ }));

    const modal = await screen.findByRole('dialog', { name: 'Edit Everywhere else' });
    const flag = within(modal).getByRole('checkbox', {
      name: /Fallback zone/,
    }) as HTMLInputElement;
    expect(flag.checked).toBe(true);
    // The hint says WHY the press will not take, before it is tried.
    expect(modal.textContent).toContain(
      'This is the only fallback — every store needs exactly one, so the flag stays on.',
    );

    // The press bounces off the pin, not off a 409 later.
    await user.click(flag);
    expect(
      (within(modal).getByRole('checkbox', { name: /Fallback zone/ }) as HTMLInputElement).checked,
    ).toBe(true);

    await user.click(within(modal).getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(bodiesOf(`${ZONES}/${restZone.id}`, 'PATCH')).toHaveLength(1));
    /* KEY BY KEY, and `isFallback: true` even after the uncheck was attempted —
       the pin holds at the wire, where it matters. */
    expect(bodiesOf(`${ZONES}/${restZone.id}`, 'PATCH')[0]).toEqual({
      label: 'Everywhere else',
      regions: [],
      taxRateBps: 750,
      taxLabel: 'VAT',
      shippingTaxable: false,
      isFallback: true,
    });
  });

  it('round-trips tax between stored bps and typed percent', async () => {
    const user = userEvent.setup();
    withZones();
    when(`${ZONES}/${namedZone.id}`, (_url, init) => ({
      body: { zone: { ...namedZone, ...(JSON.parse(String(init.body)) as object) } },
    }));
    mount();

    // A stored 750 bps reads as a percent in the table…
    const title = await screen.findByText('Lagos deliveries');
    const row = title.closest('tr');
    if (row === null) throw new Error('no row for Lagos deliveries');
    expect(within(row as HTMLElement).getByText(/7\.50%/)).toBeTruthy();

    const menu = await openMenu(user, 'Lagos deliveries');
    await user.click(within(menu).getByRole('menuitem', { name: /Edit zone/ }));
    const modal = await screen.findByRole('dialog', { name: 'Edit Lagos deliveries' });

    // …and as the digits in the modal's own box — never the raw 750.
    const tax = within(modal).getByLabelText('Tax rate') as HTMLInputElement;
    expect(tax.value).toBe('7.5');

    // A typed percent travels as basis points: 12.5 → 1250, exactly.
    await user.clear(tax);
    await user.type(tax, '12.5');
    await user.click(within(modal).getByRole('button', { name: 'Save zone' }));

    await waitFor(() => expect(bodiesOf(`${ZONES}/${namedZone.id}`, 'PATCH')).toHaveLength(1));
    expect(bodiesOf(`${ZONES}/${namedZone.id}`, 'PATCH')[0]).toEqual({
      label: 'Lagos deliveries',
      regions: ['Lagos'],
      taxRateBps: 1250,
      taxLabel: 'VAT',
      shippingTaxable: false,
      isFallback: false,
    });
  });
});
