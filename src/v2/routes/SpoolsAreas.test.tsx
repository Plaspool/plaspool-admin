import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.setConfig({ testTimeout: 20_000 });

/**
 * Where we collect — the districts a driver picks up from — pinned on the
 * four things it can get wrong QUIETLY.
 *
 *  - **A district's switch sends `{ expectedRevision, active }` and nothing
 *    else.** The PATCH schema is `.strict()`, so a stray `name` or `region`
 *    riding along is a 400 — and a rename that happened to carry `active`
 *    would flip a district nobody meant to touch.
 *  - **Switching a whole state off is PARTIAL by design, and the words say
 *    how partial.** The server refuses to switch off a district with open
 *    pickups (`area_in_use`) so those pickups are never stranded; a screen
 *    that reported "switched off" after 1 of 2 succeeded would leave the owner
 *    believing they had closed a city they had not.
 *  - **A new district is added to the state ON SCREEN, and is created OFF.**
 *    The body carries the region the person was looking at, not a default,
 *    and the toast says the switch is a separate act.
 *  - **Only the marketing domain sees the table.** The API gates
 *    `/api/marketing/areas` on it; a screen that rendered for everyone would
 *    show a support user a table that 403s on first fetch.
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
import { allAreasView, cabbageArea, turnipArea } from '../../data/marketing-fixtures';
import SpoolsAreas from './SpoolsAreas';

/* jsdom gaps the v2 chrome touches — the same blocks every v2 suite carries.
   `ResizeObserver` is the load-bearing one: `TableScroll` observes its own
   scroller on mount, so without it the table never renders at all. */
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

const AREAS = '/api/marketing/areas';
const areaPath = (id: string): string => `${AREAS}/${id}`;

/** The full list — every state, on and off — which is what this screen asks
 *  for. `allAreasView` puts two switched-on districts in one state and one
 *  switched-off district in another; Cabbage Quarter holds 5 open pickups. */
function withAreas(): void {
  when(AREAS, (_url, init) =>
    (init.method ?? 'GET') === 'GET'
      ? { body: allAreasView }
      : { status: 500, body: { error: 'internal', requestId: 'req_unexpected' } },
  );
}

/** A PATCH that answers with the row as the server would have moved it. */
function patchEcho(id: string, row: typeof turnipArea): void {
  when(areaPath(id), (_url, init) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return {
      body: {
        area: {
          ...row,
          ...('active' in body ? { active: body.active as boolean } : {}),
          ...('name' in body ? { name: body.name as string } : {}),
          revision: row.revision + 1,
        },
      },
    };
  });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/spools/areas']}>
        <SpoolsAreas />
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

describe('where we collect', () => {
  it('switches one district off with exactly { expectedRevision, active } — and nothing else', async () => {
    const user = userEvent.setup();
    withAreas();
    patchEcho(turnipArea.id, turnipArea);
    mount();

    const toggle = await screen.findByRole('switch', { name: 'Collect from Turnip Hill' });
    expect(toggle).toHaveProperty('checked', true);
    await user.click(toggle);

    await waitFor(() => expect(bodiesOf(areaPath(turnipArea.id), 'PATCH')).toHaveLength(1));
    const flip = bodiesOf(areaPath(turnipArea.id), 'PATCH')[0]!;
    expect(flip).toEqual({ expectedRevision: turnipArea.revision, active: false });
    /* Said twice on purpose: a rename key riding along would still pass
       `toEqual` if the fixture grew one too. */
    expect(flip).not.toHaveProperty('name');

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Collect from Turnip Hill' })).toHaveProperty(
        'checked',
        false,
      ),
    );
    // The strip's tally follows the row without a re-read.
    expect(screen.getByText('1 of 2 switched on')).toBeTruthy();
  });

  it('switches the whole state and says in words which districts were left on', async () => {
    const user = userEvent.setup();
    withAreas();
    patchEcho(turnipArea.id, turnipArea);
    /* The server's refusal: Cabbage Quarter still has 5 open pickups, and a
       district with open pickups is never switched off under them. */
    when(
      areaPath(cabbageArea.id),
      { error: 'area_in_use', open: 5, requestId: 'req_held' },
      409,
    );
    mount();

    const master = await screen.findByRole('switch', { name: 'All of Farflung Province' });
    // Both districts are on, so the master reads on — one press means "off".
    expect(master).toHaveProperty('checked', true);
    await user.click(master);

    // ONE PATCH PER DISTRICT THAT DIFFERS, sent together — there is no bulk route.
    await waitFor(() => expect(bodiesOf(areaPath(turnipArea.id), 'PATCH')).toHaveLength(1));
    await waitFor(() => expect(bodiesOf(areaPath(cabbageArea.id), 'PATCH')).toHaveLength(1));
    expect(bodiesOf(areaPath(turnipArea.id), 'PATCH')[0]).toEqual({
      expectedRevision: turnipArea.revision,
      active: false,
    });
    expect(bodiesOf(areaPath(cabbageArea.id), 'PATCH')[0]).toEqual({
      expectedRevision: cabbageArea.revision,
      active: false,
    });

    // The honest count, in words: what moved, and what was held and why.
    await screen.findByText('1 switched off. 1 still has open pickups and was left on.');
    // Nothing was retried blind: one write each, then a fresh read of the list.
    expect(bodiesOf(areaPath(cabbageArea.id), 'PATCH')).toHaveLength(1);
  });

  it('adds a district to the state on screen, created off', async () => {
    const user = userEvent.setup();
    withAreas();
    when(AREAS, (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: allAreasView };
      const body = JSON.parse(String(init.body)) as { region: string; name: string };
      return {
        status: 201,
        body: {
          area: {
            ...turnipArea,
            id: 'area_parsnip_row',
            key: 'parsnip-row',
            name: body.name,
            region: body.region,
            active: false,
            seeded: false,
          },
        },
      };
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Add a district' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a district' });
    await user.type(within(dialog).getByLabelText('Name of the district'), 'Parsnip Row');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(bodiesOf(AREAS, 'POST')).toHaveLength(1));
    // The region is the state the person was LOOKING AT, never a default.
    expect(bodiesOf(AREAS, 'POST')[0]).toEqual({ region: 'Farflung Province', name: 'Parsnip Row' });

    // Created off, and the words say the switch is a separate act.
    await screen.findByText('Added — switch it on when a driver covers it.');
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Collect from Parsnip Row' })).toHaveProperty(
        'checked',
        false,
      ),
    );
  });

  it('renames through a PATCH that carries only the new name', async () => {
    const user = userEvent.setup();
    withAreas();
    patchEcho(turnipArea.id, turnipArea);
    mount();

    await user.click(await screen.findByRole('button', { name: 'Rename Turnip Hill' }));
    const box = await screen.findByLabelText('New name for Turnip Hill');
    await retype(user, box, 'Turnip Hills');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(bodiesOf(areaPath(turnipArea.id), 'PATCH')).toHaveLength(1));
    const rename = bodiesOf(areaPath(turnipArea.id), 'PATCH')[0]!;
    expect(rename).toEqual({ expectedRevision: turnipArea.revision, name: 'Turnip Hills' });
    expect(rename).not.toHaveProperty('active');

    // The row adopts the server's answer — new name, still switched on.
    await screen.findByRole('switch', { name: 'Collect from Turnip Hills' });
  });

  it('shows a writer the lock, not the table — and asks the server for nothing', async () => {
    fixture.session.user.role = 'writer';
    withAreas();
    mount();

    await screen.findByText('You don’t have access to this');
    expect(screen.queryByRole('table')).toBeNull();
    expect(calls.filter((c) => c.path.startsWith(AREAS))).toHaveLength(0);
  });
});
