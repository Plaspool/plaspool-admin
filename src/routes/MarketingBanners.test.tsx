import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The banners screen, asserted on the five things it can get wrong quietly.
 *
 *  - **A status read back instead of worked out.** Nothing stores "live now" —
 *    the row stores an intent and the clock decides the rest, through the pure
 *    function the public endpoint's WHERE clause is written to match. The
 *    fixtures are five rows that land on five different derived words at the
 *    same instant, so a screen that rendered `banner.status` would show three
 *    of them wrong and look entirely reasonable doing it.
 *  - **A row that says Live while the site shows nothing.** The failure nobody
 *    can diagnose from a chip: switched on, inside no window, or beaten to its
 *    place by a higher number. "Why not showing?" has to name the condition, and
 *    name it from the same rule the storefront reads.
 *  - **A restatement that agrees with the saved row rather than with the boxes.**
 *    The status sentence exists to be read BEFORE saving; rendered from state
 *    that has already been written it agrees with everything and warns about
 *    nothing.
 *  - **A patch that loses a cleared date.** `null` is a real value on these
 *    bodies — "no end date" is a decision — so an empty box has to travel as
 *    `null` on a PATCH and be absent entirely on a POST, and the two are
 *    asserted key by key rather than "contains what I typed".
 *  - **A preview that eats the draft.** The full-screen stage is the same
 *    component, not a second route: coming back has to find half-typed words
 *    still half-typed, or the phone story is "look at it and start again".
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`, for the reason the other
 * marketing suites give: the path, the method and the body are the three things
 * most likely to be silently wrong against a backend written in another session,
 * and a mocked module asserts none of them.
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
  archivedBanner,
  banners,
  bannersWithRival,
  draftBanner,
  endedBanner,
  liveBanner,
  rivalBanner,
  scheduledBanner,
} from '../data/marketing-fixtures';
import type { Banner } from '../data/api-marketing';
import MarketingBanners from './MarketingBanners';

/**
 * The seeded preset's noun, assembled from two halves rather than typed — this
 * file is one of the paths the section's hardcoded-noun guard greps, so spelling
 * the word out to assert its absence would fail the very test that enforces it.
 */
const PRESET_NOUN = 'sp' + 'ool';

/**
 * What jsdom does not implement and Radix needs the moment a Select popup or a
 * Switch is touched, plus the `<dialog>` shim the archive confirmation needs —
 * the same blocks `Shop.test.tsx` and the other marketing suites carry.
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

const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

beforeEach(() => {
  handlers.clear();
  calls = [];
  /* Pinned rather than faked wholesale: `userEvent` needs real timers to type,
     and every derived status below is the fixtures' own fixed clock crossed
     with the fixtures' own windows. */
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

// -------------------------------------------------------------- the harness

const BANNERS = '/api/marketing/banners';

/** The fixtures' own step, restated: the file keeps it private, and the tie-break
 *  below needs two rows a day apart rather than two rows a millisecond apart. */
const DAY = 24 * 60 * 60 * 1000;

/** The list (#21 — every status, no paging) and, on the same path, the create. */
function serve(rows: Banner[] = banners, write?: Responder): void {
  when(BANNERS, (url, init) => {
    if ((init.method ?? 'GET') === 'POST') {
      return write !== undefined
        ? write(url, init)
        : { status: 201, body: { banner: { ...draftBanner, id: 'bnr_new' } } };
    }
    return { body: { banners: rows } };
  });
}

/** One row's PATCH. The default echoes the write back with the revision moved
 *  on, which is what a server that accepted it would do. */
function servePatch(row: Banner, respond?: Responder): void {
  when(
    `${BANNERS}/${row.id}`,
    respond ??
      ((_url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const { expectedRevision: _at, ...fields } = body;
        return { body: { banner: { ...row, ...fields, revision: row.revision + 1 } } };
      }),
  );
}

/** Shows the router's current URL, so a test can assert where a link went. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount(at = '/marketing/banners') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <MarketingBanners />
        <Address />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const editorFor = (banner: Banner): string => `/marketing/banners?id=${banner.id}`;

/** The `.mktform__field` an input sits in, which is where its error belongs. */
function field(label: string): HTMLElement {
  const found = screen.getByLabelText(label).closest('.mktform__field');
  if (found === null) throw new Error(`no field around ${label}`);
  return found as HTMLElement;
}

/** The table row a banner is drawn on. */
function rowOf(title: string): HTMLElement {
  const found = screen.getByRole('link', { name: title }).closest('tr');
  if (found === null) throw new Error(`no row for ${title}`);
  return found as HTMLElement;
}

// ============================================================================

describe('the banners screen', () => {
  it('gives every row the status the clock decides, not the one it stores', async () => {
    serve();
    mount();

    await screen.findByRole('link', { name: liveBanner.title });

    /*
     * FIVE ROWS, FIVE DIFFERENT WORDS, AT ONE INSTANT. Three of these are stored
     * as `live` — the scheduled one, the showing one and the expired one — and
     * only the clock tells them apart, which is why the rule is a pure function
     * both sides of the wire call rather than a column either side reads.
     */
    expect(within(rowOf(draftBanner.title)).getByText('Draft')).toBeTruthy();
    expect(within(rowOf(scheduledBanner.title)).getByText('Scheduled')).toBeTruthy();
    expect(within(rowOf(liveBanner.title)).getByText('Live')).toBeTruthy();
    expect(within(rowOf(endedBanner.title)).getByText('Ended')).toBeTruthy();
    expect(within(rowOf(archivedBanner.title)).getByText('Archived')).toBeTruthy();

    // The window in words, both ends and each absence.
    expect(within(rowOf(draftBanner.title)).getByText('whenever it is on')).toBeTruthy();
    expect(within(rowOf(liveBanner.title)).getByText(/→/)).toBeTruthy();

    /* An archived banner is still LISTED — there is no delete anywhere in this
       section — under a heading of its own rather than mixed in with the rows
       somebody is actually working on. */
    const group = rowOf(archivedBanner.title).closest('section');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByRole('heading', { name: 'Archived' })).toBeTruthy();
    expect(within(group as HTMLElement).queryByText(liveBanner.title)).toBeNull();
  });

  it('says which condition a switched-on banner is failing', async () => {
    serve(bannersWithRival);
    mount();

    await screen.findByRole('link', { name: liveBanner.title });

    // A window that closed. The chip says Ended; this says why that matters and
    // what to change, because "Ended" alone reads like a fact rather than a fix.
    const ended = within(rowOf(endedBanner.title));
    expect(ended.getByText(/^Why not showing\?/)).toBeTruthy();
    expect(ended.getByText(/Its window closed on/)).toBeTruthy();
    expect(ended.getByText(/extend the end date to relaunch it/)).toBeTruthy();

    /*
     * THE ONE A STATUS CHIP CANNOT EXPLAIN. This row is switched on, inside its
     * window, and derived Live — and invisible, because something with a higher
     * number holds the same place. The evaluator names the winner and its
     * priority, so the fix is a number rather than a mystery.
     */
    const loser = within(rowOf(rivalBanner.title));
    expect(loser.getByText('Live')).toBeTruthy();
    expect(loser.getByText(/A higher priority banner has the top bar/)).toBeTruthy();
    expect(loser.getByText(new RegExp(liveBanner.title))).toBeTruthy();
    expect(loser.getByText(/at 10\./)).toBeTruthy();

    /* The third condition the evaluator walks, and the only one with a date in
       the future: switched on, beaten by nobody, and simply early. */
    const early = within(rowOf(scheduledBanner.title));
    expect(early.getByText(/window doesn’t open until/)).toBeTruthy();

    // The winner is showing, so it says nothing…
    expect(within(rowOf(liveBanner.title)).queryByText(/Why not showing/)).toBeNull();
    // …and neither does a draft: unfinished is not "not showing", and a
    // complaint under every row somebody is still writing is noise.
    expect(within(rowOf(draftBanner.title)).queryByText(/Why not showing/)).toBeNull();

    /*
     * A TIE IS NOT A COIN TOSS. The public route orders `priority DESC,
     * createdAt DESC` (contract #29), so two rows sharing a number are separated
     * by age and the newer one wins. The evaluator restates that ORDER BY rather
     * than guessing, which is the difference between naming the row the site
     * would actually pick and naming whichever came first in the array.
     */
    cleanup();
    const older: Banner = { ...liveBanner, id: 'bnr_older', title: 'Older twin', createdAt: NOW - 9 * DAY };
    const newer: Banner = { ...liveBanner, id: 'bnr_newer', title: 'Newer twin', createdAt: NOW - DAY };
    serve([older, newer]);
    mount();

    await screen.findByRole('link', { name: 'Older twin' });
    expect(within(rowOf('Older twin')).getByText(/“Newer twin”/)).toBeTruthy();
    expect(within(rowOf('Newer twin')).queryByText(/Why not showing/)).toBeNull();
  });

  it('switches a draft on, and says what saving will do before it is saved', async () => {
    const user = userEvent.setup();
    serve();
    servePatch(draftBanner);
    mount(editorFor(draftBanner));

    expect(await screen.findByText(/Nothing is shown and nothing is scheduled/)).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: 'Showing on the site' }));

    /*
     * PRE-SAVE, AND FROM THE BOXES. The sentence restates the FORM, so switching
     * a banner on with a window that closed last week has to say so here rather
     * than let the operator find out from a chip on the list afterwards. It is
     * written in the future tense for the same reason — nothing has been written.
     */
    expect(screen.getByText('Will be Live the moment you save.')).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${draftBanner.id}`)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    await waitFor(() => expect(sent(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toBeTruthy());
    /*
     * KEY BY KEY, AND THE NULLS ARE THE POINT. Banner patches are the one family
     * of body this section does not prune, because "no end date" and "no button"
     * are decisions: pruned, the request that clears a boundary would quietly
     * change nothing at all.
     */
    expect(sent(`${BANNERS}/${draftBanner.id}`, 'PATCH')).toEqual({
      expectedRevision: 1,
      title: draftBanner.title,
      body: draftBanner.body,
      ctaText: null,
      ctaUrl: null,
      placement: 'section',
      status: 'live',
      startsAt: null,
      endsAt: null,
      priority: 0,
    });
  });

  it('archives from a confirmation, and archiving is the only way off the site', async () => {
    const user = userEvent.setup();
    serve();
    servePatch(liveBanner);
    mount(editorFor(liveBanner));

    await user.click(await screen.findByRole('button', { name: 'Archive banner…' }));
    await user.click(await screen.findByRole('button', { name: 'Archive it' }));

    /*
     * ONE FIELD, NOT THE WHOLE FORM. "Archive this" and "save these words" are
     * two different intentions, and folding a half-finished edit into the
     * request that takes a banner off the site would save words nobody asked to
     * save.
     */
    await waitFor(() => expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toBeTruthy());
    expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toEqual({
      expectedRevision: liveBanner.revision,
      status: 'archived',
    });
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe('/marketing/banners'),
    );

    // An archived row does not offer it a second time — the switch is how one
    // comes back — and nothing anywhere on this screen deletes.
    cleanup();
    serve();
    mount(editorFor(archivedBanner));
    await screen.findByDisplayValue(archivedBanner.title);
    expect(screen.queryByRole('button', { name: 'Archive banner…' })).toBeNull();
    expect(screen.getByText(/Switching it on brings it back/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('refuses half a button, on the half that is missing', async () => {
    const user = userEvent.setup();
    serve();
    servePatch(liveBanner);
    mount(editorFor(liveBanner));

    await screen.findByDisplayValue(liveBanner.title);
    await user.clear(screen.getByLabelText('Button text'));
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    /*
     * THE COLUMN'S OWN CHECK — `(cta_text IS NULL) = (cta_url IS NULL)` —
     * mirrored on the half that is empty. Left to the server this arrives as a
     * 400 naming whichever field its schema happened to read first, which may
     * not be the box anybody has to change.
     */
    expect(within(field('Button text')).getByText('A button needs words on it.')).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${liveBanner.id}`)).toBe(true);

    // And the other way round, on the other box.
    await user.type(screen.getByLabelText('Button text'), 'Read more');
    await user.clear(screen.getByLabelText('Button link'));
    await user.click(screen.getByRole('button', { name: 'Save banner' }));
    expect(within(field('Button link')).getByText('Say where the button goes.')).toBeTruthy();

    /* A path on your own site is a legal destination — the CHECK is
       `^(https?://|/)` — so the message must not insist on a full link, and a
       relative one must actually go through. */
    await user.type(screen.getByLabelText('Button link'), '/returns');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));
    await waitFor(() => expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toBeTruthy());
    expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toMatchObject({
      ctaText: 'Read more',
      ctaUrl: '/returns',
    });
  });

  it('refuses a blank title, a link that could run code, and a rank below zero', async () => {
    const user = userEvent.setup();
    serve();
    servePatch(liveBanner);
    mount(editorFor(liveBanner));

    const title = await screen.findByDisplayValue(liveBanner.title);
    await user.clear(title);
    await user.type(title, '   ');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    /* `title <> '' AND title = btrim(title)` is a column CHECK, so three spaces
       is not a title. Left to the server it comes back as a constraint
       violation on a row nobody can see. */
    expect(within(field('Title')).getByText(/A banner needs a title/)).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${liveBanner.id}`)).toBe(true);

    await user.clear(title);
    await user.type(title, 'Send them back');

    /*
     * THE URL CHECK IS A SECURITY CONSTRAINT, NOT TIDINESS, and it is the reason
     * this assertion exists at all: this is the one table a cookieless public
     * endpoint serves straight to the storefront, so a `javascript:` destination
     * is stored XSS with a publish button in front of it. The column refuses it
     * (`cta_url ~ '^(https?://|/)'`); the form has to refuse it one request
     * earlier, and on the box, or the operator learns about it from a 400.
     */
    const link = screen.getByLabelText('Button link');
    await user.clear(link);
    await user.type(link, 'javascript:alert(1)');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    expect(within(field('Button link')).getByText(/full https:\/\/ link/)).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${liveBanner.id}`)).toBe(true);

    await user.clear(link);
    await user.type(link, 'https://example.com/returns');

    /* A priority is a place in a queue and there is no minus-first place — and
       the refusal has to say WHICH thing was wrong with it: `-1` is a whole
       number, so an error that asks for one names nothing to change. */
    const rank = screen.getByLabelText('Priority');
    await user.clear(rank);
    await user.type(rank, '-1');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    expect(within(field('Priority')).getByText(/zero or more/)).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${liveBanner.id}`)).toBe(true);

    // Corrected, the three of them travel together.
    await user.clear(rank);
    await user.type(rank, '3');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    await waitFor(() => expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toBeTruthy());
    expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toMatchObject({
      title: 'Send them back',
      ctaUrl: 'https://example.com/returns',
      priority: 3,
    });
  });

  it('refuses a window that ends before it starts, on the end', async () => {
    const user = userEvent.setup();
    serve();
    servePatch(liveBanner);
    mount(editorFor(liveBanner));

    await screen.findByDisplayValue(liveBanner.title);
    // `liveBanner` starts a day before the fixtures' NOW; this ends a fortnight
    // before that. The DB CHECK is `ends_at > starts_at`.
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-07-30T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    // On the END, because a window is entered start-first and the end is the
    // box that was got wrong.
    expect(
      within(field('Ends')).getByText('The end has to come after the start.'),
    ).toBeTruthy();
    expect(sentNothing(`${BANNERS}/${liveBanner.id}`)).toBe(true);

    /* Emptying it is not an error but a DECISION — "until you turn it off" — and
       it has to survive as a real `null` rather than being pruned out of the
       body on its way to a server that would then change nothing. */
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save banner' }));
    await waitFor(() => expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toBeTruthy());
    expect(sent(`${BANNERS}/${liveBanner.id}`, 'PATCH')).toMatchObject({ endsAt: null });
  });

  it('shows the stage full screen, and comes back to what was typed', async () => {
    const user = userEvent.setup();
    serve();
    mount(editorFor(liveBanner));

    const title = await screen.findByDisplayValue(liveBanner.title);
    await user.clear(title);
    await user.type(title, 'Half typed');

    await user.click(screen.getByRole('link', { name: 'Full screen' }));

    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toContain('preview=1'),
    );
    // The stage draws the UNSAVED words — that is the whole reason it exists.
    const stage = document.querySelector('.bnrpreview__stage');
    expect(stage).not.toBeNull();
    expect(within(stage as HTMLElement).getByText('Half typed')).toBeTruthy();
    /* And nothing in it is a control. A popup's × and a call-to-action are part
       of the PICTURE of a banner; rendered as real buttons they would be two
       dead controls, one of which navigates out of the admin. */
    expect(within(stage as HTMLElement).queryAllByRole('button')).toHaveLength(0);
    expect(within(stage as HTMLElement).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText(/not a screenshot of the storefront/)).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Back to editing' }));

    /*
     * THE DRAFT SURVIVED. The takeover is an early return inside the same
     * component, not a second route, so nothing was unmounted and nothing had to
     * be stashed anywhere. A phone that lost the words on the way to looking at
     * them would make the preview worse than useless.
     */
    expect(await screen.findByDisplayValue('Half typed')).toBeTruthy();
    expect(screen.getByTestId('address').textContent).not.toContain('preview=1');
  });

  it('creates from the empty state, as a draft, with nothing it has no value for', async () => {
    const user = userEvent.setup();
    serve([], () => ({
      status: 201,
      body: { banner: { ...draftBanner, id: 'bnr_new', title: 'Weekend hours' } },
    }));
    mount();

    // Honest about what happens next, and how soon — the public read is cached
    // for a minute, so "within a minute" is the true promise.
    expect(await screen.findByText(/checks for live banners every minute/)).toBeTruthy();

    await user.click(screen.getAllByRole('link', { name: 'New banner' })[0]);
    await waitFor(() => expect(screen.getByTestId('address').textContent).toContain('id=new'));

    // No switch here: #22 takes no status, so a control would be a promise the
    // endpoint has no field for.
    expect(screen.queryByRole('switch')).toBeNull();

    await user.type(screen.getByLabelText('Title'), 'Weekend hours');
    await user.click(screen.getByRole('button', { name: 'Create banner' }));

    await waitFor(() => expect(sent(BANNERS, 'POST')).toBeTruthy());
    /*
     * ABSENT, NOT NULL. A patch clears a value somebody set; a create has
     * nothing to clear, and sending `null` would make this body depend on the
     * create schema being nullable as well as optional — which the contract
     * never says it is.
     */
    expect(sent(BANNERS, 'POST')).toEqual({
      title: 'Weekend hours',
      placement: 'top_bar',
      priority: 0,
    });
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe('/marketing/banners'),
    );
  });

  it('offers the row somebody else saved, without asking for it again', async () => {
    const user = userEvent.setup();
    const theirs: Banner = { ...liveBanner, title: 'Somebody else’s words', revision: 9 };
    serve();
    servePatch(liveBanner, () => ({
      status: 409,
      body: {
        error: 'stale_write',
        expected: liveBanner.revision,
        actual: 9,
        banner: theirs,
        requestId: 'req_conflict',
      },
    }));
    mount(editorFor(liveBanner));

    await screen.findByDisplayValue(liveBanner.title);
    await user.type(screen.getByLabelText('Title'), '!');
    await user.click(screen.getByRole('button', { name: 'Save banner' }));

    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('Somebody else’s words')).toBeTruthy();

    await user.click(within(notice).getByRole('button', { name: 'Load theirs' }));

    /*
     * NO SECOND READ. Every 409 in this section carries the re-read entity
     * precisely so a conflict costs one request rather than two, and the list is
     * still the one fetch this editor made when it opened.
     */
    expect(await screen.findByDisplayValue('Somebody else’s words')).toBeTruthy();
    expect(reads(BANNERS)).toBe(1);
  });

  it('never says the preset’s noun', async () => {
    serve(bannersWithRival);
    const list = mount();
    await screen.findByRole('link', { name: liveBanner.title });
    expect(list.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));

    cleanup();
    serve();
    const editor = mount(editorFor(liveBanner));
    await screen.findByDisplayValue(liveBanner.title);
    expect(editor.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
  });
});
