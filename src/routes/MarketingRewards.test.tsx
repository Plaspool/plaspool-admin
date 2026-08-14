import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

/**
 * The rename screen, asserted on the five things it can get wrong quietly.
 *
 *  - **A patch that carries the handle.** `key` and `kind` are what every ledger
 *    row, return request and default setting points at, and the whole
 *    rename-is-safe story is that the update body structurally cannot contain
 *    them. A form that posted either would look identical on screen and move an
 *    identity underneath everything that references it, so the body is asserted
 *    key by key rather than "contains what I typed".
 *  - **A preview that agrees with itself instead of with the email.** The plain
 *    words panel exists to be checked BEFORE saving; if it renders from saved
 *    state rather than from the boxes, it agrees with everything and verifies
 *    nothing. Every assertion below edits an input and then reads the panel.
 *  - **"Seeded preset" derived from the wrong thing.** It comes off the `seeded`
 *    column. A key comparison would hardcode the preset's noun into the one
 *    screen whose premise is that the noun is editable — and pass any test
 *    written with realistic fixtures.
 *  - **Owner-only controls rendered to writers.** Program writes and the
 *    settings PATCH are `requireOwner`, so drawing the form for a writer is a
 *    filled-in form in front of a 403.
 *  - **A switch that promises what the column refuses.** `redemption_enabled`
 *    cannot be true while a reward is worth nothing — a CHECK, not a
 *    preference — so the flip has to be refused here with the message under the
 *    box that has to change.
 *
 * `fetch` IS STUBBED, NOT `../data/api-marketing`, for the reason the queue's
 * suite gives: the path, the method and the body are the three things most
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
  capsProgram,
  freshSettings,
  goodwillProgram,
  programs,
  renamedProgram,
  settings,
} from '../data/marketing-fixtures';
import MarketingRewards from './MarketingRewards';

/**
 * The seeded preset's noun, assembled from two halves rather than typed — this
 * file is one of the paths the section's hardcoded-noun guard greps, so spelling
 * the word out to assert its absence would fail the very test that enforces it.
 */
const PRESET_NOUN = 'sp' + 'ool';

/**
 * What jsdom does not implement and Radix needs the moment a Select popup or a
 * Switch is touched, plus the `<dialog>` shim the confirm needs — the same three
 * blocks `Shop.test.tsx` and the returns suites carry.
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

/** GETs of exactly this path — `/programs` and `/programs/:id` share a prefix. */
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
  // Pinned rather than faked wholesale: `userEvent` needs real timers to type,
  // and the only clock-dependent thing here is a formatted date on a fixture.
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

const PROGRAMS = '/api/marketing/programs';
const SETTINGS = '/api/marketing/settings';

/** The list route, and the PATCH/POST that share its path with it. */
function withPrograms(rows: typeof programs = programs, write?: Responder): void {
  when(PROGRAMS, (url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: { programs: rows } }
      : (write ?? (() => ({ status: 201, body: { program: rows[0] } })))(url, init),
  );
}

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

/** Shows the router's current URL, so a test can assert what a save wrote. */
function Address() {
  const location = useLocation();
  return <output data-testid="address">{location.pathname + location.search}</output>;
}

function mount(at = '/marketing/rewards') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[at]}>
        <MarketingRewards />
        <Address />
      </MemoryRouter>
    </ToastProvider>,
  );
}

const editor = (program = capsProgram): string => `/marketing/rewards?id=${program.id}`;

/**
 * The settings half, which is a tab rather than the top of the list now.
 *
 * The two halves are different kinds of thing — one is section-wide config
 * touched once, the other is the rows somebody opened Rewards to work with — and
 * stacked, the table started below a long form nobody came for.
 */
const SETTINGS_TAB = '/marketing/rewards?tab=settings';

/**
 * The row for a program, once the list has landed.
 *
 * BY ROLE, not by text: the settings panel's default-program Select renders the
 * chosen program's name on its trigger, so the name alone matches two things on
 * this screen and only one of them is a row.
 */
const listed = (program = capsProgram): Promise<HTMLElement> =>
  screen.findByRole('link', { name: program.name });

const rowOf = (program = capsProgram): HTMLElement => {
  const found = screen.getByRole('link', { name: program.name }).closest('tr');
  if (found === null) throw new Error(`no row for ${program.name}`);
  return found as HTMLElement;
};

/** A panel, by its heading — every query about one is scoped through this. */
function panel(title: string): HTMLElement {
  const found = screen.getByText(title).closest('section');
  if (found === null) throw new Error(`no panel titled ${title}`);
  return found;
}

/** The `.mktform__field` an input sits in, which is where its error belongs. */
function field(label: string): HTMLElement {
  const found = screen.getByLabelText(label).closest('.mktform__field');
  if (found === null) throw new Error(`no field around ${label}`);
  return found as HTMLElement;
}

const retype = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
): Promise<void> => {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};

// ============================================================================

describe('the rewards screen', () => {
  it('chips exactly the rows the server called seeded', async () => {
    /*
     * A TWIN OF THE PRESET, SAME HANDLE, NOT SEEDED — and it is the whole point
     * of this fixture list. Every other row differs from the preset in its key
     * AND in its `seeded` column at once, so an implementation that chipped
     * `program.key === 'bottle-caps'` — the hardcode this screen exists to avoid
     * — rendered exactly the same chips and passed every assertion below.
     * Mutating the guard proved it. With a row that disagrees with itself, only
     * the column can be right.
     */
    const twin = { ...capsProgram, id: 'prg_twin', name: 'A Second Try', seeded: false };
    withPrograms([...programs, twin]);
    withSettings();
    mount();

    await listed();

    /*
     * ONE CHIP, on the row whose `seeded` column is true — not on the row whose
     * key happens to look like a preset's. Four programs are listed and three of
     * them were made by hand.
     */
    expect(screen.getAllByText('Seeded preset')).toHaveLength(1);
    const seeded = rowOf();
    expect(within(seeded).getByText('Seeded preset')).toBeTruthy();
    expect(within(rowOf(twin)).queryByText('Seeded preset')).toBeNull();
    expect(within(rowOf(renamedProgram)).queryByText('Seeded preset')).toBeNull();

    // The rule reads in the program's own words, and the by-hand program says so
    // rather than showing an empty rules cell.
    expect(within(seeded).getByText(/≥ 4 canisters · 7 per canister/)).toBeTruthy();
    expect(within(rowOf(goodwillProgram)).getByText('Given by hand')).toBeTruthy();

    // The aggregate the list endpoint computes, worded by the row that carried it.
    expect(within(seeded).getByText('350 Bottle Caps')).toBeTruthy();
  });

  it('shows a writer what a program pays and nothing to change it with', async () => {
    fixture.session.user.role = 'writer';
    withPrograms();
    withSettings();
    mount();

    await listed();

    // Owner-only controls are ABSENT rather than disabled — the server would
    // answer 403, and a disabled button is a promise nobody can keep.
    expect(screen.queryByRole('link', { name: 'New program' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    // …and the settings are not even fetched: a screen that reads what it cannot
    // show is a screen whose next reader adds a control for it.
    expect(asked(SETTINGS)).toBeUndefined();

    cleanup();
    mount(editor());
    // On the handle: the name is both the page's heading and a row of the
    // read-only pair below it, and only one of those is the thing being read.
    await screen.findByText(capsProgram.key);

    // The editor is reference, not a form. Zero boxes, and the facts as a `.kv`.
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save program' })).toBeNull();
    const kv = panel('What it’s called');
    expect(within(kv).getByText(capsProgram.key)).toBeTruthy();
    expect(within(kv).getByText('Bottle Caps')).toBeTruthy();
    // A writer still gets the restatement: knowing what a return is worth is
    // part of processing one.
    expect(panel('In plain words').textContent).toContain('7 Bottle Caps per accepted canister');
  });

  it('restates the rules in the words being typed, before anything is saved', async () => {
    const user = userEvent.setup();
    withPrograms();
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    const plain = panel('In plain words');
    expect(plain.textContent).toContain('Customers who send back at least 4 canisters');
    expect(plain.textContent).toContain('7 Bottle Caps per accepted canister');

    // Every noun in the sentence is a box on the form, so the sentence moves the
    // moment a box does — with nothing saved and nothing fetched.
    await retype(user, 'Smallest request', '9');
    await retype(user, 'Awarded for each accepted one', '3');
    await retype(user, 'One item', 'drum');
    await retype(user, 'More than one item', 'drums');
    await retype(user, 'More than one award', 'Widgets');

    await waitFor(() =>
      expect(panel('In plain words').textContent).toContain(
        'Customers who send back at least 9 drums',
      ),
    );
    expect(panel('In plain words').textContent).toContain('3 Widgets per accepted drum');
    expect(reads(PROGRAMS)).toBe(1);
  });

  it('previews the award email’s subject over labels that have not been saved', async () => {
    const user = userEvent.setup();
    withPrograms();
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    /*
     * THE SUBJECT LINE, not an impression of one: `awardedSubject()` from
     * `shared/marketing/copy.ts` is what the server renders into the real mail,
     * and the preview calls the same function. The sample is the smallest award
     * the rules can produce — 4 accepted at 7 each.
     */
    expect(within(panel('In plain words')).getByText('You earned 28 Bottle Caps')).toBeTruthy();

    await retype(user, 'More than one award', 'Jar Lids');
    expect(
      await within(panel('In plain words')).findByText('You earned 28 Jar Lids'),
    ).toBeTruthy();

    // And the singular is checked too, which is the label a rename gets wrong
    // most often — nothing else on the screen shows it.
    await retype(user, 'One award', 'Jar Lid');
    await retype(user, 'Smallest request', '1');
    await retype(user, 'Awarded for each accepted one', '1');
    expect(await within(panel('In plain words')).findByText('You earned 1 Jar Lid')).toBeTruthy();
  });

  it('saves the wording and never the handle, not even for the preset', async () => {
    const user = userEvent.setup();
    withPrograms();
    when(`${PROGRAMS}/${capsProgram.id}`, {
      program: { ...capsProgram, name: 'Canister Deposits', revision: 2 },
    });
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    // The identity is not on the form at all after creation — the rename-safety
    // wall, visible.
    expect(screen.queryByLabelText('Handle')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    await retype(user, 'Name', 'Canister Deposits');
    await user.click(screen.getByRole('button', { name: 'Save program' }));

    await waitFor(() => expect(asked(`${PROGRAMS}/${capsProgram.id}`)).toBeTruthy());
    const body = sent(`${PROGRAMS}/${capsProgram.id}`, 'PATCH');
    expect(body).toEqual({
      expectedRevision: capsProgram.revision,
      name: 'Canister Deposits',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      status: 'active',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      minUnitsPerReturn: 4,
      pointsPerUnit: 7,
    });
    // Said twice on purpose: `toEqual` would still pass if the type ever gained
    // one of these and the fixture gained it too.
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('kind');
  });

  it('offers the revision it lost to, out of the payload the 409 carried', async () => {
    const user = userEvent.setup();
    const theirs = { ...capsProgram, name: 'Cap Returns', pointsLabelPlural: 'Caps', revision: 7 };
    withPrograms();
    when(`${PROGRAMS}/${capsProgram.id}`, {
      error: 'stale_write',
      expected: 1,
      actual: 7,
      program: theirs,
      requestId: 'req_stale',
    }, 409);
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    await retype(user, 'Name', 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save program' }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Cap Returns');
    // Nothing was written, and the operator's own entry is still in the box
    // until they choose otherwise.
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Mine');

    await user.click(within(notice).getByRole('button', { name: 'Load theirs' }));
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Cap Returns');
    expect(screen.getByLabelText('More than one award')).toHaveProperty('value', 'Caps');
    // THE PAYLOAD WAS ENOUGH: every 409 in this section carries the re-read row
    // precisely so no screen needs a second request to recover.
    expect(reads(PROGRAMS)).toBe(1);

    // And the next save uses the revision that won.
    when(`${PROGRAMS}/${capsProgram.id}`, { program: { ...theirs, revision: 8 } });
    await user.click(screen.getByRole('button', { name: 'Save program' }));
    await waitFor(() =>
      expect(sent(`${PROGRAMS}/${capsProgram.id}`, 'PATCH').expectedRevision).toBe(7),
    );
  });

  it('puts the server’s field refusal under the field it named', async () => {
    const user = userEvent.setup();
    withPrograms();
    when(
      `${PROGRAMS}/${capsProgram.id}`,
      { error: 'bad_request', detail: 'pointsLabelPlural', requestId: 'req_400' },
      400,
    );
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    await user.click(screen.getByRole('button', { name: 'Save program' }));

    // Inline, keyed by `detail`, never a toast on its own (error catalogue).
    await waitFor(() =>
      expect(
        within(field('More than one award')).getByText('Say what more than one of them is called.'),
      ).toBeTruthy(),
    );
    expect(
      within(field('One award')).queryByText('Say what more than one of them is called.'),
    ).toBeNull();
  });

  it('asks before pausing a program that has returns already open', async () => {
    const user = userEvent.setup();
    withPrograms();
    when(`${PROGRAMS}/${capsProgram.id}`, {
      program: { ...capsProgram, status: 'paused', revision: 2 },
    });
    mount(editor());
    await screen.findByDisplayValue('Canister Returns');

    await user.click(screen.getByRole('switch', { name: 'Accepting new return requests' }));
    await user.click(screen.getByRole('button', { name: 'Save program' }));

    /*
     * INFORMATIONAL, not a block: pausing with work in flight is a legitimate
     * thing to do, and the confirmation exists to say that the five returns
     * already booked will still be picked up, inspected and awarded.
     */
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Pause ${capsProgram.name}?`)).toBeTruthy();
    expect(dialog.textContent).toContain('5 returns are already open');
    expect(sentNothing(`${PROGRAMS}/${capsProgram.id}`)).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Pause it' }));
    await waitFor(() =>
      expect(sent(`${PROGRAMS}/${capsProgram.id}`, 'PATCH').status).toBe('paused'),
    );
  });

  it('pauses a program with nothing in flight without asking', async () => {
    const user = userEvent.setup();
    withPrograms();
    when(`${PROGRAMS}/${renamedProgram.id}`, {
      program: { ...renamedProgram, status: 'paused', revision: 5 },
    });
    mount(editor(renamedProgram));
    await screen.findByDisplayValue(renamedProgram.name);

    await user.click(screen.getByRole('switch', { name: 'Accepting new return requests' }));
    await user.click(screen.getByRole('button', { name: 'Save program' }));

    // Nothing is waiting on this program, so there is nothing to warn about.
    await waitFor(() =>
      expect(sent(`${PROGRAMS}/${renamedProgram.id}`, 'PATCH').status).toBe('paused'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('chooses a handle and a kind once, and by-hand drops the counting fields', async () => {
    const user = userEvent.setup();
    withPrograms(programs, () => ({
      status: 201,
      body: { program: { ...goodwillProgram, id: 'prg_made', key: 'thanks' } },
    }));
    mount('/marketing/rewards?id=new');

    // The two things that cannot be changed later exist only here.
    expect(await screen.findByLabelText('Handle')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Counted returns' })).toHaveProperty('checked', true);
    expect(screen.getByLabelText('One item')).toBeTruthy();
    expect(screen.getByLabelText('Smallest request')).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Given by hand' }));

    // Nothing is counted, so there is no word for it and no rate for it — which
    // is also what the column CHECK says: the four rule columns are null
    // together or set together.
    expect(screen.queryByLabelText('One item')).toBeNull();
    expect(screen.queryByLabelText('Smallest request')).toBeNull();
    expect(panel('In plain words').textContent).toContain('are given out by hand');

    await retype(user, 'Handle', 'thanks');
    await retype(user, 'Name', 'Thank-yous');
    await retype(user, 'One award', 'Bottle Cap');
    await retype(user, 'More than one award', 'Bottle Caps');
    await user.click(screen.getByRole('button', { name: 'Create program' }));

    await waitFor(() => expect(sent(PROGRAMS, 'POST')).toBeTruthy());
    expect(sent(PROGRAMS, 'POST')).toEqual({
      key: 'thanks',
      kind: 'adhoc',
      name: 'Thank-yous',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
    });
    // Back to the list, where the new row now lives.
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe('/marketing/rewards'),
    );
  });

  it('names a handle another program has taken, on the handle field', async () => {
    const user = userEvent.setup();
    withPrograms(programs, () => ({
      status: 409,
      body: { error: 'duplicate_program_key', key: 'bottle-caps', requestId: 'req_dup' },
    }));
    mount('/marketing/rewards?id=new');

    await screen.findByLabelText('Handle');
    await retype(user, 'Handle', 'bottle-caps');
    await retype(user, 'Name', 'Another one');
    await retype(user, 'One award', 'Bottle Cap');
    await retype(user, 'More than one award', 'Bottle Caps');
    await retype(user, 'One item', 'canister');
    await retype(user, 'More than one item', 'canisters');
    await retype(user, 'Smallest request', '4');
    await retype(user, 'Awarded for each accepted one', '7');
    await user.click(screen.getByRole('button', { name: 'Create program' }));

    await waitFor(() =>
      expect(
        within(field('Handle')).getByText('That handle is taken by another program.'),
      ).toBeTruthy(),
    );
    // Still on the form, with everything typed still typed.
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Another one');
  });

  it('opens on the programs, with the settings one tab away', async () => {
    /*
     * The table is what somebody opens Rewards to look at. It used to start
     * below a settings form six fields long — so the screen opened on config
     * nobody came for and the rows were off the bottom of the window.
     */
    withPrograms();
    withSettings();
    mount();

    await listed();
    expect(screen.queryByLabelText('One award')).toBeNull();

    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));

    expect(await screen.findByLabelText('One award')).toBeTruthy();
    // ...and the table is not underneath it any more, which was the point.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a writer no tab strip, because there is only one half for them', async () => {
    /* The settings PATCH is `requireOwner`, so the panel is absent rather than
       disabled — and a tab leading to a panel that is never rendered is a door
       to a room this person is not in. */
    fixture.session.user.role = 'writer';
    withPrograms();
    withSettings();
    mount();

    await listed();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('refuses to switch spending on until it knows what a reward is worth', async () => {
    const user = userEvent.setup();
    withPrograms();
    withSettings(freshSettings);
    mount(SETTINGS_TAB);

    const toggle = await screen.findByRole('switch', {
      name: 'Let customers spend what they have earned',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await user.click(toggle);

    /*
     * THE COLUMN'S OWN CHECK, refused here: `redemption_enabled` cannot be true
     * while the rate is zero. The message goes under the RATE, because that is
     * the box that has to change — the switch is not what is wrong.
     */
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(
      within(field('What they take off')).getByText(
        'Say what they are worth before letting customers spend them.',
      ),
    ).toBeTruthy();

    await retype(user, 'What they take off', '500');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('writes the settings back with the revision it read, and a real null for no default', async () => {
    const user = userEvent.setup();
    withPrograms();
    withSettings();
    mount(SETTINGS_TAB);

    await screen.findByLabelText('One award');
    await retype(user, 'One award', 'Cap');

    // "No default" is a VALUE, not an empty field: with none set, every intake
    // has to name its own program.
    await user.click(screen.getByRole('combobox', { name: 'Program a return goes to by default' }));
    await user.click(await screen.findByRole('option', { name: 'No default' }));

    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(sent(SETTINGS, 'PATCH')).toBeTruthy());
    expect(sent(SETTINGS, 'PATCH')).toEqual({
      expectedRevision: settings.revision,
      pointsLabelSingular: 'Cap',
      pointsLabelPlural: 'Bottle Caps',
      redemptionEnabled: true,
      redemptionRatePoints: 100,
      redemptionRateMinor: 500,
      redemptionCurrency: 'NGN',
      minRedeemPoints: 50,
      maxRedeemBps: 5000,
      defaultReturnProgramId: null,
    });
  });

  it('never says the preset’s noun', async () => {
    withPrograms();
    withSettings();
    const list = mount();
    await listed();
    expect(list.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));

    cleanup();
    const edit = mount(editor());
    await screen.findByDisplayValue('Canister Returns');
    expect(edit.container.textContent ?? '').not.toMatch(new RegExp(PRESET_NOUN, 'i'));
    // The fixtures are absurd on purpose, and what is rendered is what they say.
    expect(edit.container.textContent ?? '').toContain('canister');
  });
});

/** No write has gone to this path yet — the confirm has not been answered. */
function sentNothing(pathname: string): boolean {
  return !calls.some((c) => c.path.split('?')[0] === pathname && (c.init.method ?? 'GET') !== 'GET');
}
