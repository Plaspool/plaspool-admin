import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The v2 returns queue, pinned on the four things it can get wrong quietly.
 *
 *  - **Rejected is DERIVED, and the derivation is what travels.** Staff type
 *    what arrived and what was accepted; the screen subtracts (spec D5). The
 *    third box exists only as a disabled readout, so "your numbers don't add
 *    up" is unrepresentable — and the body still carries `qtyRejected`,
 *    because the server records both counts. Assert the readout AND the wire.
 *  - **`already_awarded` is SUCCESS.** A 409 with that code means the first
 *    attempt landed and its response was lost, so a retried inspection must
 *    complete the flow — toast, re-read, back to the facts — and never paint
 *    an error. An implementation that lumped it in with the other 409s would
 *    tell the operator to try again against a return that is already done.
 *  - **Out-of-area rows are never offered inspect.** `allowedActions` is the
 *    server's, computed over the served set; a UI that mapped status → action
 *    would draw Inspect on any `received` row, including the one no board
 *    holds and no award may ever reach. The fixture is a `received` row whose
 *    served array says reject/cancel only — exactly the case a hardcode fails.
 *  - **The row's one button is `allowedActions[0]`.** The array is ORDERED by
 *    contract, pipeline-advancing action first; the queue renders exactly one
 *    button and it is the head of the array, not a favourite.
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
import type { ReturnDetail, ReturnListItem } from '../../data/api-marketing';
import {
  areasView,
  awardedRow,
  receivedRow,
  requestedOld,
  returnCounts,
  returnDetails,
} from '../../data/marketing-fixtures';
import Returns from './Returns';

/**
 * What jsdom does not implement and the v2 chrome touches — the same four
 * blocks the v1 suites carry. `ResizeObserver` is the load-bearing one here:
 * `TableScroll` observes its own scroller on mount, so without it the table
 * never renders at all.
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

/** GETs of exactly this path — the list and the detail share a prefix. */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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
  // The v2 chrome remembers reveals and column choices per browser session;
  // a test must not inherit the previous test's arrangement.
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

const RETURNS = '/api/marketing/returns';
const AREAS = '/api/marketing/areas';
const detailPath = (id: string): string => `${RETURNS}/${id}`;
const inspectPath = (id: string): string => `${RETURNS}/${id}/inspect`;

/** The queue's two mount-time reads: the rows and the board switcher. */
function withQueue(rows: ReturnListItem[]): void {
  when(RETURNS, { items: rows, nextCursor: null, counts: returnCounts });
  when(AREAS, areasView);
}

/** A detail that answers differently once something has been written — every
 *  transition re-reads, and the re-read is part of what these tests pin. */
function detailSequence(first: ReturnDetail, later: ReturnDetail): Responder {
  let served = 0;
  return () => ({ body: served++ === 0 ? first : later });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/orders/returns']}>
        <Returns />
      </MemoryRouter>
    </ToastHost>,
  );
}

/** The `<tr>` a customer's card sits in, once the list has landed. */
function rowOf(name: string): HTMLElement {
  const found = screen.getByText(name).closest('tr');
  if (found === null) throw new Error(`no row for ${name}`);
  return found as HTMLElement;
}

const received = returnDetails.received;

// ============================================================================

describe('the returns queue', () => {
  it('derives rejected as arrived minus accepted — a readout, not a third box — and sends the derived pair', async () => {
    const user = userEvent.setup();
    withQueue([receivedRow]);
    const done: ReturnDetail = {
      ...received,
      request: {
        ...received.request,
        status: 'awarded',
        qtyAccepted: 4,
        qtyRejected: 2,
        pointsAwarded: 28,
        revision: 5,
        allowedActions: ['note'],
      },
    };
    when(detailPath(receivedRow.id), detailSequence(received, done));
    when(inspectPath(receivedRow.id), {
      request: done.request,
      award: { points: 28, balance: 28 },
      bonus: null,
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Inspect…' }));

    // Both typed boxes open on what was declared; the readout opens on zero.
    expect(await screen.findByLabelText('Arrived')).toHaveProperty('value', '6');
    expect(screen.getByLabelText('Accepted')).toHaveProperty('value', '6');
    const rejected = screen.getByLabelText('Rejected');
    expect(rejected).toHaveProperty('value', '0');
    // NOT a third input: it is disabled, so the classic "your numbers don't
    // add up" error has nowhere to be typed.
    expect(rejected).toHaveProperty('disabled', true);

    const accepted = screen.getByLabelText('Accepted');
    await user.clear(accepted);
    await user.type(accepted, '4');

    // The screen subtracts: 6 arrived − 4 accepted = 2, nobody typed it.
    expect(screen.getByLabelText('Rejected')).toHaveProperty('value', '2');
    // …and the award restates the promised snapshot rate: 4 × 7.
    expect(screen.getByText('Awards 28 Bottle Caps')).toBeTruthy();

    await user.type(
      screen.getByLabelText('Why units were rejected (optional)'),
      'Two crushed flat',
    );
    await user.click(screen.getByRole('button', { name: 'Award points' }));

    await waitFor(() => expect(asked(inspectPath(receivedRow.id))).toBeTruthy());
    // KEY BY KEY: the derived rejected count travels beside accepted; the
    // untouched note and bonus do not travel at all.
    expect(sent(inspectPath(receivedRow.id), 'POST')).toEqual({
      expectedRevision: 4,
      qtyAccepted: 4,
      qtyRejected: 2,
      rejectedReason: 'Two crushed flat',
    });

    // The flow completes: receipt, then the re-read facts.
    await screen.findByText('Awarded 28 Bottle Caps');
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByText('4 accepted · 2 rejected');
  });

  it('treats the already_awarded 409 as success — the flow completes with no error surface', async () => {
    const user = userEvent.setup();
    withQueue([receivedRow]);
    const landed: ReturnDetail = {
      ...received,
      request: {
        ...received.request,
        status: 'awarded',
        qtyAccepted: 6,
        qtyRejected: 0,
        pointsAwarded: 42,
        revision: 5,
        allowedActions: ['note'],
      },
    };
    when(detailPath(receivedRow.id), detailSequence(received, landed));
    /* The contract's own words: the first attempt landed and its response was
       lost, so a retry answers 409 `already_awarded` and the caller treats it
       as success. */
    when(inspectPath(receivedRow.id), {
      error: 'already_awarded',
      entryId: 'pts_dup',
      requestId: 'req_dup',
    }, 409);
    mount();

    await user.click(await screen.findByRole('button', { name: 'Inspect…' }));
    await screen.findByLabelText('Arrived');
    await user.click(screen.getByRole('button', { name: 'Award points' }));

    // A receipt, not a refusal.
    await screen.findByText('Already paid out — your first attempt worked');

    // The modal re-read and landed back on the facts the first attempt wrote.
    const dialog = screen.getByRole('dialog');
    await within(dialog).findByText('6 accepted · 0 rejected');
    await within(dialog).findByText('42 Bottle Caps');
    expect(reads(detailPath(receivedRow.id))).toBe(2);

    // No error surface anywhere: no problem banner, and the form is gone.
    expect(screen.queryByText(/didn’t go through/)).toBeNull();
    expect(screen.queryByLabelText('Arrived')).toBeNull();

    // …and the list was told, exactly as a genuine success tells it.
    await waitFor(() => expect(reads(RETURNS)).toBe(2));
  });

  it('never offers inspect on an out-of-area row, on the row or in its detail', async () => {
    const user = userEvent.setup();
    /*
     * A `received` row that NO board holds. The served array says reject or
     * cancel only — an award can never reach it — so an implementation that
     * derived the button from `status` rather than from `allowedActions`
     * would draw Inspect here and be caught.
     */
    const lost: ReturnListItem = {
      ...receivedRow,
      id: 'ret_lost_1',
      customerEmail: 'ada@example.com',
      customerName: 'Ada O.',
      serviceArea: null,
      allowedActions: ['reject', 'cancel', 'note'],
    };
    withQueue([receivedRow, lost]);
    when(detailPath(receivedRow.id), received);
    when(detailPath(lost.id), {
      ...received,
      request: {
        ...received.request,
        id: lost.id,
        customerEmail: lost.customerEmail,
        customerName: lost.customerName,
        allowedActions: lost.allowedActions,
      },
    } satisfies ReturnDetail);
    mount();

    await screen.findByText('Ada O.');
    const lostRow = rowOf('Ada O.');
    expect(within(lostRow).getByText('Out of area')).toBeTruthy();
    expect(within(lostRow).queryByRole('button', { name: 'Inspect…' })).toBeNull();
    expect(within(lostRow).getByRole('button', { name: 'Reject…' })).toBeTruthy();

    // Same status ON a board does offer it — the difference is the served
    // array, never the status.
    expect(within(rowOf('Tunde B.')).getByRole('button', { name: 'Inspect…' })).toBeTruthy();

    // The detail draws every allowed action, and inspect is not among them.
    await user.click(screen.getByText('Ada O.'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Reject…' });
    expect(within(dialog).getByRole('button', { name: 'Cancel…' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add note…' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Inspect…' })).toBeNull();
  });

  it('renders exactly one row action, and it is allowedActions[0]', async () => {
    const user = userEvent.setup();
    /* Four allowed actions; the row draws ONE button and it is the head of
       the ordered array — the contract's rule, not a favourite. */
    expect(requestedOld.allowedActions).toEqual(['schedule', 'reject', 'cancel', 'note']);
    withQueue([requestedOld]);
    when(detailPath(requestedOld.id), returnDetails.requested);
    mount();

    await screen.findByText('Dara A.');
    const row = rowOf('Dara A.');
    // Every button in the row except the mobile card's expand key.
    const actions = within(row)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label') !== 'Show all details');
    expect(actions.map((b) => b.textContent)).toEqual(['Schedule…']);
    expect(within(row).queryByRole('button', { name: 'Reject…' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Cancel…' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Add note…' })).toBeNull();

    // The one button opens the detail ON that stage, not on the facts.
    const schedule = actions[0];
    if (schedule === undefined) throw new Error('no row action');
    await user.click(schedule);
    expect(await screen.findByLabelText('Pickup date and time')).toBeTruthy();
  });
});

// ============================================================ what it cost ==

/**
 * The cost form, pinned on the one thing it must never do.
 *
 * THE DISTRICT'S STANDARD IS A PLACEHOLDER AND NEVER A VALUE. If it were
 * pre-filled, pressing Save would write the standard onto the return, and an
 * estimate stored that way is indistinguishable from a figure somebody
 * measured — which would silently destroy the coverage count the analytics
 * screen uses to say how much of its headline it trusts. So the assertion is
 * on the input's `value` being empty while its `placeholder` carries the
 * number, and on the body sending `null` for the boxes nobody typed in.
 */
describe('what a pickup cost us', () => {
  const costsPath = (id: string): string => `${RETURNS}/${id}/costs`;

  it('shows the district standard as a placeholder, never as a value, and sends null for an empty box', async () => {
    const user = userEvent.setup();
    withQueue([receivedRow]);
    when(detailPath(receivedRow.id), received);
    when(costsPath(receivedRow.id), { request: received.request });
    mount();

    await user.click(await screen.findByText('Tunde B.'));
    await user.click(await screen.findByRole('button', { name: 'What it cost…' }));

    const transport = await screen.findByLabelText('Transport in');
    /* Cabbage Quarter's standard is ₦2,000. It is SHOWN and NOT FILLED IN. */
    expect(transport).toHaveProperty('value', '');
    expect(transport.getAttribute('placeholder')).toBe('₦2,000 standard');
    /* And a line the district has no standard for offers nothing at all. */
    expect(screen.getByLabelText('Driver').getAttribute('placeholder')).toBe('₦0');

    await user.type(transport, '2600');
    await user.click(screen.getByRole('button', { name: 'Save what it cost' }));

    await waitFor(() => expect(asked(costsPath(receivedRow.id))).toBeTruthy());
    /* KEY BY KEY. The typed line travels as minor units; the three nobody
       touched travel as an explicit `null`, which is what CLEARS them —
       omitting them would make a mistyped figure impossible to undo. */
    expect(sent(costsPath(receivedRow.id), 'POST')).toEqual({
      expectedRevision: received.request.revision,
      transportMinor: 260000,
      localMinor: null,
      driverMinor: null,
      feesMinor: null,
      note: null,
    });

    await screen.findByText('Saved what it cost');
  });

  it('refuses to save an amount that is not a number', async () => {
    const user = userEvent.setup();
    withQueue([receivedRow]);
    when(detailPath(receivedRow.id), received);
    mount();

    await user.click(await screen.findByText('Tunde B.'));
    await user.click(await screen.findByRole('button', { name: 'What it cost…' }));
    await user.type(await screen.findByLabelText('Loading and fees'), '-4');

    expect(screen.getAllByText('Enter an amount in naira').length).toBeGreaterThan(0);
    /* Disabled rather than 400ing at the server: the box is the only place
       the person can see what is wrong with it. */
    expect(screen.getByRole('button', { name: 'Save what it cost' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('is offered on a CLOSED return, because the transport invoice arrives late', async () => {
    const user = userEvent.setup();
    withQueue([awardedRow]);
    when(detailPath(awardedRow.id), returnDetails.awarded);
    mount();

    await user.click(await screen.findByText('Dara A.'));
    /* An awarded return's only `allowedAction` is `note`, and the cost button
       is deliberately NOT one of those — it is legal in every status, so it
       sits beside them rather than among them. */
    expect(await screen.findByRole('button', { name: 'What it cost…' })).toBeTruthy();
  });
});
