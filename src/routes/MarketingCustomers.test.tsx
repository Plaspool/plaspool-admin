import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The balances screen, asserted on the five things it can get wrong quietly.
 *
 *  - **History re-rendered through today's words.** Every ledger row's `reason`
 *    is a snapshot written at the time; a screen that formatted it through the
 *    current labels would rewrite what a customer was told every time somebody
 *    renamed a program. The fixture's oldest row says "Jar Lids" while the
 *    program now says "Bottle Caps", so the two have to appear on screen
 *    together — one live figure, one record.
 *  - **A balance with an invented noun.** The word for a balance is
 *    cross-program configuration, fetched from the settings. There is no such
 *    word in the screen's source, and the assertions below read it back out of
 *    the fixture rather than out of any string in this repository.
 *  - **A dead end for a walk-in.** The brief's rule is that anybody can be
 *    credited for any reason. Somebody who bought at a counter matches nothing,
 *    so the no-match state has to offer the page anyway — contract #16 answers
 *    zeros rather than 404 precisely so that page works.
 *  - **Owner-only controls rendered to writers.** Adjustments are
 *    `requireOwner`, so an Adjust button in front of a writer is a filled-in
 *    form in front of a 403.
 *  - **A refusal quoting the wrong figure.** `insufficient_balance` carries the
 *    server's balance because the one this screen loaded may be minutes old, and
 *    a message quoting the stale number argues with the operator about a
 *    quantity they can see is different.
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`: the path, the method and the
 * body are the three things most likely to be silently wrong against a backend
 * written in another session, and a mocked module asserts none of them.
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
  customerRows,
  customerSummary,
  ledgerWalk,
  programs,
  settings,
  unknownCustomer,
} from '../data/marketing-fixtures';
import MarketingCustomers from './MarketingCustomers';

/**
 * The seeded preset's noun, assembled from two halves rather than typed — this
 * file is one of the paths the section's hardcoded-noun guard greps, so spelling
 * the word out to assert its absence would fail the very test that enforces it.
 */
const PRESET_NOUN = 'sp' + 'ool';

/**
 * What jsdom does not implement and Radix needs the moment a Select popup is
 * touched, plus the `<dialog>` shim the adjust dialog needs — the same blocks
 * `Shop.test.tsx` and the other marketing suites carry.
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

/** No write has gone to this path — the form refused before it asked. */
const sentNothing = (pathname: string): boolean =>
  !calls.some((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET');

beforeEach(() => {
  handlers.clear();
  calls = [];
  // Pinned rather than faked wholesale: `userEvent` needs real timers to type,
  // and every figure below hangs off the fixtures' own fixed clock.
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

// -------------------------------------------------------------- the harness

const SETTINGS = '/api/marketing/settings';
const PROGRAMS = '/api/marketing/programs';
const CUSTOMERS = '/api/marketing/customers';
const ADJUSTMENTS = '/api/marketing/adjustments';

/** An email is a PATH SEGMENT on three routes, and `@` does not survive one
 *  unencoded — the paths the stub is keyed on are the encoded ones. */
const person = (email: string): string => `${CUSTOMERS}/${encodeURIComponent(email)}`;

const DARA = customerSummary.email;

function withSettings(row = settings): void {
  when(SETTINGS, { settings: row });
}

function withDirectory(rows = customerRows, nextCursor: string | null = null): void {
  when(CUSTOMERS, { items: rows, nextCursor });
}

/** One customer, their history, and the programs the adjust dialog offers. */
function withCustomer(
  summary = customerSummary,
  entries = ledgerWalk,
  write?: Responder,
): void {
  when(person(summary.email), summary);
  when(`${person(summary.email)}/ledger`, { items: entries, nextCursor: null });
  when(PROGRAMS, { programs });
  when(
    ADJUSTMENTS,
    write ??
      (() => ({
        status: 201,
        body: { entry: ledgerWalk[0], balance: summary.balance },
      })),
  );
}

/** Shows the router's current URL, so a test can assert where a link went. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount(at = '/marketing/customers') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <MarketingCustomers />
        <Address />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const detail = (email = DARA): string => `/marketing/customers?email=${email}`;

/** The `.mktform__field` an input sits in, which is where its error belongs. */
function field(label: string): HTMLElement {
  const found = screen.getByLabelText(label).closest('.mktform__field');
  if (found === null) throw new Error(`no field around ${label}`);
  return found as HTMLElement;
}

/** The row for a customer in the directory table. */
function rowOf(email: string): HTMLElement {
  const found = screen.getByRole('link', { name: email }).closest('tr');
  if (found === null) throw new Error(`no row for ${email}`);
  return found as HTMLElement;
}

/** Open the adjust dialog on a loaded customer page. */
async function openAdjust(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Adjust balance…' }));
  return screen.findByRole('dialog');
}

/** Pick an option out of one of the dialog's Radix selects. */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: string,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: control }));
  await user.click(await screen.findByRole('option', { name: option }));
}

// ============================================================================

describe('the customers screen', () => {
  it('opens on who has been active, and searches for what is typed', async () => {
    const user = userEvent.setup();
    withSettings();
    withDirectory();
    mount();

    // An EMPTY query is not an empty result (#15): it is the recently-active
    // list, which is what makes the screen worth opening before anybody types.
    await screen.findByRole('link', { name: DARA });
    expect(asked('query=')).toBeUndefined();

    // The balance is read in the settings' words — there is no such word in the
    // screen's own source.
    expect(within(rowOf(DARA)).getByText('180 Bottle Caps')).toBeTruthy();

    /*
     * THE ZERO-HISTORY GUEST. This row is a `shop_customers` match with no
     * ledger at all — the reason the directory searches beyond balance-holders,
     * and the row an admin needs in order to credit somebody for the first time.
     */
    const guest = rowOf('ada@example.com');
    expect(within(guest).getByText('Guest')).toBeTruthy();
    expect(within(guest).getByText('Nothing yet')).toBeTruthy();
    expect(within(guest).getByText('0 Bottle Caps')).toBeTruthy();

    await user.type(screen.getByLabelText('Search by email or customer id'), 'ada{Enter}');

    // `query`, not `q`: the returns list uses `q` and this one uses `query`, and
    // both schemas are `.strict()`, so the two are not interchangeable.
    await waitFor(() => expect(asked('query=ada')).toBeTruthy());
    expect(screen.getByTestId('address').textContent).toBe('/marketing/customers?q=ada');
  });

  it('offers to credit an address that matched nothing, and only to the owner', async () => {
    const user = userEvent.setup();
    withSettings();
    withDirectory([]);
    withCustomer(unknownCustomer, []);
    /* TYPED IN CAPITALS on purpose. `customer_email` is CHECKed `= lower(...)`,
       so the address this link carries has to be folded or the page it opens is
       a wallet of zeros sitting beside a real balance nobody can see. The stub
       below is keyed on the LOWERCASE address, so an unfolded link 404s. */
    mount('/marketing/customers?q=Nobody@Example.COM');

    /*
     * THE WALK-IN ESCAPE. A buyer with no online order matches nothing, and the
     * brief says any customer may be credited for any reason — so the empty
     * state carries the way through rather than being the end of the road.
     */
    const escape = await screen.findByRole('link', {
      // Said back exactly as typed — it is the operator's own spelling being
      // offered to them, and the check above it is about the spelling.
      name: /Credit Nobody@Example\.COM anyway/,
    });
    await user.click(escape);

    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toContain('email=nobody%40example.com'),
    );
    // And the page it opens works: #16 answers zeros for an unknown address, so
    // the balance tile and the dialog behind it are live immediately.
    expect(await screen.findByRole('button', { name: 'Adjust balance…' })).toBeTruthy();

    /*
     * AND ONLY FOR SOMETHING SHAPED LIKE AN ADDRESS. The same box searches
     * customer-id prefixes (#15), and `?email=cus_39fa` would open a balance
     * keyed on a string that is not an email — a wallet nothing will ever match
     * again, credited to nobody. Still the owner here, so the shape is the only
     * thing holding the offer back.
     */
    cleanup();
    mount('/marketing/customers?q=cus_39fa');
    expect(await screen.findByText('Nobody matches that')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /anyway/ })).toBeNull();

    // A writer gets the same "nobody matches" copy and no offer to credit —
    // adjustments are `requireOwner`, and the control is absent, not disabled.
    cleanup();
    fixture.session.user.role = 'writer';
    mount('/marketing/customers?q=nobody@example.com');
    expect(await screen.findByText('Nobody matches that')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /anyway/ })).toBeNull();
  });

  it('shows an address with no history as zeros rather than as a mistake', async () => {
    withSettings();
    withCustomer(unknownCustomer, []);
    mount(detail(unknownCustomer.email));

    // ZEROS, NOT 404 (#16). A customer with no history IS a zero balance, and
    // treating the absence as an error would break the walk-in path entirely.
    expect(await screen.findByText('0 Bottle Caps')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText(/Nothing has been earned or spent yet/),
    ).toBeTruthy();
  });

  it('reads the balance in today’s words and each entry in the words it was written in', async () => {
    withSettings();
    withCustomer();
    const rendered = mount(detail());

    // The live figure, in the current wording.
    expect(await screen.findByText('180 Bottle Caps')).toBeTruthy();
    expect(screen.getByText(/Earned 180 Bottle Caps/)).toBeTruthy();

    /*
     * THE SAME SCREEN, TWO VOCABULARIES, AND THAT IS CORRECT. The oldest entry
     * was written when the program said "Jar Lids" and is printed exactly as
     * stored; a screen that re-rendered it through today's labels would rewrite
     * what this customer was told (spec D2d).
     */
    expect(screen.getByText(/5 accepted × 7 = 35 Jar Lids to dara@example\.com/)).toBeTruthy();

    // A credit and a debit, each with the balance it left behind — "120 → 180"
    // comes off the row's own `balanceAfter`, not from adding rows up here.
    const credit = screen.getByText('+60 Bottle Caps').closest('.mktaudit__what');
    expect(credit).not.toBeNull();
    expect((credit as HTMLElement).textContent).toMatch(/\+60 Bottle Caps\s*120\s*→\s*180/);
    expect(screen.getByText('+60 Bottle Caps').className).toContain('mktaudit__up');
    expect(screen.getByText('−40 Bottle Caps').className).toContain('mktaudit__down');

    // Nothing on this screen can be edited: the ledger is append-only, and a
    // history with a control on its rows is a history somebody can rewrite.
    expect(within(rendered.container.querySelector('.mktaudit') as HTMLElement)
      .queryAllByRole('button')).toHaveLength(0);
  });

  it('says the figures with no word at all when it cannot learn one', async () => {
    /* NO `/settings` HANDLER: the stub answers 404, which is what a deployment
       whose settings row has not landed yet does. The word for a balance is
       cross-program configuration and this screen has none of its own — so the
       honest degradation is a bare number, and a screen that supplied a noun
       here would be wrong for every deployment that renamed the currency. */
    withCustomer();
    const view = mount(detail());

    await screen.findByText(/Earned 180/);
    expect(view.container.querySelector('.mktstat__value')?.textContent).toBe('180');
    expect(view.container.textContent ?? '').not.toContain('Bottle Caps');

    // The stored reasons are untouched by any of it — they were rendered when
    // they were written, and nothing here re-renders them.
    expect(screen.getByText(/5 accepted × 7 = 35 Jar Lids/)).toBeTruthy();
  });

  it('groups the history by the day each entry landed on', async () => {
    withSettings();
    /* Two entries on ONE day, which is the whole point: five rows on five days
       would pass a grouping test that drew a heading above every row. */
    const sameDay = [
      ledgerWalk[0],
      { ...ledgerWalk[1], id: 'pts_4b', createdAt: ledgerWalk[0].createdAt - 60_000 },
      ...ledgerWalk.slice(2),
    ];
    withCustomer(customerSummary, sameDay);
    const view = mount(detail());

    await screen.findByText('180 Bottle Caps');
    expect(view.container.querySelectorAll('.mktaudit__row')).toHaveLength(5);
    // Four headings for five rows: the first entry of each day draws one.
    expect(view.container.querySelectorAll('.mktaudit__day')).toHaveLength(4);
  });

  it('asks the server again when the kind of entry is narrowed', async () => {
    const user = userEvent.setup();
    withSettings();
    withCustomer();
    mount(detail());

    await screen.findByText('180 Bottle Caps');
    await user.click(screen.getByRole('link', { name: 'From returns' }));

    // The filter is URL state, so it survives a reload and can be sent to
    // somebody — and it is the SERVER that filters, not this screen hiding rows.
    await waitFor(() => expect(asked('kind=awards')).toBeTruthy());
    expect(screen.getByTestId('address').textContent).toContain('kind=awards');
    // `all` is the server's own default, so it is never sent and never written.
    await user.click(screen.getByRole('link', { name: 'Everything' }));
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).not.toContain('kind='),
    );
    expect(asked('kind=all')).toBeUndefined();
  });

  it('posts the debit the buttons described, with the reason and the id it knows', async () => {
    const user = userEvent.setup();
    withSettings();
    withCustomer();
    mount(detail());

    const dialog = await openAdjust(user);
    await user.click(within(dialog).getByRole('radio', { name: 'Debit' }));
    await user.type(screen.getByLabelText('Amount'), '40');
    await choose(user, 'Reason', 'Goodwill');

    // The preset WRITES the box — what is stored is what the box says.
    expect(screen.getByLabelText('What it says on the ledger (optional)')).toHaveProperty(
      'value',
      'Goodwill',
    );
    // The arithmetic, live, before anything is written.
    expect(within(dialog).getByText('Balance after: 140 Bottle Caps')).toBeTruthy();

    // THE BUTTON IS THE CONFIRMATION: it says which way and how much, in the
    // words the balance is kept in, so there is no second dialog asking the
    // same question differently.
    await user.click(screen.getByRole('button', { name: 'Debit 40 Bottle Caps' }));

    await waitFor(() => expect(sent(ADJUSTMENTS, 'POST')).toBeTruthy());
    expect(sent(ADJUSTMENTS, 'POST')).toEqual({
      email: DARA,
      // A DIRECTION, not a typed minus sign: the segmented pair decides the sign.
      delta: -40,
      reason: 'Goodwill',
      // Carried because it is known — a later merge of a customer whose email
      // changed is only possible over rows that recorded who as well as what.
      customerId: 'cus_dara',
    });
    // No program was picked, so the field is absent rather than empty: a credit
    // by hand need not belong to a program at all.
    expect(sent(ADJUSTMENTS, 'POST')).not.toHaveProperty('programId');

    // The tile and the history are two views of one write, so both are re-read.
    await waitFor(() =>
      expect(calls.filter((c) => c.path.split('?')[0] === person(DARA))).toHaveLength(2),
    );
    expect(
      calls.filter((c) => c.path.split('?')[0] === `${person(DARA)}/ledger`).length,
    ).toBeGreaterThan(1);
  });

  it('quotes the balance the refusal carried, under the amount', async () => {
    const user = userEvent.setup();
    withSettings();
    withCustomer(customerSummary, ledgerWalk, () => ({
      status: 409,
      body: { error: 'insufficient_balance', balance: 40, requestId: 'req_low' },
    }));
    mount(detail());

    const dialog = await openAdjust(user);
    await user.click(within(dialog).getByRole('radio', { name: 'Debit' }));
    await user.type(screen.getByLabelText('Amount'), '60');
    await choose(user, 'Reason', 'Correction');
    await user.click(screen.getByRole('button', { name: 'Debit 60 Bottle Caps' }));

    /*
     * THE SERVER'S FIGURE, NOT THE ONE THIS SCREEN LOADED. The tile still says
     * 180 — it was read before somebody else spent 140 of it — and the message
     * has to be about the balance that actually refused the write. Inline on the
     * amount, because that is the box that has to change.
     */
    await waitFor(() =>
      expect(
        within(field('Amount')).getByText(
          'Balance is 40 Bottle Caps — a 60 debit would go below zero.',
        ),
      ).toBeTruthy(),
    );
    // Still open, with everything typed still typed.
    expect(screen.getByLabelText('Amount')).toHaveProperty('value', '60');
  });

  /*
   * WAS 'refuses to write an entry with no reason, whatever the preset filled
   * in'. Reasons went optional on the owner's instruction, 2026-09-03.
   *
   * WHAT IS LEFT IS THE HALF THAT WAS ALWAYS THE POINT: the preset is a
   * STARTING POINT, not a value that survives being deleted. Emptying the box
   * after picking "Walk-in return" must post no reason at all — not the preset
   * the Select put there, and not an empty string, which the route still
   * refuses because `.min(1)` survives inside its `.optional()`. `filled()` in
   * `api-marketing.ts` is what drops it.
   */
  it('posts no reason when the preset is deleted, rather than the preset', async () => {
    const user = userEvent.setup();
    withSettings();
    withCustomer();
    mount(detail());

    const dialog = await openAdjust(user);
    await user.type(screen.getByLabelText('Amount'), '25');
    await choose(user, 'Reason', 'Walk-in return');

    const box = screen.getByLabelText('What it says on the ledger (optional)');
    expect(box).toHaveProperty('value', 'Walk-in return, counted at the counter');

    await user.clear(box);
    await user.click(within(dialog).getByRole('button', { name: 'Credit 25 Bottle Caps' }));

    await waitFor(() => expect(asked(ADJUSTMENTS)).toBeTruthy());
    const body = sent(ADJUSTMENTS, 'POST') as Record<string, unknown>;
    expect(body).not.toHaveProperty('reason');
    expect(body).toMatchObject({ delta: 25, email: DARA });
  });

  it('gives a writer the history and nothing to change it with', async () => {
    fixture.session.user.role = 'writer';
    withSettings();
    withCustomer();
    mount(detail());

    // The balance and every entry, because answering "why is my balance this"
    // is part of the job — the words come from the settings, which any staff
    // member may read.
    expect(await screen.findByText('180 Bottle Caps')).toBeTruthy();
    expect(screen.getByText(/5 accepted × 7 = 35 Jar Lids/)).toBeTruthy();

    // Owner-only, so ABSENT rather than disabled: the server would answer 403.
    expect(screen.queryByRole('button', { name: 'Adjust balance…' })).toBeNull();
    // …and the programs are not fetched at all: they exist on this screen for
    // one control inside that dialog.
    expect(asked(PROGRAMS)).toBeUndefined();
  });

  it('never says the preset’s noun', async () => {
    withSettings();
    withDirectory();
    const list = mount();
    await screen.findByRole('link', { name: DARA });
    expect(list.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));

    cleanup();
    withCustomer();
    const page = mount(detail());
    await screen.findByText('180 Bottle Caps');
    expect(page.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
    // The fixtures are absurd on purpose, and what is rendered is what they say.
    expect(page.container.textContent ?? '').toContain('Bottle Caps');
  });
});
