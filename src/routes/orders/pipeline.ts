import type {
  FulfillmentStatus,
  OrderStatus,
  ShopOrder,
  ShopOrderLine,
  ShopOrderRow,
} from '../../data/api-shop';
import { ageDays, isRenderable } from '../../data/when';

/**
 * THE ORDER BOARD'S LOGIC, WITH NO SCREEN ATTACHED.
 *
 * Everything here is a pure function of a row the list endpoint already sent
 * plus a `now` the caller supplies. No fetch, no `Date.now()`, no React — so the
 * board's rules can be argued with in a test rather than by clicking, and the
 * same rules can be reused by a card, a header and a keyboard shortcut without
 * any of the three re-deriving them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE LIST ACTUALLY CARRIES, AND WHAT IT DOES NOT.
 *
 * `GET /shop/admin/orders` answers `{ items: { order, lines }[] }` and NO
 * FULFILMENT ROWS (`server/shop/orders/repo/orders.ts` — the page's one
 * statement aggregates `shop_order_lines` and nothing else). So the only
 * fulfilment signal per order on this surface is `lines[].fulfilledQty`, plus
 * two fields on the order itself: `status` and `fulfilledAt`.
 *
 * `fulfilledQty` MOVES WHEN A SHIPMENT IS CREATED, NOT WHEN IT SHIPS. Migration
 * `0160_orders_fulfillment.sql` increments it from an AFTER INSERT trigger on
 * `shop_fulfillment_lines`, and gives it back only when a fulfilment is
 * cancelled. A `pending` parcel therefore already counts. That is what makes
 * "somebody has started packing this" derivable at all — and it is also why
 * COVERED DOES NOT MEAN SHIPPED anywhere in this file.
 *
 * `delivered` IS NOT DERIVABLE FROM THIS PAYLOAD AT ALL, and neither is the id
 * of the parcel to act on. Both live on `GET /shop/admin/orders/:id`. That cost
 * is modelled honestly in `planMove` rather than hidden: a move that needs the
 * detail says so, and says it before the operator clicks.
 *
 * NEITHER IS `shipped`, ONCE AN ORDER IS `partially_refunded`. `fulfilledAt` has
 * ONE writer in the entire server — `settleOrderFulfilled` — and that statement
 * CASes on `status = 'paid'`, so an order part-refunded before it shipped can
 * never acquire the mark and never flips to `fulfilled`. Its parcels can be
 * created, shipped and delivered without one field on this payload moving. That
 * is not a gap to be papered over with a best guess; it is a lane
 * (`check_parcel`) and a pair of moves that let the detail read settle it. The
 * argument, with the alternatives, is above `columnOf`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every function here is TOTAL. `/shop/orders` was already killed once by a
 * single unguarded `undefined` reaching `Intl.DateTimeFormat.format` (see
 * `src/data/when.ts`), and a board is a worse place for it than a table: one bad
 * row would take the other eleven with it. So rows arrive typed and are read as
 * if they were not — a missing `lines`, a `status` nobody has heard of and an
 * absent `placedAt` each produce a column and no throw.
 */

// ---------------------------------------------------------------- the columns

/**
 * WHERE AN ORDER SITS ON THE BOARD — FULFILMENT PROGRESS, NOT MONEY.
 *
 * The six working columns answer the operator's question ("what do I do
 * next?"), and the answer to it is never the money state. `partially_refunded`
 * is the proof: `APPLY_REFUND` in `repo/orders.ts` OVERWRITES `fulfilled` with
 * it, so a parcel that shipped on Monday and was partly refunded on Tuesday has
 * a status that says nothing about the parcel. Giving refunds their own column
 * would put that order in "refunded" and take it off the shipped pile, which is
 * the board lying about a parcel that is with the courier. Refunds are a BADGE
 * (`moneyStateOf`), and they ride along with whatever column the goods earned.
 *
 * `refunded` IS THE ONE MONEY STATE THAT DOES DECIDE A COLUMN, because the
 * server agrees it is terminal: a fully refunded order is refused by
 * `createFulfillment` ("a full refund means nothing is owed") and by `CANCEL`.
 * There is no next action, so it belongs with `cancelled` in `closed`.
 *
 * `check_parcel` IS THE LANE FOR AN ORDER WHOSE PARCEL THE LIST CANNOT PLACE.
 * `settleOrderFulfilled` — the only writer of `fulfilledAt` anywhere on the
 * server — CASes on `status = 'paid'`, so an order that was part-refunded before
 * it shipped can never acquire the mark, and after it ships there is nothing on
 * this payload that moved. Such an order is fully covered and might be on the
 * bench, with a courier, or already in the customer's hands. `packing`,
 * `shipped` and a badge on either would all be the board asserting one of those
 * three. The lane says the true thing instead, and `columnOf` argues it out.
 *
 * `needs_attention` IS THE LAST, AND IT IS NOT DECORATION. A row this client
 * cannot work with — a status it does not know, a server that grows `on_hold`, a
 * truncated payload, a line whose quantity is not a number this client will
 * read, a row that is not an object, an order with no id to address a request to
 * — has to go somewhere. `closed` would hide a live order from the only screen
 * that would have caught it, and any working column would offer moves the server
 * will refuse or that cannot even be addressed. A visible column with no moves
 * is the only honest answer, and it costs the board one usually-empty lane.
 */
export type ColumnKey =
  | 'awaiting_payment'
  | 'to_pack'
  | 'packing'
  | 'check_parcel'
  | 'shipped'
  | 'closed'
  | 'needs_attention';

/** Left to right, and this is the order `summarise` reports in. */
export const BOARD_COLUMNS: readonly ColumnKey[] = [
  'awaiting_payment',
  'to_pack',
  'packing',
  'check_parcel',
  'shipped',
  'closed',
  'needs_attention',
];

/**
 * Sentence case, British, plain — `ShopOrders.tsx`'s own register ("Awaiting
 * payment", "Partly refunded", "Ship what is left").
 *
 * `check_parcel` IS AN INSTRUCTION AND NOT A STATE, because there is no state to
 * name: "Packed" and "Gone" are the two things the board does not know. "Open to
 * check" is the whole of what it can honestly tell the operator to do.
 */
export const COLUMN_LABEL: Record<ColumnKey, string> = {
  awaiting_payment: 'Awaiting payment',
  to_pack: 'To pack',
  packing: 'Packing',
  check_parcel: 'Open to check',
  shipped: 'Shipped',
  closed: 'Closed',
  needs_attention: 'Needs a look',
};

/** The refund badge, kept apart from the column on purpose. */
export type MoneyState = 'none' | 'partly_refunded' | 'refunded';

export type Role = 'owner' | 'writer';

export type AgeBand = 'fresh' | 'ageing' | 'overdue';

// ------------------------------------------------------- reading a row safely

/**
 * The row, read as if it were `unknown` — because it is.
 *
 * `shopFetch<T>` is an unchecked assertion (`api-shop.ts` says so at length), so
 * `ShopOrderRow` is a claim about the payload rather than a fact about it. These
 * few helpers are the only place this file touches the shape, and each one
 * answers with something the rest of the module can use without a guard.
 */
function orderOf(row: unknown): Partial<ShopOrder> {
  const order = (row as { order?: unknown } | null | undefined)?.order;
  return order !== null && typeof order === 'object' ? (order as Partial<ShopOrder>) : {};
}

function linesOf(row: unknown): Partial<ShopOrderLine>[] {
  const lines = (row as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter(
    (line): line is Partial<ShopOrderLine> => line !== null && typeof line === 'object',
  );
}

/**
 * A quantity, or `null` — AND `null` IS NOT ZERO.
 *
 * COERCING IS STILL REFUSED. `'3'` is a payload this server does not send, and a
 * client that quietly reads it as `3` is a client that will keep working the day
 * the column changes type and start disagreeing with the server about how many
 * units a parcel may contain. `Number('3')` here buys one rendered card and
 * costs the only place that would have noticed.
 *
 * WHAT CHANGED IS THE ANSWER TO "AND THEN WHAT". This returned `0` for every
 * value it would not read, which made `{ qty: '3' }` arithmetically identical to
 * a line for nothing: `ordered: 0`, `untouched: true`, and a card sitting in
 * `to_pack` describing an order that contains no goods. An order whose size this
 * client cannot read is not an empty order — it is a row nobody should be asked
 * to pack, because the units a shipment would name are exactly the number that
 * could not be read. `null` is what makes the two distinguishable, and
 * `coverageOf` counts them so `columnOf` can park the row where it shows.
 *
 * Negatives and non-integers are `null` for the same reason rather than clamped:
 * `shop_order_lines_qty_ck` forbids both, so either is a payload this client
 * does not understand, and guessing which end of it to trust is the guess.
 */
function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/**
 * A MINOR-UNIT AMOUNT, floored at 0 — the money reads, not the goods reads.
 *
 * Money keeps the old "unreadable is 0" behaviour on purpose, and the asymmetry
 * with `readCount` is the point. `moneyStateOf` is deciding a BADGE, and its
 * ladder already treats "no refund recorded" and "refund unreadable" as the same
 * answer — `none` — because both mean the board has no refund to show. Nothing
 * downstream multiplies these or sends them anywhere.
 */
function amount(value: unknown): number {
  return readCount(value) ?? 0;
}

const KNOWN_STATUSES: readonly OrderStatus[] = [
  'pending',
  'paid',
  'fulfilled',
  'cancelled',
  'refunded',
  'partially_refunded',
];

function statusOf(row: unknown): OrderStatus | null {
  const status = orderOf(row).status;
  return KNOWN_STATUSES.includes(status as OrderStatus) ? (status as OrderStatus) : null;
}

/**
 * The id, or `null` — and `null` is disqualifying rather than cosmetic.
 *
 * Every route this board can reach is addressed by the order's id. Without one
 * there is no shipment to create, no cancel to post and not even a detail page
 * to open, so a card for such a row can carry state but never a button.
 */
function idOf(row: unknown): string | null {
  const id = orderOf(row).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The server's own fulfillability guard, mirrored: `paid` and
 * `partially_refunded` — the two statuses `createFulfillment`'s CAS accepts.
 * Its comment is the reasoning: "A partial refund on an order that has not
 * shipped is a price adjustment; the goods still owe."
 */
const FULFILLABLE: readonly OrderStatus[] = ['paid', 'partially_refunded'];

/**
 * The server's own cancel guard, mirrored: `pending` and `paid` ONLY.
 *
 * `CANCEL.holds` in `server/shop/orders/repo/orders.ts` is `o.status ===
 * 'pending' || o.status === 'paid'`, with the reason stated there: once goods
 * have shipped, "cancelled" is a false record of what happened. Note what falls
 * outside it — `partially_refunded` CANNOT BE CANCELLED even when nothing has
 * shipped, so a part-refunded order that is still waiting to be packed offers
 * "start packing" and no cancel. Offering it would be a 409 with a confirm
 * dialog in front of it.
 */
const CANCELLABLE: readonly OrderStatus[] = ['pending', 'paid'];

// ------------------------------------------------------------------- coverage

export interface Coverage {
  /** Units the customer bought, summed over the lines. */
  ordered: number;
  /** Units held by a fulfilment that has not been cancelled — PENDING ONES INCLUDED. */
  covered: number;
  /** Units no parcel holds yet. This is what a new shipment would contain. */
  outstanding: number;
  /** Every line is covered. NOT "every line has shipped" — see the module header. */
  complete: boolean;
  /** Nothing at all has been packed. */
  untouched: boolean;
  /**
   * Lines whose quantity this client would not read, and which therefore
   * contribute NOTHING to the four numbers above.
   *
   * `complete` AND `untouched` ARE BOTH FALSE WHENEVER THIS IS NON-ZERO, and
   * that is not a third state smuggled in — it is the absence of two claims.
   * Each is an assertion about the whole order ("every line is covered",
   * "nothing has been packed") and neither can be made about an order with a
   * line nobody can count. A caller that sees both false reads `unreadable` to
   * learn whether that means "somewhere in between" or "unknown".
   */
  unreadable: number;
}

/**
 * How much of this order a parcel already holds.
 *
 * `ShopOrders.tsx` computes `qty - fulfilledQty` per line for its shipment form;
 * this is the same arithmetic named once, so the card, the header and the plan
 * cannot disagree about what "half packed" means.
 */
export function coverageOf(row: ShopOrderRow): Coverage {
  const lines = linesOf(row);
  let ordered = 0;
  let covered = 0;
  let unreadable = 0;
  for (const line of lines) {
    const want = readCount(line.qty);
    const have = readCount(line.fulfilledQty);
    /*
     * EITHER HALF UNREADABLE DISQUALIFIES THE LINE, INCLUDING A MISSING
     * `fulfilledQty`. The two numbers are only meaningful against each other: a
     * `qty` with no `fulfilledQty` cannot say how much is outstanding, and
     * assuming zero would put the whole line in the next parcel on top of
     * whatever a parcel already holds — a 409 from
     * `shop_order_lines_fulfilled_ck` on the ordinary "ship what is left" click.
     */
    if (want === null || have === null) {
      unreadable += 1;
      continue;
    }
    /*
     * A `fulfilledQty` above `qty` is impossible under
     * `shop_order_lines_fulfilled_ck`, but clamping keeps `outstanding` from
     * going negative — and keeps one over-fulfilled line from cancelling out a
     * genuinely unpacked one in the sums.
     */
    ordered += want;
    covered += Math.min(want, have);
  }
  return {
    ordered,
    covered,
    outstanding: Math.max(0, ordered - covered),
    complete: unreadable === 0 && ordered > 0 && covered >= ordered,
    untouched: unreadable === 0 && covered === 0,
    unreadable,
  };
}

/**
 * The lines a shipment could actually name, and how many units they hold.
 *
 * NOT THE SAME QUESTION AS `coverageOf`, and the difference is the bug it fixes.
 * Coverage is about GOODS — a line with 3 outstanding units is 3 units the
 * customer has not received, whatever else is wrong with the row. A shipment is
 * about IDS: `createFulfillment` names `orderLineId`, so a line that arrived
 * without one cannot be put in a parcel however many units it claims.
 *
 * Computed once and shared by `movesFor` and `planMove`, because when they
 * disagree the board offers "start packing" on a row whose plan comes back
 * `null` — a button that does nothing at all.
 */
interface Packable {
  lines: { orderLineId: string; qty: number }[];
  units: number;
}

function packableOf(row: unknown): Packable {
  const lines = linesOf(row)
    .map((line) => {
      // A line this client cannot count is a line no parcel may name. It stays
      // in the list with `qty: 0` so the filter below drops it exactly the way
      // it drops an id-less one — one reason to exclude, not two.
      const want = readCount(line.qty);
      const have = readCount(line.fulfilledQty);
      return {
        orderLineId: line.id,
        qty: want === null || have === null ? 0 : Math.max(0, want - have),
      };
    })
    .filter(
      (line): line is { orderLineId: string; qty: number } =>
        typeof line.orderLineId === 'string' && line.orderLineId !== '' && line.qty > 0,
    );
  return { lines, units: lines.reduce((n, line) => n + line.qty, 0) };
}

/**
 * The refund badge. Read from `status` first, because that is what the server
 * decided in SQL against the frozen `grand_total`; `refundedTotal` is consulted
 * only when the status does not say, so a row that arrives without one still
 * shows the money that went back.
 */
export function moneyStateOf(row: ShopOrderRow): MoneyState {
  const order = orderOf(row);
  if (order.status === 'refunded') return 'refunded';
  if (order.status === 'partially_refunded') return 'partly_refunded';
  const refunded = amount(order.refundedTotal);
  if (refunded === 0) return 'none';
  const grand = amount(order.grandTotal);
  return grand > 0 && refunded >= grand ? 'refunded' : 'partly_refunded';
}

// ----------------------------------------------------------------- the column

/**
 * The column, from `order.status`, `order.fulfilledAt` and `lines[].fulfilledQty`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO RULES THAT ARE NOT OBVIOUS, BOTH READ OUT OF THE SERVER.
 *
 * 1. `fulfilled` MEANS SHIPPED, NOT DELIVERED. `routes.ts` calls
 *    `settleOrderFulfilled` immediately after `shipFulfillment`, and that
 *    statement's guard is `status = 'paid' AND <nothing unshipped>` — where
 *    "unshipped" counts fulfilments in `('shipped','delivered')` only. So the
 *    status flips the moment the last parcel is marked shipped. A board that
 *    reads `fulfilled` as "done and delivered" tells the operator a parcel has
 *    arrived when it has just left.
 *
 * 2. A SHIPPED ORDER THAT IS LATER PART-REFUNDED LOSES THE `fulfilled` STATUS —
 *    `APPLY_REFUND` overwrites it — but it keeps `fulfilledAt`, which is written
 *    by `settleOrderFulfilled` and by nothing else, and cleared by nothing at
 *    all. So `fulfilledAt` is the durable "this order shipped in full" mark.
 *    Without it, Monday's shipment plus Tuesday's partial refund reads as a
 *    parcel still on the bench.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `fulfilledAt` IS READ WITH COVERAGE, NOT AHEAD OF IT — and that ordering is a
 * fix, not a detail. It used to win outright, which is wrong in one reachable
 * direction: `cancelFulfillment` accepts a SHIPPED parcel ("a parcel that was
 * lost, recalled or returned to sender is a real and reasonably common event")
 * and releases its quantity through `shop_fulfillments_release`. So an order can
 * ship in full, be part-refunded, lose a parcel in transit, and arrive here with
 * `fulfilledAt` set and units owing again. `createFulfillment` accepts that row
 * — `partially_refunded` is fullfillable and the units are outstanding — so
 * parking it in `shipped` hid a move the server certainly allows, on a row where
 * a customer is waiting for goods that no longer exist in any parcel. The mark
 * means "this shipped in full", and it goes on meaning that only while the lines
 * it was written about are still covered.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FULLY COVERED AND NOT `fulfilled` IS TWO DIFFERENT QUESTIONS, NOT ONE, AND
 * `settleOrderFulfilled`'s CAS IS WHAT SEPARATES THEM.
 *
 * That statement is `SET status = 'fulfilled', fulfilled_at = …` guarded by
 * `status = 'paid' AND <nothing unshipped>`. Read the first conjunct as what it
 * is: the flip is available to `paid` orders ONLY.
 *
 * - **`paid` AND FULLY COVERED IS `packing`, AND THAT IS AN INFERENCE.** The
 *   parcels exist, and at least one is still `pending` — had they all shipped,
 *   the settle after the last one would have found `NOTHING_UNSHIPPED` true and
 *   the row would say `fulfilled`. The residual risk is a settle that lost its
 *   CAS race, which shows a shipped order as still packing. That direction is
 *   the safe one: a false "there is work here" costs a click, while a false
 *   "this is on its way" is an order nobody ever ships.
 *
 * - **`partially_refunded` AND FULLY COVERED IS `check_parcel`, BECAUSE THE
 *   INFERENCE ABOVE IS NOT AVAILABLE.** `APPLY_REFUND` can overwrite `paid`
 *   before anything ships, and from that moment the CAS can never match again:
 *   the parcels may all ship, may all be delivered, and `status` and
 *   `fulfilledAt` will not move for it. Refund-then-ship is reachable through
 *   this module's own advertised workflow — an unshipped part-refunded order is
 *   packable, `FULFILLABLE` says so — and the ordering the rule above describes
 *   is the other one.
 *
 * THREE RESOLUTIONS WERE AVAILABLE AND TWO OF THEM ASSERT SOMETHING.
 *
 * 1. **Send it to `shipped`.** The board would then claim a parcel is with the
 *    courier on the strength of a row that cannot say so. It is the exact claim
 *    the `paid` branch above refuses to make on much better evidence, and it
 *    withholds `ship` — which for a parcel still on the bench is the one move
 *    that matters, on the one order nothing else will ever chase.
 * 2. **Leave it in `packing` and stop `ageBand` from reddening this shape.**
 *    Cheaper by a lane, and it moves the lie rather than removing it: the column
 *    heading still says the goods are on the bench, the header still counts them
 *    as outstanding work, and the exception now lives in two functions that have
 *    to keep agreeing about a case neither of them names.
 * 3. **Have the lane depend on a detail fetch the board opts into.** This is the
 *    only way to actually KNOW, and it costs `columnOf` its totality and its
 *    purity for a lane that is empty on almost every board. `planMove` already
 *    models the detail read where it belongs — per click, on one order, when the
 *    operator has asked.
 *
 * So: its own lane, whose whole content is "the board cannot place this parcel,
 * open it". `movesFor` offers BOTH `ship` and `deliver` there because the server
 * will certainly refuse neither — one of them will find its parcel — and
 * `ageBand` leaves it alone, because reddening work that may already be done is
 * how a colour that means "chase this" stops being read at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function columnOf(row: ShopOrderRow): ColumnKey {
  const status = statusOf(row);
  // A status nobody knows, or an order nothing can be addressed to. Both are
  // rows the board can show and cannot work with, which is one lane.
  if (status === null || idOf(row) === null) return 'needs_attention';

  // Money returned in full, or the order withdrawn: nothing is owed either way,
  // and the server refuses every further transition on both.
  if (status === 'refunded' || status === 'cancelled') return 'closed';

  // No money has arrived, so no goods are owed. Waiting on the customer, or on
  // the sweep that turns a capture into a paid order — never on the operator.
  if (status === 'pending') return 'awaiting_payment';

  /*
   * CHECKED BEFORE THE QUANTITIES, and deliberately so. `fulfilled` is the
   * server's own assertion that nothing is unshipped, and the only move out of
   * `shipped` names a parcel rather than a number of units — so a line this
   * client cannot count changes neither the lane nor the button, and parking
   * such a row in `needs_attention` would take a shipped order off the board
   * over an arithmetic it does not use.
   */
  if (status === 'fulfilled') return 'shipped';

  // `paid` or `partially_refunded` — the two the server will still fulfil, and
  // the two where the units decide both the lane and what a parcel may contain.
  const coverage = coverageOf(row);

  /*
   * A LINE NOBODY CAN COUNT ON AN ORDER THAT STILL OWES GOODS. Every move from
   * here names quantities — `createFulfillment` sends them and
   * `shop_order_lines_fulfilled_ck` checks them — so the board cannot work this
   * row, which is what `needs_attention` is for. The alternative is what this
   * used to do: read the unreadable line as zero and show a `to_pack` card for
   * an order that appears to contain nothing, which is both wrong and invisible.
   */
  if (coverage.unreadable > 0) return 'needs_attention';

  if (coverage.complete) {
    if (isRenderable(orderOf(row).fulfilledAt)) return 'shipped';
    if (status === 'partially_refunded') return 'check_parcel';
  }

  return coverage.untouched ? 'to_pack' : 'packing';
}

// ------------------------------------------------------------------ the moves

export type MoveKey = 'pack' | 'ship' | 'deliver' | 'cancel';

/**
 * What a move costs the operator BEFORE anything happens.
 *
 * `needs_detail` is not a performance note, it is a truth the button has to
 * carry: the list holds no fulfilment ids, so "mark shipped" and "mark
 * delivered" BOTH begin with `GET /shop/admin/orders/:id`. One request on one
 * human's click for one order is a fine price; a spinner the operator cannot
 * account for is not.
 */
export type MoveCost = 'direct' | 'needs_detail';

export interface Move {
  /** Stable across labels and refactors — this is what a caller passes to `planMove`. */
  key: MoveKey;
  label: string;
  /** One line under the button. Says what will happen, never more than is known. */
  hint: string;
  /** The move deserves a `ConfirmDialog` before it fires. */
  confirm: boolean;
  /** Renders as `btn--danger`: it takes something away this screen cannot give back. */
  destructive: boolean;
  /** `requireOwner()` on the server. Carried so a UI can explain the absence. */
  ownerOnly: boolean;
  cost: MoveCost;
}

/**
 * THE TWO PARCEL MOVES ARE OFFERED TOGETHER WHEREVER A PARCEL EXISTS AND THE
 * LIST CANNOT SAY WHICH KIND IT IS, and their hints have to earn that.
 *
 * `SHIP.holds` is `f.status === 'pending'` and `DELIVER.holds` is
 * `f.status === 'shipped'` — both keyed on the FULFILMENT row alone, with no
 * condition on the order. So the server's answer to either move is decided by a
 * row this payload does not carry, and the only dishonest hint is one that
 * implies the board knows which. Each says what it will look for and says that
 * looking can come back empty, because for one of the two it usually will.
 */
const SHIP_MOVE: Move = {
  key: 'ship',
  label: 'Mark shipped',
  hint: 'Opens the order to find a parcel still waiting to go, then marks it shipped. If every parcel has already left, it will say so and change nothing.',
  confirm: false,
  destructive: false,
  ownerOnly: false,
  cost: 'needs_detail',
};

const DELIVER_MOVE: Move = {
  key: 'deliver',
  label: 'Mark delivered',
  hint: 'Opens the order to find a parcel that has left, then marks it delivered. If nothing has left yet, it will say so and change nothing.',
  confirm: false,
  destructive: false,
  ownerOnly: false,
  cost: 'needs_detail',
};

const CANCEL_MOVE: Move = {
  key: 'cancel',
  label: 'Cancel this order',
  hint: 'Releases the reserved stock and stops the order ever shipping. It does not refund anything.',
  confirm: true,
  destructive: true,
  ownerOnly: true,
  cost: 'direct',
};

function packMove(coverage: Coverage, packable: Packable): Move {
  return {
    key: 'pack',
    /*
     * The repo already says "Ship what is left" for the second parcel, so the
     * board says the same thing in the same words rather than inventing a
     * synonym. The KEY does not move with the label — a caller matches on
     * `'pack'` either way.
     */
    label: coverage.untouched ? 'Start packing' : 'Pack what is left',
    hint: `Creates a shipment for the ${packable.units} item${
      packable.units === 1 ? '' : 's'
    } nothing holds yet. Carrier and tracking are optional.`,
    confirm: false,
    destructive: false,
    ownerOnly: false,
    cost: 'direct',
  };
}

/**
 * The legal moves out of this row, for this role, in the order a card should
 * show them.
 *
 * EVERY ENTRY MIRRORS A SERVER GUARD, and the mirrors are named above
 * (`FULFILLABLE`, `CANCELLABLE`) rather than re-typed here. A move this function
 * offers and the server refuses is worse than a move it withholds: the operator
 * clicks, a dialog says "the reserved stock will be released", and a 409 comes
 * back — so the rule is that the board offers strictly less than the API allows,
 * never more.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "STRICTLY LESS" IS ABOUT WHAT IS CERTAIN, NOT ABOUT WHAT IS LIKELY, AND THE
 * PARCEL MOVES ARE WHERE THE DIFFERENCE BITES.
 *
 * `ship` and `deliver` are guarded by the FULFILMENT's own status — `pending`
 * for one, `shipped` for the other — and fulfilment rows are the thing this
 * payload does not have. So on any row where a parcel exists, each move is
 * POSSIBLE and neither is certain, and the old rule (offer `ship` in `packing`,
 * `deliver` in `shipped`, never both) was reading a guess as a fact in both
 * directions at once:
 *
 * - It offered `ship` on a `packing` row whose only parcel had already gone —
 *   an ordinary multi-parcel order, one box sent, the rest of the lines still
 *   unpacked — where the plan's read finds no `pending` parcel and the button
 *   cannot succeed however many times it is pressed.
 * - It withheld `deliver` on that same row, though `deliverFulfillment` would
 *   have taken it, because the courier had in fact delivered the box.
 *
 * BOTH, THEN, WHEREVER A PARCEL EXISTS. The pair costs one button and makes the
 * read step the thing that decides — which is the only thing that can, and which
 * `MoveCost` already tells the operator they are paying for. `shipped` is the
 * one lane that still offers `deliver` alone, and only because `fulfilled` is
 * the server asserting that nothing is left unshipped: there, `ship` is not
 * uncertain, it is refused.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `cancel` IS ABSENT FOR A WRITER RATHER THAN DISABLED. `POST /admin/orders/:id/
 * cancel` is `requireOwner()` while every fulfilment route is `requireAuth()`; a
 * greyed-out button on a surface a writer uses all day is a permanent invitation
 * to a 403.
 */
export function movesFor(row: ShopOrderRow, role: Role): Move[] {
  const column = columnOf(row);
  /*
   * THE INVARIANT THIS LINE HOLDS UP: every move offered here can be planned.
   * `needs_attention` is where a row lands when its status is unreadable OR its
   * id is missing, and the second one is easy to forget — the status can be a
   * perfectly good `paid` while there is no id to post a cancel to. A button
   * that cannot be turned into a request is worse than no button: the operator
   * clicks it, nothing happens, and the board has taught them not to trust it.
   */
  if (column === 'needs_attention') return [];

  const status = statusOf(row);
  const coverage = coverageOf(row);
  const packable = packableOf(row);
  const moves: Move[] = [];

  /*
   * A shipment needs a fulfillable status AND lines it can name. An order whose
   * lines did not arrive has nothing to pack, and `createFulfillment` answers
   * 400 to an empty `lines` array — which the operator would read as the order
   * being broken rather than as the payload being thin.
   */
  const canPack = status !== null && FULFILLABLE.includes(status) && packable.lines.length > 0;

  if (column === 'to_pack' && canPack) moves.push(packMove(coverage, packable));
  if (column === 'packing') {
    // A partly packed order is three moves, not one: box the rest, send what is
    // boxed, and — because the box may already be with the courier — close it.
    // "Three items, two in stock" is the case the shipment form was built
    // around, and it is also the case where the first parcel goes out days
    // before the second is packed.
    if (canPack) moves.push(packMove(coverage, packable));
    moves.push(SHIP_MOVE, DELIVER_MOVE);
  }
  /*
   * Fully covered, and the board cannot say whether the parcels have gone. No
   * `pack`: there is nothing outstanding, and `createFulfillment` answers 400 to
   * an empty `lines` array — that one IS certain, so it stays withheld.
   */
  if (column === 'check_parcel') moves.push(SHIP_MOVE, DELIVER_MOVE);
  if (column === 'shipped') moves.push(DELIVER_MOVE);

  if (role === 'owner' && status !== null && CANCELLABLE.includes(status)) {
    moves.push(CANCEL_MOVE);
  }

  return moves;
}

// ------------------------------------------------------------------- the plan

/**
 * A step of a move, as DATA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A PLAN AND NOT A FUNCTION THAT DOES IT.
 *
 * The alternative is `execute(row, 'deliver'): Promise<void>` — which needs
 * `shopApi`, which makes this module impure, untestable without a fetch mock and
 * unusable from a reducer. Worse, it hides the shape of the work: "deliver" is
 * two round trips and the first one can find nothing, and a promise says none of
 * that until it rejects.
 *
 * As data, the two-step case is visible before it runs: a `read` step that
 * exists ONLY to name the fulfilment, then a `write` step that names it by
 * reference. A caller executes the plan with a short switch over `call`, every
 * branch of which is a `shopApi` method — so the UI still encodes no routes.
 * `path` is carried for logs and for tests to assert on; it is not what anyone
 * fetches, which is why the unresolved id may honestly appear in it as
 * `{fulfillmentId}`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface ReadStep {
  kind: 'read';
  /** The `shopApi` method to call. */
  call: 'getOrder';
  method: 'GET';
  path: string;
  orderId: string;
  /**
   * The parcel this read exists to find: the first entry of `detail.fulfillments`
   * with this status. Finding none is an ORDINARY ANSWER — the board could not
   * see fulfilment rows when it drew the button — and the caller should say so
   * rather than PATCH nothing.
   */
  find: { fulfillmentStatus: FulfillmentStatus };
  /**
   * WHAT TO PUT ON THE SCREEN WHEN THE READ FINDS NOTHING, carried here because
   * "say so" was previously said only in the comment above.
   *
   * `movesFor` offers `ship` and `deliver` together on every row where a parcel
   * exists and the list cannot say which kind it is, so ONE OF THE TWO COMING
   * BACK EMPTY IS THE DESIGNED OUTCOME rather than an edge — it is how the board
   * asks the question it could not answer itself. A caller that only knows "the
   * plan stopped" has nothing to render but a spinner that ends, which is the
   * dead button this whole arrangement exists to remove.
   *
   * A SENTENCE AND NOT A CODE. The alternative is a `reason: 'no_pending'` the
   * UI maps to English, which puts this decision — what an operator is told when
   * the board turns out to have been wrong about a parcel — in a switch
   * statement in a component, away from the guard it is about. Every other
   * explanation this module produces (`hint`, `COLUMN_LABEL`) is already a
   * sentence in the same register, and there is one locale.
   */
  whenMissing: string;
  /** The field of the following step that the id it yields fills in. */
  binds: 'fulfillmentId';
}

export type WriteStep =
  | {
      kind: 'write';
      call: 'createFulfillment';
      method: 'POST';
      path: string;
      orderId: string;
      /**
       * Everything outstanding, which is what the shipment form starts with.
       * Carrier and tracking are the operator's to add — the plan describes the
       * work, not the typing.
       */
      body: { lines: { orderLineId: string; qty: number }[] };
    }
  | {
      kind: 'write';
      call: 'setFulfillmentStatus';
      method: 'PATCH';
      path: string;
      /** Filled in from the `read` step at this index. */
      fulfillmentId: { from: 'step'; index: number };
      body: { status: 'shipped' | 'delivered' };
    }
  | {
      kind: 'write';
      call: 'cancelOrder';
      method: 'POST';
      path: string;
      orderId: string;
      body: Record<string, never>;
    };

export type PlanStep = ReadStep | WriteStep;

export interface MovePlan {
  move: MoveKey;
  orderId: string;
  /** `true` when step 0 is a read that exists only to name a later step's target. */
  needsDetail: boolean;
  steps: PlanStep[];
}

const ADMIN = '/shop/admin';

/**
 * The API work a move implies, or `null` when the move is not legal for this row
 * and this role.
 *
 * `role` IS REQUIRED, THOUGH ONLY `cancel` READS IT. A board hands out buttons
 * from `movesFor`, so in the ordinary path the role has already been checked —
 * but "the ordinary path" is exactly the assumption that puts an owner-only call
 * behind a writer's keyboard shortcut or a replayed action. Two checks of one
 * rule cost a parameter; one check costs a 403 in front of a customer.
 *
 * `null` RATHER THAN A THROW, because the common way to reach it is a stale
 * board: the operator packed an order in another tab, this one still shows
 * "start packing", and the click arrives against a row that has moved on. That
 * is a refresh, not an exception.
 */
export function planMove(row: ShopOrderRow, move: MoveKey, role: Role): MovePlan | null {
  const legal = movesFor(row, role).some((m) => m.key === move);
  if (!legal) return null;

  // Unreachable through `movesFor`, which parks an id-less row in
  // `needs_attention` — kept because `planMove` is callable on its own.
  const id = idOf(row);
  if (id === null) return null;

  if (move === 'pack') {
    // The SAME computation `movesFor` offered the button on, not a second one
    // that agrees with it today.
    const { lines } = packableOf(row);
    if (lines.length === 0) return null;
    return {
      move,
      orderId: id,
      needsDetail: false,
      steps: [
        {
          kind: 'write',
          call: 'createFulfillment',
          method: 'POST',
          path: `${ADMIN}/orders/${id}/fulfillments`,
          orderId: id,
          body: { lines },
        },
      ],
    };
  }

  if (move === 'cancel') {
    return {
      move,
      orderId: id,
      needsDetail: false,
      steps: [
        {
          kind: 'write',
          call: 'cancelOrder',
          method: 'POST',
          path: `${ADMIN}/orders/${id}/cancel`,
          orderId: id,
          body: {},
        },
      ],
    };
  }

  /*
   * `ship` and `deliver` differ only in which parcel they look for and what they
   * set it to. Writing them once keeps the two-step shape identical, which is
   * what lets one executor run both — and stops "deliver" growing a third step
   * the day somebody edits only one of two near-identical blocks.
   */
  const from: FulfillmentStatus = move === 'ship' ? 'pending' : 'shipped';
  const to = move === 'ship' ? 'shipped' : 'delivered';
  /*
   * BOTH SENTENCES NAME THE OTHER POSSIBILITY, because the operator is standing
   * in front of the answer the board could not give: "nothing is waiting to go"
   * on an order the board called `packing` means the parcel has already left,
   * and that is the useful half of the message. Neither says "try the other
   * button" — the order is open on the screen by then, with its fulfilments on
   * it, which is a better answer than any instruction this module could write.
   */
  const whenMissing =
    move === 'ship'
      ? 'No parcel on this order is waiting to go — everything packed has already been shipped, or nothing has been packed yet. Nothing was changed.'
      : 'No parcel on this order has been shipped yet, so there is nothing to mark delivered. Nothing was changed.';
  return {
    move,
    orderId: id,
    needsDetail: true,
    steps: [
      {
        kind: 'read',
        call: 'getOrder',
        method: 'GET',
        path: `${ADMIN}/orders/${id}`,
        orderId: id,
        find: { fulfillmentStatus: from },
        whenMissing,
        binds: 'fulfillmentId',
      },
      {
        kind: 'write',
        call: 'setFulfillmentStatus',
        method: 'PATCH',
        path: `${ADMIN}/fulfillments/{fulfillmentId}`,
        fulfillmentId: { from: 'step', index: 0 },
        body: { status: to },
      },
    ],
  };
}

// --------------------------------------------------------------- the age band

/**
 * How long this order has been WAITING ON THE OPERATOR.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THRESHOLDS, AND WHY THEY ARE THESE.
 *
 * One owner, one shop, Nigeria, and dispatch arranged separately — CLAUDE.md
 * records the delivery rates (Abuja ₦3,000, Lagos ₦10,000, elsewhere ₦10,000) as
 * provisional and "more like logging" while a courier is booked by hand, order
 * by order. That is the reality the numbers have to fit:
 *
 * - **Under a day is FRESH, always.** An order paid at 23:40 cannot be packed
 *   before morning, and a board that scolds the owner at breakfast for it is a
 *   board they stop reading. There is no same-day promise anywhere in this shop
 *   to measure against.
 * - **One to two days is AGEING.** A courier here is a phone call, not a
 *   scheduled pickup, so the second morning is the first one where nothing
 *   happening is a decision rather than a clock. Amber, not red: it is a nudge.
 * - **Three days or more is OVERDUE.** Three days covers a Sunday plus a public
 *   holiday, which is every calendar excuse a week can hold. Past it, a customer
 *   who paid ₦26,000 has heard nothing for three days and the shop has not
 *   started. That is the only state on this board worth a red mark.
 *
 * Deliberately NOT hours. `ageDays` floors to whole days for the reason `when.ts`
 * gives — "an ageing badge that overstates is one that cries wolf" — and a
 * 25-hour-old order reading as "1 day" is the honest version of that.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONLY `to_pack` AND `packing` CAN AGE. `awaiting_payment` waits on the customer
 * or on the sweep; `shipped` waits on a courier; `closed` waits on nobody. A
 * delivered order is not overdue however long ago it was placed, and marking one
 * red would train the operator to ignore the colour.
 *
 * `packing` COUNTS TOO, which is a judgement call. A parcel that was packed on
 * Monday and never marked shipped is neglect of exactly the kind this band
 * exists to surface — the goods are boxed and sitting on the bench, the customer
 * has had no shipment mail, and it is one click from being fixed.
 *
 * `check_parcel` DOES NOT, AND IT IS THE HARDEST LANE TO DECIDE. A row lands there
 * fully packed and unplaceable: the goods may be on the bench — the same neglect
 * `packing` is reddened for — or they may have been delivered a fortnight ago.
 * Ageing it would put the loudest mark on the board over a coin toss, on the one
 * lane where the operator cannot even resolve it by looking at the card. The
 * decision follows the same rule as an unreadable date two paragraphs down: this
 * band exists to say "you are late", and it may only say that where the board
 * KNOWS. What makes the silence affordable is that the lane is not silent — it
 * is a permanent standing instruction to open the order, which does not fade
 * after three days the way an amber badge stops being seen.
 *
 * The clock is `paidAt` and falls back to `placedAt`: the shop owes goods from
 * the moment the money lands. An unreadable date is `fresh`, never `overdue` — a
 * broken timestamp is a data bug, and painting it red would put the loudest mark
 * on the board next to the one thing the operator cannot act on.
 */
const AGEING_DAYS = 1;
const OVERDUE_DAYS = 3;

export function ageBand(row: ShopOrderRow, now: number): AgeBand {
  const column = columnOf(row);
  if (column !== 'to_pack' && column !== 'packing') return 'fresh';

  const order = orderOf(row);
  const from = isRenderable(order.paidAt) ? order.paidAt : order.placedAt;
  const days = ageDays(from, now);
  if (days === null) return 'fresh';
  if (days >= OVERDUE_DAYS) return 'overdue';
  return days >= AGEING_DAYS ? 'ageing' : 'fresh';
}

// ---------------------------------------------------------------- the summary

/** Minor units under an ISO-4217 code. The two travel together or not at all. */
export interface MoneyTotal {
  currency: string;
  /** Sum of the FROZEN `grandTotal`. Never recomputed from the lines. */
  total: number;
}

export interface ColumnSummary {
  column: ColumnKey;
  label: string;
  count: number;
  /** One entry per currency present, ascending by code. NEVER one number. */
  money: MoneyTotal[];
  ageing: number;
  overdue: number;
}

export interface BoardSummary {
  /** The `now` every band below was taken against. */
  generatedAt: number;
  /** Rows in, rows out — including the ones nothing could be read off. */
  total: number;
  /** Every column, in board order, empty ones included. */
  columns: ColumnSummary[];
}

interface Bucket {
  count: number;
  money: Map<string, number>;
  ageing: number;
  overdue: number;
}

/**
 * The board header: how many orders sit in each column, and how much money.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MONEY IS GROUPED BY CURRENCY AND IS NEVER SUMMED ACROSS ONE.
 *
 * `server/shop/admin/stats.ts` refuses the same thing and says why: "two codes
 * cannot be added — summing GBP and EUR into one integer produces a number that
 * looks like a total and reconciles against nothing". v1 has one store currency,
 * so in practice each column carries one entry; the grouping is what makes the
 * day that stops being true visible instead of silently wrong.
 *
 * TOTALS ARE COPIED, NEVER RECOMPUTED. `grandTotal` was frozen at checkout, and
 * re-adding the lines here would reintroduce exactly the drift freezing exists to
 * prevent — a header that disagrees with the customer's receipt by the shipping
 * line, in minor units, at 100 per naira.
 *
 * A ROW WHOSE MONEY CANNOT BE READ IS STILL COUNTED. Where `stats.ts` omits an
 * empty status because a zero row would have to invent a currency, this counts
 * the order and contributes nothing to `money`: the count is a fact about the
 * board (the card is there, the operator can see it), the currency is not. A
 * `NaN` in a header would poison a real total; a missing order would hide work.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `needs_attention` CARRIES MONEY LIKE EVERY OTHER LANE, AND THAT IS DELIBERATE.
 *
 * The objection is real: it is the lane defined as "the board cannot work this
 * row", and a total over rows the client has just declared unreadable looks like
 * a number standing on nothing.
 *
 * It is not, because of WHICH thing is unreadable. A row lands there for a
 * status this client does not know, a missing id, or a line quantity that is not
 * a number — none of which touches `currency` or `grandTotal`, and both of those
 * are checked independently one screen down before either is added. The lane is
 * about the board's ability to ACT, not about the payload's legibility; the
 * money is a separate read that either succeeds or contributes nothing, exactly
 * as it does in `to_pack`.
 *
 * And dropping it would be the expensive half of the trade. That total is the
 * size of the incident — "three orders, ₦7,500,000, and nobody can touch them"
 * is the sentence that gets a truncated payload or an unrecognised status looked
 * at today rather than on Friday. Suppressing it would make a shop whose list
 * response lost a field show a board full of real orders and ₦0, which is a
 * worse lie than the one this paragraph was worried about. The header groups by
 * currency and publishes no board-wide total, so there is nothing here to add it
 * into by mistake.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EMPTY COLUMNS DO GET A ROW HERE, and that is not a contradiction of
 * `stats.ts` — an empty column carries `money: []` and invents nothing. The
 * board renders its lanes whether or not orders are in them, so making the
 * client reconstruct the absent ones is the "one line there and a lie here"
 * trade run in the direction that costs nothing.
 *
 * NO BOARD-WIDE MONEY TOTAL, deliberately. Adding cancelled and refunded orders
 * to paid ones produces a headline figure that is not revenue, not outstanding
 * work and not anything else a person could act on. The dashboard has
 * `stats.ts` for money; this header is about where the parcels are.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function summarise(rows: readonly ShopOrderRow[], now: number): BoardSummary {
  const buckets = new Map<ColumnKey, Bucket>();
  for (const column of BOARD_COLUMNS) {
    buckets.set(column, { count: 0, money: new Map<string, number>(), ageing: 0, overdue: 0 });
  }

  // `rows` is typed as an array and is still checked, for the same reason every
  // other read in this file is: the payload is asserted, not parsed.
  const list = Array.isArray(rows) ? rows : [];
  let total = 0;

  for (const row of list) {
    const bucket = buckets.get(columnOf(row));
    if (!bucket) continue;
    total += 1;
    bucket.count += 1;

    const band = ageBand(row, now);
    if (band === 'ageing') bucket.ageing += 1;
    if (band === 'overdue') bucket.overdue += 1;

    const order = orderOf(row);
    const currency = typeof order.currency === 'string' ? order.currency.trim() : '';
    const grand = order.grandTotal;
    // Both halves or neither: an amount with no code cannot be rendered, and a
    // code with no amount is not money.
    if (currency !== '' && typeof grand === 'number' && Number.isFinite(grand)) {
      bucket.money.set(currency, (bucket.money.get(currency) ?? 0) + grand);
    }
  }

  return {
    generatedAt: now,
    total,
    columns: BOARD_COLUMNS.map((column) => {
      const bucket = buckets.get(column) ?? {
        count: 0,
        money: new Map<string, number>(),
        ageing: 0,
        overdue: 0,
      };
      return {
        column,
        label: COLUMN_LABEL[column],
        count: bucket.count,
        money: [...bucket.money.entries()]
          .map(([currency, sum]) => ({ currency, total: sum }))
          .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)),
        ageing: bucket.ageing,
        overdue: bucket.overdue,
      };
    }),
  };
}
