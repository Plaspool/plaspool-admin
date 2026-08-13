import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The returns queue, asserted on the five things a screenshot cannot show.
 *
 *  - **Which view it opened on, and what it asked the server for.** The queue's
 *    whole claim is that it opens on the work waiting for a person; a screen
 *    that renders the "Needs action" tab as active while requesting the
 *    unfiltered list looks correct and is not.
 *  - **Whose words are on the row.** Every fixture here is deliberately absurd —
 *    the points are "Bottle Caps" and the things being returned are "canisters"
 *    — because the programme this section ships with counts something else
 *    entirely and can be renamed on day one. A row that hardcoded the shipped
 *    noun passes any hand-written check and fails the first rename, so these
 *    suites assert the fixture's words are on screen and the preset's are not.
 *  - **That the button on a row is the server's answer.** `allowedActions[0]`
 *    is ordered by contract; a UI computing its own next action drifts the
 *    moment the state machine gains a branch, and drifts silently.
 *  - **What happens when somebody else got there first.** Every 409 in this
 *    section carries the re-read entity, and the treatment is to show the true
 *    stage rather than to ask for a reload — the row regroups under the heading
 *    it now belongs to and says so out loud.
 *  - **That it is workable from a keyboard.** ↑/↓ walk the rows, Enter opens,
 *    'a' fires the row's action. A roving tabindex that stops roving is a queue
 *    of a hundred and fifty tab stops.
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`. The path, the method and the
 * query are three of the things most likely to be silently wrong against a
 * backend built in another session, and a mocked module asserts none of them.
 * An unregistered path answers 404 in the real envelope's shape, which is how
 * the "this deployment has no returns route yet" arm gets exercised too.
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

/*
 * Nothing on this screen reads the session, and this mock is here to keep it
 * that way: every lifecycle transition is `requireAuth`, so a writer processes
 * returns exactly as an owner does. The role-flipping case near the bottom goes
 * red the day somebody gates this queue on ownership.
 */
vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

import { ToastProvider } from '../components/Toast';
import {
  NOW,
  capsProgram,
  collectedRow,
  needsActionPage,
  programs,
  requestedNew,
  requestedOld,
  returnCounts,
  returnDetails,
  returnsPage,
  scheduledRow,
} from '../data/marketing-fixtures';
import MarketingReturns from './MarketingReturns';

const HOUR = 3_600_000;

/**
 * The seeded preset's unit noun, assembled from two halves rather than typed.
 *
 * This file sits under `src/routes/Marketing*.tsx`, which is one of the paths
 * the section's hardcoded-noun guard greps. Spelling the word out to assert its
 * absence would put it in a source the guard reads and fail it on the test that
 * exists to enforce it. Joined at runtime it is the same word to `RegExp` and
 * not a match for a grep over the text.
 */
const PRESET_NOUN = 'sp' + 'ool';

// --------------------------------------------------------------- what jsdom lacks

/**
 * Radix's Select needs these the moment its trigger renders, and `Dialog` calls
 * `showModal()` from an effect — without the shim React tears the tree down
 * during commit and every assertion fails against an empty document for a
 * reason that has nothing to do with the screen. Both blocks are copied from
 * `Shop.test.tsx` and `Settings.test.tsx`, which measured the same gaps.
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

// --------------------------------------------------------------------- the server

type Responder = (url: URL, init: RequestInit) => { status?: number; body: unknown };

const handlers = new Map<string, Responder>();
let calls: { path: string; init: RequestInit }[] = [];

/**
 * Register a route. Anything unregistered answers 404 `gone`, like the app.
 *
 * TWO OVERLOADS RATHER THAN ONE UNION, because `unknown | Responder` collapses
 * to `unknown` — and a parameter of type `unknown` contributes no contextual
 * type, so every responder written inline would take `(url, init)` as implicit
 * `any` and the suite would be asserting against a URL nothing had typed.
 */
function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** Every path+query asked for, in order. The query is the assertion target. */
const asked = (fragment: string): string | undefined =>
  calls.find((c) => c.path.includes(fragment))?.path;

const askedTimes = (fragment: string): number =>
  calls.filter((c) => c.path.includes(fragment)).length;

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
  /*
   * The clock is pinned rather than faked wholesale: the ages this screen
   * renders ("waiting 4d") and the pickup date it refuses ("can't be in the
   * past") are both read off `Date.now()`, and a suite whose answers depend on
   * the minute it ran is a suite that fails at midnight. Fake timers would also
   * have to be handed to `userEvent`, which needs real ones to type.
   */
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
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
  fixture.session.user.role = 'owner';
});

// ------------------------------------------------------------------- the harness

/** Shows the router's current URL, so a test can assert what a click wrote. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount(at = '/marketing/returns') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <MarketingReturns />
        <Address />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const address = (): string => screen.getByTestId('address').textContent ?? '';

/** The whole programs list, which the filter and the intake dialog both read. */
const withPrograms = (): void => when('/api/marketing/programs', { programs });

/** `1786600000000` → `2026-08-13T06:46` in whatever zone the suite is running in. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const row = (id: string): HTMLElement => {
  const found = screen.getByText(id).closest('li');
  if (found === null) throw new Error(`no row for ${id}`);
  return found as HTMLElement;
};

/**
 * The open `<dialog>`, and every in-dialog query goes through it.
 *
 * Both dialogs on this screen stay mounted while closed — the intake so its
 * exit animation has something to animate, the quick action so a re-open comes
 * up empty rather than holding the last pickup date — and a closed `<dialog>`
 * is still in jsdom's document. Unscoped, `getByLabelText('Note')` would find
 * two, and worse, a query for a button inside a dialog that never opened would
 * pass. Scoping proves the dialog opened as well as what is in it.
 */
function sheet(): HTMLElement {
  const open = [...document.querySelectorAll('dialog')].find(
    (d) => (d as HTMLDialogElement).open,
  );
  if (open === undefined) throw new Error('no dialog is open');
  return open as HTMLElement;
}

// ============================================================================

describe('the returns queue', () => {
  it('opens on the work waiting for a person, and asks the server for exactly that', async () => {
    withPrograms();
    when('/api/marketing/returns', needsActionPage);
    mount();

    await screen.findByText(requestedOld.id);
    // The tab being lit is not the assertion — what was fetched is. A screen
    // that renders the right tab and requests the unfiltered list looks right.
    expect(asked('/api/marketing/returns?view=needs_action')).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Return stages' });
    expect(
      within(tabs).getByRole('link', { name: 'Needs action 3' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('counts its tabs from the sidecar the list arrived with', async () => {
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');

    await screen.findByText(requestedOld.id);
    const tabs = screen.getByRole('navigation', { name: 'Return stages' });

    // Real aggregates, not the rows this page happens to hold: the objection to
    // counted tabs is about invented numbers, and `counts` rides on every page.
    expect(within(tabs).getByRole('link', { name: 'Needs action 3' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'To inspect 1' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'Done 3' })).toBeTruthy();
    expect(within(tabs).getByRole('link', { name: 'All 8' })).toBeTruthy();
    expect(screen.getByText('8 of 8 — oldest first')).toBeTruthy();
  });

  it('says how many are coming back in the program’s own words, and never the preset’s', async () => {
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');

    await screen.findByText(requestedOld.id);
    expect(screen.getAllByText('6 canisters').length).toBeGreaterThan(0);
    // A closed return says what was kept as well as what was sent.
    expect(screen.getByText('6 canisters · 5 accepted')).toBeTruthy();
    // Waiting time is text as well as colour — `.mktage--danger` says nothing
    // on its own to somebody who cannot tell the two tokens apart.
    expect(within(row(requestedOld.id)).getByText('waiting 4d')).toBeTruthy();

    expect(document.body.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
  });

  it('renders the one action the server allows, and a closed return gets no write at all', async () => {
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');

    await screen.findByText(requestedOld.id);
    expect(
      within(row(requestedOld.id)).getByRole('button', {
        name: 'Schedule pickup — dara@example.com',
      }),
    ).toBeTruthy();
    expect(
      within(row(scheduledRow.id)).getByRole('button', {
        name: 'Mark picked up — ngozi@example.com',
      }),
    ).toBeTruthy();
    // `allowedActions` on an awarded row is `['note']`, and a note is not
    // something a queue button should write on somebody's behalf.
    expect(
      within(row('ret_dara_0')).getByRole('button', { name: 'View — dara@example.com' }),
    ).toBeTruthy();
  });

  it('logs a return from the queue’s one create control, and shows the row it made', async () => {
    const user = userEvent.setup();
    withPrograms();
    let list: unknown = needsActionPage;
    when('/api/marketing/returns', (_url, init) => {
      if (init.method === 'POST') {
        list = {
          ...needsActionPage,
          items: [
            { ...requestedNew, id: 'ret_zara_1', customerEmail: 'zara@example.com' },
            ...needsActionPage.items,
          ],
        };
        return { status: 201, body: returnDetails.requested };
      }
      return { body: list };
    });
    mount();
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Log a return…' }));
    await user.type(within(sheet()).getByLabelText('Customer email'), 'zara@example.com');
    await user.click(within(sheet()).getByRole('button', { name: 'Log the return' }));

    await screen.findByText('ret_zara_1');
    expect(sent('/api/marketing/returns', 'POST')).toEqual({
      email: 'zara@example.com',
      // The program's own minimum, so the commonest return needs no typing.
      qtyDeclared: 4,
      programId: capsProgram.id,
    });
  });

  it('puts a below-minimum refusal under the quantity box, in the program’s units', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', (_url, init) =>
      init.method === 'POST'
        ? {
            status: 400,
            body: {
              error: 'below_minimum',
              detail: 'qtyDeclared',
              /*
               * NINE, WHICH IS NOT THE FOUR THIS SCREEN ALREADY KNOWS. The
               * program list is a snapshot taken when the queue loaded, and an
               * owner raising the minimum in the next tab is exactly why the
               * catalogue puts `min` on the payload at all. Stubbed as the
               * program's own 4, this test would pass identically against a
               * dialog that ignored the payload and quoted its stale copy —
               * the refusal would read plausibly and be a lie.
               */
              min: 9,
              requestId: 'req_1',
            },
          }
        : { body: needsActionPage },
    );
    mount();
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Log a return…' }));
    await user.type(within(sheet()).getByLabelText('Customer email'), 'zara@example.com');
    // Typed, not stepped: the box deliberately lets a number below the minimum
    // stand, because the operator is recording what the customer actually sent.
    await user.clear(within(sheet()).getByLabelText('Quantity'));
    await user.type(within(sheet()).getByLabelText('Quantity'), '2');
    await user.click(within(sheet()).getByRole('button', { name: 'Log the return' }));

    // The server's number, in the program's units, under the box it belongs to.
    expect(await within(sheet()).findByText('At least 9 canisters per request.')).toBeTruthy();
    expect(within(sheet()).queryByText('At least 4 canisters per request.')).toBeNull();
    expect(sent('/api/marketing/returns', 'POST').qtyDeclared).toBe(2);
  });

  it('answers a second open return with a link to the first, not a dead end', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', (_url, init) =>
      init.method === 'POST'
        ? {
            status: 409,
            body: {
              error: 'return_already_open',
              existingId: requestedOld.id,
              status: 'requested',
              requestId: 'req_2',
            },
          }
        : { body: needsActionPage },
    );
    mount();
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Log a return…' }));
    await user.type(within(sheet()).getByLabelText('Customer email'), 'dara@example.com');
    await user.click(within(sheet()).getByRole('button', { name: 'Log the return' }));

    const open = await within(sheet()).findByRole('link', { name: 'Open it' });
    await user.click(open);
    expect(address()).toBe(`/marketing/returns?id=${requestedOld.id}`);
  });

  it('sends a paused program to the screen that can unpause it', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', (_url, init) =>
      init.method === 'POST'
        ? { status: 409, body: { error: 'program_paused', requestId: 'req_3' } }
        : { body: needsActionPage },
    );
    mount();
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Log a return…' }));
    await user.type(within(sheet()).getByLabelText('Customer email'), 'zara@example.com');
    await user.click(within(sheet()).getByRole('button', { name: 'Log the return' }));

    expect(
      await within(sheet()).findByText('That program is paused, so it isn’t taking new returns.'),
    ).toBeTruthy();
    expect(
      within(sheet()).getByRole('link', { name: 'Open Rewards' }).getAttribute('href'),
    ).toBe('/marketing/rewards');
  });

  it('schedules a pickup from the row without leaving the queue', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    when(`/api/marketing/returns/${requestedOld.id}/schedule`, {
      request: { ...returnDetails.scheduled.request, id: requestedOld.id },
    });
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);
    const before = askedTimes('/api/marketing/returns?view=all');

    await user.click(
      within(row(requestedOld.id)).getByRole('button', {
        name: 'Schedule pickup — dara@example.com',
      }),
    );
    const at = localInput(NOW + 20 * HOUR);
    fireEvent.change(within(sheet()).getByLabelText('Pickup date and time'), {
      target: { value: at },
    });
    await user.click(within(sheet()).getByRole('button', { name: 'Schedule pickup' }));

    expect(sent(`/api/marketing/returns/${requestedOld.id}/schedule`, 'POST')).toEqual({
      expectedRevision: requestedOld.revision,
      pickupAt: new Date(at).getTime(),
      // The row already carries an address, so the form offered it back rather
      // than making somebody retype it — and it travels with the booking.
      pickupAddress: requestedOld.pickupAddress,
    });
    // The list is re-read rather than patched from the response: the transition
    // may have moved the row out of the view it was sitting in.
    expect(askedTimes('/api/marketing/returns?view=all')).toBeGreaterThan(before);
  });

  it('leaves the next row’s form usable once one has been saved', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    when(`/api/marketing/returns/${requestedOld.id}/schedule`, {
      request: { ...returnDetails.scheduled.request, id: requestedOld.id },
    });
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    await user.click(
      within(row(requestedOld.id)).getByRole('button', {
        name: 'Schedule pickup — dara@example.com',
      }),
    );
    fireEvent.change(within(sheet()).getByLabelText('Pickup date and time'), {
      target: { value: localInput(NOW + 20 * HOUR) },
    });
    await user.click(within(sheet()).getByRole('button', { name: 'Schedule pickup' }));
    await screen.findByText('Pickup scheduled');

    // The in-flight flag has to be cleared on the way out of a SUCCESS as well
    // as a failure. Left set, the next dialog opens with its submit already
    // disabled — a form that refuses to be used, saying nothing about why.
    await user.click(
      within(row(scheduledRow.id)).getByRole('button', {
        name: 'Mark picked up — ngozi@example.com',
      }),
    );
    const submit = within(sheet()).getByRole('button', {
      name: 'Mark picked up',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('stops the quantity buttons at the program’s minimum, and still takes less typed', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', needsActionPage);
    mount();
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Log a return…' }));
    const box = within(sheet());
    expect((box.getByLabelText('Quantity') as HTMLInputElement).value).toBe('4');
    // The floor is where the buttons stop — the minimum is a rule the form
    // states, and the hint beside it says so in the program's own units.
    expect(
      (box.getByRole('button', { name: 'Decrease Quantity' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(box.getByText('At least 4 canisters per request.')).toBeTruthy();

    await user.clear(box.getByLabelText('Quantity'));
    await user.type(box.getByLabelText('Quantity'), '2');
    expect((box.getByLabelText('Quantity') as HTMLInputElement).value).toBe('2');
  });

  it('refuses a pickup booked in the past before it reaches the server', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    await user.click(
      within(row(requestedOld.id)).getByRole('button', {
        name: 'Schedule pickup — dara@example.com',
      }),
    );
    fireEvent.change(within(sheet()).getByLabelText('Pickup date and time'), {
      target: { value: localInput(NOW - 3 * HOUR) },
    });
    await user.click(within(sheet()).getByRole('button', { name: 'Schedule pickup' }));

    expect(within(sheet()).getByText('The pickup can’t be booked in the past.')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/schedule'))).toBe(false);
  });

  it('regroups a row the server says has already moved on', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    when(`/api/marketing/returns/${scheduledRow.id}/collect`, () => ({
      status: 409,
      body: {
        error: 'invalid_transition',
        status: 'received',
        action: 'collect',
        // Every 409 in this section carries the re-read entity, which is what
        // makes healing possible without a second fetch.
        request: { ...returnDetails.received.request, id: scheduledRow.id },
        requestId: 'req_4',
      },
    }));
    mount('/marketing/returns?view=all');
    await screen.findByText(scheduledRow.id);

    await user.click(
      within(row(scheduledRow.id)).getByRole('button', {
        name: 'Mark picked up — ngozi@example.com',
      }),
    );
    await user.click(within(sheet()).getByRole('button', { name: 'Mark picked up' }));

    expect(await screen.findByText('That return is now Received.')).toBeTruthy();
    const moved = row(scheduledRow.id);
    expect(within(moved).getByText('Received')).toBeTruthy();
    // And the row's one button is now the one the fresh `allowedActions` allows.
    expect(
      within(moved).getByRole('button', { name: 'Inspect — ngozi@example.com' }),
    ).toBeTruthy();
  });

  it('offers the revision it lost to, and keeps the form that lost', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    when(`/api/marketing/returns/${scheduledRow.id}/collect`, () => ({
      status: 409,
      body: {
        error: 'stale_write',
        expected: scheduledRow.revision,
        actual: scheduledRow.revision + 1,
        request: { ...returnDetails.scheduled.request, id: scheduledRow.id, revision: 9 },
        requestId: 'req_5',
      },
    }));
    mount('/marketing/returns?view=all');
    await screen.findByText(scheduledRow.id);

    await user.click(
      within(row(scheduledRow.id)).getByRole('button', {
        name: 'Mark picked up — ngozi@example.com',
      }),
    );
    await user.type(within(sheet()).getByLabelText('Note'), 'Driver called ahead');
    await user.click(within(sheet()).getByRole('button', { name: 'Mark picked up' }));

    // A lost CAS is not an illegal move: the dialog stays, the note stays, and
    // the band offers the revision the write lost to — from the payload, with
    // no second request.
    await within(sheet()).findByRole('button', { name: 'Load theirs' });
    expect((within(sheet()).getByLabelText('Note') as HTMLTextAreaElement).value).toBe(
      'Driver called ahead',
    );
    await user.click(within(sheet()).getByRole('button', { name: 'Load theirs' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Mark picked up' }));

    expect(sent(`/api/marketing/returns/${scheduledRow.id}/collect`, 'POST')).toEqual({
      expectedRevision: 9,
      note: 'Driver called ahead',
    });
  });

  it('lists the queue with plain tabs when the server sends no counts', async () => {
    withPrograms();
    when('/api/marketing/returns', { items: needsActionPage.items, nextCursor: null });
    mount();

    await screen.findByText(requestedOld.id);
    const tabs = screen.getByRole('navigation', { name: 'Return stages' });
    // Degrade, don't block: a missing sidecar costs the numbers, not the queue.
    expect(within(tabs).getByRole('link', { name: 'Needs action' })).toBeTruthy();
    expect(screen.getByText('3 loaded — oldest first')).toBeTruthy();
  });

  it('walks the rows with the arrow keys and fires the row’s action with ‘a’', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    row(requestedOld.id).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(row(requestedNew.id));

    await user.keyboard('a');
    // The second row is `requested`, so 'a' is "schedule a pickup" — and the
    // dialog names the row it is about, because a queue is a list of look-alikes.
    expect(within(sheet()).getByText('Schedule a pickup')).toBeTruthy();
    expect(within(sheet()).getByText(`bode@example.com · ${requestedNew.id}`)).toBeTruthy();
  });

  it('is three stops on the way through the page, not three per row', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    /*
     * THE OTHER HALF OF THE ROVING TABINDEX, and the half the arrow-key test
     * above cannot see. ↑/↓ keep working perfectly if every row is left in the
     * tab order — the regression is invisible from the keyboard spine and shows
     * up only as Tab, Tab, Tab, twenty-four times, between the search box and
     * the pager. Eight rows carry three focusable things each; exactly one row's
     * worth may be reachable with Tab.
     */
    const list = screen.getByRole('list', { name: 'Return requests' });
    const stops = [...list.querySelectorAll('li.mktqrow, a, button')].filter(
      (el) => el.getAttribute('tabindex') !== '-1',
    );
    expect(stops).toHaveLength(3);
    const first = row(requestedOld.id);
    expect(stops.every((el) => el === first || first.contains(el))).toBe(true);

    // And the walk agrees with the attributes: into the row, across its two
    // controls, then out of the list entirely rather than into row two.
    first.focus();
    await user.tab();
    expect(first.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(first.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(list.contains(document.activeElement)).toBe(false);
  });

  it('names the dialog after the action the server offered, whatever it offered', async () => {
    const user = userEvent.setup();
    withPrograms();
    /*
     * A row whose served actions begin with `cancel`. The queue renders
     * `allowedActions[0]` and is deliberately not allowed to reason about which
     * action that will be — so the dialog it opens has to be named from the
     * action too. Written as a ternary over the three stages somebody had in
     * mind, the leftover arm titles a cancellation "Mark as received", which is
     * a confirmation dialog describing the opposite of what pressing it does.
     */
    when('/api/marketing/returns', {
      items: [{ ...collectedRow, allowedActions: ['cancel', 'note'] }],
      nextCursor: null,
      counts: returnCounts,
    });
    mount('/marketing/returns?view=all');
    await screen.findByText(collectedRow.id);

    await user.click(
      within(row(collectedRow.id)).getByRole('button', {
        name: 'Cancel return — kemi@example.com',
      }),
    );
    expect(within(sheet()).getByText('Cancel this return')).toBeTruthy();
    expect(within(sheet()).queryByText('Mark as received')).toBeNull();
  });

  it('opens the return itself on Enter, keeping the view behind it', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    row(requestedOld.id).focus();
    await user.keyboard('{Enter}');
    expect(address()).toBe(`/marketing/returns?view=all&id=${requestedOld.id}`);
  });

  it('sends an inspection to its own screen rather than a dialog over the queue', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');
    await screen.findByText('ret_tunde_1');

    await user.click(
      within(row('ret_tunde_1')).getByRole('button', { name: 'Inspect — tunde@example.com' }),
    );
    expect(address()).toBe('/marketing/returns?view=all&id=ret_tunde_1&act=inspect');
  });

  it('shows a writer the same queue — processing returns is staff work', async () => {
    fixture.session.user.role = 'writer';
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    mount('/marketing/returns?view=all');

    await screen.findByText(requestedOld.id);
    expect(screen.getByRole('button', { name: 'Log a return…' })).toBeTruthy();
    expect(
      within(row(requestedOld.id)).getByRole('button', {
        name: 'Schedule pickup — dara@example.com',
      }),
    ).toBeTruthy();
  });

  it('says something different for each empty view', async () => {
    withPrograms();
    when('/api/marketing/returns', { items: [], nextCursor: null, counts: returnCounts });
    mount('/marketing/returns?view=received');
    expect(await screen.findByText('Nothing is waiting to be inspected')).toBeTruthy();

    cleanup();
    mount('/marketing/returns?view=all');
    // The all-view is the only one that may promise a storefront form later —
    // v1's intake is admin-driven, and the empty state says so.
    expect(await screen.findByText('No return requests yet')).toBeTruthy();
    expect(
      screen.getByText('Log one when a customer asks — the storefront form comes later.'),
    ).toBeTruthy();
  });

  it('tells a fruitless search what it actually matches', async () => {
    withPrograms();
    when('/api/marketing/returns', { items: [], nextCursor: null, counts: returnCounts });
    mount('/marketing/returns?view=all&q=zzz');

    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    expect(
      screen.getByText('The queue matches the start of an email address, or a whole return id.'),
    ).toBeTruthy();
    expect(asked('q=zzz')).toBeTruthy();
  });

  it('appends the next page instead of replacing the list', async () => {
    const user = userEvent.setup();
    withPrograms();
    when('/api/marketing/returns', (url) =>
      url.searchParams.get('cursor') === null
        ? { body: { items: [requestedOld], nextCursor: requestedOld.id, counts: returnCounts } }
        : { body: { items: [requestedNew], nextCursor: null, counts: returnCounts } },
    );
    mount('/marketing/returns?view=all');
    await screen.findByText(requestedOld.id);

    await user.click(screen.getByRole('button', { name: 'Show more' }));

    await screen.findByText(requestedNew.id);
    // The first page is still there — a keyset walk that replaced the list
    // would be a pager that loses everything above it.
    expect(screen.getByText(requestedOld.id)).toBeTruthy();
    expect(asked(`cursor=${requestedOld.id}`)).toBeTruthy();
    expect(screen.getByText('2 of 8 — oldest first')).toBeTruthy();
  });

  it('says the queue didn’t load rather than showing an empty one', async () => {
    withPrograms();
    // Nothing registered for the list: 404 in the real envelope's shape.
    mount();

    expect(await screen.findByText('This deployment has no returns route yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps a return’s own URL out of the queue', async () => {
    withPrograms();
    when('/api/marketing/returns', returnsPage);
    when(`/api/marketing/returns/${requestedOld.id}`, returnDetails.requested);
    mount(`/marketing/returns?view=all&id=${requestedOld.id}`);

    // `?id=` is a DESTINATION, not the queue with something on top of it: the
    // tab strip and the filters are gone rather than hidden behind it, and the
    // way back carries the view somebody was actually looking at.
    // (What the detail then does with the return is `MarketingReturnDetail`'s
    // own suite; this one only asserts the switch.)
    expect(await screen.findByText('Details')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Return stages' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the queue' }).getAttribute('href')).toBe(
      '/marketing/returns?view=all',
    );
  });
});
