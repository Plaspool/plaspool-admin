import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { safeFormatMinor, type ShopOrder, type ShopOrderLine, type ShopOrderRow } from '../../data/api-shop';
import { isRenderable } from '../../data/when';
import {
  BOARD_COLUMNS,
  COLUMN_LABEL,
  ageBand,
  columnOf,
  coverageOf,
  movesFor,
  summarise,
  type AgeBand,
  type ColumnKey,
  type Move,
  type MoveKey,
  type Role,
} from './pipeline';
import './board.css';

/**
 * THE ORDERS BOARD — six lists on a canvas, and the rule that a gesture cannot
 * ship a parcel.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DROP IS THE INTENT; THE FORM IS THE ACT.
 *
 * Releasing a card on Packing does not move it. It opens the shipment form with
 * the card held where it was, and the move commits when the form does. Abandon
 * the form and the card is already home.
 *
 * This is not caution for its own sake, and for orders it is sharper than it was
 * for returns. `POST /admin/orders/:id/fulfillments` names
 * `lines: [{ orderLineId, qty }]`, and optionally a carrier and a tracking
 * number. A DRAG CANNOT SUPPLY ANY OF THAT. A board that let the release finish
 * the move would be choosing, on the operator's behalf, that every outstanding
 * unit goes in this box — which is exactly wrong in the ordinary case the
 * shipment form was built around: three items ordered, two on the shelf, one
 * parcel today and one next week. The board would have created a shipment
 * covering three, the customer would be told all three were on their way, and
 * `fulfilledQty` would say the order is fully packed while a unit sat on the
 * floor. A shipment nobody packed is a worse lie than a slow board.
 *
 * The rule is stronger here than on the returns board: A DROP NEVER COMMITS,
 * EVEN WHEN THE MOVE NEEDS NO DATA. `cancel` needs nothing and `ship` needs
 * nothing, and both still open a dialog on a drop — one ends an order and
 * releases its stock, the other tells a customer their parcel has left. A
 * release is a coarse gesture that lands where the pointer was, not where the
 * eye was; a labelled button with a sentence under it, clicked in the card's own
 * move list, is not. So the move list obeys `Move.confirm` (which is
 * `pipeline.ts`'s judgement, not this file's) and a DROP always asks.
 *
 * THE LISTS ARE FIXED WIDTH. The whole value of a board is that things stay
 * where you put them; a lane that grew as cards arrived would move every other
 * lane under the pointer mid-drag.
 *
 * NO COLOURED DOTS BESIDE THE LANE NAMES. Urgency belongs on the card, because
 * every card in a lane has a different age. The lane heads DO carry "3 overdue",
 * and that is not the same claim smuggled back in: it is a COUNT of cards, which
 * is a fact, said in a word so a reader who cannot see the colour reads the same
 * sentence. Nothing on a heading asserts that the lane itself is urgent.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BOTH TERMINAL COLUMNS ARE LANES — AND THAT IS A DELIBERATE DIVERGENCE FROM
 * `ReturnsBoard.tsx`.
 *
 * That board says terminal states are not columns, because "a board is a
 * dispatch surface, and an awarded return is history". The argument is right and
 * it does not transfer, for two reasons that are about where the rows come from
 * rather than about what a board is.
 *
 * 1. **THE PAGE IS FILTERED BY THE ROUTE, NOT BY THIS COMPONENT.**
 *    `/shop/orders` carries a status filter in the URL. Drop `closed` from the
 *    lanes and `?status=cancelled` renders a board of empty lanes and no
 *    explanation — a dead end, on the screen the owner runs the shop from. The
 *    returns board can afford the omission because its rows are fetched fresh
 *    per district and its terminal returns are reachable through a desk, a
 *    search and a modal that this board does not have.
 *
 * 2. **A CARD THAT VANISHES IS A CARD SOMEBODY GOES LOOKING FOR.** The header
 *    counts the page; a board showing nine of twelve orders with nothing saying
 *    where the other three went is the board lying by omission about work the
 *    operator can see in the table view one click away.
 *
 * `closed` ALSO EARNS ITS LANE AS A DESTINATION, which settles it: `cancel`
 * lands there, so for an owner it is a real drop target and dragging a card onto
 * it is how you cancel an order. For a writer the same drop is refused with the
 * reason, because `POST /orders/:id/cancel` is `requireOwner()`.
 *
 * `needs_attention` stays for the reason `pipeline.ts` gives at length: a row
 * this client cannot work has to go somewhere visible, and `closed` would hide a
 * live order from the only screen that would have caught it.
 *
 * `awaiting_payment` IS THE ONE COLUMN THAT IS NOT A LANE, and neither of the
 * two reasons above rescues it — point 2 in particular is a debt this file pays
 * rather than dodges. `BOARD_LANES` argues it; `awaitingPayment` below is what
 * keeps those orders on the screen without one.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS COMPONENT IMPORTS NO DRAG LIBRARY. It takes `columnRef`, `columnState`
 * and `renderCard`, and the SCREEN (`BoardScreen.tsx`) owns the `DndContext`.
 * That is what keeps the arrangement — six fixed lists, their headings, their
 * order — testable without driving a drag library in jsdom.
 */

/**
 * A COLUMN THIS BOARD DRAWS. Every `ColumnKey` except `awaiting_payment`, and
 * the exception is the type rather than a runtime check so that a drop target,
 * a lane state or a card that named the missing lane would not compile.
 */
export type BoardLane = Exclude<ColumnKey, 'awaiting_payment'>;

/**
 * The lanes, left to right — `pipeline.ts`'s order, minus one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOARD'S LANES ARE A SUBSET OF THE MODEL'S COLUMNS, AND THE FILTER IS HERE
 * RATHER THAN IN `pipeline.ts` ON PURPOSE. IT IS NOT A RE-EXPORT THAT DRIFTED.
 *
 * `columnOf` returning `awaiting_payment` for a `pending` order is TRUE and must
 * stay true: it is the classification `summarise` counts by, `ageBand` reads to
 * decide that such an order cannot age, and `awaitingPayment` below asks for by
 * name. Deleting the column would delete the answer. What is being said here is
 * narrower — that the answer does not deserve a LIST ON A CANVAS.
 *
 * A LANE IS AN OFFER OF WORK, AND THERE IS NO WORK IN THIS ONE.
 *
 *  - The server INSERTs an order as `pending` (`createOrderFromCheckout`, on
 *    `checkout.completed`) and moves it on its own: `payment.captured` →
 *    `paid`, `payment.failed` → `cancelOrder('payment_failed')`, which also
 *    releases the held points. Both are events. Neither is a gesture.
 *  - The only transition an operator may apply to a `pending` order is `cancel`
 *    — `CANCEL.holds` is `pending || paid` — and cancelling is not the thing
 *    they want; the money arriving is, and no drag can fetch it.
 *  - So the lane was a permanent invitation to do the one thing that is almost
 *    never right, at the HEAD of the board, in the position the eye starts at.
 *
 * This is `ReturnsBoard.tsx`'s rule — "Terminal states are not columns: a board
 * is a dispatch surface" — read in the other direction. A state nobody can
 * dispatch is not a column either, whichever end of the pipeline it sits at.
 *
 * AND A LANE CANNOT SAY THE ONE THING THESE ORDERS ARE WORTH SAYING. Nothing in
 * this system expires a pending order — the sweep drains the commerce-event and
 * email outboxes and does not touch order status — so a pending row is durable,
 * and a DURABLE one is the signature of a payment event that never arrived. A
 * column cannot tell a 30-second-old pending order from a three-day-old one:
 * both are one card in one list. The notice `awaitingPayment` feeds can, because
 * it is allowed to read the clock. That is the trade this subset buys.
 *
 * WHAT IS OWED IN RETURN, and it is the debt the header's point 2 records: a
 * card that vanishes is a card somebody goes looking for. Every row this filter
 * removes is counted and linked above the lanes by `ShopOrders.tsx` — the count
 * of orders "on the board" is the count of orders DRAWN on it, and the
 * difference is named in the same breath. Nothing here may be dropped silently.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const BOARD_LANES: readonly BoardLane[] = BOARD_COLUMNS.filter(
  (column): column is BoardLane => column !== 'awaiting_payment',
);

/**
 * How a lane is drawn WHILE A CARD IS IN HAND: `'legal'` for one the card may
 * enter, `'illegal'` for one it may not, `'over'` for the one under the pointer,
 * `null` when nothing is being dragged — and also `null` for the lane the card
 * already lives in, which is neither an offer nor a refusal.
 *
 * A STATE RATHER THAN A BOOLEAN, because "dimmed" and "outlined" are two
 * different messages and a card must be able to see both at once across six
 * lanes. Passed in rather than computed here: this component does not know which
 * card is in hand, and should not.
 */
export type LaneState = 'legal' | 'illegal' | 'over';

// ─────────────────────────────────────────────────── the optimistic projection

/**
 * THE ROW AS IT WILL LOOK IF THE MOVE SUCCEEDS — the whole of the board's
 * optimism, in one pure function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A `move → lane` TABLE.
 *
 * A table mapping "ship" to "Shipped" would be a SECOND copy of `columnOf`'s
 * rules, written in a component, drifting the first time the server grows a
 * status. So the destination is not stated anywhere: the move is applied to a
 * COPY of the row and `columnOf` is asked again. One authority, asked twice.
 *
 * It also makes the moves that DO NOT CHANGE LANE fall out for free rather than
 * needing to be remembered:
 *
 *  - `pack` on a partly-packed order is "pack what is left" and lands in
 *    `packing`, which is where the card already is.
 *  - `deliver` cannot change the lane at all, because `delivered` is not
 *    derivable from the list payload and so is not a lane (`pipeline.ts` says so
 *    at length). The order stays in `shipped`.
 *
 * A board that animated those across a lane boundary would be lying, and
 * `destinationLane` returning the SAME lane is what stops it: the drag layer
 * offers no target for them, and the card's move list says "stays in Packing" on
 * the button instead.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `shipping` NAMES THE UNITS THIS PARCEL WILL ACTUALLY HOLD, and defaults to
 * everything outstanding. The default is what a DRAG means and what `planMove`
 * builds; the argument is what the shipment FORM sends once the operator has
 * said "two of the three". Projecting the default over a partial shipment would
 * paint every line covered and, on a `paid` order, could move the card a lane
 * further than the server did.
 *
 * Nothing here is trusted for longer than the request takes: the board re-reads
 * the order the moment the write lands, and this projection is thrown away.
 */
export function projectMove(
  row: ShopOrderRow,
  move: MoveKey,
  now: number,
  shipping?: readonly { orderLineId: string; qty: number }[],
): ShopOrderRow {
  const order: ShopOrder = row.order;
  const lines: ShopOrderLine[] = Array.isArray(row.lines) ? row.lines : [];

  if (move === 'cancel') {
    return { ...row, order: { ...order, status: 'cancelled', cancelledAt: now } };
  }

  if (move === 'pack') {
    /*
     * `fulfilledQty` MOVES WHEN THE SHIPMENT IS CREATED, not when it ships —
     * migration `0160_orders_fulfillment.sql` increments it from an AFTER INSERT
     * trigger. So the units this parcel names are covered the moment the POST
     * returns, whether or not anything has left the building.
     */
    if (shipping === undefined) {
      return { ...row, lines: lines.map((line) => ({ ...line, fulfilledQty: line.qty })) };
    }
    const added = new Map<string, number>();
    for (const line of shipping) added.set(line.orderLineId, (added.get(line.orderLineId) ?? 0) + line.qty);
    return {
      ...row,
      lines: lines.map((line) => {
        const extra = added.get(line.id) ?? 0;
        if (extra === 0) return line;
        const have = typeof line.fulfilledQty === 'number' ? line.fulfilledQty : 0;
        const want = typeof line.qty === 'number' ? line.qty : have + extra;
        return { ...line, fulfilledQty: Math.min(want, have + extra) };
      }),
    };
  }

  if (move === 'ship') {
    /*
     * `settleOrderFulfilled`'s guard is `status = 'paid' AND <nothing
     * unshipped>`, so a partial parcel shipping settles NOTHING and a
     * `partially_refunded` order never settles at all. Both leave the card
     * exactly where it is, which is the honest picture: there is still a parcel
     * on the bench.
     */
    const settles = order.status === 'paid' && coverageOf(row).complete;
    return settles ? { ...row, order: { ...order, status: 'fulfilled', fulfilledAt: now } } : row;
  }

  // `deliver` — see the header. Nothing on this surface can show it.
  return row;
}

/** Where this move puts the card. The SAME lane means it does not move. */
export function destinationLane(row: ShopOrderRow, move: MoveKey, now: number): ColumnKey {
  return columnOf(projectMove(row, move, now));
}

// ───────────────────────────────────────────────────────── what a drop means

export type DropOutcome =
  /** The move the release asked for. The screen opens its form or its
   *  confirmation; NOTHING is sent from here. */
  | { kind: 'form'; move: Move }
  /** Released where it already lives. Not an error and not worth a message —
   *  the operator changed their mind mid-drag, which is what dragging a card
   *  back is for. */
  | { kind: 'noop' }
  /** The server would not allow it, or this account may not ask. `reason` is
   *  said out loud as the card springs back, because a card that refuses a drop
   *  silently reads as a broken board. */
  | { kind: 'refused'; reason: string };

/** Lanes a card cannot leave at all, said in the lane's own terms rather than as
 *  a generic "no". */
const DEAD_END: Partial<Record<ColumnKey, string>> = {
  closed: 'This order is closed — cancelled, or refunded in full. Nothing moves out of it.',
  needs_attention:
    'The board cannot work this order: it arrived in a shape this screen cannot address, so there is nothing to drag it to.',
};

/**
 * THE WHOLE DECISION A DROP MAKES, as a pure function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TESTED HERE RATHER THAN THROUGH THE GESTURE, deliberately. Driving synthetic
 * pointer events through a drag library in jsdom tests the library; this tests
 * the RULE — which is the part that decides whether a board can ship a parcel
 * nobody packed.
 *
 * IT ASKS `movesFor`, WHICH MIRRORS THE SERVER'S GUARDS. There is no
 * lane → move table in this file. `pipeline.ts` owns which moves a row has for a
 * role, and `destinationLane` asks `columnOf` where each one lands; a board that
 * kept its own map would drift the first time the state machine gained a branch,
 * and would drift SILENTLY — the card would move, the request would 409, and
 * nothing on screen could explain why.
 *
 * `role` AND `now` ARE PARAMETERS rather than ambient, for the same reason
 * everything in `pipeline.ts` is: a rule that reads a clock or a session cannot
 * be argued with in a test, and the boundary between "the owner may cancel this"
 * and "you may not" is exactly the boundary worth pinning.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function resolveDrop(
  row: ShopOrderRow,
  target: ColumnKey,
  role: Role,
  now: number,
): DropOutcome {
  const here = columnOf(row);
  if (target === here) return { kind: 'noop' };

  const move = movesFor(row, role).find((m) => destinationLane(row, m.key, now) === target);
  if (move !== undefined) return { kind: 'form', move };

  /*
   * WITHHELD BY ROLE IS ITS OWN ANSWER, and it is worth the extra call. Asking
   * `movesFor` a second time as an OWNER is how the refusal can say "only the
   * owner may do this" without this file re-stating `CANCELLABLE` or knowing
   * that cancel is the owner-only one. `pipeline.ts` carries `ownerOnly` on the
   * move precisely so a UI can explain an absence.
   */
  if (role !== 'owner') {
    const asOwner = movesFor(row, 'owner').find((m) => destinationLane(row, m.key, now) === target);
    if (asOwner?.ownerOnly === true) {
      return {
        kind: 'refused',
        reason: `Only the owner can do that — “${asOwner.label}” is not offered to your account, so this order cannot be moved to ${COLUMN_LABEL[target]}.`,
      };
    }
  }

  if (movesFor(row, role).length === 0) {
    return {
      kind: 'refused',
      reason:
        DEAD_END[here] ??
        `Nothing is waiting on you for this order, so there is no move that takes it to ${COLUMN_LABEL[target]}.`,
    };
  }

  /*
   * Moves exist and none of them lands here. That is the ordinary case for
   * `deliver` and for "pack what is left", both of which leave the card where it
   * is — so the sentence points at the card's own list rather than pretending
   * the order is stuck.
   */
  return {
    kind: 'refused',
    reason: `An order in ${COLUMN_LABEL[here]} cannot go straight to ${COLUMN_LABEL[target]}. Open the card for what can be done to it.`,
  };
}

/** Which lanes a card in hand may legally enter — everything else is dimmed
 *  while it is held, so an illegal target is visible before the release rather
 *  than explained after it.
 *
 *  IT WALKS `BOARD_LANES` AND NOT `BOARD_COLUMNS`, so a lane the board does not
 *  draw can never be offered as a target. `resolveDrop` still takes the whole
 *  `ColumnKey` vocabulary — it answers "what would a drop here mean", which is a
 *  question about the model — and this is the one place the answer is narrowed
 *  to what is on screen. */
export function legalTargets(row: ShopOrderRow, role: Role, now: number): BoardLane[] {
  return BOARD_LANES.filter((lane) => resolveDrop(row, lane, role, now).kind === 'form');
}

// ──────────────────────────────────────────────────────────── the order cards

/** Overdue first, then longest-waiting. `ageBand` is `fresh` in every lane that
 *  cannot age, so this one rule degrades to "oldest first" there rather than
 *  needing to know which lanes those are. */
const SEVERITY: Record<AgeBand, number> = { overdue: 0, ageing: 1, fresh: 2 };

/**
 * The clock a card ages against: the shop owes goods from the moment the money
 * lands, so `paidAt` first and `placedAt` behind it.
 *
 * ⚠️  THE ONE RULE DUPLICATED FROM `pipeline.ts` (`ageBand`'s `from`). It is
 *     here because `ageBand` answers a BAND while the card and this sort need
 *     the INSTANT, and nothing exports the instant the two agree on. See the
 *     report — a `waitingSince(row)` export from `pipeline.ts` would delete it.
 */
export function waitingSince(order: Partial<ShopOrder> | undefined | null): unknown {
  if (order === undefined || order === null) return undefined;
  return isRenderable(order.paidAt) ? order.paidAt : order.placedAt;
}

export function compareCards(a: ShopOrderRow, b: ShopOrderRow, now: number): number {
  const bands = SEVERITY[ageBand(a, now)] - SEVERITY[ageBand(b, now)];
  if (bands !== 0) return bands;
  const at = waitingSince(a?.order);
  const bt = waitingSince(b?.order);
  const an = typeof at === 'number' ? at : Number.POSITIVE_INFINITY;
  const bn = typeof bt === 'number' ? bt : Number.POSITIVE_INFINITY;
  return an - bn;
}

/** The lane an order is drawn in, with its cards already in reading order. */
export interface LaneCards {
  lane: BoardLane;
  cards: ShopOrderRow[];
}

export function laneCardsOf(rows: readonly ShopOrderRow[], now: number): LaneCards[] {
  /* Keyed on `ColumnKey` and seeded only with the LANES, so the `?.` below is
   * the whole of the filter: a row whose column is not drawn — `awaiting_payment`
   * and nothing else — finds no bucket and is left out. `awaitingPayment` is the
   * other half of that sentence and must be rendered wherever this is. */
  const out = new Map<ColumnKey, ShopOrderRow[]>();
  for (const lane of BOARD_LANES) out.set(lane, []);
  for (const row of Array.isArray(rows) ? rows : []) out.get(columnOf(row))?.push(row);
  for (const cards of out.values()) cards.sort((a, b) => compareCards(a, b, now));
  return BOARD_LANES.map((lane) => ({ lane, cards: out.get(lane) ?? [] }));
}

// ───────────────────────────────────────────────── the orders with no lane

/**
 * HOW LONG A `pending` ORDER MAY SIT BEFORE IT MEANS SOMETHING. One hour.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BOUNDARY IS BETWEEN "THE PAYMENT IS IN FLIGHT" AND "NO PAYMENT EVENT IS
 * EVER COMING", and both sides of it are measured rather than guessed.
 *
 * BELOW IT, ORDINARY. `__fixtures__/orders-live.json` is a verbatim capture of
 * the deployed shop, and the gap between `placedAt` and `paidAt` in it is 191 ms,
 * 53 ms, 20.6 s, 22.3 s and 63.0 s. An hour is fifty-seven times the slowest of
 * those, which leaves room for a provider that retries a webhook — retry
 * schedules are counted in seconds and minutes — without the operator being told
 * anything about an order that is merely mid-checkout.
 *
 * ABOVE IT, WORTH SAYING TODAY. A day would be the obvious reach, because
 * `ageBand` already uses days and `ageDays` is right there. It is the wrong unit
 * here: `ageBand` measures the SHOP's lateness on goods it owes and can start
 * tomorrow, while this measures money that may be sitting at the provider under
 * an order the shop believes is unpaid, with stock and points still held against
 * it and a customer who thinks they have bought something. That wants finding
 * within the working day, not the next morning.
 *
 * AND IT IS THE BOUNDARY `when.ts` ALREADY DRAWS. `ageLabel` says minutes below
 * an hour and hours above it, so the moment this can fire is the moment the
 * app's own vocabulary for an age switches to the coarser unit — the notice
 * never has to say "97 minutes", and the threshold is not a number invented for
 * one component. Anything finer would be a second scale nothing else on this
 * screen uses.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const STALE_PAYMENT_MS = 60 * 60_000;

/** The orders no lane draws, split by whether their payment is merely late. */
export interface AwaitingPayment {
  /** Every row `columnOf` puts in `awaiting_payment` — exactly what the lanes
   *  leave out — oldest first. */
  all: ShopOrderRow[];
  /** Those of them placed more than `STALE_PAYMENT_MS` ago, oldest first. */
  stale: ShopOrderRow[];
  /** When the oldest STALE one was placed, or `null` when none is. Handed out as
   *  the instant rather than a phrase so the caller formats it with `ageLabel`
   *  and this stays a rule rather than a sentence. */
  oldestSince: number | null;
}

/**
 * THE ROWS THE LANES DROPPED, AND WHICH OF THEM ARE A PROBLEM.
 *
 * `columnOf` IS ASKED RATHER THAN `order.status`, and the two are not the same
 * question. A `pending` row with no id, or one whose line quantities this client
 * cannot read, is parked in `needs_attention` by `columnOf` — it IS on the board,
 * in a lane — and counting it here as well would report an order twice and
 * subtract it twice from the board's own count. Asking the same authority the
 * lanes ask is what makes "drawn" and "not drawn" add up to the page.
 *
 * THE CLOCK IS `placedAt`, NOT `waitingSince`. For every other row on this board
 * the wait starts when the money lands, which is why `waitingSince` prefers
 * `paidAt`; here the whole subject is that no money has landed. `placedAt` is
 * the instant `createOrderFromCheckout` INSERTed the row, which is the instant
 * the payment event became due.
 *
 * AN UNREADABLE `placedAt` IS NEVER STALE, which is `ageBand`'s rule and it is
 * borrowed deliberately: "a broken timestamp is a data bug, and painting it red
 * would put the loudest mark on the board next to the one thing the operator
 * cannot act on". Such a row is still in `all`, so it is still counted, still
 * named and still one click from the table — it simply raises nothing.
 */
export function awaitingPayment(rows: readonly ShopOrderRow[], now: number): AwaitingPayment {
  const all = (Array.isArray(rows) ? rows : [])
    .filter((row) => columnOf(row) === 'awaiting_payment')
    .sort((a, b) => placedOf(a) - placedOf(b));

  const stale = all.filter((row) => {
    const placed = row?.order?.placedAt;
    return isRenderable(placed) && Number.isFinite(now) && now - placed >= STALE_PAYMENT_MS;
  });

  const oldest = stale[0]?.order?.placedAt;
  return { all, stale, oldestSince: isRenderable(oldest) ? oldest : null };
}

/** Oldest first, with a date nothing can read sorted to the end rather than to
 *  the front — the same treatment `compareCards` gives an absent instant. */
function placedOf(row: ShopOrderRow): number {
  const placed = row?.order?.placedAt;
  return isRenderable(placed) ? placed : Number.POSITIVE_INFINITY;
}

// ──────────────────────────────────────────────────────────────────── the board

export interface OrdersBoardProps {
  /**
   * Every order on THIS page, in one list. The lanes are drawn from it rather
   * than fetched separately: one read, six groupings. The board never mutates
   * the array — the screen holds an optimistic patch beside it.
   */
  rows: readonly ShopOrderRow[];
  /**
   * The instant the board is drawn at, epoch ms. PASSED IN, never read from a
   * clock — the rule `summarise`, `ageBand` and `breakdown` all follow, and for
   * the same reason: an age this component computed itself could not be tested
   * for the boundary it exists to draw.
   */
  now: number;
  /** Lets the drag layer register each lane as a drop target without this
   *  component knowing anything about the library doing it. */
  columnRef?: (lane: BoardLane) => ((node: HTMLElement | null) => void) | undefined;
  /** See `LaneState`. `null` means "nothing is in hand, or this is home". */
  columnState?: (lane: BoardLane) => LaneState | null;
  /**
   * Wrap each card — the seam the drag layer attaches through.
   *
   * A RENDER PROP RATHER THAN dnd-kit IMPORTS IN HERE. This component's job is
   * the arrangement (six fixed lists, headings, counts, the empty lines) and
   * it stays renderable without a drag library. The screen that owns the
   * `DndContext` supplies the draggable card.
   *
   * `cardId` IS THE KEY THIS BOARD ALREADY USES, handed over rather than left to
   * be re-derived. A drag library needs one stable identifier per draggable, and
   * a row with no `order.id` still gets a card (`columnOf` parks it in
   * `needs_attention`) — so the screen would otherwise have to invent the same
   * `lane#position` fallback this component already computes, and the day the
   * two disagreed there would be two cards claiming one drag id.
   */
  renderCard: (row: ShopOrderRow, lane: BoardLane, cardId: string) => ReactNode;
}

/**
 * WHAT AN EMPTY LANE MEANS — one sentence each, because five of the six used to
 * say "Nothing here."
 *
 * That is the state a healthy shop sees most days, on five lanes at once, and it
 * is the screen's own answer to "did this load?". Each of these says what the
 * emptiness IS: the lane a card would have to be in for this line to be gone.
 * `needs_attention` already had one and it is kept verbatim — it was the model.
 *
 * THEY ARE READ OFF `columnOf`, not invented. "Half-filled" is `packing`'s actual
 * predicate (`coverage` partial), and `check_parcel` is the lane for an order
 * part-refunded before `settleOrderFulfilled` could mark it — so the sentence
 * names the shape that fills the lane rather than a mood about it. A cheerful
 * line that did not match the rule would be worse than "Nothing here.", because
 * it would teach the operator a rule the board does not follow.
 */
const NOTHING_HERE: Record<BoardLane, string> = {
  to_pack: 'Nothing paid for is waiting on a parcel. This is the lane you want empty.',
  packing: 'No parcel is half-filled — nothing was started and left on the bench.',
  check_parcel: 'Nothing needs opening. A refund landing before the parcel settles is what fills this lane.',
  shipped: 'Nothing on this page has gone out yet.',
  closed: 'Nothing on this page was cancelled or refunded in full.',
  needs_attention: 'Nothing the board cannot read. This lane staying empty is the good outcome.',
};

/** What the two edge markers say, and whether each is the lit "a card can go
 *  there" version. Both empty is the ordinary state and the one every width from
 *  1556px up is in; held apart so the effect can compare without allocating. */
export interface BeyondEdges {
  start: string;
  startDrop: boolean;
  end: string;
  endDrop: boolean;
}

const NONE_BEYOND: BeyondEdges = { start: '', startDrop: false, end: '', endDrop: false };

function sameEdges(a: BeyondEdges, b: BeyondEdges): boolean {
  return a.start === b.start && a.end === b.end && a.startDrop === b.startDrop && a.endDrop === b.endDrop;
}

/**
 * WHICH LANES HAVE GONE PAST AN EDGE OF THE RAIL, and what to say about them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS MEASURED IN THE DOM RATHER THAN DERIVED.
 *
 * Nothing this component is given says where a lane IS. The lane width is a clamp
 * against the canvas, the canvas breaks out of the shell, the rail scrolls, and
 * the drag layer scrolls it on its own while a card is in hand — so "is `closed`
 * on screen" has exactly one honest source, and it is the box the browser gave
 * it. A derived answer would be a second layout engine written in TypeScript,
 * wrong the first time `board.css` was retuned and wrong silently. Reading it is
 * cheap: six rects, on scroll and on resize.
 *
 * HALF A LANE IS THE LINE. A lane clipped past its own midpoint has lost its
 * heading and the names on its cards; a marker that only fired at total
 * invisibility would leave the operator staring at an anonymous sliver and being
 * told nothing. More than half of itself on screen is a lane, and gets no marker.
 *
 * `legal` IS PASSED IN AND NOT COMPUTED. This file has `legalTargets`, but the
 * board must not ask it: only the SCREEN knows which card is in hand, and a
 * component that guessed would light an edge for a card nobody is holding.
 * Empty means nothing is held, which is why the at-rest wording is a count.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function edgesPastTheRail(
  canvas: HTMLElement,
  legal: readonly BoardLane[],
): BeyondEdges {
  const box = canvas.getBoundingClientRect();
  const start: BoardLane[] = [];
  const end: BoardLane[] = [];
  for (const lane of BOARD_LANES) {
    const node = canvas.querySelector(`[data-lane="${lane}"]`);
    if (node === null) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) continue; // no layout at all — jsdom, or a hidden board
    const shown = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
    if (shown >= rect.width / 2) continue;
    (rect.left < box.left ? start : end).push(lane);
  }

  /* A NAME AND AN INSTRUCTION WHILE A CARD IS IN HAND, A COUNT OTHERWISE. At rest
   * the only question is whether the board ends at this edge, and five lane names
   * in a pill on a phone would cover the card underneath. In hand the question is
   * which of them will take THIS card, and there is never more than a handful. */
  const say = (lanes: BoardLane[]): [string, boolean] => {
    if (lanes.length === 0) return ['', false];
    const takers = lanes.filter((lane) => legal.includes(lane));
    if (takers.length > 0) return [`drop in ${takers.map((lane) => COLUMN_LABEL[lane]).join(', ')}`, true];
    return [`${lanes.length} more lane${lanes.length === 1 ? '' : 's'}`, false];
  };

  const [startText, startDrop] = say(start);
  const [endText, endDrop] = say(end);
  return { start: startText, startDrop, end: endText, endDrop };
}

export function OrdersBoard({ rows, now, columnRef, columnState, renderCard }: OrdersBoardProps) {
  /* `summarise` is the one authority for the counts, the money and the ageing
   * tallies, and it reports every COLUMN in board order — empty ones included. A
   * heading that counted its own children would disagree with the header the
   * first time a row landed somewhere this component did not expect. */
  const summary = summarise(rows, now);
  const lanes = laneCardsOf(rows, now);

  /* BY KEY, NEVER BY POSITION — the lookup below used to be `columns[index]`,
   * which the moment `BOARD_LANES` stopped being `BOARD_COLUMNS` became an
   * off-by-one across the whole board: `summarise` still reports seven columns
   * starting at `awaiting_payment`, so every heading would have carried its
   * left-hand neighbour's count and money, and the last lane would have carried
   * `closed`'s. It reads as a plausible board rather than as a crash, which is
   * what makes it worth a lookup. A Map rather than a `find` per lane only
   * because the two totals below ask the same question again. */
  const columnFor = new Map(summary.columns.map((entry) => [entry.column, entry]));

  /*
   * WHETHER ANY LANE HAS A MONEY LINE OR AN AGEING LINE — asked of the BOARD and
   * not of each lane, because the answer buys the head rows in `board.css` that
   * keep every lane's first card on the same line. Reserving per lane would
   * reserve nothing (each lane already sizes to its own head, which is the bug);
   * reserving unconditionally would charge a shop with nothing overdue for a row
   * no lane on its screen fills. `BOARD_LANES` and not `summary.columns`, so
   * `awaiting_payment` — counted, never drawn — cannot buy a row for lanes that
   * do not show its money.
   */
  const anyMoney = BOARD_LANES.some((lane) => (columnFor.get(lane)?.money.length ?? 0) > 0);
  const anyAges = BOARD_LANES.some((lane) => {
    const column = columnFor.get(lane);
    return column !== undefined && (column.overdue > 0 || column.ageing > 0);
  });

  /* The lanes a held card may enter. `columnState` is the screen's answer and
   * this component keeps no idea of its own about legality — see `LaneState`. */
  const legal = BOARD_LANES.filter((lane) => {
    const state = columnState?.(lane);
    return state === 'legal' || state === 'over';
  });
  const legalKey = legal.join(',');

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [beyond, setBeyond] = useState<BeyondEdges>(NONE_BEYOND);

  /*
   * `legalKey` IS THE DEPENDENCY, NOT `legal`. `columnState` is a fresh closure
   * every render — the screen builds it inline — so an array derived from it is a
   * new array every render and this effect would tear its listeners down and
   * rebuild them on every keystroke anywhere on the board. The joined key changes
   * exactly when the answer changes, which is at pick-up and at release.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const lanesLegal = legalKey === '' ? [] : (legalKey.split(',') as BoardLane[]);
    const measure = (): void => {
      const next = edgesPastTheRail(canvas, lanesLegal);
      /* Compared before it is stored. `scroll` fires many times a second while
       * the drag layer auto-scrolls the rail, and a fresh object every time would
       * re-render the whole board under a card in hand. */
      setBeyond((prev) => (sameEdges(prev, next) ? prev : next));
    };

    /*
     * THE OBSERVER'S CALLBACK GOES THROUGH A FRAME AND THE TWO EVENTS DO NOT, and
     * the difference is where each one is delivered rather than how often it
     * fires. `scroll` and `resize` arrive as ordinary tasks, between renders,
     * where a state write is exactly what a state write is meant to be — and they
     * are already coalesced to one per frame by the browser, so there is nothing
     * left to throttle. A `ResizeObserver` callback is delivered inside the
     * browser's rendering step, which React's concurrent renderer may be part-way
     * through, so that one is deferred to a frame of its own.
     *
     * It also means the marker keeps working in a tab that is not painting, where
     * `requestAnimationFrame` never runs: measured on a hidden window, a scroll
     * with every measurement behind a frame left the marker showing the previous
     * viewport's answer indefinitely.
     */
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    canvas.addEventListener('scroll', measure, { passive: true });

    /*
     * A `ResizeObserver` ON THE CANVAS, AND IT IS NOT BELT-AND-BRACES FOR THE
     * WINDOW LISTENER — it is the only one of the two that catches the first
     * measurement. Measured: the effect's own `measure()` ran with every lane
     * 0px wide, because the board's stylesheet had not been applied to the
     * document yet, and nothing afterwards asked again — the rail was one lane
     * short and the marker never appeared. Anything that changes the canvas's
     * width changes every lane's width with it (the basis is a share of it), so
     * one observer on one box is the whole of the dependency.
     *
     * Guarded because jsdom has no `ResizeObserver`, and a board that throws
     * during an effect in a test suite is worse than a board with no marker in
     * an environment that has no layout to mark.
     */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      canvas.removeEventListener('scroll', measure);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [legalKey]);

  return (
    <div className="shopboard__rail">
      <div
        className={`shopboard__canvas${anyMoney ? ' shopboard__canvas--money' : ''}${
          anyAges ? ' shopboard__canvas--ages' : ''
        }`}
        ref={canvasRef}
      >
        {lanes.map(({ lane, cards }) => {
          const column = columnFor.get(lane);
          const state = columnState?.(lane) ?? null;
          const count = column?.count ?? cards.length;
          return (
            <section
              className={`shoplist${state === null ? '' : ` shoplist--${state}`}`}
              key={lane}
              ref={columnRef?.(lane)}
              data-lane={lane}
              aria-label={`${COLUMN_LABEL[lane]}: ${count} order${count === 1 ? '' : 's'}`}
            >
              <header className="shoplist__head">
                <div className="shoplist__title">
                  {/* NO COLOURED DOT HERE. See the file header. */}
                  <h3 className="shoplist__name">{COLUMN_LABEL[lane]}</h3>
                  <span className="shoplist__count">{count}</span>
                </div>

                {/*
                  ONE LINE PER CURRENCY, NEVER A SUM. `summarise` groups by code
                  for the reason `server/shop/admin/stats.ts` gives — two codes
                  added produce a number that reconciles against nothing — and a
                  heading that quietly re-added them here would undo that.
                */}
                {column !== undefined && column.money.length > 0 && (
                  <p className="shoplist__money">
                    {column.money.map((total) => (
                      <span key={total.currency}>{safeFormatMinor(total.total, total.currency)}</span>
                    ))}
                  </p>
                )}

                {column !== undefined && (column.overdue > 0 || column.ageing > 0) && (
                  /* A COUNT OF CARDS, not a colour standing for the lane — and
                     the word carries it, so a reader who cannot tell amber from
                     red reads the same sentence. */
                  <p className="shoplist__ages">
                    {column.overdue > 0 && (
                      <span className="shoplist__age shoplist__age--overdue">
                        {column.overdue} overdue
                      </span>
                    )}
                    {column.ageing > 0 && (
                      <span className="shoplist__age shoplist__age--ageing">
                        {column.ageing} waiting
                      </span>
                    )}
                  </p>
                )}
              </header>

              {/*
                `role="list"` alongside the `<ul>`, because `board.css` removes
                the markers and Safari drops list semantics the moment
                `list-style: none` is applied. The lane is a list of jobs and
                "5 items" is what a screen reader should say before reading one.
              */}
              <ul className="shoplist__cards" role="list">
                {cards.map((row, position) => {
                  /*
                   * A row with no id can still be drawn — `columnOf` parks it in
                   * `needs_attention` — so it needs a key that is stable ACROSS
                   * RENDERS. A random one would remount the card on every
                   * keystroke anywhere on the board.
                   */
                  const id = row?.order?.id;
                  const cardId = typeof id === 'string' && id !== '' ? id : `${lane}#${position}`;
                  return <Fragment key={cardId}>{renderCard(row, lane, cardId)}</Fragment>;
                })}

                {cards.length === 0 && <li className="shoplist__empty">{NOTHING_HERE[lane]}</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {/*
        WHAT IS PAST EACH EDGE. Rendered outside the scroller so they stay pinned
        while the lanes move under them, and `aria-hidden` because the drag
        layer's live region already reads every legal lane by name at pick-up —
        this is the same sentence for the eye, not a second one for the ear.
        `board.css` argues the rest.
      */}
      {beyond.start !== '' && (
        <p
          className={`shopboard__beyond shopboard__beyond--start${
            beyond.startDrop ? ' shopboard__beyond--drop' : ''
          }`}
          aria-hidden="true"
        >
          ◂ {beyond.start}
        </p>
      )}
      {beyond.end !== '' && (
        <p
          className={`shopboard__beyond shopboard__beyond--end${
            beyond.endDrop ? ' shopboard__beyond--drop' : ''
          }`}
          aria-hidden="true"
        >
          {beyond.end} ▸
        </p>
      )}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUTE'S `Board` IS THE SCREEN, AND THIS LINE IS WHY IT STILL RESOLVES.
 *
 * `ShopOrders.tsx` renders `<Board rows now onMoved onReload />` and imports it
 * from this module. That file is not owned by this change, so the name it
 * imports has to keep working — and what it must receive is the SCREEN, which
 * owns the `DndContext`, the sensors and the move forms. The arrangement above
 * would render six lanes nothing could be dragged between.
 *
 * It is a compatibility alias and nothing else. `BoardScreen` is the real name;
 * repoint the route's import at `./orders/BoardScreen` and delete this line —
 * see the report. Until then this module has a cycle with `BoardScreen.tsx`
 * (it imports the arrangement from here), which ES modules resolve because
 * neither file reads a binding from the other at module-evaluation time: both
 * only call across the seam while rendering.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export { BoardScreen as Board } from './BoardScreen';
