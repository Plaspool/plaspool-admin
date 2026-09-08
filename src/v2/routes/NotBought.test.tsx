import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * "Not bought yet", pinned on the six things it can get wrong quietly.
 *
 *  - **The tab it opens on, and the tab a click asks for.** `tab` is the whole
 *    contract with `server/shop/admin/prospects.ts`: the four populations are
 *    DISJOINT, so a screen that sent the wrong value would show a coherent,
 *    plausible, wrong list. It is read off the URL rather than off the screen.
 *  - **The cursor surviving a tab change.** A keyset cursor is a position in
 *    ONE tab's ordering. Carrying it across pages into a list it was never
 *    measured against, and the rows that come back look fine.
 *  - **`unreachableBaskets` read as a fact about the page.** 13 of the 19
 *    baskets on production hold goods and resolve to no email address at all.
 *    The count does not move with the tab or the search, so the sentence has
 *    to say *shop-wide* — and it has to be on screen without opening a menu,
 *    because the analytics bar starts hidden and a screen that lists 6 people
 *    and says nothing else implies 6 is the whole picture.
 *  - **The send action gated on a ROLE NAME rather than the domain.** The list
 *    is `customers`; the send is `marketing`. Support must get the rows and no
 *    pill — absent, not disabled, because the server answers 403.
 *  - **An unsubscribed person shown as merely unknown.** Suppression is the one
 *    state that stops a send, so it is its own word and its own tone.
 *  - **A search that filters the 25 rows it already has.** That answers "nobody
 *    matches" for anybody on page three. The term has to reach the wire.
 *
 * `fetch` IS STUBBED, NOT `../../data/api-shop`, per the section's canonical
 * harness (`src/routes/MarketingRewards.test.tsx`): the path, the method and
 * the body are what integration gets silently wrong against a backend written
 * in another session, and a mocked module asserts none of them.
 */

vi.setConfig({ testTimeout: 20_000 });

const fixture = vi.hoisted(() => ({
  session: {
    status: 'authed',
    user: {
      id: 'u_owner',
      email: 'o@test.local',
      displayName: 'An Owner',
      role: 'owner' as 'owner' | 'support' | 'marketing',
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
import type { ShopProspect } from '../../data/api-shop';
import NotBought from './NotBought';

/** The harness's standard jsdom shims — `ResizeObserver` is the one the v2
 *  table chrome actually constructs. */
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

/** Every GET of the list route, oldest first — the query string is the assertion. */
const reads = (): string[] =>
  calls.filter((c) => c.path.split('?')[0] === PROSPECTS).map((c) => c.path);

const lastRead = (): string => {
  const all = reads();
  if (all.length === 0) throw new Error('the list was never asked for');
  return all[all.length - 1] as string;
};

beforeEach(() => {
  handlers.clear();
  calls = [];
  /* Pinned rather than faked wholesale: `userEvent` needs real timers to type,
     and so does the search box's own 220ms debounce. */
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
  window.sessionStorage.clear();
});

// ------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const PROSPECTS = '/api/shop/admin/customers/prospects';

/** Left a basket, never told us they wanted mail. ₦2,800 over three items. */
const lead: ShopProspect = {
  email: 'lead@example.test',
  displayName: null,
  hasBasket: true,
  hasAccount: false,
  isSubscriber: false,
  subscribeState: 'never_asked',
  basketItems: 3,
  basketMinor: 280_000,
  currency: 'NGN',
  lastSeenAt: NOW - 3_600_000,
  lastNudgeAt: null,
};

/** An account and a subscription and no basket — the row whose Basket cell
 *  must stay BLANK rather than reading ₦0. */
const ada: ShopProspect = {
  email: 'ada@example.test',
  displayName: 'Ada Okoye',
  hasBasket: false,
  hasAccount: true,
  isSubscriber: true,
  subscribeState: 'subscribed',
  basketItems: 0,
  basketMinor: 0,
  currency: '',
  lastSeenAt: NOW - 86_400_000,
  lastNudgeAt: NOW - 172_800_000,
};

/** Opted out. Still listed, still chipped as a subscriber — hiding the row
 *  would make somebody who asked to leave look like somebody we never met. */
const gone: ShopProspect = {
  email: 'gone@example.test',
  displayName: null,
  hasBasket: false,
  hasAccount: false,
  isSubscriber: true,
  subscribeState: 'unsubscribed',
  basketItems: 0,
  basketMinor: 0,
  currency: '',
  lastSeenAt: NOW - 604_800_000,
  lastNudgeAt: null,
};

interface PageOpts {
  items?: ShopProspect[];
  nextCursor?: string | null;
  unreachableBaskets?: number;
}

/** The list route, answering whatever the current query asks for. */
function withList(page: PageOpts | ((url: URL) => PageOpts) = {}): void {
  when(PROSPECTS, (url) => {
    const chosen = typeof page === 'function' ? page(url) : page;
    return {
      body: {
        items: chosen.items ?? [lead, ada, gone],
        nextCursor: chosen.nextCursor ?? null,
        unreachableBaskets: chosen.unreachableBaskets ?? 0,
      },
    };
  });
}

function mount() {
  return render(
    <ToastHost>
      <MemoryRouter initialEntries={['/customers/not-bought']}>
        <NotBought />
      </MemoryRouter>
    </ToastHost>,
  );
}

/**
 * Money, matched WITHOUT its symbol. `Intl` renders NGN as "₦2,800.00" under a
 * full ICU and "NGN 2,800.00" under a small one, so an exact string is a test
 * that passes on a laptop and fails elsewhere for a reason that has nothing to
 * do with the screen.
 */
const amount = (digits: string) => (content: string) => {
  const text = content.replace(/ /g, ' ').trim();
  return /^(?:₦|NGN ?)?[\d.,]+$/.test(text) && text.includes(digits);
};

/** The `<tr>` an address sits in. */
function rowFor(email: string): HTMLElement {
  const found = screen.getByText(email).closest('tr');
  if (found === null) throw new Error(`no row for ${email}`);
  return found as HTMLElement;
}

// ============================================================================

describe('the not-bought-yet list', () => {
  it('asks for the basket tab first', async () => {
    withList();
    mount();

    await screen.findByText('lead@example.test');
    /* The DEFAULT is the server's too (`DEFAULT_PROSPECT_TAB`), but naming it
       is what makes a later change to either side visible here rather than in
       production: an absent `tab=` would still have answered with baskets. */
    expect(reads()[0]).toContain(`${PROSPECTS}?tab=basket`);
  });

  it('switches tab, and drops the cursor it was holding', async () => {
    const user = userEvent.setup();
    withList({ nextCursor: 'cur_page2' });
    mount();

    await screen.findByText('lead@example.test');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastRead()).toContain('cursor=cur_page2'));

    await user.click(screen.getByRole('tab', { name: 'Subscribers' }));

    await waitFor(() => expect(lastRead()).toContain('tab=subscriber'));
    /* THE CURSOR IS A POSITION IN THE BASKET TAB'S ORDERING. Carried across it
       pages into a list it was never measured against, and what comes back
       looks entirely reasonable. */
    expect(lastRead()).not.toContain('cursor=');
  });

  it('says how many baskets we cannot reach, shop-wide, without opening a menu', async () => {
    /* 13 of 19 on production, 2026-09-08. A screen that lists 6 and says
       nothing else implies 6 is the whole picture. */
    withList({ items: [lead], unreachableBaskets: 13 });
    mount();

    const said = await screen.findByText(/13 more baskets/);
    /* The analytics bar starts HIDDEN, so this sentence is the only place the
       number can be — and the word that stops it reading as a claim about the
       rows on screen is "shop-wide". */
    expect(said.textContent).toContain('Shop-wide');
    expect(said.textContent).toContain('no email address at all');
    expect(screen.queryByLabelText('This page summary')).toBeNull();
  });

  it('keeps that count the same on a tab that shows no baskets at all', async () => {
    const user = userEvent.setup();
    /* The server does not move it with the tab, the cursor or the search — it
       is a property of the shop. So the wording has to survive standing beside
       zero baskets, which is exactly what the Subscribers tab is. */
    withList((url) =>
      url.searchParams.get('tab') === 'subscriber'
        ? { items: [gone], unreachableBaskets: 13 }
        : { items: [lead], unreachableBaskets: 13 },
    );
    mount();

    await screen.findByText('lead@example.test');
    await user.click(screen.getByRole('tab', { name: 'Subscribers' }));
    await screen.findByText('gone@example.test');

    const said = screen.getByText(/13 more baskets/);
    expect(said.textContent).toContain('Shop-wide');
    /* And not one basket is claimed for this page. */
    expect(rowFor('gone@example.test').textContent).not.toMatch(/item/);
  });

  it('drops the sentence entirely when every basket has an address', async () => {
    withList({ unreachableBaskets: 0 });
    mount();

    await screen.findByText('lead@example.test');
    expect(screen.queryByText(/Shop-wide/)).toBeNull();
  });

  it('offers the send to marketing and gives support the list with nothing to mail it from', async () => {
    const user = userEvent.setup();
    withList();
    mount();

    await screen.findByText('lead@example.test');
    /* The bar only exists once something is ticked, so the pill has to be
       asked for with a row selected — otherwise "absent" is true of everybody
       and the assertion proves nothing. */
    await user.click(within(rowFor('lead@example.test')).getByLabelText('Select row'));
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /send an email/i })).toBeTruthy();

    cleanup();
    /* SUPPORT HOLDS `customers` AND `analytics` AND NOT `marketing` — it reads
       the list and cannot mail anybody. Gated on the DOMAIN and never on the
       role's name, so a role added later inherits the right answer. */
    fixture.session.user.role = 'support';
    mount();

    /* The ROWS are still there — the read is a different domain from the send,
       and a screen that 403s support would be the wrong gate applied twice. */
    await screen.findByText('lead@example.test');
    expect(screen.getByText('gone@example.test')).toBeTruthy();
    /* And the selection goes with the pill rather than standing on its own: a
       tick box whose only action is missing is a bar with nothing on it. */
    expect(screen.queryByLabelText('Select row')).toBeNull();
    expect(screen.queryByRole('button', { name: /send an email/i })).toBeNull();
  });

  it('marks an unsubscribed person as unsubscribed, and still chips them a subscriber', async () => {
    withList({ items: [gone, lead] });
    mount();

    await screen.findByText('gone@example.test');
    const row = rowFor('gone@example.test');
    expect(within(row).getByText('Unsubscribed')).toBeTruthy();
    /* The chip is about whether a row EXISTS in `email_subscribers`; the state
       beside it is whether we may write. Dropping the chip would make somebody
       who asked to leave look like somebody we had never met. */
    expect(within(row).getByText('Subscriber')).toBeTruthy();
    expect(within(rowFor('lead@example.test')).queryByText('Unsubscribed')).toBeNull();
  });

  it('prints a basket in naira and leaves an empty one blank', async () => {
    withList();
    mount();

    await screen.findByText('lead@example.test');
    const withGoods = rowFor('lead@example.test');
    expect(within(withGoods).getByText('3 items')).toBeTruthy();
    expect(within(withGoods).getByText(amount('2,800.00'))).toBeTruthy();
    expect(within(withGoods).getByText('Basket')).toBeTruthy();

    /* BLANK, not "0 items · ₦0": a zero in a money column reads as a basket
       worth nothing, which is not the same fact as no basket at all. */
    const empty = rowFor('ada@example.test');
    expect(within(empty).queryByText(/item/)).toBeNull();
    expect(within(empty).queryByText(amount('0.00'))).toBeNull();
    expect(within(empty).getByText('Ada Okoye')).toBeTruthy();
    expect(within(empty).getByText('Account')).toBeTruthy();
  });

  it('sends the search to the server rather than filtering the page it has', async () => {
    const user = userEvent.setup();
    withList((url) =>
      url.searchParams.get('query') === 'ada' ? { items: [ada] } : { items: [lead, ada, gone] },
    );
    mount();

    await screen.findByText('lead@example.test');
    const before = reads().length;
    await user.type(screen.getByRole('searchbox'), 'ada');

    /* The term on the wire — filtering the 25 rows already in hand would
       answer "nobody matches" for anybody sitting on page three. */
    await waitFor(() => expect(lastRead()).toContain('query=ada'));
    /* And ONE request for the word rather than one per keystroke. Three
       characters undebounced is three reads; the bound is loose by one so a
       stalled machine that lets the timer fire mid-word is not a failure. */
    expect(reads().length).toBeLessThan(before + 3);
    expect(lastRead()).toContain('tab=basket');
    await waitFor(() => expect(screen.queryByText('lead@example.test')).toBeNull());
  });

  it('names the population a tab found nothing in', async () => {
    const user = userEvent.setup();
    withList((url) =>
      url.searchParams.get('tab') === 'account' ? { items: [] } : { items: [lead] },
    );
    mount();

    await screen.findByText('lead@example.test');
    await user.click(screen.getByRole('tab', { name: 'Made an account' }));

    /* Not "No results": four tabs over four different populations, and which
       one is empty is the only thing the reader wanted to know. The body says
       where such a person went, because the tabs are DISJOINT — an account
       that starts a basket leaves this tab for the first one. */
    expect(await screen.findByText('No accounts waiting')).toBeTruthy();
    expect(screen.getByText(/moves to Has a basket/)).toBeTruthy();
  });
});
