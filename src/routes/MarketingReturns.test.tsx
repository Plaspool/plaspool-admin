import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The returns board, asserted on the six things a screenshot cannot show.
 *
 *  - **Which board it opened on, and what it asked the server for.** The screen
 *    claims to land an operator on the district with the most work waiting; a
 *    board that renders the right name while requesting the whole city looks
 *    correct and is not.
 *  - **That the desk and the board answer DIFFERENT questions.** The desk is
 *    whole-of-city and the board is one district. Two reads, two scopes — and a
 *    desk that quietly inherited `?district=` would stop being the thing that
 *    tells you another district is on fire.
 *  - **That a badge comes from the API and not from the cards on screen.**
 *    Counting the rendered rows would badge every other district with zero,
 *    which is the switcher lying about the one thing it exists to answer.
 *  - **That a drop opens a FORM.** Nothing on this board performs a transition
 *    from a gesture. The resolver is unit-tested next door; what is provable
 *    here is that the form-and-request path works by ordinary clicks.
 *  - **That multi-select offers only the intersection**, and shows the rest
 *    greyed WITH the reason rather than hidden.
 *  - **Whose words are on the card.** Every fixture is deliberately absurd — the
 *    points are "Bottle Caps" and the things returned are "canisters" — because
 *    the programme ships renameable and the served districts are editable. A
 *    card that hardcoded either passes a hand-written check and fails the first
 *    edit.
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`. The path, the method and the
 * query are three of the things most likely to be silently wrong, and a mocked
 * module asserts none of them.
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
  areasView,
  boardPage,
  cabbageArea,
  collectedRow,
  needsActionPage,
  programs,
  requestedNew,
  requestedOld,
  returnDetails,
  scheduledRow,
  turnipArea,
} from '../data/marketing-fixtures';
import MarketingReturns from './MarketingReturns';

/**
 * The seeded preset's unit noun and the served city, each assembled from halves.
 *
 * This file sits under `src/routes/Marketing*.tsx`, which the section's grep
 * guard reads. Spelling either word out to assert its absence would put it in a
 * source the guard scans and fail the test that exists to enforce it.
 */
const PRESET_NOUN = 'sp' + 'ool';
const SERVED_CITY = 'ab' + 'uja';

// --------------------------------------------------------------- what jsdom lacks

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

function when(pathname: string, respond: Responder): void;
function when(pathname: string, body: unknown, status?: number): void;
function when(pathname: string, body: unknown, status = 200): void {
  handlers.set(
    pathname,
    typeof body === 'function' ? (body as Responder) : () => ({ status, body }),
  );
}

/** Every path+query asked for, in order. The query is the assertion target. */
const askedAll = (fragment: string): string[] =>
  calls.filter((c) => c.path.includes(fragment)).map((c) => c.path);

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
  /* Pinned rather than faked wholesale: the ages this screen renders ("4d") are
   * read off `Date.now()`, and a suite whose answers depend on the minute it ran
   * fails at midnight. `userEvent` also needs real timers to type. */
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

/** The ordinary server: areas, one board, the desk, the programs. */
function aWorkingShop(): void {
  when('/api/marketing/areas', { areas: areasView.areas, outOfArea: areasView.outOfArea });
  when('/api/marketing/programs', { programs });
  when('/api/marketing/returns', (url) =>
    url.searchParams.get('view') === 'needs_action'
      ? { body: needsActionPage }
      : { body: boardPage },
  );
}

/** The column with this heading, as a container to query inside. */
function column(heading: string): HTMLElement {
  const title = screen.getByRole('heading', { name: heading, level: 3 });
  const box = title.closest('[data-column]');
  if (box === null) throw new Error(`no column for ${heading}`);
  return box as HTMLElement;
}

/**
 * THE BOARD HAS LANDED — both fetches, not just the one that draws the heading.
 *
 * The area name comes from `GET /areas` and the cards from a second
 * `GET /returns`, so waiting on the heading and then querying a card is a race
 * the suite loses whenever the machine is busy enough to reorder two promises.
 * Waiting for a CARD waits for the read that actually put it there.
 */
async function settled(): Promise<void> {
  await screen.findByRole('heading', { name: cabbageArea.name, level: 2 });
  await screen.findByText('Dara A.', { selector: '.mktcard__who' });
}

/**
 * A card, found by the name printed on it.
 *
 * BY ITS OWN CLASS AND NOT BY `getByRole('button')`. The drag layer wraps every
 * card in a node that dnd-kit gives `role="button"` of its own, so a role query
 * finds the WRAPPER first — and a click on the wrapper is a drag handle rather
 * than an open. Anchoring on the line that prints the person's name reaches the
 * card itself, which is the thing a person actually clicks.
 */
const card = (name: string): HTMLElement => {
  const who = screen
    .getAllByText(name, { selector: '.mktcard__who' })
    .map((node) => node.closest('.mktcard'))
    .find((node): node is HTMLElement => node !== null);
  if (who === undefined) throw new Error(`no card for ${name}`);
  return who;
};

// ============================================================================

describe('which board it opens on', () => {
  it('lands on the BUSIEST served district and writes it into the URL', async () => {
    aWorkingShop();
    mount();

    /*
     * The default that is never wrong. Landing alphabetically on an empty board
     * is a click an operator always has to undo; `replace` keeps the fallback
     * out of the history stack so Back does not walk through it.
     */
    await waitFor(() => expect(address()).toContain(`district=${cabbageArea.id}`));
    await settled();
  });

  it('asks for ONE district on the board and for the WHOLE city on the desk', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * TWO READS, TWO SCOPES — the structural claim of the whole screen.
     *
     * A desk that inherited `?district=` would stop being the thing that tells
     * an operator another district is on fire, which is the only reason it sits
     * above the board instead of inside it.
     * ═══════════════════════════════════════════════════════════════════════
     */
    aWorkingShop();
    mount();

    await waitFor(() => {
      const asked = askedAll('/api/marketing/returns');
      const board = asked.find((p) => p.includes('view=all'));
      const desk = asked.find((p) => p.includes('view=needs_action'));
      expect(board).toContain(`district=${cabbageArea.id}`);
      expect(desk).toBeDefined();
      expect(desk).not.toContain('district=');
    });
  });

  it('honours a district already in the URL rather than overriding it', async () => {
    aWorkingShop();
    mount(`/marketing/returns?district=${turnipArea.id}`);

    await screen.findByRole('heading', { name: turnipArea.name, level: 2 });
    expect(address()).toContain(turnipArea.id);
  });
});

describe('the switcher', () => {
  it('badges a district from the API, not from the cards on screen', async () => {
    /*
     * The board holds five cards and the fixture's `needsAction` is three. A
     * switcher counting what it can see would say five here — and would say ZERO
     * for every district it is not currently showing, which is the one question
     * it exists to answer.
     */
    aWorkingShop();
    mount();

    const trigger = await screen.findByRole('button', { name: new RegExp(cabbageArea.name) });
    expect(within(trigger).getByText(String(cabbageArea.needsAction))).toBeTruthy();
  });

  it('lists an idle district quietly, and lets you go there anyway', async () => {
    /*
     * Removing it would read as "we do not serve there", which is a different
     * and much worse claim than "nothing is waiting there today". So it is
     * listed, without a badge, and says why it is quiet.
     *
     * IT USED TO BE INERT, on the reasoning that there would be nothing to do on
     * arrival. That was wrong twice: the screen can already be sitting on an idle
     * board — open it on a quiet morning and every column reads "Nothing here" —
     * and now that the list has a search field, a row you typed the name of and
     * cannot click is the most frustrating control on the screen.
     */
    aWorkingShop();
    mount();

    const trigger = await screen.findByRole('button', { name: new RegExp(cabbageArea.name) });
    await userEvent.click(trigger);

    const menu = await screen.findByRole('listbox');
    const idle = within(menu).getByRole('option', { name: new RegExp(turnipArea.name) });
    expect(within(idle).getByText('nothing waiting')).toBeTruthy();
    /* No badge: there is no number, and a zero would be one. */
    expect(within(idle).queryByText('0')).toBeNull();
  });

  it('filters the districts as you type, which is why the field is there', async () => {
    /*
     * The list is every served district in the country. Scrolling it was the
     * whole complaint — three letters is the only interaction that scales.
     */
    aWorkingShop();
    mount();

    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(cabbageArea.name) }),
    );
    await userEvent.type(screen.getByRole('textbox'), turnipArea.name.slice(1, 5));

    const menu = screen.getByRole('listbox');
    expect(within(menu).getByRole('option', { name: new RegExp(turnipArea.name) })).toBeTruthy();
    /* Matched anywhere in the name, not only at the front — the search skipped
       the first letter above and still found it. */
    expect(within(menu).queryByRole('option', { name: new RegExp(cabbageArea.name) })).toBeNull();
  });

  it('never names the served city — every sentence is rendered from data', async () => {
    aWorkingShop();
    mount();
    await settled();
    expect(document.body.textContent ?? '').not.toMatch(new RegExp(SERVED_CITY, 'i'));
  });
});

describe('the desk above the boards', () => {
  it('says WHY each row is there, not just its stage', async () => {
    aWorkingShop();
    mount();

    const desk = await screen.findByRole('region', { name: 'Waiting on you' });
    // The database's words for the same two facts are worse at prompting an
    // action, so the desk says what a person can do about it.
    expect(within(desk).getAllByText('No pickup booked').length).toBeGreaterThan(0);
    expect(within(desk).getByText('Arrived — not counted')).toBeTruthy();
  });

  it('names the board each row lives on', async () => {
    // The desk is whole-of-city, so the Area column is how a row says which
    // board to go to. A row with no area says so in the danger colour.
    aWorkingShop();
    mount();
    const desk = await screen.findByRole('region', { name: 'Waiting on you' });
    expect(within(desk).getAllByText(cabbageArea.name).length).toBeGreaterThan(0);
  });
});

describe('the board', () => {
  it('lands each card in the column matching its status', async () => {
    aWorkingShop();
    mount();

    await settled();
    expect(within(column('Requested')).getByText('Dara A.')).toBeTruthy();
    expect(
      within(column('Scheduled')).getByText(scheduledRow.customerName ?? scheduledRow.customerEmail),
    ).toBeTruthy();
    /* "Picked up" is a DISPLAY label for the wire value `collected` — the wire
     * word never reaches a screen. */
    expect(column('Picked up')).toBeTruthy();
  });

  it('offers "Log a return" under Requested ONLY', async () => {
    /*
     * That is the one list a return can be BORN into. A create control under the
     * others would be offering to fabricate a history that never happened.
     */
    aWorkingShop();
    mount();

    await settled();
    expect(within(column('Requested')).getByRole('button', { name: /log a return/i })).toBeTruthy();
    for (const heading of ['Scheduled', 'Picked up', 'Received']) {
      expect(
        within(column(heading)).queryByRole('button', { name: /log a return/i }),
      ).toBeNull();
    }
  });

  it('bands a card by its age, in words as well as in colour', async () => {
    /*
     * Colour is never the only carrier. The 100-hour card is past the danger
     * band and the 3-hour one is in no band at all — and both say their wait in
     * text, for anybody who cannot separate the red bar from the amber.
     */
    aWorkingShop();
    mount();

    await settled();
    const old = card('Dara A.');
    expect(old.className).toContain('mktcard--danger');
    expect(within(old).getByText('4d')).toBeTruthy();

    const fresh = card(requestedNew.customerName ?? requestedNew.customerEmail);
    expect(fresh.className).not.toContain('mktcard--danger');
    expect(fresh.className).not.toContain('mktcard--warn');
  });

  it('renders the programme’s own words and never the shipped preset’s', async () => {
    aWorkingShop();
    mount();

    await settled();
    expect(screen.getAllByText(/canisters/).length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
  });
});

describe('acting on a card', () => {
  it('opens the card as a modal over the board, and gives focus back on close', async () => {
    /*
     * The board stays behind it — which is what makes the panel read as a card
     * LIFTED OFF the board rather than a page you navigated to. Focus returns to
     * the card, because that is where the operator was looking; without the
     * restore, the next keystroke goes to `document.body`.
     */
    aWorkingShop();
    when('/api/marketing/returns/ret_dara_1', returnDetails.requested);
    mount();

    await settled();
    const opened = card('Dara A.');
    opened.focus();
    await userEvent.click(opened);

    const modal = await screen.findByRole('dialog', { name: 'Return' });
    expect(address()).toContain('id=ret_dara_1');
    /* The board is still mounted underneath. */
    expect(screen.getByRole('heading', { name: cabbageArea.name, level: 2 })).toBeTruthy();

    await userEvent.click(within(modal).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Return' })).toBeNull());
    expect(document.activeElement).toBe(opened);
  });

  it('hides the bonus stepper from a WRITER — absent, not disabled', async () => {
    /*
     * Minting points above the programme's rate is money, and the role matrix
     * reserves money for the owner. A disabled control would advertise a
     * capability and then refuse it; the server's 403 is the backstop.
     */
    fixture.session.user.role = 'writer';
    aWorkingShop();
    when('/api/marketing/returns/ret_tunde_1', returnDetails.received);
    mount();

    await settled();
    await userEvent.click(card('Tunde B.'));

    const modal = await screen.findByRole('dialog', { name: 'Return' });
    expect(within(modal).queryByLabelText('Bonus points')).toBeNull();
    /* …and the same writer can still count what arrived, which is the half a
     * `requireOwner` on the route would have broken. */
    expect(within(modal).getByRole('button', { name: /count what arrived/i })).toBeTruthy();
  });

  it('shows the owner the arithmetic a bonus changes, before committing it', async () => {
    fixture.session.user.role = 'owner';
    aWorkingShop();
    when('/api/marketing/returns/ret_tunde_1', returnDetails.received);
    mount();

    await settled();
    await userEvent.click(card('Tunde B.'));

    const modal = await screen.findByRole('dialog', { name: 'Return' });
    const stepper = within(modal).getByLabelText('Bonus points');
    await userEvent.clear(stepper);
    await userEvent.type(stepper, '25');

    /* 6 declared × 7 promised = 42, plus 25 = 67 — in front of the person
     * committing it, which is the only reason the control lives beside the sum
     * rather than in a settings panel. */
    await waitFor(() => expect(within(modal).getByText(/67 Bottle Caps total/)).toBeTruthy());
    expect(within(modal).getByText(/42 \+ 25 bonus/)).toBeTruthy();
  });

  it('keeps the bonus stepper off a return that has not reached Received yet — absent, not disabled', async () => {
    /*
     * `pointsAwarded === null` is true for a COLLECTED return exactly as it is
     * for a received one — nothing has been inspected yet either way — so
     * gating the stepper on that alone offered an owner this box on a return
     * still "Picked up", with no button anywhere in the modal that could ever
     * submit what they typed into it: "Count what arrived…" below only renders
     * for `status === 'received'`. Same rule this file already pins for a
     * writer, applied to the OTHER precondition the box was missing.
     */
    fixture.session.user.role = 'owner';
    aWorkingShop();
    when(`/api/marketing/returns/${collectedRow.id}`, returnDetails.collected);
    mount();

    await settled();
    await userEvent.click(card(collectedRow.customerEmail));

    const modal = await screen.findByRole('dialog', { name: 'Return' });
    expect(within(modal).queryByLabelText('Bonus points')).toBeNull();
    expect(within(modal).queryByRole('button', { name: /count what arrived/i })).toBeNull();
  });
});

describe('many cards at once', () => {
  async function pick(names: string[]): Promise<void> {
    for (const name of names) {
      await userEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Select ${name}`) }));
    }
  }

  it('offers only what is legal for EVERY card, and greys the rest WITH the reason', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE INTERSECTION RULE. Two Requested cards and one Scheduled card share
     * only "note" — so "Mark picked up" is greyed rather than hidden, because a
     * control that silently disappears reads as a bug and sends somebody
     * looking for a feature the board still has.
     * ═══════════════════════════════════════════════════════════════════════
     */
    aWorkingShop();
    mount();
    await settled();

    await pick(['Dara A.']);
    const bar = await screen.findByRole('region', { name: 'Selected returns' });
    expect(within(bar).getByRole('button', { name: /schedule/i }).getAttribute('aria-disabled')).toBe(
      'false',
    );

    await pick([scheduledRow.customerEmail]);
    /* Schedule survives — it is legal from both `requested` and `scheduled`
     * (a reschedule) — and collect does not, because the requested card cannot
     * be collected. */
    expect(
      within(bar).getByRole('button', { name: /mark picked up/i }).getAttribute('aria-disabled'),
    ).toBe('true');
    /* The reason NAMES A CARD. "Not legal for every card" is true and useless. */
    expect(within(bar).getByText(new RegExp(`Not legal for ${requestedOld.customerName}`))).toBeTruthy();
  });

  it('reports a PARTIAL failure per card rather than pretending it rolled back', async () => {
    /*
     * There are no transactions on the server, so a bulk call IS a loop of
     * single statements. "4 of 5" is what happened; an all-or-nothing message
     * would be a claim the backend never made.
     */
    aWorkingShop();
    when('/api/marketing/returns/bulk', {
      results: [
        { id: requestedOld.id, ok: true, request: requestedOld },
        { id: requestedNew.id, ok: false, error: 'stale_write' },
      ],
    });
    mount();
    await settled();

    await pick(['Dara A.', requestedNew.customerEmail]);
    const bar = await screen.findByRole('region', { name: 'Selected returns' });
    await userEvent.click(within(bar).getByRole('button', { name: /schedule/i }));

    const dialog = await screen.findByRole('dialog');
    /* One body, applied to all — said out loud so nobody mistakes the first
     * card's details for all of them. */
    expect(within(dialog).getByText(/applied to all 2 selected/i)).toBeTruthy();

    await userEvent.type(
      within(dialog).getByLabelText('Pickup date and time'),
      '2026-08-20T10:00',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Schedule pickup' }));

    await waitFor(() => {
      const body = sent('/api/marketing/returns/bulk', 'POST');
      expect(body.action).toBe('schedule');
      expect((body.items as unknown[]).length).toBe(2);
    });
    /* The failure NAMES the card, so somebody knows which one to look at. */
    await screen.findByText(new RegExp(`1 of 2 updated.*${requestedNew.customerEmail}`, 'i'));
  });
});
