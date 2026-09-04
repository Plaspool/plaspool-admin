import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The v2 marketing screen, pinned on the three things it can get wrong quietly.
 *
 *  - **The redemption rate is an integer rational and the money half crosses
 *    the wire in MINOR UNITS.** The operator types naira; the client multiplies
 *    by 100 once, on commit. Off by that factor in either direction is a
 *    checkout that prices points at a hundredth — or a hundred times — what the
 *    owner set, so the round trip is asserted whole: stored minor renders back
 *    as the typed naira, typed naira lands as minor units, and the server's
 *    echo renders back again.
 *  - **`insufficient_balance` lands beside the delta, not as a toast.** The
 *    ledger's column refuses a debit below zero with a 409; the refusal has to
 *    arrive where the number was typed, with the typed number still in the box,
 *    because the fix is to type a smaller one.
 *  - **A programme's `key` exists at create and never again.** The ledger's
 *    rows point at it, so the create modal offers the field, the edit modal
 *    shows it read-only, and the PATCH body structurally cannot carry `key` or
 *    `kind` — a rename moves the words and never the identity.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-marketing`: the path, the method and
 * the body are the three things most likely to be silently wrong against a
 * backend written in another session, and a mocked module asserts none of them.
 */

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
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
import { capsProgram, programs, settings } from '../../data/marketing-fixtures';
import Marketing from './Marketing';

/**
 * What jsdom does not implement and the v2 chrome touches. `ResizeObserver` is
 * the load-bearing one: `TableScroll` observes its scroller on mount, so
 * without it the programmes table never renders.
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

const asked = (fragment: string): string | undefined =>
  calls.find((c) => c.path.includes(fragment))?.path;

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
  // Reveal panels and column choices are remembered per browser session; a
  // test must not inherit the previous test's arrangement.
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

const PROGRAMS = '/api/marketing/programs';
const SETTINGS = '/api/marketing/settings';
const ADJUSTMENTS = '/api/marketing/adjustments';

function withPrograms(rows = programs): void {
  when(PROGRAMS, { programs: rows });
}

/** The settings GET, and the PATCH that shares its path. */
function withSettings(row = settings, write?: Responder): void {
  when(SETTINGS, (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { settings: row } }
      : (write ?? (() => ({ body: { settings: { ...row, revision: row.revision + 1 } } })))(
          url,
          init,
        ),
  );
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/marketing']}>
        <Marketing />
      </MemoryRouter>
    </ToastHost>,
  );
}

/**
 * The programmes table, once it has landed. The skeleton's table is inside an
 * `aria-hidden` wrapper, so the role query resolves only when rows exist —
 * and scoping row lookups through it matters because the redemption card
 * repeats the default programme's NAME in its own defs.
 */
const table = (): Promise<HTMLElement> => screen.findByRole('table');

const retype = async (
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  value: string,
): Promise<void> => {
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};

// ============================================================================

describe('the marketing screen', () => {
  it('round-trips the redemption rate: stored minor units render as naira, typed naira travels as minor units', async () => {
    const user = userEvent.setup();
    withPrograms();
    // 100 points are worth 500 minor units — ₦5.00 at 100 per naira.
    withSettings(settings, () => ({
      body: { settings: { ...settings, redemptionRateMinor: 75000, revision: 5 } },
    }));
    mount();
    await table();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByRole('dialog', { name: 'How points are spent' });

    // Stored minor → typed naira: 500 opens as "5.00", never "500" or "0.05".
    expect(screen.getByLabelText('How much money')).toHaveProperty('value', '5.00');
    expect(screen.getByLabelText('How many points')).toHaveProperty('value', '100');

    await retype(user, screen.getByLabelText('How much money'), '750');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(asked(SETTINGS)).toBeTruthy());
    // KEY BY KEY: the money half crossed at ×100, the points half as typed,
    // and everything else exactly as the form held it.
    expect(sent(SETTINGS, 'PATCH')).toEqual({
      expectedRevision: settings.revision,
      redemptionEnabled: true,
      redemptionRatePoints: 100,
      redemptionRateMinor: 75000,
      minRedeemPoints: 50,
      maxRedeemBps: 5000,
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      defaultReturnProgramId: capsProgram.id,
    });

    // The server's echo closes the loop: reopened, the stored 75000 minor
    // units render back as the same naira that was typed.
    await screen.findByText('Spending settings saved');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText('How much money')).toHaveProperty('value', '750.00');
    expect(screen.getByLabelText('How many points')).toHaveProperty('value', '100');
  });

  it('surfaces insufficient_balance beside the delta, with the typed debit kept — never a toast', async () => {
    const user = userEvent.setup();
    withPrograms();
    withSettings();
    // The column's own refusal: a debit below zero, named by code.
    when(ADJUSTMENTS, { error: 'insufficient_balance', balance: 20, requestId: 'req_low' }, 409);
    mount();
    await table();

    await user.click(screen.getByRole('button', { name: 'Credit a customer…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add points by hand' });

    await user.type(within(dialog).getByLabelText('Customer email'), 'dara@example.com');
    await user.type(within(dialog).getByLabelText('Points'), '-500');
    await user.type(
      within(dialog).getByLabelText('Reason (optional)'),
      'Fixing a double credit',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save entry' }));

    await waitFor(() => expect(asked(ADJUSTMENTS)).toBeTruthy());
    expect(sent(ADJUSTMENTS, 'POST')).toEqual({
      email: 'dara@example.com',
      delta: -500,
      reason: 'Fixing a double credit',
    });

    // The refusal is the SPECIFIC sentence for this code — proof the branch
    // ran rather than the generic fallback — and it renders inside the modal,
    // in the same form block as the delta it is about.
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toBe(
      'That would take their balance below zero.',
    );
    expect(alert.closest('.stack')).toBe(
      within(dialog).getByLabelText('Points').closest('.stack'),
    );

    // Not a toast, not a dismissal: the modal stays up with the number still
    // in the box, because the fix is to type a smaller one.
    expect(document.querySelector('.toast')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Add points by hand' })).toBeTruthy();
    expect(within(dialog).getByLabelText('Points')).toHaveProperty('value', '-500');
  });

  it('offers the programme key only at create; the edit modal shows it read-only and the patch never carries it', async () => {
    const user = userEvent.setup();
    withPrograms();
    withSettings();
    when(`${PROGRAMS}/${capsProgram.id}`, {
      program: { ...capsProgram, name: 'Deposit Scheme', revision: 2 },
    });
    mount();
    const grid = await table();

    // CREATE: the two things that can never change later exist only here.
    await user.click(screen.getByRole('button', { name: 'New programme' }));
    const create = await screen.findByRole('dialog', { name: 'New programme' });
    expect(within(create).getByLabelText('ID code')).toBeTruthy();
    expect(within(create).getByRole('group', { name: 'Type' })).toBeTruthy();
    await user.click(within(create).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // EDIT: no key box, no kind switch — the handle is read-only prose.
    await user.click(within(grid).getByText('Canister Returns'));
    const edit = await screen.findByRole('dialog', { name: 'Edit Canister Returns' });
    expect(within(edit).queryByLabelText('ID code')).toBeNull();
    expect(within(edit).queryByRole('group', { name: 'Type' })).toBeNull();
    expect(within(edit).getByText(capsProgram.key)).toBeTruthy();
    expect(within(edit).getByText(/The type and ID code can’t be changed/)).toBeTruthy();

    await retype(user, within(edit).getByLabelText('Name'), 'Deposit Scheme');
    await user.click(within(edit).getByRole('button', { name: 'Save programme' }));

    await waitFor(() => expect(asked(`${PROGRAMS}/${capsProgram.id}`)).toBeTruthy());
    const body = sent(`${PROGRAMS}/${capsProgram.id}`, 'PATCH');
    expect(body).toEqual({
      expectedRevision: capsProgram.revision,
      name: 'Deposit Scheme',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      pointsPerUnit: 7,
      minUnitsPerReturn: 4,
      // 0920's two money rates, sent on every unit-return patch — including
      // when they are unchanged, because a PATCH that omitted them could not
      // express "clear this rate" and a cleared rate must be undoable.
      unitCostMinor: capsProgram.unitCostMinor,
      unitMarketCostMinor: capsProgram.unitMarketCostMinor,
    });
    // Said twice on purpose: `toEqual` would still pass if the type ever
    // gained one of these and the fixture gained it too.
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('kind');

    await screen.findByText('Deposit Scheme saved');
  });
});
