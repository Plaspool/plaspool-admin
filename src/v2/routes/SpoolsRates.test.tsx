import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * Points and costs — the per-item programme's numbers — pinned on the four
 * things it can get wrong QUIETLY.
 *
 *  - **Only programmes that pay per item are here, and every word comes from
 *    the row.** The manual-points programme stays on Marketing; the rate line
 *    reads "7 Bottle Caps per canister" because the fixture says so, not
 *    because anything in source knows what the business collects.
 *  - **A programme's `key` exists at create and never again.** The ledger's
 *    rows point at it, so the PATCH body structurally cannot carry `key` or
 *    `kind` — a rename moves the words and never the identity. The two money
 *    rates travel on every per-item PATCH, null included, so a cleared rate is
 *    undoable. (Moved here from `Marketing.test.tsx` with the modal.)
 *  - **Where requests go is a two-key PATCH.** `defaultReturnProgramId` shares
 *    a settings row with the redemption rate; a save from here must not carry
 *    the redemption fields, or a stale copy of them would overwrite a change
 *    made on Marketing a minute earlier.
 *  - **Only switched-on districts get a pickup standard, and an empty box
 *    clears one with `null`.** Absent leaves a line alone; `null` says "we
 *    have no standard here" — and JSON is the one layer where that difference
 *    can quietly die.
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
import {
  allAreasView,
  cabbageArea,
  capsProgram,
  programs,
  renamedProgram,
  settings,
} from '../../data/marketing-fixtures';
import SpoolsRates from './SpoolsRates';

/* jsdom gaps the v2 chrome touches — the same blocks every v2 suite carries. */
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
const AREAS = '/api/marketing/areas';

/** The three mount-time reads. The programmes GET carries every kind, as the
 *  real route does; the settings PATCH echoes what it was sent. */
function withEverything(): void {
  when(PROGRAMS, { programs });
  when(SETTINGS, (_url, init) => {
    if ((init.method ?? 'GET') === 'GET') return { body: { settings } };
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return {
      body: {
        settings: {
          ...settings,
          defaultReturnProgramId: body.defaultReturnProgramId as string | null,
          revision: settings.revision + 1,
        },
      },
    };
  });
  when(AREAS, allAreasView);
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/spools/rates']}>
        <SpoolsRates />
      </MemoryRouter>
    </ToastHost>,
  );
}

const retype = async (
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  value: string,
): Promise<void> => {
  await user.clear(input);
  if (value !== '') await user.type(input, value);
};

// ============================================================================

describe('points and costs', () => {
  it('lists only programmes that pay per item, in their own words, and edits one without ever sending key or kind', async () => {
    const user = userEvent.setup();
    withEverything();
    when(`${PROGRAMS}/${capsProgram.id}`, {
      program: { ...capsProgram, name: 'Deposit Scheme', revision: 2 },
    });
    mount();

    // Both per-item programmes, neither manual one.
    await screen.findByRole('heading', { name: 'Canister Returns' });
    expect(screen.getByRole('heading', { name: 'Canister Returns (trial)' })).toBeTruthy();
    expect(screen.queryByText('Goodwill')).toBeNull();
    // The rate line is the ROW's words — nothing in source knows these nouns.
    expect(screen.getAllByText('7 Bottle Caps per canister').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Edit Canister Returns' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit Canister Returns' });
    // No key box, no type switch — the handle is read-only prose.
    expect(within(edit).queryByLabelText('ID code')).toBeNull();
    expect(within(edit).queryByRole('group', { name: 'Type' })).toBeNull();
    expect(within(edit).getByText(capsProgram.key)).toBeTruthy();
    expect(within(edit).getByText(/The type and ID code can’t be changed/)).toBeTruthy();

    await retype(user, within(edit).getByLabelText('Name'), 'Deposit Scheme');
    await user.click(within(edit).getByRole('button', { name: 'Save programme' }));

    await waitFor(() => expect(bodiesOf(`${PROGRAMS}/${capsProgram.id}`, 'PATCH')).toHaveLength(1));
    const body = bodiesOf(`${PROGRAMS}/${capsProgram.id}`, 'PATCH')[0]!;
    expect(body).toEqual({
      expectedRevision: capsProgram.revision,
      name: 'Deposit Scheme',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
      pointsPerUnit: 7,
      minUnitsPerReturn: 4,
      // 0920's two money rates, sent on every per-item patch — including when
      // unchanged, because a PATCH that omitted them could not express "clear
      // this rate" and a cleared rate must be undoable.
      unitCostMinor: capsProgram.unitCostMinor,
      unitMarketCostMinor: capsProgram.unitMarketCostMinor,
    });
    // Said twice on purpose: `toEqual` would still pass if the type ever
    // gained one of these and the fixture gained it too.
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('kind');

    await screen.findByText('Deposit Scheme saved');
  });

  it('saves where customer requests go with only the two keys the setting needs', async () => {
    const user = userEvent.setup();
    withEverything();
    mount();

    const pick = await screen.findByLabelText('Programme for new requests');
    // Opens on the stored choice, offering only per-item programmes.
    expect(pick).toHaveProperty('value', capsProgram.id);
    expect(within(pick).queryByRole('option', { name: 'Goodwill' })).toBeNull();

    await user.selectOptions(pick, renamedProgram.id);

    await waitFor(() => expect(bodiesOf(SETTINGS, 'PATCH')).toHaveLength(1));
    // TWO KEYS. The redemption rate lives on Marketing; a stale copy of it
    // riding along here would overwrite a change made there a minute ago.
    expect(bodiesOf(SETTINGS, 'PATCH')[0]).toEqual({
      expectedRevision: settings.revision,
      defaultReturnProgramId: renamedProgram.id,
    });
    await screen.findByText('Saved — new requests join that programme');
    // The server's echo is what the select shows now — revision moved with it.
    expect(screen.getByLabelText('Programme for new requests')).toHaveProperty(
      'value',
      renamedProgram.id,
    );
  });

  it('lists only switched-on districts, and an empty box clears a pickup standard with null', async () => {
    const user = userEvent.setup();
    withEverything();
    when(`${AREAS}/${cabbageArea.id}`, (_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const { expectedRevision: _cas, ...rest } = body;
      return { body: { area: { ...cabbageArea, ...rest, revision: cabbageArea.revision + 1 } } };
    });
    mount();

    // Cabbage Quarter and Turnip Hill are on; Distant Marsh is off and absent.
    const cabbage = await screen.findByRole('button', {
      name: 'What a pickup from Cabbage Quarter costs us',
    });
    expect(
      screen.getByRole('button', { name: 'What a pickup from Turnip Hill costs us' }),
    ).toBeTruthy();
    expect(screen.queryByText('Distant Marsh')).toBeNull();

    await user.click(cabbage);
    const transport = await screen.findByLabelText('Transport in');
    // The stored ₦2,000.00 opens as the typed figure, not as minor units.
    expect(transport).toHaveProperty('value', '2,000.00');
    await user.clear(transport);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(`${AREAS}/${cabbageArea.id}`, 'PATCH')).toHaveLength(1));
    const patch = bodiesOf(`${AREAS}/${cabbageArea.id}`, 'PATCH')[0]!;
    /* All four lines, every time: the cleared one as a real `null` (absent
       would LEAVE it), the kept one back in minor units, the two that were
       never set still null rather than dropped. */
    expect(patch).toEqual({
      expectedRevision: cabbageArea.revision,
      stdTransportMinor: null,
      stdLocalMinor: 50000,
      stdDriverMinor: null,
      stdFeesMinor: null,
    });
    expect(patch).toHaveProperty('stdTransportMinor', null);
  });

  it('shows a writer the lock, not the numbers — and asks the server for nothing', async () => {
    fixture.session.user.role = 'writer';
    withEverything();
    mount();

    await screen.findByText('You don’t have access to this');
    expect(screen.queryByText('Programme for new requests')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

/**
 * SET THE PICKUP COST FOR A WHOLE STATE.
 *
 * Twenty-eight FCT districts, four figures each, is the thing this screen was
 * worst at, and the owner asked for it directly.
 *
 * THERE IS NO BULK ROUTE FOR AREAS — the server takes `PATCH /areas/:id` one
 * at a time with CAS on `expectedRevision` — so the interesting thing to pin
 * is that it fans out, sends EVERY district's OWN revision (a shared one would
 * lose the CAS race by construction), and reports partial success rather than
 * claiming a clean sweep. The `Promise.allSettled` shape is deliberate: some
 * rows moving and some not is the normal case with another tab open.
 */
describe('setting the pickup cost across a state', () => {
  it('writes every district in the state, each with its own revision', async () => {
    const user = userEvent.setup();
    withEverything();
    const seen: string[] = [];
    for (const area of allAreasView.areas) {
      when(`${AREAS}/${area.id}`, (_url, init) => {
        seen.push(area.id);
        const { expectedRevision: _r, ...rest } = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
        return { body: { area: { ...area, ...rest, revision: area.revision + 1 } } };
      });
    }
    mount();

    const open = await screen.findByRole('button', { name: /Set for all of/ });
    const region = open.textContent!.replace('Set for all of ', '').trim();
    await user.click(open);

    await user.type(screen.getByLabelText('Transport in'), '1500');
    await user.type(screen.getByLabelText('Driver'), '500');
    await user.click(screen.getByRole('button', { name: /^Set \d+ districts?$/ }));

    /* Only the state on screen — never every district in the country. */
    const inRegion = allAreasView.areas.filter((a) => a.region === region && a.active);
    await waitFor(() => expect(seen.length).toBe(inRegion.length));
    expect(new Set(seen)).toEqual(new Set(inRegion.map((a) => a.id)));

    for (const area of inRegion) {
      const body = bodiesOf(`${AREAS}/${area.id}`, 'PATCH')[0]!;
      /* Each row's OWN revision. One shared number would lose the CAS race. */
      expect(body.expectedRevision).toBe(area.revision);
      /* ₦1,500 and ₦500 — 100 minor units per naira. */
      expect(body.stdTransportMinor).toBe(150_000);
      expect(body.stdDriverMinor).toBe(50_000);
      /* An empty box CLEARS that line, which is "no standard here" and not
         "it is free" — a missing key would have left the old figure. */
      expect(body.stdLocalMinor).toBeNull();
      expect(body.stdFeesMinor).toBeNull();
    }
  });

  it('refuses money it cannot read instead of writing it to the whole state', async () => {
    const user = userEvent.setup();
    withEverything();
    for (const area of allAreasView.areas) {
      when(`${AREAS}/${area.id}`, { area });
    }
    mount();

    await user.click(await screen.findByRole('button', { name: /Set for all of/ }));
    await user.type(screen.getByLabelText('Transport in'), 'fifteen hundred');
    await user.click(screen.getByRole('button', { name: /^Set \d+ districts?$/ }));

    for (const area of allAreasView.areas) {
      expect(bodiesOf(`${AREAS}/${area.id}`, 'PATCH')).toHaveLength(0);
    }
  });
});
