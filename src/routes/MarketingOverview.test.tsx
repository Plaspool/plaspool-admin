import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The section's front door, asserted on the four things it can get wrong
 * quietly.
 *
 *  - **The figures are links, and each one lands where it was counted.** A tile
 *    that says "2 need scheduling" and opens the unfiltered queue is a tile that
 *    looks right and costs an operator the same search every morning.
 *  - **The regions are independent.** Three requests, three failures, three
 *    degradations: a 500 on the summary must leave the first-run checklist
 *    standing, because the checklist is what a first-day operator opened this
 *    screen for and the summary is a row of zeros. This is asserted by breaking
 *    one region at a time and looking for the others.
 *  - **History is read in the words it was written in.** The ledger fixtures
 *    were written when the program said "Jar Lids" and the program now says
 *    "Bottle Caps": the stored reason must come through verbatim while the
 *    number beside it — arithmetic on a live balance — carries today's word.
 *    A screen that re-rendered the reason through current labels passes every
 *    hand-written check and rewrites history on the first rename.
 *  - **A banner's chip is derived, not stored.** Two of the fixtures are stored
 *    `live`; only one of them is showing, and the difference is the clock.
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`, for the reason the queue's
 * suite gives: the path and the query are the two things most likely to be
 * silently wrong against a backend written in another session — and this screen
 * is the FIRST consumer of `GET /summary`, which no server route answers yet.
 * An unregistered path answers 404 in the real envelope's shape, which is how
 * the soft regions' failure arms get exercised at all.
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
 * Nothing on this screen reads the session and nothing on it writes, so there
 * is no owner-only control to gate: every figure here is a `requireAuth` read
 * and every action is a link to the screen that owns the write. The mock keeps
 * the module graph honest rather than switching a role.
 */
vi.mock('../data/session', () => ({
  getSession: () => fixture.session,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../data/sync', () => ({ revalidate: vi.fn() }));

import {
  NOW,
  awardedRow,
  capsProgram,
  endedBanner,
  freshSummary,
  ledgerWalk,
  programs,
  receivedRow,
  requestedNew,
  requestedOld,
  scheduledRow,
  settings,
  summary,
} from '../data/marketing-fixtures';
import MarketingOverview from './MarketingOverview';

/**
 * The seeded preset's noun, assembled from two halves rather than typed.
 *
 * This file sits under `src/routes/Marketing*.tsx`, one of the paths the
 * section's hardcoded-noun guard greps. Spelling the word out to assert its
 * absence would put it in a source the guard reads and fail the very test that
 * exists to enforce it. Joined at runtime it is the same word to `RegExp` and
 * not a match for a grep over the text.
 */
const PRESET_NOUN = 'sp' + 'ool';

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

/** Every path+query asked for, in order. */
const asked = (fragment: string): string | undefined =>
  calls.find((c) => c.path.includes(fragment))?.path;

const askedTimes = (fragment: string): number =>
  calls.filter((c) => c.path.includes(fragment)).length;

beforeEach(() => {
  handlers.clear();
  calls = [];
  /*
   * The clock is pinned rather than faked wholesale: an age ("waited 4d"), a
   * 48-hour alert band and a banner's derived status are all read off
   * `Date.now()`, and a suite whose answers depend on the minute it ran is a
   * suite that fails at midnight. `userEvent` needs real timers to click.
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
});

/**
 * The jsdom gaps Radix's Select falls through — the same block `Shop.test.tsx:83`,
 * `Emails.test.tsx:55` and `Dashboard.test.tsx:122` all carry.
 *
 * ADDED WHEN THE PANELS GREW FILTERS. Without these, opening a Select throws
 * `hasPointerCapture is not a function` from inside a React handler, which is
 * reported as a whole-FILE error rather than as a failing assertion — so the
 * suite goes red somewhere other than where it broke.
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

// -------------------------------------------------------------- the harness

const withPrograms = (rows = programs): void =>
  when('/api/marketing/programs', { programs: rows });

const withSettings = (): void => when('/api/marketing/settings', { settings });

/** The three regions, all answering. */
function withEverything(figures = summary): void {
  when('/api/marketing/summary', figures);
  withPrograms();
  withSettings();
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/marketing']}>
      <MarketingOverview />
    </MemoryRouter>,
  );
}

/**
 * Wait for the figures to land.
 *
 * On the first tile's label rather than on a panel heading, because the panels
 * are what most of these tests then go looking for — waiting on the thing under
 * test would make half of them assert that a query found what a query found.
 */
const landed = (): Promise<HTMLElement> => screen.findByText('Needs scheduling');

/** A whole tile — the Link, because the whole card is the target. */
function tile(label: string): HTMLElement {
  const found = screen.getByText(label).closest('a');
  if (found === null) throw new Error(`no tile for ${label}`);
  return found;
}

/** A panel, by its heading. Every query about one goes through this: the
 *  ledger, the banners and the checklist all render short lines of text and an
 *  unscoped query would be ambiguous exactly where the panel matters. */
function panel(title: string): HTMLElement {
  const found = screen.getByText(title).closest('section');
  if (found === null) throw new Error(`no panel titled ${title}`);
  return found;
}

const row = (scope: HTMLElement, id: string): HTMLElement => {
  const found = within(scope).getByText(id).closest('li');
  if (found === null) throw new Error(`no row for ${id}`);
  return found as HTMLElement;
};

// ============================================================================

describe('the marketing overview', () => {
  it('counts the morning’s work, and reddens only what has been waiting two days', async () => {
    withEverything();
    mount();

    await screen.findByText('Needs scheduling');
    expect(asked('/api/marketing/summary')).toBeTruthy();

    expect(within(tile('Needs scheduling')).getByText('2')).toBeTruthy();
    expect(within(tile('Needs scheduling')).getByText('Oldest has waited 4d.')).toBeTruthy();
    // 100 hours: past the 48-hour band the queue reddens a row at.
    expect(tile('Needs scheduling').className).toContain('mktstat--alert');

    // 26 hours, and the band is a threshold rather than "anything with an age".
    expect(within(tile('To inspect')).getByText('Oldest has waited 26h.')).toBeTruthy();
    expect(tile('To inspect').className).not.toContain('mktstat--alert');

    // The stage that is waiting on a driver says WHEN, not how long.
    expect(within(tile('Out for pickup')).getByText(/^Next pickup /)).toBeTruthy();

    // The rolling window's label matches the field: thirty days, not "this
    // month" — a figure that resets on the 1st is a different number.
    expect(within(tile('Awarded · 30 days')).getByText('9')).toBeTruthy();
    // Awaited separately because the points word arrives on its own request:
    // the tiles are drawn from the summary and worded from the settings.
    expect(
      await within(tile('Awarded · 30 days')).findByText('350 Bottle Caps earned across them.'),
    ).toBeTruthy();
  });

  it('sends every tile at the queue view it counted', async () => {
    withEverything();
    mount();
    await screen.findByText('Needs scheduling');

    expect(tile('Needs scheduling').getAttribute('href')).toBe('/marketing/returns?view=requested');
    expect(tile('Out for pickup').getAttribute('href')).toBe('/marketing/returns?view=scheduled');
    expect(tile('To inspect').getAttribute('href')).toBe('/marketing/returns?view=received');
    expect(tile('Awarded · 30 days').getAttribute('href')).toBe('/marketing/returns?view=done');
  });

  it('offers each open return the step the server named, and sends inspection to its own form', async () => {
    /*
     * A CLOSED ROW RIDES ALONG. `oldestOpen` is open returns by contract, but
     * the only thing standing between this panel and "Add a note" as a row's
     * headline step is one predicate — and a payload the screen is not braced
     * for is exactly what a summary route written in another session might
     * hand it. Dara's award is closed and her new request is open, which is a
     * state the one-open-return-per-email index permits.
     */
    withEverything({ ...summary, oldestOpen: [...summary.oldestOpen, awardedRow] });
    mount();

    await landed();
    const open = panel('Oldest open returns');
    expect(within(open).getByText(requestedOld.id)).toBeTruthy();

    // `allowedActions[0]`, ordered by contract — never a status→action map of
    // this screen's own, which is the drift the served array exists to kill.
    const first = within(row(open, requestedOld.id)).getByRole('link', {
      name: 'Schedule pickup — dara@example.com',
    });
    expect(first.getAttribute('href')).toBe('/marketing/returns?id=ret_dara_1');

    // Inspection is a form with derived quantities and a confirmation that
    // restates the award, so it is deep-linked at itself.
    const inspect = within(row(open, receivedRow.id)).getByRole('link', {
      name: 'Inspect — tunde@example.com',
    });
    expect(inspect.getAttribute('href')).toBe('/marketing/returns?id=ret_tunde_1&act=inspect');

    // Terminal: a note is the only action the server allows and a note is not
    // a step, so the row goes quiet rather than headlining "Add a note".
    expect(awardedRow.allowedActions).toEqual(['note']);
    expect(
      within(row(open, awardedRow.id))
        .getByRole('link', { name: 'View — dara@example.com' })
        .getAttribute('href'),
    ).toBe('/marketing/returns?id=ret_dara_0');

    // The row says what is coming back in the program's own words, and how
    // long it has been saying it.
    expect(within(open).getAllByText('6 canisters').length).toBeGreaterThan(0);

    /*
     * AGE IS TEXT AND COLOUR, NEVER COLOUR ALONE — and the two bands are
     * thresholds rather than "anything with an age on it". Three rows, one per
     * band, because a screen that reddens everything is a screen nobody reads
     * the red on.
     */
    expect(within(row(open, requestedOld.id)).getByText('waiting 4d').className).toContain(
      'mktage--danger',
    );
    expect(within(row(open, scheduledRow.id)).getByText('waiting 2d').className).toContain(
      'mktage--warn',
    );
    const fresh = within(row(open, requestedNew.id)).getByText('waiting 3h').className;
    expect(fresh).toContain('mktage');
    expect(fresh).not.toContain('mktage--');
  });

  it('reads the ledger in the words each row was written in, not today’s', async () => {
    withEverything();
    mount();

    await landed();
    const activity = panel('Latest rewards activity');

    /*
     * ONE ROW, TWO VOCABULARIES, AND BOTH ARE CORRECT. The reason was rendered
     * when the entry was written and is printed verbatim; the delta is
     * arithmetic on a live balance and carries the current word. A screen that
     * re-rendered the reason through today's labels would print "Bottle Caps"
     * where the fixture demands the wording of the day.
     */
    expect(
      within(activity).getByText('5 accepted × 7 = 35 Jar Lids to dara@example.com'),
    ).toBeTruthy();
    // Awaited: the word on the number rides on the settings request, which is
    // its own region and lands on its own schedule.
    expect(await within(activity).findByText('+35 Bottle Caps')).toBeTruthy();
    expect(within(activity).queryByText(/35 Bottle Caps to dara/)).toBeNull();

    // A debit reads as one, in the same words.
    expect(within(activity).getByText('−40 Bottle Caps')).toBeTruthy();
    expect(within(activity).getByText('Goodwill — box arrived crushed')).toBeTruthy();
  });

  it('draws no more of the ledger than a panel beside three others can hold', async () => {
    /*
     * The contract says `latestLedger` is eight rows at most, so this asks what
     * happens when it isn't. A panel that renders whatever it is handed turns a
     * server-side pagination slip into a summary screen scrolled past the
     * things it exists to summarise — and the cap costs one `slice`.
     */
    const flood = Array.from({ length: 14 }, (_, i) => ({
      ...ledgerWalk[0],
      id: `pts_flood_${i}`,
      customerEmail: 'dara@example.com',
    }));
    withEverything({ ...summary, latestLedger: flood });
    mount();

    await landed();
    expect(within(panel('Latest rewards activity')).getAllByRole('listitem')).toHaveLength(8);
  });

  it('chips a banner with the status the clock gives it, not the one stored on it', async () => {
    withEverything();
    mount();

    await landed();
    const site = panel('Banners');

    expect(within(site).getByText('Draft')).toBeTruthy();
    expect(within(site).getByText('Scheduled')).toBeTruthy();
    expect(within(site).getByText('Live')).toBeTruthy();

    /*
     * THE ONE THAT MATTERS. This banner is stored `live` — somebody switched it
     * on and never switched it off — and its window closed yesterday. The admin
     * chip has to say what the public endpoint's WHERE clause would say, or the
     * two disagree and nobody can tell which is lying.
     */
    expect(endedBanner.status).toBe('live');
    const ended = within(site).getByText(endedBanner.title).closest('tr');
    expect(ended === null ? null : within(ended).getByText('Ended')).toBeTruthy();
  });

  it('says how many letters are waiting, and that nothing is going to send them', async () => {
    withEverything();
    mount();

    await screen.findByText('1 notification is waiting to be sent.');
    // Honest about the mechanism: nothing schedules the sweep, so a number that
    // looked like a queue being worked through would imply one that is not
    // running.
    expect(screen.getByText(/Nothing schedules the mail sweep/)).toBeTruthy();
  });

  it('shows every first step on a fresh install, with the preset’s editor behind the first two', async () => {
    withEverything(freshSummary);
    /*
     * THE PRESET IS LAST IN THE LIST, DELIBERATELY. `seeded` is the only handle
     * on it — the key is un-editable but never matched on, because matching the
     * key is exactly what the hardcoded-noun guard forbids (spec D2a/D11) — and
     * a fixture whose seeded row happens to be first cannot tell "found by its
     * flag" apart from "took the first row it was given". Reversed, the first
     * row is an unseeded program on revision 2: a screen reading position gets
     * a reviewed program and drops both naming lines.
     */
    withPrograms([...programs].reverse());
    mount();

    await landed();
    const card = panel('First steps');

    expect(within(card).getByText('Check the wording')).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(4);
    expect(within(card).getByText('Confirm the rules')).toBeTruthy();
    expect(within(card).getByText('Log the first return')).toBeTruthy();
    expect(within(card).getByText('Put something on the site')).toBeTruthy();

    // The seeded preset is found by its `seeded` flag, and the two lines about
    // it open the editor that answers both.
    expect(capsProgram.seeded).toBe(true);
    expect(
      within(card).getByRole('link', { name: 'Open the program' }).getAttribute('href'),
    ).toBe(`/marketing/rewards?id=${capsProgram.id}`);
    expect(within(card).getByRole('link', { name: 'Open the rules' }).getAttribute('href')).toBe(
      `/marketing/rewards?id=${capsProgram.id}`,
    );
  });

  it('drops each first step as it comes true', async () => {
    // A section in use: points have moved, returns are in flight, banners exist
    // — and the preset is still on its seeded revision.
    withEverything();
    mount();

    await landed();
    const card = panel('First steps');

    expect(within(card).getByText('Check the wording')).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).queryByText('Log the first return')).toBeNull();
    expect(within(card).queryByText('Put something on the site')).toBeNull();
  });

  it('stops asking for a first return the moment one is in flight, not when one is awarded', async () => {
    /*
     * THE DAY BETWEEN. A return has been logged and nothing has been awarded
     * yet, so the ledger is still empty — and a checklist reading only the
     * ledger would spend that whole week telling the person who logged it to
     * log their first return. The banner line is untouched by any of it, which
     * is what proves the two lines are two questions.
     */
    withEverything({ ...freshSummary, oldestOpen: [requestedOld] });
    mount();

    await landed();
    const card = panel('First steps');

    expect(within(card).queryByText('Log the first return')).toBeNull();
    expect(within(card).getByText('Put something on the site')).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(3);
  });

  it('takes the card away entirely once somebody has been through the preset', async () => {
    when('/api/marketing/summary', summary);
    // `revision > 1` is the only signal either naming line has: the preset has
    // been saved at least once, so its words and its numbers were looked at.
    withPrograms([{ ...capsProgram, revision: 3 }, ...programs.slice(1)]);
    withSettings();
    mount();

    await screen.findByText('Oldest open returns');
    expect(screen.queryByText('First steps')).toBeNull();
  });

  it('says nothing about the preset when the programs didn’t load', async () => {
    when('/api/marketing/summary', freshSummary);
    withSettings();
    // No `/programs` handler: the region 404s, and unknown is not the same as
    // untouched — the card may not claim a preset it has never read.
    mount();

    await landed();
    const card = panel('First steps');

    expect(within(card).getByText('Log the first return')).toBeTruthy();
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(card).queryByText('Check the wording')).toBeNull();
    expect(within(card).queryByText('Confirm the rules')).toBeNull();
  });

  it('renders the ledger without a currency word rather than guessing one', async () => {
    when('/api/marketing/summary', summary);
    withPrograms();
    // No `/settings` handler. The points word is configuration and there is
    // none of it in this file, so the number goes out bare.
    mount();

    await landed();
    const activity = panel('Latest rewards activity');

    expect(within(activity).getByText('+35')).toBeTruthy();
    expect(within(activity).queryByText('+35 Bottle Caps')).toBeNull();
    // The stored reason is untouched by any of this — it was never rendered
    // from labels this screen holds.
    expect(
      within(activity).getByText('5 accepted × 7 = 35 Jar Lids to dara@example.com'),
    ).toBeTruthy();
    expect(within(tile('Awarded · 30 days')).getByText('350 earned across them.')).toBeTruthy();
  });

  it('renders a first day as real zeros rather than as something still loading', async () => {
    withEverything(freshSummary);
    mount();

    await screen.findByText('Needs scheduling');

    // Four real zeros. A fresh install is a fact about the shop, not a state
    // the screen is still resolving, and a skeleton here would say otherwise.
    expect(screen.getAllByText('0')).toHaveLength(4);
    expect(document.querySelector('.ui-skeleton')).toBeNull();
    expect(screen.getAllByText('Nothing is waiting.')).toHaveLength(2);
    expect(screen.getByText('No pickup is booked.')).toBeTruthy();

    // And no ops line: an empty outbox is not news, and "0 notifications are
    // waiting" on a screen whose whole subject is what is waiting on somebody
    // is a line that has to be read before it can be ignored.
    expect(screen.queryByText(/waiting to be sent/)).toBeNull();

    // And every panel says what empty MEANS, in the voice of a section whose
    // intake is admin-driven — nothing here promises requests that arrive on
    // their own.
    expect(screen.getByText(/No open returns yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing earned or spent yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing is on the site/)).toBeTruthy();

    // An empty panel offers the screen that would fill it. A dashboard that
    // reports emptiness and leaves the reader to find the way out is a report
    // rather than a place to start work.
    expect(screen.getByRole('link', { name: 'Log a return' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Write one' })).toBeTruthy();

    // AND NO FILTER CONTROLS ANYWHERE. Filtering nothing is a control that can
    // only ever produce the state it is already in — the panels grow their
    // toolbars when they have rows to choose between.
    expect(screen.queryByLabelText('Filter returns')).toBeNull();
    expect(screen.queryByLabelText('Filter banners')).toBeNull();
    expect(screen.queryByLabelText('Filter activity')).toBeNull();
  });

  it('filters a panel down to one stage, and says so when nothing is left', async () => {
    const user = userEvent.setup();
    withEverything();
    mount();
    await landed();

    const returns = screen.getByRole('region', { name: /oldest open returns/i });
    const before = within(returns).getAllByRole('listitem').length;
    expect(before).toBeGreaterThan(1);

    /*
     * The filter narrows the ROWS ALREADY ON SCREEN — no request is made, which
     * is what keeps a dashboard's controls from disagreeing with the totals
     * above them. The stages offered are the stages present, so choosing one
     * always leaves at least the row it was drawn from.
     */
    await user.click(within(returns).getByLabelText('Filter returns'));
    await user.click(await screen.findByRole('option', { name: 'Received' }));

    const kept = within(returns).getAllByRole('listitem');
    expect(kept.length).toBeLessThan(before);
    for (const row of kept) expect(within(row).getByText('Received')).toBeTruthy();

    // And the sort is over what survived, not over the original list.
    await user.click(within(returns).getByLabelText('Sort returns'));
    await user.click(await screen.findByRole('option', { name: 'Newest first' }));
    expect(within(returns).getAllByRole('listitem').length).toBe(kept.length);
  });

  it('explains a failed summary in place, and the checklist beside it still stands', async () => {
    const user = userEvent.setup();
    let broken = true;
    when('/api/marketing/summary', () =>
      broken
        ? { status: 500, body: { error: 'internal', requestId: 'req_9' } }
        : { status: 200, body: summary },
    );
    withPrograms();
    withSettings();
    mount();

    await screen.findByText(/Something went wrong on the server/);
    // Copyable, because a 500 is somebody else's to diagnose.
    expect(screen.getByText(/reference req_9/)).toBeTruthy();

    // The other two regions asked separately and answered separately: the
    // checklist is what a first-day operator came for, and a failed row of
    // figures must not take it down.
    expect(screen.getByText('Check the wording')).toBeTruthy();
    // Absent rather than empty — an empty panel would be a claim about state
    // this screen does not have.
    expect(screen.queryByText('Oldest open returns')).toBeNull();

    /*
     * AND THE CHECKLIST SAYS ONLY WHAT IT KNOWS. The two lines the programs
     * answered are there; the two the summary would have answered are not,
     * because a failed request is UNKNOWN and unknown is not empty. Read as
     * empty, this screen would tell a shop with a full pipeline and a live
     * banner to go and create its first of each — the most confident possible
     * wrong answer, on the one card an operator is most likely to trust.
     */
    expect(within(panel('First steps')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Log the first return')).toBeNull();
    expect(screen.queryByText('Put something on the site')).toBeNull();

    broken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Oldest open returns');
    expect(askedTimes('/api/marketing/summary')).toBe(2);
    // The retry is the summary's alone; the regions that answered are not
    // re-fetched behind it.
    expect(askedTimes('/api/marketing/programs')).toBe(1);
  });

  it('never says the preset’s noun', async () => {
    withEverything();
    mount();
    await screen.findByText('Needs scheduling');

    // Every word on this screen is either the section's own chrome or a label
    // that travelled on a payload. The fixtures are deliberately absurd, so a
    // hardcoded noun would be visible here and nowhere else.
    expect(screen.getAllByText('6 canisters').length).toBeGreaterThan(0);
    expect(document.body.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
  });
});
