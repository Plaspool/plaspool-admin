import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * THE BOARD, DRIVEN — not merely rendered.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, GIVEN CLAUDE.md §2 SAYS A GREEN SUITE HAS MEANT
 * NOTHING HERE.
 *
 * It cannot prove the board works in production; nothing that mounts a component
 * in jsdom can, and the two failures that killed this shop's orders screen (a
 * client type that disagreed with the payload, and post-response work that never
 * runs on Vercel) were both invisible to exactly this kind of test. So the bar is
 * lower and sharper: EVERY CASE HERE MUST FAIL AGAINST A WRONG IMPLEMENTATION,
 * not merely execute one.
 *
 * Four things follow from that, and they are why the setup looks heavier than it
 * needs to:
 *
 *  1. **The rows are `__fixtures__/orders-live.json`, verbatim.** Five real
 *     orders from the deployed shop. A fixture written from this component's
 *     assumptions would agree with it by construction, which is precisely how
 *     eleven passing tests once covered a dead screen.
 *  2. **`fetch` is stubbed, `shopApi` is not.** The requests go through the real
 *     `apiFetch`, so the path, the method, the body and the error classes are the
 *     production ones. A mocked `shopApi` would let a wrong route pass.
 *  3. **THE DROP RULE IS TESTED AS A FUNCTION.** `resolveDrop` is pure and it is
 *     the thing that decides whether a gesture can ship a parcel nobody packed,
 *     so it is asserted directly, outcome by outcome. Driving synthetic pointer
 *     events through a drag library in jsdom tests the library — `@dnd-kit`'s own
 *     suite already does that, and doing it here would swap a sharp assertion for
 *     a brittle one.
 *  4. **…and the seam between the rule and the screen is still exercised once,**
 *     through the KEYBOARD sensor with the lane boxes stubbed, because "the pure
 *     function is right" and "the screen calls it" are two claims and only the
 *     second one is about wiring.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/*
 * `useSession` is `useSyncExternalStore(subscribe, getSession)`, which requires
 * `getSession` to return a CACHED snapshot: a fresh object each call is an
 * infinite re-render, not a slow one. So the mock holds one object and swaps it
 * wholesale, exactly as `session.ts` itself does.
 */
const fixture = vi.hoisted(() => {
  const owner = {
    status: 'authed',
    user: { id: 'u_1', email: 'o@test.local', displayName: 'An Owner', role: 'owner' },
  };
  const writer = {
    status: 'authed',
    user: { id: 'u_2', email: 'w@test.local', displayName: 'A Writer', role: 'writer' },
  };
  return { owner, writer, current: owner as typeof owner };
});

vi.mock('../../data/session', () => ({
  getSession: () => fixture.current,
  subscribe: () => () => {},
  initSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../../data/sync', () => ({ revalidate: vi.fn() }));

import { ToastProvider } from '../../components/Toast';
import type { ShopOrderRow } from '../../data/api-shop';
import {
  BOARD_LANES,
  Board,
  STALE_PAYMENT_MS,
  awaitingPayment,
  laneCardsOf,
  legalTargets,
  resolveDrop,
} from './Board';
import { GeographyPanel } from './GeographyPanel';
import { SEEDED_DELIVERY_ZONES } from './geography';
import { BOARD_COLUMNS, COLUMN_LABEL, columnOf, type ColumnKey } from './pipeline';
import LIVE from '../__fixtures__/orders-live.json';

/*
 * jsdom has no `HTMLDialogElement.showModal`, and `Dialog` calls it from an
 * effect — without this every dialog throws during commit and React tears the
 * whole tree down, which fails every assertion for a reason that has nothing to
 * do with the board. Same shim, same reasoning, as `RequireAuth.test.tsx`.
 *
 * ⚠️  IT ALSO MODELS THE ONE UA BEHAVIOUR THE FOCUS CASES BELOW ARE ABOUT, and
 *     that is deliberate rather than convenient. Per HTML, `showModal()` stores
 *     the element that was focused when it ran and `close()` gives focus back to
 *     it; REMOVING a still-open modal does neither. A shim that only flipped
 *     `open` would pass whether or not `Dialog` closes before it unmounts, which
 *     is precisely the bug — so the shim implements both halves and the tests
 *     can fail against the version that skipped `close()`. Nothing here can
 *     prove the real browser does it (CLAUDE.md §2); this fails on the wrong
 *     implementation, which is the bar this file sets for itself.
 */
const dialogProto = Object.getPrototypeOf(document.createElement('dialog'));
if (typeof dialogProto.showModal !== 'function') {
  dialogProto.showModal = function (this: HTMLDialogElement & { __restoreTo?: Element | null }) {
    this.open = true;
    this.__restoreTo = document.activeElement;
  };
  dialogProto.close = function (this: HTMLDialogElement & { __restoreTo?: Element | null }) {
    this.open = false;
    const back = this.__restoreTo ?? null;
    this.__restoreTo = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
}

/*
 * Raised for this file only. Nothing here is slow work — it is jsdom's
 * `getComputedStyle`, which every `*ByRole` query and every `userEvent`
 * visibility check goes through, against a board of seven lanes. 5 s is the
 * project default and it is thin enough that a loaded machine turns a passing
 * case red.
 */
vi.setConfig({ testTimeout: 20_000 });

const ROWS = LIVE.items as unknown as ShopOrderRow[];

/**
 * Two days after the newest payment in the capture. Every fixture order is then
 * `paid`, unpacked and one to two days old — which is `ageing` and not
 * `overdue`, so the red band is not being tested by accident.
 */
const NOW = 1787175360547 + 2 * 86_400_000;

// ──────────────────────────────────────────────────── rows built from the capture

/** The same order with every line covered — what a full shipment does to it. */
function packed(row: ShopOrderRow): ShopOrderRow {
  return { ...row, lines: row.lines.map((line) => ({ ...line, fulfilledQty: line.qty })) } as ShopOrderRow;
}

function withOrder(row: ShopOrderRow, over: Record<string, unknown>): ShopOrderRow {
  return { ...row, order: { ...row.order, ...over } } as unknown as ShopOrderRow;
}

/** The capture's own line, three deep. The SHAPE is the server's; only the count
 *  moves, because every order in the capture holds exactly one unit and a
 *  partial parcel needs two. */
function threeDeep(row: ShopOrderRow): ShopOrderRow {
  return { ...row, lines: row.lines.map((line) => ({ ...line, qty: 3 })) } as ShopOrderRow;
}

/**
 * The same order as `createOrderFromCheckout` INSERTs it and before any payment
 * event: `pending`, no `paidAt`, placed `agoMs` before `NOW`.
 *
 * `paidAt: null` is not decoration. It is the shape of the row this whole notice
 * is about — a checkout that completed and a `payment.captured` that never came.
 */
function unpaid(row: ShopOrderRow, agoMs: number): ShopOrderRow {
  return withOrder(row, { status: 'pending', paidAt: null, placedAt: NOW - agoMs });
}

// ────────────────────────────────────────────────────────── the fake server

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
/** path-suffix → [status, body]. First match wins; the defaults answer below. */
let routes: { match: RegExp; method: string; status: number; body: unknown }[] = [];

function detailFor(id: string, over: Partial<Record<string, unknown>> = {}) {
  const row = ROWS.find((r) => r.order.id === id) ?? ROWS[0];
  return {
    order: row.order,
    lines: row.lines,
    fulfillments: [],
    timeline: [],
    emails: [],
    payment: null,
    ...over,
  };
}

/** The same order with every line covered and one parcel on the bench. */
function packedDetail(id: string) {
  const row = ROWS.find((r) => r.order.id === id) ?? ROWS[0];
  return detailFor(id, {
    lines: row.lines.map((line) => ({ ...line, fulfilledQty: line.qty })),
    fulfillments: [
      {
        id: 'ful_1',
        orderId: id,
        status: 'pending',
        carrier: null,
        trackingNumber: null,
        shippedAt: null,
        deliveredAt: null,
        createdAt: NOW,
        revision: 1,
        lines: row.lines.map((line) => ({ id: 'fl_1', orderLineId: line.id, qty: line.qty })),
      },
    ],
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'https://studio.test');
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });

      const staged = routes.find((r) => r.method === method && r.match.test(url.pathname));
      if (staged !== undefined) {
        return new Response(JSON.stringify(staged.body), {
          status: staged.status,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Defaults: everything succeeds, and a re-read answers a packed order.
      const detail = /\/orders\/(ord_[^/]+)$/.exec(url.pathname);
      if (method === 'GET' && detail !== null) {
        return json(packedDetail(detail[1]));
      }
      if (method === 'POST' && /\/fulfillments$/.test(url.pathname)) {
        return json({ fulfillment: packedDetail(ROWS[0].order.id).fulfillments[0] }, 201);
      }
      if (method === 'POST' && /\/cancel$/.test(url.pathname)) {
        const id = /\/orders\/(ord_[^/]+)\/cancel$/.exec(url.pathname)?.[1] ?? '';
        const row = ROWS.find((r) => r.order.id === id) ?? ROWS[0];
        return json({ order: { ...row.order, status: 'cancelled', revision: row.order.revision + 1 } });
      }
      if (method === 'PATCH' && /\/fulfillments\//.test(url.pathname)) {
        return json({ fulfillment: packedDetail(ROWS[0].order.id).fulfillments[0], order: null });
      }
      return new Response(JSON.stringify({ error: 'gone', requestId: 'req_test' }), { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  fixture.current = fixture.owner;
  try {
    localStorage.clear();
  } catch {
    /* a browser without storage is the case the board is built to survive */
  }
});

function mount(rows: readonly ShopOrderRow[] = ROWS) {
  return render(
    <ToastProvider>
      <Board rows={rows} now={NOW} />
    </ToastProvider>,
  );
}

/**
 * `ColumnKey` is `pipeline.ts`'s vocabulary and `data-lane` carries it into the
 * DOM, so the helpers below address a lane by the key rather than by scraping a
 * heading. The ACCESSIBLE NAME is asserted separately, once — see the first case
 * — because that is a claim about the markup and not a way of finding it.
 */
const LANE: Record<string, ColumnKey> = {
  /* No entry for `awaiting_payment`. It is a column of the model and not a lane
   * of the board, so `lane('Awaiting payment')` SHOULD throw — see "the column
   * that is not a lane" below for the assertions that say so on purpose. */
  'To pack': 'to_pack',
  Packing: 'packing',
  'Open to check': 'check_parcel',
  Shipped: 'shipped',
  Closed: 'closed',
  'Needs a look': 'needs_attention',
};

/*
 * `querySelector` AND NOT `getByRole` FOR THE HELPERS, and it is not laziness.
 * `*ByRole` builds the accessibility tree for the whole document and calls
 * `getComputedStyle` on every node to decide what is hidden; jsdom's
 * implementation of that is slow enough that seven lanes of cards queried a
 * dozen times per case blew the 5 s default timeout. Every assertion that is
 * ABOUT accessibility — a button found by its accessible name, the live region,
 * a dialog's heading — still goes through `*ByRole`, scoped to one card.
 */
function lane(name: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-lane="${LANE[name]}"]`);
  if (node === null) throw new Error(`no lane on the board called ${name}`);
  return node;
}

/** Every card face inside a lane, by the order number each one names. */
function cardsIn(name: string): string[] {
  return [...lane(name).querySelectorAll('.shopcard__face')].map(
    (node) => /^Order ([^,]+),/.exec(node.getAttribute('aria-label') ?? '')?.[1] ?? '',
  );
}

/** The card for one order number, wherever it is. */
function card(number: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.shopcard__face')].find((node) =>
    (node.getAttribute('aria-label') ?? '').startsWith(`Order ${number},`),
  );
  if (found === undefined) throw new Error(`no card on the board for ${number}`);
  return found.closest('.shopcard') as HTMLElement;
}

/** The face button of one card — the thing a click or a Tab lands on. */
function face(number: string): HTMLElement {
  return card(number).querySelector('.shopcard__face') as HTMLElement;
}

/** The board's own polite live region — what a MOVE said, not what the drag
 *  layer narrated. */
function spoken(): string {
  return document.querySelector('.shopboard > [role="status"]')?.textContent ?? '';
}

// ═══════════════════════════════════════════════════════════ the drop rule

/**
 * THE RULE, AS A FUNCTION. Every case below would pass on a board with no drag
 * layer at all and fail on one whose lane→move table drifted from
 * `pipeline.ts`, which is the whole point of asserting it here.
 */
describe('resolveDrop', () => {
  const toPack = ROWS[0];

  it('answers a lane the card can reach with the move that gets it there', () => {
    expect(columnOf(toPack)).toBe('to_pack');
    const outcome = resolveDrop(toPack, 'packing', 'owner', NOW);
    expect(outcome.kind).toBe('form');
    // The MOVE, not a transition — nothing has been decided about a request.
    expect(outcome.kind === 'form' && outcome.move.key).toBe('pack');
  });

  it('is a noop on the lane the card already lives in', () => {
    // Releasing where it started is the operator changing their mind mid-drag,
    // which is what dragging a card back is for. Not an error, not a message.
    expect(resolveDrop(toPack, 'to_pack', 'owner', NOW)).toEqual({ kind: 'noop' });
  });

  it('refuses a lane no move leads to, and names both lanes', () => {
    const outcome = resolveDrop(toPack, 'shipped', 'owner', NOW);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/To pack/);
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/Shipped/);
  });

  it('offers an owner the drop that cancels, and refuses a writer the same drop', () => {
    const asOwner = resolveDrop(toPack, 'closed', 'owner', NOW);
    expect(asOwner.kind).toBe('form');
    expect(asOwner.kind === 'form' && asOwner.move.key).toBe('cancel');
    // `POST /orders/:id/cancel` is `requireOwner()`. The refusal says which rule
    // stopped it rather than pretending the order cannot be cancelled at all.
    const asWriter = resolveDrop(toPack, 'closed', 'writer', NOW);
    expect(asWriter.kind).toBe('refused');
    expect(asWriter.kind === 'refused' && asWriter.reason).toMatch(/[Oo]nly the owner/);
  });

  it('sends a fully packed paid order to Shipped and nowhere else', () => {
    const row = packed(ROWS[0]);
    expect(columnOf(row)).toBe('packing');
    const outcome = resolveDrop(row, 'shipped', 'owner', NOW);
    expect(outcome.kind).toBe('form');
    expect(outcome.kind === 'form' && outcome.move.key).toBe('ship');
  });

  it('will not move an order out of a terminal lane, and says which one', () => {
    const closed = withOrder(ROWS[0], { status: 'cancelled', cancelledAt: NOW });
    expect(columnOf(closed)).toBe('closed');
    for (const target of BOARD_COLUMNS.filter((l) => l !== 'closed')) {
      const outcome = resolveDrop(closed, target, 'owner', NOW);
      expect(outcome.kind).toBe('refused');
      expect(outcome.kind === 'refused' && outcome.reason).toMatch(/closed/i);
    }
  });

  it('will not move a row the board cannot read, whoever is asking', () => {
    const broken = withOrder(ROWS[0], { status: 'on_hold' });
    expect(columnOf(broken)).toBe('needs_attention');
    const outcome = resolveDrop(broken, 'to_pack', 'owner', NOW);
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.reason).toMatch(/cannot work this order/);
  });

  it('lights exactly the lanes a drop would be accepted on', () => {
    // Everything else is dimmed while the card is held, so an illegal target is
    // visible BEFORE the release rather than explained after it.
    expect(legalTargets(ROWS[0], 'owner', NOW)).toEqual(['packing', 'closed']);
    expect(legalTargets(ROWS[0], 'writer', NOW)).toEqual(['packing']);
    // A `deliver`-only row leads nowhere: `delivered` is not derivable from the
    // list payload and so is not a lane. The move list is the path to it.
    const shipped = withOrder(packed(ROWS[0]), { status: 'fulfilled', fulfilledAt: NOW });
    expect(columnOf(shipped)).toBe('shipped');
    expect(legalTargets(shipped, 'owner', NOW)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════ the lanes

describe('the lanes', () => {
  it('puts the live capture where pipeline.ts says it goes', () => {
    mount();

    // Every lane is a landmark with its count in the name, so a screen reader
    // reaches "To pack: 5 orders" without reading five cards to find out.
    expect(screen.getByRole('region', { name: 'To pack: 5 orders' })).toBeTruthy();

    // Every order in the capture is `paid`, unpacked and un-fulfilled, so all
    // five are work waiting on the operator and none is anywhere else.
    expect(cardsIn('To pack')).toHaveLength(5);
    expect(cardsIn('To pack')).toContain('2026-000006-S');
    expect(cardsIn('Packing')).toHaveLength(0);
    expect(cardsIn('Shipped')).toHaveLength(0);
    expect(cardsIn('Closed')).toHaveLength(0);
    expect(cardsIn('Needs a look')).toHaveLength(0);
  });

  it('keeps the terminal lanes as lanes rather than hiding those orders', () => {
    /*
     * The divergence from `ReturnsBoard.tsx` argued in `Board.tsx`'s header. A
     * cancelled order is still on the page the route fetched; dropping the lane
     * would make `?status=cancelled` render an empty board, and would make this
     * page show four cards for five orders with nothing saying where the fifth
     * went.
     */
    const rows = [withOrder(ROWS[0], { status: 'cancelled', cancelledAt: NOW }), ...ROWS.slice(1)];
    mount(rows);
    expect(cardsIn('Closed')).toEqual(['2026-000006-S']);
    expect(cardsIn('To pack')).toHaveLength(4);
  });

  it('heads each lane with the count and the money, grouped by currency', () => {
    mount();
    const head = lane('To pack');
    expect(within(head).getByText('5')).toBeTruthy();
    // Five orders at ₦25,000 + ₦26,000 × 4 = ₦129,000, in minor units at 100 to
    // the naira. Copied from the frozen `grandTotal`, never recomputed.
    expect(within(head).getByText(/129,000\.00/)).toBeTruthy();
  });

  it('gives a lane head the count and money of ITS OWN column, not its neighbour’s', () => {
    /*
     * THE OFF-BY-ONE THE DROPPED LANE MADE POSSIBLE, pinned. `summarise` reports
     * SEVEN columns starting at `awaiting_payment`; the board draws six starting
     * at `to_pack`. Head each lane from `summary.columns[index]` — which is what
     * this file did while the two lists were the same — and every heading
     * carries its left-hand neighbour's numbers: "To pack" would say 1 and
     * ₦25,000 here, and the board would look entirely plausible.
     */
    mount([unpaid(ROWS[0], 3 * 60 * 60_000), ...ROWS.slice(1)]);

    const head = lane('To pack');
    // The four paid orders, at ₦26,000 each. NOT the one unpaid one at ₦25,000.
    expect(within(head).getByText('4')).toBeTruthy();
    expect(within(head).getByText(/104,000\.00/)).toBeTruthy();
    expect(within(head).queryByText(/25,000\.00/)).toBeNull();

    // …and the far end of the board is not one lane out either.
    expect(screen.getByRole('region', { name: 'Needs a look: 0 orders' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Closed: 0 orders' })).toBeTruthy();
  });

  /**
   * FIVE OF THE SIX EMPTY LANES USED TO SAY "Nothing here." — on the board a
   * healthy shop looks at most days, where five lanes empty IS the good day. Each
   * one now says what the emptiness means, and the sentence has to match
   * `columnOf`'s own predicate for that lane rather than be a cheerful noise.
   */
  it('tells each empty lane what its emptiness means', () => {
    mount([]);

    const said = [...document.querySelectorAll('.shoplist__empty')].map((n) => n.textContent ?? '');
    expect(said).toHaveLength(6);
    expect(said.some((line) => line === 'Nothing here.')).toBe(false);
    // Six lanes, six different sentences — not one line repeated with a full stop.
    expect(new Set(said).size).toBe(6);

    const of = (name: string): string =>
      lane(name).querySelector('.shoplist__empty')?.textContent ?? '';
    // Each names the shape that WOULD fill it, which is the fact the operator
    // can act on: `packing` is a partly-covered order, `check_parcel` is one
    // refunded before `settleOrderFulfilled` could mark it.
    expect(of('Packing')).toMatch(/half-filled/);
    expect(of('Open to check')).toMatch(/refund landing before the parcel settles/);
    expect(of('Closed')).toMatch(/cancelled or refunded in full/);
    // The one that already had a sentence keeps it, verbatim — it was the model.
    expect(of('Needs a look')).toMatch(/staying empty is the good outcome/);
  });

  /**
   * THE HOOK THAT KEEPS THE FIRST CARD OF EVERY LANE ON ONE LINE. A head is one,
   * two or three rows deep depending on whether ITS lane has money and ageing
   * tallies; `board.css` reserves the rows so they all match, and it may only
   * charge for a row some lane on this board actually fills. Measured before the
   * fix, at 1280px: cards started at y=451 in the lanes with money and y=430 in
   * the ones without.
   */
  it('marks the canvas with the head rows this board actually needs', () => {
    const canvas = () => document.querySelector('.shopboard__canvas') as HTMLElement;

    // Money on the board, nothing overdue or ageing: one reserved row, not two.
    mount([withOrder(ROWS[0], { paidAt: NOW, placedAt: NOW })]);
    expect(canvas().className).toContain('shopboard__canvas--money');
    expect(canvas().className).not.toContain('shopboard__canvas--ages');
    cleanup();

    // The capture is two days old, so every card is ageing and the tally row is
    // on the board — and now both rows are reserved.
    mount();
    expect(canvas().className).toContain('shopboard__canvas--money');
    expect(canvas().className).toContain('shopboard__canvas--ages');
    cleanup();

    // An empty page has neither, and pays for neither.
    mount([]);
    expect(canvas().className).toBe('shopboard__canvas');
  });

  it('shows an order the client cannot read in its own lane, with no moves', async () => {
    const user = userEvent.setup();
    mount([withOrder(ROWS[0], { status: 'on_hold' })]);

    expect(cardsIn('Needs a look')).toHaveLength(1);
    const number = cardsIn('Needs a look')[0];
    await user.click(face(number));
    const open = within(card(number));
    expect(open.getByText(/arrived in a shape this screen cannot address/)).toBeTruthy();
    // No lane, no moves: `movesFor` returns nothing for a row it cannot address.
    expect(open.queryAllByRole('button', { name: /packing|shipped|cancel/i })).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════ the column that is not a lane

/**
 * `awaiting_payment` IS A TRUE CLASSIFICATION AND NOT A LIST ON A CANVAS.
 *
 * Every case here fails on the obvious wrong implementations: a board that still
 * draws the lane, a board that drops the row and says nothing, a threshold that
 * fires on an ordinary in-flight payment, and a drag layer that still has a
 * seventh lane to arrow into.
 */
describe('the column that is not a lane', () => {
  it('draws no lane for it, at any width, with or without a row in it', () => {
    mount([unpaid(ROWS[0], 3 * 60 * 60_000), ...ROWS.slice(1)]);

    expect(document.querySelector('[data-lane="awaiting_payment"]')).toBeNull();
    expect(screen.queryByRole('region', { name: /^Awaiting payment/ })).toBeNull();
    expect(screen.queryByText('Awaiting payment')).toBeNull();

    // The list the board walks, and the type that walks it.
    expect(BOARD_LANES).not.toContain('awaiting_payment');
    expect([...BOARD_LANES]).toEqual(BOARD_COLUMNS.filter((c) => c !== 'awaiting_payment'));
    expect(laneCardsOf(ROWS, NOW).map((l) => l.lane)).not.toContain('awaiting_payment');

    // The unpaid order is drawn NOWHERE — not smuggled into another lane.
    expect(cardsIn('To pack')).toHaveLength(4);
    expect(cardsIn('Needs a look')).toHaveLength(0);
    expect(cardsIn('Closed')).toHaveLength(0);
    expect(document.querySelectorAll('.shopcard').length).toBe(4);
  });

  it('hands the row over instead of swallowing it, so the screen can account for it', () => {
    /*
     * THE OTHER HALF OF THE SENTENCE. `laneCardsOf` drops the row on purpose;
     * this is what stops that being a silent loss. `ShopOrders.tsx` counts these
     * above the board and links to them, and its own suite asserts the words.
     */
    const rows = [unpaid(ROWS[0], 3 * 60 * 60_000), ...ROWS.slice(1)];
    const drawn = laneCardsOf(rows, NOW).reduce((n, l) => n + l.cards.length, 0);
    const away = awaitingPayment(rows, NOW);

    expect(away.all).toHaveLength(1);
    expect(away.all[0].order.orderNumber).toBe('2026-000006-S');
    // Nothing is lost and nothing is counted twice: drawn + not drawn = the page.
    expect(drawn + away.all.length).toBe(rows.length);
  });

  it('says nothing about a payment still in flight, and speaks the moment it is not', () => {
    /*
     * THE THRESHOLD, PINNED ON BOTH SIDES, to the millisecond. The boundary is
     * an hour: below it a payment is merely in flight — the live capture's
     * capture-to-payment gaps are 191 ms, 22 s and 63 s — and above it no event
     * is coming, because nothing in this system ever expires a pending order.
     */
    const justUnder = awaitingPayment([unpaid(ROWS[0], STALE_PAYMENT_MS - 1)], NOW);
    expect(justUnder.all).toHaveLength(1); // counted…
    expect(justUnder.stale).toHaveLength(0); // …and quiet.
    expect(justUnder.oldestSince).toBeNull();

    const justOver = awaitingPayment([unpaid(ROWS[0], STALE_PAYMENT_MS)], NOW);
    expect(justOver.stale).toHaveLength(1);
    expect(justOver.oldestSince).toBe(NOW - STALE_PAYMENT_MS);

    // The slowest gap anywhere in the live capture, which must stay silent by a
    // wide margin or the notice is one an operator learns to ignore.
    expect(awaitingPayment([unpaid(ROWS[0], 63_020)], NOW).stale).toHaveLength(0);
    expect(STALE_PAYMENT_MS / 63_020).toBeGreaterThan(50);

    /*
     * AND THE SAME TWO CLAIMS IN ABSOLUTE TIME, so moving the constant cannot
     * quietly take the cases above with it: five minutes is silent, six hours is
     * not, and the boundary therefore sits well above a minute — every observed
     * payment lands inside one — and well below a day, because money that may be
     * sitting at the provider is worth finding within the working day.
     */
    expect(awaitingPayment([unpaid(ROWS[0], 5 * 60_000)], NOW).stale).toHaveLength(0);
    expect(awaitingPayment([unpaid(ROWS[0], 6 * 60 * 60_000)], NOW).stale).toHaveLength(1);
    expect(STALE_PAYMENT_MS).toBeGreaterThan(60_000);
    expect(STALE_PAYMENT_MS).toBeLessThan(24 * 60 * 60_000);
  });

  it('reports the oldest of several, and reports them oldest first', () => {
    const rows = [
      unpaid(ROWS[0], 2 * 60 * 60_000),
      unpaid(ROWS[1], 26 * 60 * 60_000),
      unpaid(ROWS[2], 30_000),
    ];
    const away = awaitingPayment(rows, NOW);

    expect(away.all.map((r) => r.order.orderNumber)).toEqual([
      '2026-000005-F',
      '2026-000006-S',
      '2026-000004-T',
    ]);
    // The 30-second-old one is ordinary and is not in `stale`, but it is still
    // in `all` — it is a row of the page that is not a card on the board.
    expect(away.stale.map((r) => r.order.orderNumber)).toEqual([
      '2026-000005-F',
      '2026-000006-S',
    ]);
    expect(away.oldestSince).toBe(NOW - 26 * 60 * 60_000);
  });

  it('counts a row with an unreadable date and never calls it stale', () => {
    // `ageBand`'s rule, borrowed: a broken timestamp is a data bug, and raising
    // a money alarm off one is how a warning stops being read.
    const broken = withOrder(ROWS[0], { status: 'pending', paidAt: null, placedAt: undefined });
    const away = awaitingPayment([broken], NOW);

    expect(away.all).toHaveLength(1);
    expect(away.stale).toHaveLength(0);
    expect(away.oldestSince).toBeNull();
  });

  it('leaves an unpaid row the board cannot address in its lane, uncounted here', () => {
    /*
     * `columnOf` IS THE AUTHORITY, NOT `order.status`. A `pending` row with no
     * id is `needs_attention` — it IS on the board — so counting it as "awaiting
     * payment" as well would report one order twice and subtract it from the
     * board's own count for a card that is sitting right there.
     */
    const rows = [withOrder(unpaid(ROWS[0], 3 * 60 * 60_000), { id: '' }), ...ROWS.slice(1)];
    mount(rows);

    expect(cardsIn('Needs a look')).toHaveLength(1);
    expect(awaitingPayment(rows, NOW).all).toHaveLength(0);
  });

  it('offers no drop that lands on it, for any row and either role', () => {
    const shapes: ShopOrderRow[] = [
      ROWS[0],
      packed(ROWS[0]),
      unpaid(ROWS[0], 3 * 60 * 60_000),
      withOrder(ROWS[0], { status: 'cancelled', cancelledAt: NOW }),
      withOrder(ROWS[0], { status: 'on_hold' }),
    ];

    for (const row of shapes) {
      for (const role of ['owner', 'writer'] as const) {
        expect(legalTargets(row, role, NOW)).not.toContain('awaiting_payment');
        // Even asked directly — as a stale drag id would ask — no release
        // resolves to a form for a lane the board does not draw.
        expect(resolveDrop(row, 'awaiting_payment', role, NOW).kind).not.toBe('form');
      }
    }
  });

  it('has no lane to the left of To pack for a held card to arrow into', async () => {
    /*
     * THE DRAG LAYER'S OWN LIST, not the pure one. `To pack` is the leftmost
     * lane on the rail now, so `laneCoordinateGetter` clamps there and the
     * release is a noop that puts the card back. Restore the lane — drawn,
     * measured and registered, as it was — and this fails instead: the card
     * arrows one lane further left and the release resolves to `awaiting_payment`,
     * which answers `refused` and says the card "stayed" rather than came home.
     *
     * MEASURED, NOT ASSUMED: a droppable registered with NO NODE is inert here.
     * dnd-kit never measures it, so it is absent from `droppableRects` and from
     * collision detection, and re-adding the `useDroppable` call alone changes
     * nothing this can see. That is why the guard against a drop naming a lane
     * that is not drawn is `BoardLane` — a type, checked at build — rather than a
     * runtime branch nothing could reach.
     */
    const user = userEvent.setup();
    mount();
    const restore = stubBoxes();
    try {
      const number = cardsIn('To pack')[0];
      face(number).focus();
      await user.keyboard(' ');
      await waitFor(() => expect(lane('Packing').className).toContain('shoplist--legal'));

      await user.keyboard('{ArrowLeft}');
      await user.keyboard('{Enter}');

      // Nowhere to go: the card came home, nothing was asked and nothing sent.
      await waitFor(() => expect(spoken()).toMatch(/put back in To pack/));
      expect(screen.queryByRole('heading', { name: /^Pack order/ })).toBeNull();
      expect(cardsIn('To pack')).toContain(number);
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════ roles

describe('what each role is offered', () => {
  it('does not offer a writer the owner-only cancel', async () => {
    fixture.current = fixture.writer;
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    const open = within(card(number));

    expect(open.getByRole('button', { name: /Start packing/ })).toBeTruthy();
    // Withheld, not disabled: `POST /orders/:id/cancel` is `requireOwner()`, and
    // a greyed-out button on a writer's surface is a standing invitation to a
    // 403.
    expect(open.queryByRole('button', { name: /Cancel this order/ })).toBeNull();
    // …and the absence is explained rather than left as a hole in the list.
    expect(open.getByText(/Only the owner can cancel an order/)).toBeTruthy();
  });

  it('offers an owner the cancel, and asks before it fires', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    const cancel = within(card(number)).getByRole('button', { name: /Cancel this order/ });

    await user.click(cancel);
    // `Move.confirm` is `pipeline.ts`'s flag; nothing has been sent yet.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Cancel this order' })).toBeTruthy();
    expect(cardsIn('To pack')).toContain(number);
  });
});

// ═══════════════════════════════════════ a drop is the intent, a form is the act

describe('the form is the act', () => {
  it('opens the shipment form and moves nothing until it is submitted', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));

    // The form is open…
    expect(screen.getByRole('heading', { name: `Pack order ${number}` })).toBeTruthy();
    // …the card has NOT moved…
    expect(cardsIn('To pack')).toContain(number);
    expect(cardsIn('Packing')).toHaveLength(0);
    // …and nothing at all has been sent. A gesture cannot name what is in a box,
    // so the board refuses to guess: this is the assertion the whole design is
    // for.
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('leaves the card at home when the form is abandoned', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: /^Pack order/ })).toBeNull());
    expect(cardsIn('To pack')).toContain(number);
    expect(cardsIn('Packing')).toHaveLength(0);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('sends the quantities the operator named, not everything outstanding', async () => {
    const user = userEvent.setup();
    // Three units on the line, two on the shelf — the case the shipment form was
    // built around, and the one a drag alone would get wrong by shipping three.
    mount([threeDeep(ROWS[0])]);

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));

    const qty = screen.getByRole('spinbutton', { name: /in this parcel/i });
    // The form starts at `packableOf`'s answer: everything nothing holds yet.
    expect((qty as HTMLInputElement).value).toBe('3');
    await user.clear(qty);
    await user.type(qty, '2');
    await user.type(screen.getByLabelText('Carrier'), 'GIG Logistics');
    await user.type(screen.getByLabelText('Tracking number'), 'GIG-77');

    await user.click(screen.getByRole('button', { name: 'Create shipment' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const posted = calls.find((c) => c.method === 'POST');
    expect(posted?.path).toMatch(/^\/api\/shop\/admin\/orders\/ord_[^/]+\/fulfillments$/);
    expect(posted?.body).toMatchObject({
      lines: [{ qty: 2 }],
      carrier: 'GIG Logistics',
      trackingNumber: 'GIG-77',
    });
  });

  it('refuses a parcel bigger than the order owes rather than clamping it', async () => {
    const user = userEvent.setup();
    mount([threeDeep(ROWS[0])]);

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));

    const qty = screen.getByRole('spinbutton', { name: /in this parcel/i });
    await user.clear(qty);
    await user.type(qty, '9');

    // Quietly shipping 3 when the operator typed 9 would be the board deciding
    // what is in a box it cannot see.
    expect(screen.getByText(/more units than are still unpacked/)).toBeTruthy();
    /*
     * `aria-disabled` AND NOT `disabled`, which is the difference between a
     * refusal and a disappearance: the button stays in the tab order so the
     * sentence explaining it can be read from it, and the click is refused in
     * the handler instead. Pressing it anyway is asserted below to send focus at
     * the field rather than do nothing.
     */
    const submit = screen.getByRole('button', { name: 'Create shipment' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    await user.click(submit);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    expect(document.activeElement).toBe(qty);
  });

  it('moves the card once the form commits, on the request planMove described', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));
    await user.click(screen.getByRole('button', { name: 'Create shipment' }));

    await waitFor(() => expect(cardsIn('Packing')).toContain(number));
    expect(cardsIn('To pack')).not.toContain(number);

    const posted = calls.find((c) => c.method === 'POST');
    // Asserted present first: reading `.lines` off an absent call would throw a
    // TypeError, and a case that dies of its own assertion reports the wrong
    // failure.
    expect(posted).toBeDefined();
    expect(posted?.path).toMatch(/^\/api\/shop\/admin\/orders\/ord_[^/]+\/fulfillments$/);
    expect((posted?.body as { lines: unknown[] } | undefined)?.lines).toHaveLength(1);

    await waitFor(() => expect(spoken()).toMatch(/Start packing done/));
  });
});

// ═══════════════════════════════════════════════════ the drop, through the screen

/**
 * jsdom has no layout, so every `getBoundingClientRect` is a box of zeroes and
 * the drag layer would measure seven lanes stacked on one another. They are given
 * fake, non-overlapping boxes instead — 180 wide, 200 apart, in board order —
 * which is the one piece of the browser this case needs.
 *
 * EVERYTHING ELSE FALLS BACK TO THE HELD CARD'S BOX, because the drag overlay's
 * own node is the thing the collision detector measures and it is not ours to
 * find by class.
 */
function stubBoxes(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const box = (left: number, width: number): DOMRect =>
    ({
      left,
      right: left + width,
      top: 0,
      bottom: 400,
      width,
      height: 400,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = this.getAttribute?.('data-lane');
    if (key !== null && key !== undefined) {
      return box(BOARD_COLUMNS.indexOf(key as ColumnKey) * 200, 180);
    }
    // The card, and the overlay copy of it: inside `to_pack`, where the capture
    // puts every order.
    return box(210, 160);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe('a drop through the drag layer', () => {
  it('opens the form for the lane it was dropped on, and moves nothing', async () => {
    const user = userEvent.setup();
    mount();
    const restore = stubBoxes();
    try {
      const number = cardsIn('To pack')[0];
      face(number).focus();
      expect(document.activeElement).toBe(face(number));

      // Space is the sensor's own activator — there is no key handler on the
      // card. `keyboardCodes.start` is narrowed to Space precisely so Enter can
      // go on opening the move list.
      await user.keyboard(' ');
      // The refusal is visible BEFORE the release: the two lanes a move leads to
      // are outlined and every other lane is flattened, while the lane the card
      // came from is left alone because putting it back is always allowed.
      await waitFor(() => expect(lane('Packing').className).toContain('shoplist--legal'));
      expect(lane('Closed').className).toContain('shoplist--legal');
      expect(lane('Shipped').className).toContain('shoplist--illegal');
      expect(lane('To pack').className).not.toContain('shoplist--');

      // One press, one lane: `laneCoordinateGetter` snaps to the next lane's
      // centre rather than nudging the card 25px, so seven lanes are six presses
      // apart rather than forty.
      await user.keyboard('{ArrowRight}');
      await waitFor(() => expect(lane('Packing').className).toContain('shoplist--over'));

      await user.keyboard('{Enter}');

      // THE WHOLE CONTRACT: the release opened the form and moved nothing.
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: `Pack order ${number}` })).toBeTruthy(),
      );
      expect(cardsIn('To pack')).toContain(number);
      expect(cardsIn('Packing')).toHaveLength(0);
      expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

// ══════════════════════════════════════ the rail, and what is past its edges

/**
 * THE LANE BOXES THE BROWSER ACTUALLY PRODUCES AT A 900px WINDOW, so this case
 * asserts against the shipped geometry rather than an invented one.
 *
 * Measured in Chrome against a scratch harness of this board: the full-bleed
 * canvas is 868px of visible width, `board.css`'s clamp bottoms out at its 15rem
 * floor, and six 240px lanes with `--s3` gutters run to 1500px — so `shipped` is
 * 47% visible and `closed` and `needs a look` are entirely past the right edge.
 * jsdom has no layout, so those numbers are handed to it directly.
 */
function stubRail(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  const box = (left: number, width: number): DOMRect =>
    ({
      left,
      right: left + width,
      top: 0,
      bottom: 400,
      width,
      height: 400,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: Element) {
    const key = this.getAttribute?.('data-lane');
    if (key !== null && key !== undefined) {
      return box((BOARD_LANES as readonly string[]).indexOf(key) * 252, 240);
    }
    if (this.classList?.contains('shopboard__canvas')) return box(0, 868);
    return box(0, 240);
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/** Every lane the board is currently offering the held card, by key. */
function litLanes(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.shoplist--legal, .shoplist--over')].map(
    (node) => node.dataset.lane ?? '',
  );
}

/** Whether more than half of a lane is inside the canvas — `Board.tsx`'s own
 *  rule, restated here so the assertion cannot drift with it silently. */
function onScreen(lane: string): boolean {
  const canvas = document.querySelector('.shopboard__canvas') as HTMLElement;
  const node = document.querySelector(`[data-lane="${lane}"]`) as HTMLElement;
  const box = canvas.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return Math.min(rect.right, box.right) - Math.max(rect.left, box.left) >= rect.width / 2;
}

/** What the two edge markers say, start first. */
function edgeMarkers(): string[] {
  return [...document.querySelectorAll('.shopboard__beyond')].map((node) =>
    (node.textContent ?? '').trim(),
  );
}

describe('a lane past the edge of the rail', () => {
  /**
   * THE BLOCKING HALF OF THE LAYOUT DEFECT, AS AN INVARIANT.
   *
   * Outlining a legal lane says nothing about a legal lane that is off the
   * screen, and on the shipped board that was the ordinary case rather than the
   * corner one: `legalTargets(row, 'owner', now)` answered `['packing', 'closed']`
   * and exactly ONE lane lit, because `closed` was past the right-hand edge at
   * every desktop width. The board understated where the card could go.
   *
   * The assertion is not "a marker exists" — it is that NO lit lane is left
   * unnamed, which is the property, and which stays true if the marker is
   * redesigned or the widths are retuned.
   */
  it('names every legal lane the operator cannot see, while the card is in hand', async () => {
    const user = userEvent.setup();
    mount();
    const restore = stubRail();
    try {
      const number = cardsIn('To pack')[0];
      face(number).focus();
      await user.keyboard(' ');

      // The reviewer's case, reproduced: two lanes will take this card.
      await waitFor(() => expect(litLanes()).toEqual(['packing', 'closed']));

      // …and one of them is off the screen, which is what makes the case worth
      // asserting rather than a tautology about a board that happens to fit.
      const hidden = litLanes().filter((lane) => !onScreen(lane));
      expect(hidden).toEqual(['closed']);

      await waitFor(() => expect(edgeMarkers().join(' ')).toContain('drop in'));
      const said = edgeMarkers().join(' ');
      for (const lane of hidden) {
        expect(said, `${lane} is a legal drop target and nothing on screen says so`).toContain(
          COLUMN_LABEL[lane as ColumnKey],
        );
      }
      // The one that IS on screen is left to its own outline — a marker naming a
      // lane the operator is looking at is noise pointing at the wrong edge.
      expect(said).not.toContain(COLUMN_LABEL.packing);
      expect(edgeMarkers()).toEqual(['drop in Closed ▸']);
      expect(document.querySelector('.shopboard__beyond--drop')).toBeTruthy();
    } finally {
      restore();
    }
  });

  /**
   * AT REST IT COUNTS RATHER THAN NAMES, and the difference is the question being
   * asked. With nothing in hand the only thing worth saying is that the board
   * does not end at this edge; five lane names in a pill on a phone would cover
   * the card underneath it.
   */
  it('counts what is past the edge when nothing is being dragged', async () => {
    mount();
    const restore = stubRail();
    try {
      // The board measures on mount, on scroll and on resize — the mount pass ran
      // before these boxes existed, so this is the resize.
      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(edgeMarkers()).toEqual(['3 more lanes ▸']));
      expect(document.querySelector('.shopboard__beyond--drop')).toBeNull();
    } finally {
      restore();
    }
  });

  /** The rail re-reads itself when it is scrolled, which is the event that fires
   *  while the drag layer auto-scrolls towards a lane the marker just named. */
  it('re-reads the edges when the rail is scrolled', async () => {
    mount();
    const restore = stubRail();
    try {
      fireEvent(window, new Event('resize'));
      await waitFor(() => expect(edgeMarkers()).toEqual(['3 more lanes ▸']));

      // Scrolled to the far end: now it is the first three that are past the
      // start, and the marker has to have changed sides.
      Element.prototype.getBoundingClientRect = function (this: Element) {
        const key = this.getAttribute?.('data-lane');
        if (key !== null && key !== undefined) {
          return {
            left: (BOARD_LANES as readonly string[]).indexOf(key) * 252 - 656,
            right: (BOARD_LANES as readonly string[]).indexOf(key) * 252 - 656 + 240,
            width: 240,
            top: 0,
            bottom: 400,
            height: 400,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        if (this.classList?.contains('shopboard__canvas')) {
          return { left: 0, right: 868, width: 868, top: 0, bottom: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        }
        return { left: 0, right: 240, width: 240, top: 0, bottom: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      };
      fireEvent.scroll(document.querySelector('.shopboard__canvas') as HTMLElement);
      /*
       * THREE, AND THE THIRD ONE IS THE INTERESTING ONE. `edgesPastTheRail`
       * counts a lane as past the edge when LESS THAN HALF of it is showing,
       * not when it has gone entirely — so with these boxes lanes 0 and 1 are
       * wholly off the start, and lane 2 (left -152, right 88, so 88px of 240
       * on screen) is past it too. That is the rule the assertion above is
       * already relying on at the other edge; counting only what has vanished
       * completely would leave the operator a lane showing a sliver of its
       * heading and no cards, which is the thing the marker exists to name.
       *
       * What this test is actually about is the SIDE: `3 more lanes ▸` before
       * the scroll, `◂ 3 more lanes` after it. If the marker ever stops
       * following the rail, that flip is what stops happening.
       */
      await waitFor(() => expect(edgeMarkers()).toEqual(['◂ 3 more lanes']));
    } finally {
      restore();
    }
  });

  /** No layout, no claim. A board rendered where nothing has a box — jsdom, a
   *  `display: none` ancestor — must not decide that every lane is off screen. */
  it('says nothing at all when there is no layout to read', () => {
    mount();
    expect(edgeMarkers()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════ failure and CAS

describe('when the server refuses', () => {
  it('rolls the card back and says why', async () => {
    const user = userEvent.setup();
    routes.push({
      match: /\/fulfillments$/,
      method: 'POST',
      status: 500,
      body: { error: 'internal', requestId: 'req_boom' },
    });
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));
    await user.click(screen.getByRole('button', { name: 'Create shipment' }));

    // The reason reaches the operator twice — once as a toast they can read at
    // leisure, once through the live region for a screen reader. A silent
    // failure is the blocking defect this case exists for.
    await waitFor(() => expect(spoken()).toMatch(/didn.t go through/));
    expect(spoken()).toContain('stayed in To pack');
    // The toast is the sighted half of the same sentence, and it is its own
    // element — asserting on the document would have matched the live region
    // twice and proved only one of the two.
    const toast = document.querySelector('.toast') ?? document.querySelector('[class*="toast"]');
    expect(toast?.textContent).toMatch(/didn.t go through/);

    // And it is back where it was, not stranded in the lane it never reached.
    expect(cardsIn('Packing')).toHaveLength(0);
    expect(cardsIn('To pack')).toContain(number);
  });

  it('refetches the one order that lost a compare-and-swap, and does not retry', async () => {
    const user = userEvent.setup();
    routes.push({
      match: /\/fulfillments$/,
      method: 'POST',
      status: 409,
      body: { error: 'stale_write', expected: 2, actual: 3, requestId: 'req_cas' },
    });
    mount();

    const number = cardsIn('To pack')[0];
    await user.click(face(number));
    await user.click(within(card(number)).getByRole('button', { name: /Start packing/ }));
    await user.click(screen.getByRole('button', { name: 'Create shipment' }));

    await waitFor(() => expect(spoken()).toMatch(/Something else changed this order first/));

    // Exactly one write attempt: a stale premise asked twice is still stale.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // And the losing order is re-read — by id, not by reloading the page.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'GET' && /\/orders\/ord_[^/]+$/.test(c.path)),
      ).not.toHaveLength(0),
    );
  });

  it('refuses honestly when the parcel the plan needs is not there', async () => {
    const user = userEvent.setup();
    // …and a detail with no pending parcel to ship, which the LIST could not
    // have told the board when it drew the button.
    routes.push({
      match: /\/orders\/ord_[^/]+$/,
      method: 'GET',
      status: 200,
      body: detailFor(ROWS[0].order.id, { fulfillments: [] }),
    });
    mount([packed(ROWS[0])]);

    expect(cardsIn('Packing')).toHaveLength(1);
    const number = cardsIn('Packing')[0];
    await user.click(face(number));
    // From the MENU, `Move.confirm` decides — and `ship` does not ask, so the
    // click is the commit. Only a DROP always asks.
    await user.click(within(card(number)).getByRole('button', { name: /Mark shipped/ }));

    await waitFor(() => expect(spoken()).toMatch(/no parcel that is ready to ship/));
    // Nothing was PATCHed against nothing.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(cardsIn('Packing')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════ the local mark

describe('the triage marker', () => {
  it('says it is local, on the control itself', async () => {
    const user = userEvent.setup();
    mount();

    const mark = within(card(cardsIn('To pack')[0])).getByRole('button', { name: /^Mark order/ });
    // The accessible name carries it, not a tooltip: an operator who reads
    // "Seen" as a shared state stops telling their colleague.
    expect(mark.getAttribute('aria-label')).toMatch(/stored in this browser only/);
    // AND THE CONTROL IS NOW THE ONLY PLACE IT IS SAID. The board used to repeat
    // it in a paragraph above the lanes; that prose is gone, so this assertion
    // moved onto the button rather than being dropped — the guarantee is that
    // the locality claim is reachable at the point of the act, not that any
    // particular paragraph exists.
    expect(mark.getAttribute('title')).toMatch(/Stored in this browser/);

    await user.click(mark);
    expect(mark.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('plaspool-admin:orders-seen')).toMatch(/ord_/);
  });

  it('survives a browser that refuses to store it', async () => {
    const user = userEvent.setup();
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      mount();
      const mark = within(card(cardsIn('To pack')[0])).getByRole('button', { name: /^Mark order/ });
      await user.click(mark);
      // The mark still took for this session, and the control stopped promising
      // it would last. Asserted on the button's own tooltip now that the board's
      // paragraph is gone — `seenPersists` is threaded to exactly this spot.
      expect(mark.getAttribute('aria-pressed')).toBe('true');
      expect(mark.getAttribute('title')).toMatch(/will not keep it/);
    } finally {
      Storage.prototype.setItem = setItem;
    }
  });
});

// ═══════════════════════════════════════════════════════ the keyboard reach

describe('the keyboard', () => {
  it('reaches a card with Tab and opens its moves with Enter', async () => {
    const user = userEvent.setup();
    mount();

    // Tab reaches a card, and it is ONE stop: the drag handle and the move
    // trigger are the same element.
    await user.tab();
    const first = document.activeElement as HTMLElement;
    expect(first.className).toContain('shopcard__face');
    expect(first.getAttribute('aria-roledescription')).toBe('draggable');
    expect(first.getAttribute('aria-expanded')).toBe('false');

    // Enter opens the move list rather than picking the card up, which is what
    // narrowing `keyboardCodes.start` to Space buys — and it is the only path to
    // the moves that change no lane.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(first.getAttribute('aria-expanded')).toBe('true'));
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════ what a dialog is called, and where
//                                          focus goes when it stops existing

/** The `<dialog>` currently on screen. */
function openDialog(): HTMLDialogElement {
  const el = [...document.querySelectorAll('dialog')].find((d) => d.open);
  if (el === undefined) throw new Error('no dialog is open');
  return el as HTMLDialogElement;
}

/** Buttons inside the open dialog, by the words on them, in DOM order. */
function dialogButtons(): string[] {
  return [...openDialog().querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());
}

/**
 * Open one card's move list and press one of its moves, from the control the
 * operator would actually be standing on. The returned trigger is what focus
 * has to come back to.
 */
async function pressMove(
  user: ReturnType<typeof userEvent.setup>,
  number: string,
  name: RegExp,
): Promise<HTMLElement> {
  await user.click(face(number));
  const trigger = within(card(number)).getByRole('button', { name }) as HTMLElement;
  await user.click(trigger);
  return trigger;
}

describe('the dialogs', () => {
  it('is named by the heading a sighted operator reads, not by "dialog"', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    await pressMove(user, number, /Start packing/);

    // The computed accessible name, not merely the attribute — which is the
    // claim, since `aria-labelledby` pointing at nothing computes to nothing.
    expect(screen.getByRole('dialog', { name: `Pack order ${number}` })).toBeTruthy();
    const by = openDialog().getAttribute('aria-labelledby');
    expect(by).toBeTruthy();
    expect(document.getElementById(by as string)?.textContent).toBe(`Pack order ${number}`);
  });

  /**
   * ALL FOUR WAYS OUT, because they are four ways of doing ONE thing — flipping
   * `pending` back to `null` — and a fix that only handled the button would have
   * left escape and the backdrop dumping focus on `<body>`.
   */
  it('gives focus back to the control that opened it, on every route out', async () => {
    const routes: Record<string, (dialog: HTMLDialogElement) => void | Promise<void>> = {
      // What the UA fires when escape is pressed on a modal dialog.
      escape: (dialog) => {
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      },
      backdrop: (dialog) => {
        fireEvent.click(dialog);
      },
      "the form's own Cancel": (dialog) => {
        const cancel = [...dialog.querySelectorAll('button')].find(
          (b) => (b.textContent ?? '').trim() === 'Cancel',
        );
        if (cancel === undefined) throw new Error('the shipment form has no Cancel');
        fireEvent.click(cancel);
      },
    };

    for (const [route, dismiss] of Object.entries(routes)) {
      const user = userEvent.setup();
      mount();

      const number = cardsIn('To pack')[0];
      const trigger = await pressMove(user, number, /Start packing/);
      expect(openDialog()).toBeTruthy();

      await dismiss(openDialog());
      await waitFor(() => expect(screen.queryByRole('heading', { name: /^Pack order/ })).toBeNull());

      // Not `<body>`, and not "something inside the board" — the exact button.
      expect(document.activeElement, `after ${route}`).toBe(trigger);
      cleanup();
    }
  });

  it('gives focus back from the confirmation too, dismissed by its footer', async () => {
    const user = userEvent.setup();
    mount();

    const number = cardsIn('To pack')[0];
    const trigger = await pressMove(user, number, /Cancel this order/);
    const dismiss = openDialog().querySelector('.dialog__footer button') as HTMLElement;

    await user.click(dismiss);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Cancel this order' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('offers one way out of the shipment form rather than three', async () => {
    const user = userEvent.setup();
    mount();

    await pressMove(user, cardsIn('To pack')[0], /Start packing/);
    // The submit and ONE dismiss. The shared `Dialog`'s default footer "Close"
    // would be a second dismiss under a different word.
    expect(dialogButtons()).toEqual(['Create shipment', 'Cancel']);
  });

  it('does not put "Cancel" beside "Cancel this order"', async () => {
    const user = userEvent.setup();
    mount();

    await pressMove(user, cardsIn('To pack')[0], /Cancel this order/);
    const buttons = dialogButtons();
    expect(buttons).toEqual(['Keep this order', 'Cancel this order']);
    // The point is the button list a screen reader reads out, so it is asserted
    // as a list: nothing in it is the bare word.
    expect(buttons).not.toContain('Cancel');
  });
});

// ═══════════════════════════════════════════════ the shipment form's refusals

describe('a refusal the shipment form makes', () => {
  async function openOverCeiling(user: ReturnType<typeof userEvent.setup>) {
    mount([threeDeep(ROWS[0])]);
    await pressMove(user, cardsIn('To pack')[0], /Start packing/);
    const qty = screen.getByRole('spinbutton', { name: /in this parcel/i });
    await user.clear(qty);
    await user.type(qty, '9');
    return qty;
  }

  it('attaches the message to the field it is about', async () => {
    const user = userEvent.setup();
    const qty = await openOverCeiling(user);

    expect(qty.getAttribute('aria-invalid')).toBe('true');
    const by = qty.getAttribute('aria-describedby');
    expect(by).toBeTruthy();
    expect(document.getElementById(by as string)?.textContent).toMatch(
      /more units than are still unpacked/,
    );
  });

  it('says it in the one live region the dialog has, and says why the submit will not fire', async () => {
    const user = userEvent.setup();
    const qty = await openOverCeiling(user);

    const live = [...openDialog().querySelectorAll('[aria-live], [role="status"], [role="alert"]')];
    // ONE. A second region competing with this one is two voices on one event.
    expect(live).toHaveLength(1);
    // …and it is about the BUTTON, not a second copy of the field's message.
    expect(live[0].textContent).toBe('Not ready to ship: a quantity is above what the order still owes.');

    // …and it is the submit's own description, so a keyboard operator who lands
    // on the button hears the reason rather than silence.
    const submit = screen.getByRole('button', { name: 'Create shipment' });
    expect(submit.getAttribute('aria-describedby')).toBe(live[0].id);

    // The empty-selection path is the same region, not a second silence.
    await user.clear(qty);
    expect(live[0].textContent).toBe('Enter at least one quantity to ship.');
    expect(submit.getAttribute('aria-describedby')).toBe(live[0].id);
  });

  it('describes a quantity that is not a whole number as that, not as a ceiling', async () => {
    const user = userEvent.setup();
    mount([threeDeep(ROWS[0])]);
    await pressMove(user, cardsIn('To pack')[0], /Start packing/);

    const qty = screen.getByRole('spinbutton', { name: /in this parcel/i });
    await user.clear(qty);
    await user.type(qty, '-2');

    expect(qty.getAttribute('aria-invalid')).toBe('true');
    const by = qty.getAttribute('aria-describedby');
    expect(document.getElementById(by as string)?.textContent).toMatch(
      /whole numbers, zero or more/,
    );
  });
});

// ═════════════════════════════════════ what the card will not make up

describe('a quantity the card cannot read', () => {
  /** `pipeline.ts` sends this row to `needs_attention` BECAUSE of that line. */
  const mystery = {
    ...ROWS[0],
    lines: [{ id: 'oln_x', lineNo: 0, title: 'Mystery line', qty: null, fulfilledQty: 0 }],
  } as unknown as ShopOrderRow;

  it('prints no quantity rather than inventing one, and the label agrees', () => {
    mount([mystery]);

    expect(cardsIn('Needs a look')).toHaveLength(1);
    const el = face(cardsIn('Needs a look')[0]);

    // `1 × Mystery line` was a number the board had just declared unreadable,
    // printed in the one lane that exists to say it could not read it.
    expect(el.querySelector('.shopcard__what')?.textContent).toContain('— × Mystery line');
    expect(el.querySelector('.shopcard__what')?.textContent).not.toContain('1 × Mystery line');

    // …and the accessible name no longer says the confident version of the same
    // lie in the other direction.
    const spoken = el.getAttribute('aria-label') ?? '';
    expect(spoken).not.toMatch(/\b0 items\b/);
    expect(spoken).toMatch(/1 line with no readable quantity/);
  });
});

// ═══════════════════════════════════ the guess the card makes about a region

describe('a region the board worked out', () => {
  it('says so in the accessible name and not only in a tooltip', () => {
    // No `region`, so `normaliseRegion` matches on the city and refuses to call
    // the answer confident — which is what puts the "inferred" chip on screen.
    const guessed = withOrder(ROWS[0], {
      shippingAddress: { ...ROWS[0].order.shippingAddress, region: null, city: 'Abuja' },
    });
    mount([guessed]);

    const el = face(cardsIn('To pack')[0]);
    expect(el.querySelector('.shopcard__guess')).toBeTruthy();
    /*
     * The chip lives INSIDE the face button, whose `aria-label` replaces its
     * contents — so before this the only explanation was a `title` on a
     * `<span>` nothing can focus, and the claim never reached a screen reader
     * at all.
     */
    expect(el.getAttribute('aria-label')).toMatch(/worked out from the address rather than stated/);
  });
});

// ═════════════════════════════════════════════════════════════════ geography

describe('the destination panel', () => {
  function geo(rows: readonly ShopOrderRow[] = ROWS) {
    return render(<GeographyPanel rows={rows} now={NOW} />);
  }

  it('shows one row for Abuja and Federal Capital Territory, and can reveal both', async () => {
    const user = userEvent.setup();
    geo();

    // One destination, not two. The capture spells the same place two ways and
    // the shop's own zone table prices both identically; two rows would have the
    // operator planning two runs for one city.
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2); // the header, and one destination
    // The canonical ISO name, not either of the two spellings that produced it.
    expect(rows[1].querySelector('.dtable__strong')?.textContent).toBe('Federal Capital Territory');

    // The collapse is reported rather than performed silently.
    const details = rows[1].querySelector('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(within(details).getByText(/2 spellings folded/)).toBeTruthy();

    await user.click(within(details).getByText(/2 spellings folded/));
    expect(details.open).toBe(true);
    const variants = within(details).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(variants.some((t) => /^Abuja × 4/.test(t))).toBe(true);
    expect(variants.some((t) => /^Federal Capital Territory × 1/.test(t))).toBe(true);

    // …and the tile above the table restates it rather than asserting anything
    // new: one place, one folded spelling set, nothing unplaced.
    const tiles = document.querySelectorAll('.shopgeo__stats .stat');
    expect(tiles).toHaveLength(3);
    expect(tiles[0].textContent).toMatch(/Destinations1/);
  });

  it('gives an unclassifiable address a visible row rather than dropping it', () => {
    const odd = [
      ROWS[0],
      {
        ...ROWS[1],
        order: {
          ...ROWS[1].order,
          id: 'ord_odd',
          shippingAddress: { region: '   ', city: null, countryCode: 'NG' },
        },
      },
    ] as unknown as ShopOrderRow[];
    geo(odd);

    expect(screen.getByText(/could not be placed on the map/)).toBeTruthy();
    expect(screen.getByText(/the region field was blank/)).toBeTruthy();
    // Labelled in words, not by colour alone.
    expect(screen.getAllByText('not recognised')).not.toHaveLength(0);
    // …and the tile that counts them is the one marked as needing attention.
    expect(document.querySelector('.shopgeo__stats .stat--alert')?.textContent).toMatch(/Not placed1/);
  });

  it('will not quote a rate it was not given a table for', () => {
    geo();
    /*
     * `BreakdownOptions.zones` has NO DEFAULT, and this is the panel honouring
     * that: with no table there is no zone, no rate and no agreement verdict — a
     * column that says so rather than the seeded migration values, which are
     * owner-editable without a deploy and may not have been charged since.
     */
    expect(screen.getByText(/no zone table was supplied/)).toBeTruthy();
    expect(screen.getByText(/No delivery rates are shown/)).toBeTruthy();
    expect(screen.queryByText(/3,000\.00/)).toBeNull();
  });

  /**
   * THE CAVEAT IS SEPARATED IN THE STRING, NOT ONLY IN THE PICTURE.
   *
   * `.shopgeo__caveat` is `display: block`, so on screen the caveat has always
   * been its own line — but a line break drawn by CSS is not a character, and
   * this cell computed to "Delivery zoneno zone table was supplied" (measured in
   * Chrome, via `textContent`). That string is what the accessible name is built
   * from, so it is what a screen reader announced before every cell in the
   * column. Asserted on the computed text and not on the markup, because the
   * markup was never what was wrong.
   */
  it('separates the column heading from its caveat in the text, not just visually', () => {
    geo();
    const th = screen
      .getAllByRole('columnheader')
      .find((cell) => (cell.textContent ?? '').startsWith('Delivery zone'));
    expect(th).toBeDefined();

    const text = th?.textContent ?? '';
    expect(text).not.toContain('zoneno');
    expect(text).toMatch(/Delivery zone\s+—\s+no zone table was supplied/);
    // …and the separator is not on screen twice: the block already does the
    // separating, so a dash starting the second line would be noise.
    expect(th?.querySelector('.visually-hidden')?.textContent?.trim()).toBe('—');
  });

  it('quotes the zone and the rate once it is handed the live table', () => {
    render(<GeographyPanel rows={ROWS} now={NOW} zones={SEEDED_DELIVERY_ZONES} />);
    expect(screen.queryByText(/no zone table was supplied/)).toBeNull();

    // The zone column, and only it: `Abuja` also appears as one of the folded
    // spellings, and asserting on the document would pass on that instead.
    const zone = screen.getAllByRole('row')[1].querySelector('.shopgeo__zone') as HTMLElement;
    expect(within(zone).getByText('Abuja')).toBeTruthy();
    expect(within(zone).getByText(/3,000\.00/)).toBeTruthy();
  });

  it('isolates a region label that carries bidi control characters', () => {
    const hostile = [
      {
        ...ROWS[0],
        order: {
          ...ROWS[0].order,
          shippingAddress: { region: '‮Ogun', city: null, countryCode: 'NG' },
        },
      },
    ] as unknown as ShopOrderRow[];
    geo(hostile);

    // React escapes markup and does nothing at all about U+202E. The label has
    // to sit inside an isolate or it reverses the row it is in.
    const bdi = document.querySelector('bdi');
    expect(bdi).toBeTruthy();
    expect(bdi?.textContent).toContain('Ogun');
  });

  it('isolates the customer text on a card as well as in the panel', () => {
    // The same hazard one surface over: a name or a region carrying U+202E on a
    // card whose next line is a money total reads the total back to front.
    mount([
      withOrder(ROWS[0], {
        shippingAddress: { ...ROWS[0].order.shippingAddress, name: '‮Dara', region: 'Ogun' },
      }),
    ]);
    const who = card(cardsIn('To pack')[0]).querySelector('.shopcard__who bdi');
    expect(who?.textContent).toContain('Dara');
    expect(card(cardsIn('To pack')[0]).querySelector('bdi.shopcard__place')).toBeTruthy();
  });
});
