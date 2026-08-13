import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The return detail — the screen the whole section exists to reach.
 *
 * A separate file from the queue's suite because it asserts a different set of
 * claims, and they are the ones that cost money if they are wrong:
 *
 *  - **The arithmetic is stated before it is committed, and it is ONE string.**
 *    The live line under the counts, the confirmation that restates it, the
 *    success toast and (on the server) the customer's email are all
 *    `awardSentence()`. If those four ever drift, a dispute becomes
 *    unreconstructible — so the parity is pinned, not trusted.
 *  - **Rejected is derived and never typed.** Two boxes and a subtraction; the
 *    classic "your numbers don't add up" refusal has nowhere to come from.
 *  - **A lost race does not cost a count.** Every 409 carries the re-read
 *    entity, and the treatment is to show the true stage WITHOUT wiping a
 *    half-counted inspection. Somebody who counted six canisters must not have
 *    to count them again over a race they did not cause.
 *  - **History is read in the words it was written in.** The `inspected` event
 *    carries the labels as they were at the time; the fixtures rename the
 *    program afterwards, so a screen that re-rendered history through today's
 *    labels prints "Bottle Caps" where this suite asks for "Jar Lids".
 *  - **The letter the award owes gets sent.** Nothing schedules the sweep, so
 *    the admin's own click is the delivery mechanism — and a deployment with no
 *    transport gets a setup note, never a retry loop.
 *
 * `fetch` is stubbed rather than `../data/api-marketing`, for the queue suite's
 * reason: the path, the method and the exact body are the three things most
 * likely to be silently wrong against a backend written in another session, and
 * a mocked module asserts none of them.
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
  OLD_LABELS,
  awardedRow,
  cancelledRow,
  receivedRow,
  requestedOld,
  returnDetails,
  scheduledRow,
} from '../data/marketing-fixtures';
import type { ReturnDetail } from '../data/api-marketing';
import MarketingReturns from './MarketingReturns';

const HOUR = 3_600_000;

/**
 * The seeded preset's unit noun, assembled rather than typed — this file is
 * under `src/routes/`, which the section's hardcoded-noun guard greps, and
 * spelling the word out to assert its absence would fail the very test that
 * enforces it. Joined at runtime it is the same word to `RegExp`.
 */
const PRESET_NOUN = 'sp' + 'ool';

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

const asked = (fragment: string): string | undefined =>
  calls.find((c) => c.path.includes(fragment))?.path;

const askedTimes = (fragment: string): number =>
  calls.filter((c) => c.path.includes(fragment)).length;

/**
 * How many times a path was READ.
 *
 * Exact and method-filtered, because every write on this screen hangs off the
 * detail's own path — `/inspect`, `/notes`, `/schedule` all begin with it — so a
 * substring count of re-reads would silently include the write that caused them.
 */
const reads = (pathname: string): number =>
  calls.filter((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') === 'GET')
    .length;

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

const path = (id: string): string => `/api/marketing/returns/${id}`;

/** Serve one return's detail, and answer its programs list so nothing 404s. */
function withDetail(detail: ReturnDetail): void {
  when('/api/marketing/programs', { programs: [] });
  when(path(detail.request.id), detail);
}

function mount(at: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <MarketingReturns />
      </MemoryRouter>
    </ToastProvider>,
  );
}

/**
 * Wait for a detail to land.
 *
 * On the reference panel's heading rather than on the return's id, which the
 * screen deliberately renders TWICE — once in the masthead line and once as a
 * copyable field — so a query for it is ambiguous by design.
 */
const landed = (): Promise<HTMLElement> => screen.findByText('Details');

/** Open the detail of a fixture return and wait for it to land. */
async function open(detail: ReturnDetail, search = ''): Promise<void> {
  withDetail(detail);
  mount(`/marketing/returns?id=${detail.request.id}${search}`);
  await landed();
}

/** The open `<dialog>`. Both dialogs stay mounted while closed, so every
 *  in-dialog query is scoped through this — it proves the dialog opened as
 *  well as what is inside it. */
function sheet(): HTMLElement {
  const found = [...document.querySelectorAll('dialog')].find((d) => (d as HTMLDialogElement).open);
  if (found === undefined) throw new Error('no dialog is open');
  return found as HTMLElement;
}

/** The NEXT STEP panel, which is where every action on this screen lives. */
function panel(): HTMLElement {
  const found = document.querySelector('.mktdetail--act');
  if (found === null) throw new Error('no action panel');
  return found as HTMLElement;
}

/**
 * Everything that ACTS on this screen lives in that panel, and both dialogs
 * deliberately restate its wording — the confirmation repeats the award
 * sentence and the button that opened it. So every query about the form is
 * scoped to the panel, and every query about a dialog to the dialog: an
 * unscoped one would be ambiguous exactly where the parity is the point.
 */
const inPanel = () => within(panel());

const box = (name: string): HTMLInputElement =>
  inPanel().getByLabelText(name) as HTMLInputElement;

/**
 * A fixture from one row, wearing the identity of the return under test.
 *
 * The id AND the email travel together: neither ever changes over a return's
 * life, so a stand-in that moved one without the other would describe a state
 * the database cannot hold — and would quietly change the award sentence, which
 * names the customer.
 */
function asSelf(detail: ReturnDetail, id: string, email: string): ReturnDetail {
  return { ...detail, request: { ...detail.request, id, customerEmail: email } };
}

function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The inspection's default sentence for the received fixture: 6 declared, all
 *  accepted, at the rate frozen onto the request. */
const ALL_SIX = '6 accepted × 7 = 42 Bottle Caps to tunde@example.com';
const FIVE_OF_SIX = '5 accepted × 7 = 35 Bottle Caps to tunde@example.com';

/**
 * The flagship count: five of the six that arrived, and why the sixth was not
 * kept. A reason is REQUIRED once anything is rejected, so this is the shortest
 * path to a submittable inspection that is not "accept everything".
 */
async function countFiveOfSix(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(inPanel().getByRole('button', { name: 'Decrease Accepted' }));
  await user.click(inPanel().getByRole('combobox', { name: 'Why they were rejected' }));
  // Radix puts its menu in a portal at the document root, not inside the panel.
  await user.click(await screen.findByRole('option', { name: 'Damaged' }));
}

// ============================================================================

describe('the return detail', () => {
  it('draws the lifecycle as far as it has got, and names the step in one line', async () => {
    await open(returnDetails.received);

    const steps = document.querySelectorAll('.stagepath__step');
    expect(steps.length).toBe(5);
    // Done, done, done, HERE, and one still to come — "here" and "done" are
    // deliberately different marks.
    expect([...steps].map((s) => s.className)).toEqual([
      'stagepath__step is-done',
      'stagepath__step is-done',
      'stagepath__step is-done',
      'stagepath__step is-current',
      'stagepath__step',
    ]);
    // The one line a 375px screen shows instead of five labels.
    expect(screen.getByText('Step 4 of 5 — Received')).toBeTruthy();
  });

  it('states the award in the program’s own words, and the confirmation restates the same sentence', async () => {
    const user = userEvent.setup();
    await open(returnDetails.received);

    // The live line, priced from the rate frozen onto the request.
    expect(inPanel().getByText(ALL_SIX)).toBeTruthy();
    await user.click(inPanel().getByRole('button', { name: 'Record & award 42 Bottle Caps' }));

    /*
     * ONE STRING, TWICE — the line on the form, and the dialog that restates it.
     * `sheet()` throws unless a dialog is actually open, so this asserts both
     * that the confirmation appeared and that it is the SAME sentence: a
     * confirmation worded differently from the thing it confirms is a second
     * claim about the same arithmetic, and the two drift the first time either
     * is improved.
     */
    expect(within(sheet()).getByText(ALL_SIX)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
  });

  it('prices the award from the promise the return was made under, not today’s rate', async () => {
    // The program now pays 7 a unit; this request was made when it paid 3, and
    // `pointsPerUnitSnapshot` is what a customer was actually promised.
    const repriced: ReturnDetail = {
      ...returnDetails.received,
      request: { ...returnDetails.received.request, pointsPerUnitSnapshot: 3 },
    };
    await open(repriced);

    expect(screen.getByText('6 accepted × 3 = 18 Bottle Caps to tunde@example.com')).toBeTruthy();
    expect(inPanel().queryByText(ALL_SIX)).toBeNull();
  });

  it('derives what was rejected, and only then asks why', async () => {
    const user = userEvent.setup();
    await open(returnDetails.received);

    // Nothing rejected yet, so there is nothing to explain.
    expect(within(panel()).getByText('0 canisters')).toBeTruthy();
    expect(inPanel().queryByRole('combobox', { name: 'Why they were rejected' })).toBeNull();

    await user.click(inPanel().getByRole('button', { name: 'Decrease Accepted' }));

    // Received minus accepted, in the program's own unit word — and displayed,
    // never typed: there is no third box for the two counts to contradict.
    expect(within(panel()).getByText('1 canister')).toBeTruthy();
    // And it opens on nothing: a picker defaulted to "Damaged" would let an
    // inspection assert damage nobody went looking for.
    expect(
      inPanel().getByRole('combobox', { name: 'Why they were rejected' }).textContent,
    ).toContain('Pick a reason');
  });

  it('refuses a count that keeps more than arrived, and says so under the box', async () => {
    const user = userEvent.setup();
    await open(returnDetails.received);

    /*
     * The one contradiction two boxes CAN still hold. Accepted is ceilinged at
     * Received while it is being typed, but lowering Received afterwards strands
     * a number above a limit it never crossed — a driver who brought four back
     * against six already counted. The form says so where the wrong number is,
     * and refuses to open a confirmation about arithmetic it will not take.
     */
    await user.click(inPanel().getByRole('button', { name: 'Decrease Received' }));
    await user.click(inPanel().getByRole('button', { name: 'Decrease Received' }));
    expect(box('Received').value).toBe('4');
    expect(box('Accepted').value).toBe('6');
    expect(inPanel().getByText('Accepted can’t be more than received.')).toBeTruthy();

    await user.click(inPanel().getByRole('button', { name: 'Record & award 42 Bottle Caps' }));
    expect(() => sheet()).toThrow();
    expect(calls.some((c) => c.path.includes('/inspect'))).toBe(false);

    // And it clears itself the moment the numbers agree again — the refusal is
    // about the pair, not a flag somebody has to dismiss.
    await user.click(inPanel().getByRole('button', { name: 'Increase Received' }));
    await user.click(inPanel().getByRole('button', { name: 'Increase Received' }));
    expect(inPanel().queryByText('Accepted can’t be more than received.')).toBeNull();
  });

  it('leaves the reason out of an inspection that refused nothing', async () => {
    const user = userEvent.setup();
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/inspect`, {
      request: returnDetails.awarded.request,
      award: { points: 42, balance: 222 },
    });
    when('/api/marketing/sweep', { sent: 1, failed: 0, skipped: 0 });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await user.click(inPanel().getByRole('button', { name: 'Record & award 42 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 42 Bottle Caps' }));

    await waitFor(() => expect(asked(`${path(receivedRow.id)}/inspect`)).toBeTruthy());
    /*
     * EXACTLY these three. `rejectedReason` is a sentence the customer reads
     * back off the ledger and out of their email, so an inspection that refused
     * nothing must not carry one — the unchosen picker's placeholder travelling
     * as a stored reason is a nonsense the server has no way to spot, and an
     * empty note is absence rather than a blank line on the timeline.
     */
    expect(sent(`${path(receivedRow.id)}/inspect`, 'POST')).toEqual({
      expectedRevision: receivedRow.revision,
      qtyAccepted: 6,
      qtyRejected: 0,
    });
  });

  it('records five of six, says so in the same sentence, and sends the letter it owes', async () => {
    const user = userEvent.setup();
    const awarded = asSelf(returnDetails.awarded, receivedRow.id, receivedRow.customerEmail);
    let served: ReturnDetail = returnDetails.received;
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), (_url, init) => {
      if (init.method === 'POST') {
        served = awarded;
        return { body: { request: awarded.request, award: { points: 35, balance: 215 } } };
      }
      return { body: served };
    });
    when(`${path(receivedRow.id)}/inspect`, () => {
      served = awarded;
      return { body: { request: awarded.request, award: { points: 35, balance: 215 } } };
    });
    when('/api/marketing/sweep', { sent: 1, failed: 0, skipped: 0 });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await countFiveOfSix(user);
    await user.type(box('Note'), 'One canister is dented');
    await user.click(inPanel().getByRole('button', { name: 'Record & award 35 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 35 Bottle Caps' }));

    await waitFor(() => expect(asked(`${path(receivedRow.id)}/inspect`)).toBeTruthy());
    expect(sent(`${path(receivedRow.id)}/inspect`, 'POST')).toEqual({
      expectedRevision: receivedRow.revision,
      qtyAccepted: 5,
      // Derived by the screen and posted by it — the server records both counts
      // and its award CHECK is written over them.
      qtyRejected: 1,
      // The heading and what was typed beside it, as ONE render-final string:
      // this is what the customer is told and what the ledger keeps.
      rejectedReason: 'Damaged — One canister is dented',
      note: 'One canister is dented',
    });

    // The same sentence again, this time as the answer.
    expect(await screen.findByText(`Recorded — ${FIVE_OF_SIX}`)).toBeTruthy();
    // Nothing schedules the sweep, so this click is what sends the mail.
    expect(asked('/api/marketing/sweep')).toBeTruthy();
  });

  it('relabels the primary when nothing is being kept, and refuses it without a reason', async () => {
    const user = userEvent.setup();
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/inspect`, {
      request: { ...returnDetails.rejected.request, id: receivedRow.id },
      award: null,
    });
    when('/api/marketing/sweep', { sent: 0, failed: 0, skipped: 1 });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    // NOT the /reject endpoint — that one is illegal once the goods are in hand.
    // It prefills the inspection so the quantities are still counted.
    await user.click(inPanel().getByRole('button', { name: 'Reject everything…' }));
    const record = inPanel().getByRole('button', { name: 'Record — nothing to award' });

    // A refusal still has to say why, and the form asks before the server does.
    await user.click(record);
    expect(inPanel().getByText('Pick a reason for the ones being refused.')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/inspect'))).toBe(false);

    await user.click(inPanel().getByRole('combobox', { name: 'Why they were rejected' }));
    await user.click(await screen.findByRole('option', { name: 'Not ours' }));
    await user.click(record);
    await user.click(within(sheet()).getByRole('button', { name: 'Record — nothing to award' }));

    await waitFor(() => expect(asked(`${path(receivedRow.id)}/inspect`)).toBeTruthy());
    expect(sent(`${path(receivedRow.id)}/inspect`, 'POST')).toEqual({
      expectedRevision: receivedRow.revision,
      // Zero SURVIVES the body pruner, and it is the number that makes this a
      // rejection rather than a body the server refuses for a missing field.
      qtyAccepted: 0,
      qtyRejected: 6,
      rejectedReason: 'Not ours',
    });
  });

  it('keeps a half-counted inspection when somebody else got there first', async () => {
    const user = userEvent.setup();
    const moved = asSelf(returnDetails.awarded, receivedRow.id, receivedRow.customerEmail).request;
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/inspect`, () => ({
      status: 409,
      body: {
        error: 'invalid_transition',
        status: 'awarded',
        action: 'inspect',
        // Every 409 in this section carries the re-read entity.
        request: moved,
        requestId: 'req_9',
      },
    }));
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await countFiveOfSix(user);
    await user.click(inPanel().getByRole('button', { name: 'Record & award 35 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 35 Bottle Caps' }));

    // Said out loud…
    expect(
      await screen.findByText(/Somebody else has already moved this return/),
    ).toBeTruthy();
    // …the true stage is rendered from the payload, with no second read…
    expect(screen.getByText('Step 5 of 5 — Awarded')).toBeTruthy();
    expect(reads(path(receivedRow.id))).toBe(1);
    // …and the five somebody counted is still on screen, with the reason.
    expect(box('Accepted').value).toBe('5');
    expect(inPanel().getByText(FIVE_OF_SIX)).toBeTruthy();
    expect(
      inPanel().getByRole('combobox', { name: 'Why they were rejected' }).textContent,
    ).toContain('Damaged');
  });

  it('offers the revision it lost to, and keeps the count that lost', async () => {
    const user = userEvent.setup();
    let refused = false;
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/inspect`, () => {
      if (refused) {
        return {
          body: { request: returnDetails.received.request, award: { points: 35, balance: 215 } },
        };
      }
      refused = true;
      return {
        status: 409,
        body: {
          error: 'stale_write',
          expected: receivedRow.revision,
          actual: 9,
          request: { ...returnDetails.received.request, revision: 9 },
          requestId: 'req_10',
        },
      };
    });
    when('/api/marketing/sweep', { sent: 0, failed: 0, skipped: 0 });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await countFiveOfSix(user);
    await user.click(inPanel().getByRole('button', { name: 'Record & award 35 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 35 Bottle Caps' }));

    // A lost CAS is not an illegal move: the stage is unchanged, so the form is
    // still valid — it only needs the revision it lost to, which the payload
    // carried. No second read.
    await inPanel().findByRole('button', { name: 'Load theirs' });
    expect(box('Accepted').value).toBe('5');
    await user.click(inPanel().getByRole('button', { name: 'Load theirs' }));

    await user.click(inPanel().getByRole('button', { name: 'Record & award 35 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 35 Bottle Caps' }));
    await waitFor(() =>
      expect(sent(`${path(receivedRow.id)}/inspect`, 'POST').expectedRevision).toBe(9),
    );
    expect(sent(`${path(receivedRow.id)}/inspect`, 'POST').qtyAccepted).toBe(5);
  });

  it('treats a replayed inspection as the success it already was', async () => {
    const user = userEvent.setup();
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/inspect`, {
      error: 'already_awarded',
      entryId: 'pts_77',
      requestId: 'req_11',
    }, 409);
    when('/api/marketing/sweep', { sent: 0, failed: 0, skipped: 0 });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await user.click(inPanel().getByRole('button', { name: 'Record & award 42 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 42 Bottle Caps' }));

    /*
     * It means the FIRST attempt landed and its answer was lost on the way back
     * — which is what a dropped warehouse connection produces. Anything other
     * than success here tells an operator their inspection failed while the
     * customer's points are already in the ledger.
     */
    expect(await screen.findByText('That inspection was already recorded.')).toBeTruthy();
    expect(screen.queryByText(/Somebody else/)).toBeNull();
    await waitFor(() => expect(reads(path(receivedRow.id))).toBe(2));
    /*
     * And the letter still goes. The attempt that landed is the one whose answer
     * was lost, so it is exactly the attempt whose fire-and-forget never fired —
     * and nothing schedules the sweep, so a replay that skipped it would leave
     * the customer's mail queued for good over a dropped connection.
     */
    expect(asked('/api/marketing/sweep')).toBeTruthy();
  });

  it('turns a missing mail transport into a setup note rather than a retry loop', async () => {
    const user = userEvent.setup();
    const awarded = asSelf(returnDetails.awarded, receivedRow.id, receivedRow.customerEmail);
    let served: ReturnDetail = returnDetails.received;
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), () => ({ body: served }));
    when(`${path(receivedRow.id)}/inspect`, () => {
      served = awarded;
      return { body: { request: awarded.request, award: { points: 42, balance: 222 } } };
    });
    when(
      '/api/marketing/sweep',
      { error: 'mail_not_configured', requestId: 'req_12' },
      501,
    );
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();

    await user.click(inPanel().getByRole('button', { name: 'Record & award 42 Bottle Caps' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Record & award 42 Bottle Caps' }));

    // A persistent band, because it is a deployment setting somebody has to go
    // and change — and the intents are still queued, so nothing was lost.
    expect(await screen.findByText('Email transport isn’t configured')).toBeTruthy();
    expect(document.querySelector('.notice--warn')?.textContent ?? '').toContain(
      '1 notification',
    );
    // Asked once. A client that re-asked would produce the same 501 forever.
    expect(askedTimes('/api/marketing/sweep')).toBe(1);
  });

  it('reads history in the words it was written in, not today’s', async () => {
    await open(returnDetails.awarded);

    // The program says "Bottle Caps" and "canisters" NOW. This row was written
    // when it said something else, and it keeps saying it: a rename changes the
    // future, never what a customer was already told.
    const line = screen.getByText(
      `5 ${OLD_LABELS.unitLabelPlural} accepted · 1 rejected · 35 ${OLD_LABELS.pointsLabelPlural} awarded`,
    );
    expect(line.closest('li')?.textContent ?? '').not.toMatch(/Bottle Cap/);

    // And every kind of thing that happened is on the timeline, named.
    for (const what of [
      'Return requested',
      'Pickup scheduled',
      'Picked up by the driver',
      'Received at the warehouse',
      'Note added',
      'Inspected',
    ]) {
      expect(screen.getByText(what)).toBeTruthy();
    }
    expect(screen.getByText('Queued — sends with the next sweep')).toBeTruthy();
  });

  it('says a notification is queued or stuck, and never that it was delivered', async () => {
    const stuck: ReturnDetail = {
      ...returnDetails.awarded,
      emailIntents: [
        { kind: 'return_awarded', sentAt: null, attempts: 3, lastError: 'Recipient rejected' },
      ],
    };
    await open(stuck);

    // Three tries and still nothing — said out loud, with the mailer's own words
    // beside it, because the alternative is an award that looks delivered.
    expect(screen.getByText('3 failed attempts — still queued')).toBeTruthy();
    expect(document.querySelector('.mktmail__err')?.textContent).toBe('Recipient rejected');

    cleanup();
    // A row that HAS left is proof of a hand-off, never of a delivery: this
    // screen only ever knows that the mailer took it.
    await open({
      ...returnDetails.awarded,
      emailIntents: [
        { kind: 'return_awarded', sentAt: NOW - HOUR, attempts: 1, lastError: null },
      ],
    });
    expect(screen.getByText(/^Handed to the mailer/)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/\bSent\b/);
  });

  it('adds a note without moving the return', async () => {
    const user = userEvent.setup();
    when('/api/marketing/programs', { programs: [] });
    when(path(receivedRow.id), returnDetails.received);
    when(`${path(receivedRow.id)}/notes`, {
      event: {
        id: 'mev_new',
        type: 'note',
        actorType: 'admin',
        actorId: 'u_owner',
        note: 'Driver says the box was already open',
        data: null,
        occurredAt: NOW,
      },
    });
    mount(`/marketing/returns?id=${receivedRow.id}`);
    await landed();
    const before = reads(path(receivedRow.id));

    await user.type(screen.getByLabelText('Add a note'), 'Driver says the box was already open');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    expect(await screen.findByText('Driver says the box was already open')).toBeTruthy();
    expect(sent(`${path(receivedRow.id)}/notes`, 'POST')).toEqual({
      note: 'Driver says the box was already open',
    });
    // The response IS the event, and a note bumps nothing — so nothing is re-read.
    expect(reads(path(receivedRow.id))).toBe(before);
  });

  it('aims the cursor at the count when the queue sent somebody here to inspect', async () => {
    await open(returnDetails.received, '&act=inspect');

    // The queue never opens the inspection in a dialog; it navigates, and the
    // deep link has to land on the first thing there is to type.
    await waitFor(() => expect(document.activeElement).toBe(box('Received')));
  });

  it('offers exactly the actions the server allows, and never invents one', async () => {
    await open(returnDetails.collected);

    // Collected is deliberately cancellable — the lost-in-transit escape — and
    // deliberately NOT rejectable: post-receipt refusals go through inspect so
    // the quantities are recorded.
    expect(within(panel()).getByRole('button', { name: 'Cancel return…' })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Reject request…' })).toBeNull();
    // The stage's note names the currency in the PROGRAM's word, never "points".
    expect(screen.getByText(/Bottle Caps are computed at inspection/)).toBeTruthy();

    cleanup();
    await open(returnDetails.scheduled);
    // A scheduled return may be re-scheduled, and the button says so.
    expect(within(panel()).getByRole('button', { name: 'Reschedule…' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Reject request…' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Cancel return…' })).toBeTruthy();
  });

  it('books a pickup from the panel and re-reads the return it moved', async () => {
    const user = userEvent.setup();
    when('/api/marketing/programs', { programs: [] });
    when(path(requestedOld.id), returnDetails.requested);
    when(`${path(requestedOld.id)}/schedule`, {
      request: { ...returnDetails.scheduled.request, id: requestedOld.id },
    });
    mount(`/marketing/returns?id=${requestedOld.id}`);
    await landed();
    const before = reads(path(requestedOld.id));

    const at = localInput(NOW + 20 * HOUR);
    fireEvent.change(screen.getByLabelText('Pickup date and time'), { target: { value: at } });
    await user.click(within(panel()).getByRole('button', { name: 'Schedule pickup' }));

    await waitFor(() => expect(asked(`${path(requestedOld.id)}/schedule`)).toBeTruthy());
    expect(sent(`${path(requestedOld.id)}/schedule`, 'POST')).toEqual({
      expectedRevision: requestedOld.revision,
      pickupAt: new Date(at).getTime(),
      // Offered back from the request rather than retyped, and it travels.
      pickupAddress: requestedOld.pickupAddress,
    });
    // The whole detail is re-read: the timeline gained an entry and the panel
    // owes a different form now.
    await waitFor(() => expect(reads(path(requestedOld.id))).toBeGreaterThan(before));
  });

  it('carries the stage’s one action in the phone bar, and submits the panel’s own form', async () => {
    const user = userEvent.setup();
    await open(returnDetails.received);

    const mirror = document.querySelector('.mktbar button') as HTMLButtonElement;
    // MIRRORS, never replaces: `form=` points at the panel's own form, so the
    // same client-side refusals run whichever button was pressed — which is what
    // keeps the flow working while a phone keyboard covers the bar. It also
    // carries the same words, because two names for one action is one name
    // nobody recognises.
    expect(mirror.getAttribute('form')).toBe(panel().querySelector('form')?.getAttribute('id'));
    expect(mirror.textContent).toBe('Record & award 42 Bottle Caps');

    // And pressing it reaches the same confirmation the inline submit does.
    await user.click(mirror);
    expect(within(sheet()).getByText(ALL_SIX)).toBeTruthy();
    // …at which point the bar is GONE rather than sitting over the sheet it
    // opened: it is fixed to the bottom of the viewport, which is exactly where
    // a bottom sheet puts its own confirm button.
    expect(document.querySelector('.mktbar')).toBeNull();
  });

  it('says how a closed return ended instead of drawing a sixth dot', async () => {
    await open(returnDetails.rejected);

    // Rejected is a different ending, not a later step — so the path is replaced
    // rather than extended with a branch it never walks again.
    expect(document.querySelector('.stagepath')).toBeNull();
    const band = document.querySelector('.notice--danger');
    expect(band?.textContent ?? '').toContain('Rejected');
    expect(band?.textContent ?? '').toContain('Not ours — different brand entirely.');

    // Nothing to do, and nothing that writes: a closed return keeps its history.
    expect(within(panel()).queryByRole('button')).toBeNull();
    expect(document.querySelector('.mktbar')).toBeNull();
    // Notes still work — they are legal in every state.
    expect(screen.getByLabelText('Add a note')).toBeTruthy();
  });

  it('goes back to the queue somebody actually had', async () => {
    await open(returnDetails.cancelled, '&view=all&q=ada');

    expect(
      screen.getByRole('link', { name: 'Back to the queue' }).getAttribute('href'),
    ).toBe('/marketing/returns?view=all&q=ada');
    // The email is the way into the customer's balance and history.
    expect(
      screen.getByRole('link', { name: cancelledRow.customerEmail }).getAttribute('href'),
    ).toBe(`/marketing/customers?email=${encodeURIComponent(cancelledRow.customerEmail)}`);
  });

  it('says a return is gone rather than offering to try again', async () => {
    when('/api/marketing/programs', { programs: [] });
    // Nothing registered for the detail: a 404 in the real envelope's shape.
    mount(`/marketing/returns?id=${awardedRow.id}`);

    expect(await screen.findByText('That return no longer exists')).toBeTruthy();
    // `gone` is permanent; a Try again here could only fail identically.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the queue' })).toBeTruthy();
  });

  it('explains a detail that didn’t load, and offers the read again', async () => {
    when('/api/marketing/programs', { programs: [] });
    when(path(scheduledRow.id), { error: 'internal', requestId: 'req_500' }, 500);
    mount(`/marketing/returns?id=${scheduledRow.id}`);

    expect(
      await screen.findByText('Something went wrong on the server — reference req_500.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('shows an awarded return what it paid, in the wording it paid it under', async () => {
    await open(returnDetails.awarded);

    // The award panel is history too: read through the snapshot the inspection
    // left behind, not through the labels the program carries today.
    expect(
      screen.getByText(
        `5 ${OLD_LABELS.unitLabelPlural} accepted · 35 ${OLD_LABELS.pointsLabelPlural} awarded`,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View the ledger entry →' })).toBeTruthy();
    // Nothing left to write, so no bar and no primary.
    expect(document.querySelector('.mktbar')).toBeNull();
  });
});
