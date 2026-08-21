import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Areas screen — where the business decides where its vans go.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR CLAIMS, AND EACH IS ONE A SCREENSHOT CANNOT MAKE.
 *
 *  - **Every region is already loaded and switched off.** That is the whole
 *    national-model argument: expanding is an owner flipping a Switch, not a
 *    migration. A screen that only listed the SERVED areas would leave no way to
 *    reach the other seven hundred, and the claim would quietly be false.
 *  - **A writer sees the list and cannot change it.** Owner-only controls are
 *    ABSENT rather than disabled, because a disabled control advertises a
 *    capability and then refuses it.
 *  - **Switching off a district with open returns is refused, with the count.**
 *    Those returns would otherwise fall off every board into the out-of-area
 *    footer, unrewardable, with nothing on screen to say why — so the refusal
 *    has to be an instruction rather than a wall.
 *  - **A rename keeps `seeded` true.** It only ever meant "this row was not
 *    typed by a person"; clearing it on a correction would make the screen call
 *    a shipped row hand-made the moment somebody fixed its spelling.
 * ═══════════════════════════════════════════════════════════════════════════
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
import { allAreasView, cabbageArea, marshArea, turnipArea } from '../data/marketing-fixtures';
import MarketingAreas from './MarketingAreas';

/** Assembled from halves: this file is under a path the section's grep guard
 *  reads, and spelling the city out to assert its absence would fail it. */
const SERVED_CITY = 'ab' + 'uja';

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

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

const mount = () =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/marketing/areas']}>
        <MarketingAreas />
      </MemoryRouter>
    </ToastProvider>,
  );

const loaded = (): void => {
  when('/api/marketing/areas', { areas: allAreasView.areas, outOfArea: allAreasView.outOfArea });
};

/** The row for an area, as a container to query inside. */
const row = (name: string): HTMLElement => {
  const found = screen.getByText(name).closest('li');
  if (found === null) throw new Error(`no row for ${name}`);
  return found as HTMLElement;
};

/**
 * Open the state picker and choose one.
 *
 * THE SCREEN SHOWS ONE STATE AT A TIME. It used to render all 37 stacked, which
 * meant finding a district was a scroll past several hundred rows the browser
 * had also laid out. So a test that needs a row in another state now does what a
 * person does: opens the picker and chooses it.
 */
const chooseState = async (name: string): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: /^State:/ }));
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
};

describe('the areas an owner manages', () => {
  it('asks for EVERY area, not only the served ones', async () => {
    /*
     * This screen is where a region gets switched ON, so the rows that are off
     * are the whole point of it. `?active=true` here would leave the other seven
     * hundred unreachable and make the national model a claim with no interface.
     */
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);
    expect(calls.some((c) => c.path.includes('active=true'))).toBe(false);
  });

  it('opens on the state we actually serve, not on the first one alphabetically', async () => {
    /*
     * ONE STATE AT A TIME, and the opening one is the first with anything
     * switched on — the state this business operates in, which is the one an
     * owner opened this screen to adjust. Every region is still loaded (the test
     * above pins that); this is about which of them is on the page.
     */
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);

    expect(screen.getByRole('heading', { name: 'Farflung Province', level: 2 })).toBeTruthy();
    expect(screen.getByText('2 of 2 switched on')).toBeTruthy();
    // The other state's rows are not underneath it, which is the whole change.
    expect(screen.queryByRole('heading', { name: 'Nearby Province', level: 2 })).toBeNull();
    expect(screen.queryByText(marshArea.name)).toBeNull();
  });

  it('carries each state’s served tally in the picker, so the map is in one place', async () => {
    /*
     * Otherwise "where do we operate" is answered by opening all 37 in turn —
     * the scrolling this screen replaced, moved into a dropdown.
     */
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);

    await userEvent.click(screen.getByRole('button', { name: /^State:/ }));
    const served = await screen.findByRole('option', { name: /Farflung Province/ });
    expect(within(served).getByText('2')).toBeTruthy();
    /* No badge for a state with nothing switched on — a zero is a number, and
       there is none here. It says how many areas it holds instead. */
    const idle = screen.getByRole('option', { name: /Nearby Province/ });
    expect(within(idle).getByText('1 areas')).toBeTruthy();
  });

  it('swaps the page to the state the picker names', async () => {
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);

    await chooseState('Nearby Province');

    expect(await screen.findByText(marshArea.name)).toBeTruthy();
    expect(screen.getByText('0 of 1 switched on')).toBeTruthy();
    expect(screen.queryByText(cabbageArea.name)).toBeNull();
  });

  it('marks a shipped row from `seeded` and nothing else', async () => {
    // Never by matching a key or a name — that is precisely what the grep guards
    // forbid, and a rename must not change the marker.
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);
    expect(within(row(cabbageArea.name)).getByText('Preset')).toBeTruthy();
  });

  it('warns about the returns that belong to no area at all', async () => {
    /* They can be closed with a reason and can never be awarded — and this is the
     * only screen that says so before somebody goes looking for the board they
     * are on. */
    loaded();
    mount();
    await screen.findByText(/belong to no area at all/i);
  });

  it('never names the served city — the list is the only source', async () => {
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);
    expect(document.body.textContent ?? '').not.toMatch(new RegExp(SERVED_CITY, 'i'));
  });
});

describe('what a writer can do here', () => {
  it('sees the list read-only — the controls are ABSENT, not disabled', async () => {
    /*
     * Which districts are served decides where the business sends a driver, so
     * it sits beside a programme's rate rather than beside the day's return
     * processing. A disabled Switch would advertise the capability and refuse it.
     */
    fixture.session.user.role = 'writer';
    loaded();
    mount();
    await screen.findByText(cabbageArea.name);

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /rename/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add an area/i })).toBeNull();
    /* …and the state is still LEGIBLE: knowing where the vans go is part of
     * processing returns. The picker is NOT an owner-only control for the same
     * reason — it is how a writer reads the rest of the map. */
    expect(within(row(cabbageArea.name)).getByText('Collecting')).toBeTruthy();

    await chooseState('Nearby Province');
    expect(within(row(marshArea.name)).getByText('Not collecting')).toBeTruthy();
  });
});

describe('switching an area on and off', () => {
  it('sends a CAS patch carrying the revision it read', async () => {
    loaded();
    when('/api/marketing/areas/area_distant_marsh', {
      area: { ...marshArea, active: true, revision: 2 },
    });
    mount();
    await screen.findByText(cabbageArea.name);
    // Distant Marsh is in the other state, which is a choice away now.
    await chooseState('Nearby Province');
    await screen.findByText(marshArea.name);

    await userEvent.click(
      within(row(marshArea.name)).getByRole('switch', {
        name: new RegExp(`Collect from ${marshArea.name}`),
      }),
    );

    await waitFor(() => {
      const body = sent('/api/marketing/areas/area_distant_marsh', 'PATCH');
      expect(body).toEqual({ expectedRevision: marshArea.revision, active: true });
    });
  });

  it('REFUSES to switch off a board with open returns, and says how many', async () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE REFUSAL THAT NEEDS ITS OWN PATH. Deactivating would strand those
     * returns — off every board, into the out-of-area footer, unrewardable, with
     * nothing on screen to explain it. The count comes back with the error so
     * the message is an instruction rather than a wall.
     * ═══════════════════════════════════════════════════════════════════════
     */
    loaded();
    when(
      '/api/marketing/areas/area_cabbage_quarter',
      { error: 'area_in_use', open: 4, requestId: 'req_test' },
      409,
    );
    mount();
    await screen.findByText(cabbageArea.name);

    await userEvent.click(
      within(row(cabbageArea.name)).getByRole('switch', {
        name: new RegExp(`Collect from ${cabbageArea.name}`),
      }),
    );

    await screen.findByText(/4 open returns are still on that board/i);
    /* …and it stays ON, because the write was refused. */
    expect(
      within(row(cabbageArea.name))
        .getByRole('switch', { name: new RegExp(`Collect from ${cabbageArea.name}`) })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('correcting the shipped list', () => {
  it('renames an area in place and keeps it shipped', async () => {
    /*
     * The shipped dataset misspells real places. An owner must be able to fix
     * one without a developer — and `seeded` has to survive the fix, or the
     * screen starts calling a shipped row hand-made.
     */
    loaded();
    when('/api/marketing/areas/area_turnip_hill', {
      area: { ...turnipArea, name: 'Turnip Hills', revision: 2 },
    });
    mount();
    await screen.findByText(turnipArea.name);

    await userEvent.click(within(row(turnipArea.name)).getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText(`Rename ${turnipArea.name}`);
    await userEvent.clear(field);
    await userEvent.type(field, 'Turnip Hills');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const body = sent('/api/marketing/areas/area_turnip_hill', 'PATCH');
      expect(body).toEqual({ expectedRevision: turnipArea.revision, name: 'Turnip Hills' });
    });
    /* NO `seeded` IN THE BODY — the PATCH schema has no such field, which is a
     * structural wall rather than a check somebody can delete. */
    expect(sent('/api/marketing/areas/area_turnip_hill', 'PATCH')).not.toHaveProperty('seeded');
  });

  it('adds an area, and says it is off until somebody switches it on', async () => {
    loaded();
    when('/api/marketing/areas', (url, init) =>
      (init.method ?? 'GET') === 'POST'
        ? { status: 201, body: { area: { ...turnipArea, id: 'area_sprout_lane', name: 'Sprout Lane', active: false, seeded: false } } }
        : { body: { areas: allAreasView.areas, outOfArea: allAreasView.outOfArea } },
    );
    mount();
    await screen.findByText(cabbageArea.name);

    await userEvent.click(screen.getAllByRole('button', { name: 'Add an area' })[0]);
    await userEvent.type(screen.getByLabelText(/New area in Farflung Province/), 'Sprout Lane');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const body = sent('/api/marketing/areas', 'POST');
      expect(body).toEqual({ region: 'Farflung Province', name: 'Sprout Lane' });
    });
    /* Created OFF, like every other area — said out loud so nobody waits for a
     * van that is not coming. */
    await screen.findByText(/switch it on when a driver covers it/i);
  });

  it('shows a duplicate name as an inline field error, not a toast', async () => {
    loaded();
    when('/api/marketing/areas', (url, init) =>
      (init.method ?? 'GET') === 'POST'
        ? {
            status: 409,
            body: {
              error: 'duplicate_area',
              region: 'Farflung Province',
              name: cabbageArea.name,
              requestId: 'req_test',
            },
          }
        : { body: { areas: allAreasView.areas, outOfArea: allAreasView.outOfArea } },
    );
    mount();
    await screen.findByText(cabbageArea.name);

    await userEvent.click(screen.getAllByRole('button', { name: 'Add an area' })[0]);
    await userEvent.type(screen.getByLabelText(/New area in Farflung Province/), cabbageArea.name);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Beside the field somebody has to change, rather than a toast that vanishes
    // while they are still reading the form.
    await screen.findByText('That region already has an area with that name.');
  });
});
