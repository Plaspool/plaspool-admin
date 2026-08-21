import { describe, expect, it } from 'vitest';

import type { ShopOrder, ShopOrderLine, ShopOrderRow } from '../../data/api-shop';
import LIVE from '../__fixtures__/orders-live.json';
import {
  BOARD_COLUMNS,
  ageBand,
  columnOf,
  coverageOf,
  moneyStateOf,
  movesFor,
  planMove,
  summarise,
  type ColumnKey,
} from './pipeline';

/**
 * THE BOARD'S RULES, AGAINST THE PAYLOAD THE DEPLOYED SERVER ACTUALLY SENDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY ROW IN THIS FILE DESCENDS FROM `__fixtures__/orders-live.json`.
 *
 * CLAUDE.md §2: "a green suite has repeatedly meant nothing" here, and the way
 * it meant nothing on THIS surface was a fixture that disagreed with the server
 * — a flat `items[0]` where production sends `{ order, lines }`. Eleven tests
 * passed while the screen was dead.
 *
 * So nothing below invents a payload. The five live orders are used as they
 * were captured, and every other state is that capture with the ONE field the
 * server would have moved changed on a copy: `status`, `fulfilledAt`,
 * `fulfilledQty`. If the server's shape moves, these fail; a scenario cannot
 * quietly drift into a shape production never produces, because it never stops
 * being a production row.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The assertions are written so that a WRONG implementation fails, not so that
 * the current one passes. Each block names the wrong implementation it exists to
 * catch.
 */

const LIVE_ROWS = LIVE.items as unknown as ShopOrderRow[];

const DAY = 86_400_000;

/** The most recent capture: paid 2026-something, `paid`, nothing packed. */
const PAID = LIVE_ROWS[0];

/** An hour after the newest live order was paid. Everything is fresh here. */
const NOW = (PAID.order.paidAt ?? PAID.order.placedAt) + 60 * 60 * 1000;

function withOrder(row: ShopOrderRow, patch: Partial<ShopOrder>): ShopOrderRow {
  return { order: { ...row.order, ...patch }, lines: row.lines.map((line) => ({ ...line })) };
}

/** The same order with `n` more of the same line — a real multi-line order's shape. */
function withLines(row: ShopOrderRow, lines: Partial<ShopOrderLine>[]): ShopOrderRow {
  const base = row.lines[0];
  return {
    order: { ...row.order },
    lines: lines.map((patch, i) => ({ ...base, id: `${base.id}-${i}`, lineNo: i, ...patch })),
  };
}

// --------------------------------------------------------------- the fixture

describe('the captured payload', () => {
  /*
   * The guard on everything else in this file. If `lines[].fulfilledQty` ever
   * stops being part of the list response, every column below is derived from
   * a field that is not there — and the failure would otherwise show up as a
   * board that reads every order as unpacked.
   */
  it('carries lines with `fulfilledQty`, and carries no fulfilment rows', () => {
    expect(LIVE_ROWS.length).toBeGreaterThan(0);
    for (const row of LIVE_ROWS) {
      expect(Object.keys(row).sort()).toEqual(['lines', 'order']);
      expect(row).not.toHaveProperty('fulfillments');
      expect(row.lines.length).toBeGreaterThan(0);
      for (const line of row.lines) {
        expect(typeof line.fulfilledQty).toBe('number');
        expect(typeof line.qty).toBe('number');
        expect(typeof line.id).toBe('string');
      }
    }
  });

  it('is five paid, unpacked orders — the state the shop was actually in', () => {
    expect(LIVE_ROWS.map((r) => r.order.status)).toEqual(['paid', 'paid', 'paid', 'paid', 'paid']);
    expect(LIVE_ROWS.every((r) => r.lines.every((l) => l.fulfilledQty === 0))).toBe(true);
    expect(LIVE_ROWS.every((r) => r.order.fulfilledAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------- the columns

describe('columnOf', () => {
  it('puts every live order in `to_pack` — paid, nothing packed', () => {
    for (const row of LIVE_ROWS) expect(columnOf(row)).toBe('to_pack');
  });

  it('moves an order to `packing` as soon as ONE unit is covered', () => {
    /*
     * The wrong implementation this catches: `fulfilledQty > 0 → shipped`.
     * `fulfilled_qty` is incremented by an AFTER INSERT trigger on
     * `shop_fulfillment_lines` (migration 0160), so it moves when the parcel is
     * CREATED — status `pending` — not when it ships.
     */
    const packing = withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]);
    expect(columnOf(packing)).toBe('packing');
  });

  it('does not read a PARTLY packed order as fully packed', () => {
    const partly = withLines(PAID, [
      { qty: 3, fulfilledQty: 1 },
      { qty: 2, fulfilledQty: 0 },
    ]);
    const coverage = coverageOf(partly);

    expect(coverage).toMatchObject({ ordered: 5, covered: 1, outstanding: 4, complete: false });
    expect(coverage.untouched).toBe(false);
    // And the board still offers the operator the rest of the work.
    expect(movesFor(partly, 'owner').map((m) => m.key)).toContain('pack');
  });

  it('keeps a fully covered but unshipped order in `packing`, not `shipped`', () => {
    /*
     * `settleOrderFulfilled` flips the status to `fulfilled` the moment the last
     * parcel SHIPS, so an order that is still `paid` with every line covered has
     * parcels that have not gone. Calling that "shipped" is the one direction
     * that loses an order: nobody ever ships it and nobody is ever told.
     */
    const boxed = withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]);
    expect(coverageOf(boxed).complete).toBe(true);
    expect(columnOf(boxed)).toBe('packing');
  });

  it('reads `fulfilled` as SHIPPED — the status flips on ship, not on delivery', () => {
    const shipped = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'fulfilled',
      fulfilledAt: NOW - DAY,
    });
    expect(columnOf(shipped)).toBe('shipped');
    /*
     * `delivered` is not on this payload at any price, so the board must not
     * claim it — the only move out of `shipped` is the one that goes and looks.
     * And `ship` is the ONE parcel move that is certainly refused anywhere:
     * `fulfilled` is the server's own assertion that `NOTHING_UNSHIPPED` held,
     * so no `pending` fulfilment exists for `SHIP.holds` to match.
     */
    expect(movesFor(shipped, 'owner').map((m) => m.key)).toEqual(['deliver']);
  });

  it('keeps a SHIPPED order on the shipped pile after a partial refund', () => {
    /*
     * THE CASE THAT MAKES `partially_refunded` A BADGE AND NOT A COLUMN.
     * `APPLY_REFUND` overwrites `fulfilled` with `partially_refunded`, but
     * `fulfilled_at` survives — it is written by `settleOrderFulfilled` and
     * cleared by nothing. An implementation that switches on `status` alone
     * sends a parcel that is with the courier back to the packing bench.
     */
    const shippedThenRefunded = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'partially_refunded',
      fulfilledAt: NOW - 2 * DAY,
      refundedTotal: 500000,
    });

    expect(columnOf(shippedThenRefunded)).toBe('shipped');
    expect(moneyStateOf(shippedThenRefunded)).toBe('partly_refunded');
    expect(ageBand(shippedThenRefunded, NOW + 30 * DAY)).toBe('fresh');
  });

  it('puts an UNSHIPPED partly refunded order back in the packing queue', () => {
    /*
     * The other half of the same rule. `createFulfillment`'s CAS accepts
     * `('paid','partially_refunded')`: "a partial refund on an order that has
     * not shipped is a price adjustment; the goods still owe."
     */
    const adjusted = withOrder(PAID, { status: 'partially_refunded', refundedTotal: 100000 });
    expect(columnOf(adjusted)).toBe('to_pack');
    expect(movesFor(adjusted, 'owner').map((m) => m.key)).toContain('pack');
  });

  it('does not strand a parcel that shipped AFTER the partial refund', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE ORDERING THE TWO TESTS ABOVE DO NOT CONSTRUCT: REFUND, THEN SHIP.
     *
     * The one above it is ship-then-refund, which `fulfilledAt` settles. This is
     * the other way round, and it is reachable through this module's own
     * advertised workflow — the previous test asserts a part-refunded order is
     * packable, and nothing had considered what the board says once that parcel
     * goes out.
     *
     * `fulfilledAt` HAS ONE WRITER IN THE SERVER, `settleOrderFulfilled`, and
     * its CAS reads `AND status = 'paid'`. `APPLY_REFUND` has already overwritten
     * `paid` here, so that statement can never match again: the parcels can ship
     * and be delivered and this row will not move a field. The wrong
     * implementations this catches are the three that fell out of reading
     * `fulfilledAt` as the only shipped-mark —
     *
     *   1. column `packing`, which says the goods are on the bench,
     *   2. `ship` as the only move, whose plan hunts a `pending` fulfilment that
     *      no longer exists — a button that cannot succeed at any time,
     *   3. `deliver` withheld, though `DELIVER.holds` is `f.status === 'shipped'`
     *      alone and the server would take it.
     *
     * — plus the fourth that a lazy fix introduces: moving it to `shipped`,
     * which asserts a courier has it on evidence that does not exist.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const refundedThenShipped = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'partially_refunded',
      fulfilledAt: null,
      refundedTotal: 100000,
      paidAt: NOW - 10 * DAY,
    });

    expect(coverageOf(refundedThenShipped).complete).toBe(true);
    expect(columnOf(refundedThenShipped)).toBe('check_parcel');
    expect(columnOf(refundedThenShipped)).not.toBe('packing');
    expect(columnOf(refundedThenShipped)).not.toBe('shipped');

    // Both parcel moves, because the server refuses neither for certain — and
    // no `pack`, which it WOULD refuse: nothing is outstanding, and
    // `createFulfillment` answers 400 to an empty `lines` array.
    expect(movesFor(refundedThenShipped, 'owner').map((m) => m.key)).toEqual(['ship', 'deliver']);
    expect(planMove(refundedThenShipped, 'ship', 'owner')).not.toBeNull();
    expect(planMove(refundedThenShipped, 'deliver', 'owner')).not.toBeNull();
    expect(planMove(refundedThenShipped, 'pack', 'owner')).toBeNull();

    // Ten days old and it must never read as neglect: the operator may have
    // shipped it on day one and the board cannot tell.
    expect(ageBand(refundedThenShipped, NOW)).toBe('fresh');
    expect(ageBand(refundedThenShipped, NOW + 90 * DAY)).toBe('fresh');
  });

  it('tells the operator what happened when the parcel hunt finds nothing', () => {
    /*
     * The counterpart of offering both moves: one of the two is EXPECTED to come
     * back empty, so the plan has to hand the UI something to put on the screen.
     * A caller that only learns "the plan stopped" renders a spinner that ends,
     * which is the dead button this arrangement exists to remove.
     */
    const unplaceable = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'partially_refunded',
      fulfilledAt: null,
      refundedTotal: 100000,
    });

    for (const move of ['ship', 'deliver'] as const) {
      const step = planMove(unplaceable, move, 'owner')?.steps[0];
      expect(step?.kind).toBe('read');
      const missing = step && step.kind === 'read' ? step.whenMissing : '';
      expect(typeof missing).toBe('string');
      expect(missing.length).toBeGreaterThan(20);
      // It says nothing happened, which is the half the operator has to know.
      expect(missing).toContain('Nothing was changed');
    }

    // And the two are not the same sentence — each names what it looked for.
    const ship = planMove(unplaceable, 'ship', 'owner')?.steps[0];
    const deliver = planMove(unplaceable, 'deliver', 'owner')?.steps[0];
    const text = (s: typeof ship) => (s && s.kind === 'read' ? s.whenMissing : '');
    expect(text(ship)).not.toBe(text(deliver));
  });

  it('re-opens packing on an order whose shipped parcel was cancelled', () => {
    /*
     * `fulfilledAt` USED TO WIN OUTRIGHT, AHEAD OF THE LINES, and this is the
     * row that made that wrong. `cancelFulfillment` holds on `pending` OR
     * `shipped` — "a parcel that was lost, recalled or returned to sender is a
     * real and reasonably common event" — and releases the quantity through
     * `shop_fulfillments_release`. So: shipped in full, part-refunded, parcel
     * lost in transit and cancelled. `fulfilledAt` survives all of it and the
     * units are owed again.
     *
     * The wrong implementation this catches parks it in `shipped` with `deliver`
     * as the only move, hiding a `pack` the server CERTAINLY allows —
     * `partially_refunded` is fulfillable and the line is outstanding — from a
     * customer who is waiting on goods no parcel holds.
     */
    const parcelLost = withOrder(withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]), {
      status: 'partially_refunded',
      fulfilledAt: NOW - 5 * DAY,
      refundedTotal: 100000,
      paidAt: NOW - 6 * DAY,
    });

    expect(columnOf(parcelLost)).toBe('packing');
    expect(movesFor(parcelLost, 'owner').map((m) => m.key)).toContain('pack');
    expect(planMove(parcelLost, 'pack', 'owner')?.steps[0]).toMatchObject({
      body: { lines: [{ qty: 1 }] },
    });
    // Real outstanding work, so this one DOES age.
    expect(ageBand(parcelLost, NOW)).toBe('overdue');
  });

  it('closes `refunded` and `cancelled`, and offers nothing on either', () => {
    const refunded = withOrder(PAID, { status: 'refunded', refundedTotal: PAID.order.grandTotal });
    const cancelled = withOrder(PAID, { status: 'cancelled', cancelledAt: NOW - DAY });

    expect(columnOf(refunded)).toBe('closed');
    expect(columnOf(cancelled)).toBe('closed');
    expect(movesFor(refunded, 'owner')).toEqual([]);
    expect(movesFor(cancelled, 'owner')).toEqual([]);
    expect(moneyStateOf(refunded)).toBe('refunded');
  });

  it('holds an unpaid order in `awaiting_payment` and refuses to pack it', () => {
    const pending = withOrder(PAID, { status: 'pending', paidAt: null });
    expect(columnOf(pending)).toBe('awaiting_payment');
    expect(movesFor(pending, 'owner').map((m) => m.key)).toEqual(['cancel']);
  });

  it('parks a status nobody has heard of in `needs_attention` with no moves', () => {
    /*
     * `closed` would hide a live order from the only screen that would have
     * caught it; `to_pack` would offer a shipment the server refuses. A visible
     * lane with no buttons is the only answer that lies about nothing.
     */
    const odd = withOrder(PAID, { status: 'on_hold' as ShopOrder['status'] });
    expect(columnOf(odd)).toBe('needs_attention');
    expect(movesFor(odd, 'owner')).toEqual([]);
    expect(planMove(odd, 'pack', 'owner')).toBeNull();
  });

  it('parks an order with no id in `needs_attention` too', () => {
    /*
     * A perfectly good `paid` status and nothing to address a request to. Every
     * route this board can reach is `/orders/:id/…`, so the card can carry state
     * and must not carry a button — the operator would click "cancel this
     * order", confirm the stock release, and nothing at all would happen.
     */
    const noId = withOrder(PAID, { id: undefined as unknown as string });
    expect(columnOf(noId)).toBe('needs_attention');
    expect(movesFor(noId, 'owner')).toEqual([]);
    expect(planMove(noId, 'cancel', 'owner')).toBeNull();
  });

  it('reaches every column on the board', () => {
    const reached = new Set<ColumnKey>(
      [
        withOrder(PAID, { status: 'pending' }),
        PAID,
        withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]),
        withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
          status: 'partially_refunded',
          fulfilledAt: null,
        }),
        withOrder(PAID, { status: 'fulfilled', fulfilledAt: NOW }),
        withOrder(PAID, { status: 'cancelled' }),
        withOrder(PAID, { status: 'nonsense' as ShopOrder['status'] }),
      ].map(columnOf),
    );
    expect([...reached].sort()).toEqual([...BOARD_COLUMNS].sort());
  });
});

// ------------------------------------------------------- the unreadable line

describe('a quantity this client will not read', () => {
  /*
   * ═══════════════════════════════════════════════════════════════════════════
   * REFUSING TO COERCE IS RIGHT. RETURNING ZERO WAS NOT.
   *
   * `'3'` is not a payload this server sends, and a client that reads it as `3`
   * is the client that stops noticing the day the column changes type. But
   * answering `0` made an unreadable line arithmetically identical to a line for
   * nothing: `ordered: 0`, `untouched: true`, and a card sitting in `to_pack`
   * describing an order that contains no goods, with a "Start packing" button on
   * it. Wrong AND invisible, which is the pair this board is written against.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const stringy = {
    order: { ...PAID.order },
    lines: [{ ...PAID.lines[0], qty: '3', fulfilledQty: '1' }],
  } as unknown as ShopOrderRow;

  it('counts the line it could not read instead of scoring it as nothing', () => {
    const coverage = coverageOf(stringy);
    expect(coverage.unreadable).toBe(1);
    // Neither claim can be made about an order with a line nobody can count, so
    // BOTH are false — the absence of two assertions, not a third state.
    expect(coverage.complete).toBe(false);
    expect(coverage.untouched).toBe(false);
    expect(coverage).toMatchObject({ ordered: 0, covered: 0, outstanding: 0 });
  });

  it('parks the row where it will be seen, not in `to_pack` looking empty', () => {
    expect(columnOf(stringy)).toBe('needs_attention');
    expect(columnOf(stringy)).not.toBe('to_pack');
    expect(movesFor(stringy, 'owner')).toEqual([]);
    expect(planMove(stringy, 'pack', 'owner')).toBeNull();
  });

  it('treats a MISSING `fulfilledQty` as unreadable, not as zero packed', () => {
    /*
     * The half that is easy to wave through. A `qty` with no `fulfilledQty`
     * cannot say how much is outstanding, and assuming zero puts the whole line
     * in the next parcel on top of whatever a parcel already holds — a 409 from
     * `shop_order_lines_fulfilled_ck` on an ordinary click.
     */
    const halfRead = {
      order: { ...PAID.order },
      lines: [{ ...PAID.lines[0], qty: 2, fulfilledQty: undefined }],
    } as unknown as ShopOrderRow;

    expect(coverageOf(halfRead).unreadable).toBe(1);
    expect(columnOf(halfRead)).toBe('needs_attention');
  });

  it('still counts the row and its money on the board header', () => {
    /*
     * THE REASON `needs_attention` CARRIES MONEY. What is unreadable is the line
     * quantity; `currency` and `grandTotal` are a separate read on the same row
     * and both succeeded. Suppressing the lane's money would show a shop whose
     * payload lost a field a board full of real orders and ₦0 — a worse lie than
     * the one that objection was worried about, and the total is the size of the
     * incident: it is what gets this looked at today rather than on Friday.
     */
    const board = summarise([stringy], NOW);
    const lane = board.columns.find((c) => c.column === 'needs_attention');
    expect(lane).toMatchObject({ count: 1 });
    expect(lane?.money).toEqual([{ currency: 'NGN', total: PAID.order.grandTotal }]);
    // And a lane with nothing to do in it is never reddened.
    expect(lane).toMatchObject({ ageing: 0, overdue: 0 });
  });

  it('leaves a `fulfilled` order alone — its one move names a parcel, not units', () => {
    /*
     * The quantities are read only where goods are still owed. `fulfilled` is
     * the server asserting nothing is unshipped, and `deliver` names a fulfilment
     * id; parking this in `needs_attention` would take a shipped order off the
     * board over an arithmetic nothing on it uses.
     */
    const shippedOddLine = {
      order: { ...PAID.order, status: 'fulfilled', fulfilledAt: NOW - DAY },
      lines: [{ ...PAID.lines[0], qty: '3', fulfilledQty: '3' }],
    } as unknown as ShopOrderRow;

    expect(columnOf(shippedOddLine)).toBe('shipped');
    expect(movesFor(shippedOddLine, 'owner').map((m) => m.key)).toEqual(['deliver']);
  });
});

// ------------------------------------------------------------------ the moves

describe('movesFor', () => {
  it('never offers a writer the owner-only cancel', () => {
    /*
     * `POST /shop/admin/orders/:id/cancel` is `requireOwner()` while every
     * fulfilment route is `requireAuth()`. A writer who is offered it gets a 403
     * behind a confirm dialog that already promised to release the stock.
     */
    const cancellable = [PAID, withOrder(PAID, { status: 'pending', paidAt: null })];

    for (const row of cancellable) {
      expect(movesFor(row, 'owner').map((m) => m.key)).toContain('cancel');
      expect(movesFor(row, 'writer').map((m) => m.key)).not.toContain('cancel');
      expect(planMove(row, 'cancel', 'writer')).toBeNull();
      expect(planMove(row, 'cancel', 'owner')).not.toBeNull();
    }
  });

  it('gives a writer every fulfilment move it gives an owner', () => {
    const packing = withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]);
    const owner = movesFor(packing, 'owner')
      .map((m) => m.key)
      .filter((k) => k !== 'cancel');
    expect(movesFor(packing, 'writer').map((m) => m.key)).toEqual(owner);
  });

  it('withholds cancel from a partly refunded order even for the owner', () => {
    /*
     * `CANCEL.holds` is `pending || paid`, so `partially_refunded` is refused
     * however unshipped it is. The board offers strictly less than the API
     * allows, never more.
     */
    const adjusted = withOrder(PAID, { status: 'partially_refunded', refundedTotal: 100000 });
    expect(columnOf(adjusted)).toBe('to_pack');
    expect(movesFor(adjusted, 'owner').map((m) => m.key)).toEqual(['pack']);
  });

  it('offers `deliver` on a multi-parcel order whose first box has gone', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE SELF-CLEARING MIRROR OF THE REFUND-THEN-SHIP BUG, AND THE ORDINARY
     * SHAPE OF A TWO-PARCEL ORDER.
     *
     * Two lines, one in stock. The operator packs and ships it on Monday; the
     * second line arrives on Thursday. Between those days the order is `paid`
     * with `fulfilledAt` still null — `settleOrderFulfilled` cannot flip a row
     * with lines nothing has shipped — and its ONE fulfilment is `shipped`.
     *
     * Two wrong implementations, both from reading a lane as a parcel status:
     *   1. `ship` offered alone, whose read hunts a `pending` fulfilment there
     *      is none of. It clears itself once the second parcel is packed, which
     *      is exactly why it survived: the operator packs, the button starts
     *      working, and nobody reports it.
     *   2. `deliver` withheld, though `DELIVER.holds` is `f.status === 'shipped'`
     *      with no condition on the order at all — the courier delivered box one
     *      and the server would have recorded it.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const halfShipped: ShopOrderRow = {
      order: { ...PAID.order, status: 'paid', fulfilledAt: null },
      lines: [
        { ...PAID.lines[0], id: 'oln_gone', qty: 1, fulfilledQty: 1 },
        { ...PAID.lines[0], id: 'oln_waiting', qty: 1, fulfilledQty: 0 },
      ],
    };

    expect(columnOf(halfShipped)).toBe('packing');
    expect(movesFor(halfShipped, 'owner').map((m) => m.key)).toEqual([
      'pack',
      'ship',
      'deliver',
      'cancel',
    ]);
    // All three fulfilment moves plan, and the pack names only what is left.
    expect(planMove(halfShipped, 'deliver', 'writer')?.steps[0]).toMatchObject({
      find: { fulfillmentStatus: 'shipped' },
    });
    expect(planMove(halfShipped, 'ship', 'writer')?.steps[0]).toMatchObject({
      find: { fulfillmentStatus: 'pending' },
    });
    expect(planMove(halfShipped, 'pack', 'writer')?.steps[0]).toMatchObject({
      body: { lines: [{ orderLineId: 'oln_waiting', qty: 1 }] },
    });
  });

  it('offers `deliver` beside `ship` on a fully boxed but unshipped order', () => {
    /*
     * The same rule at the other end of the same lane. Fully covered and still
     * `paid` proves at least one parcel is `pending` — `NOTHING_UNSHIPPED` would
     * have held otherwise — so `ship` is as close to certain as this payload
     * gets. It does NOT prove the others are: a three-parcel order can have two
     * away and one on the bench, and `deliver` is legal on either of the two.
     */
    const boxed = withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]);
    expect(columnOf(boxed)).toBe('packing');
    expect(movesFor(boxed, 'writer').map((m) => m.key)).toEqual(['ship', 'deliver']);
  });

  it('says which moves cost a second request, and which need confirming', () => {
    const byKey = (row: ShopOrderRow, key: string) =>
      movesFor(row, 'owner').find((m) => m.key === key);

    const packing = withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]);
    const shipped = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'fulfilled',
      fulfilledAt: NOW,
    });

    // The list carries no fulfilment ids, so BOTH parcel moves start with a GET.
    expect(byKey(packing, 'ship')?.cost).toBe('needs_detail');
    expect(byKey(shipped, 'deliver')?.cost).toBe('needs_detail');
    expect(byKey(packing, 'pack')?.cost).toBe('direct');

    const cancel = byKey(PAID, 'cancel');
    expect(cancel).toMatchObject({ confirm: true, destructive: true, ownerOnly: true });
    expect(byKey(PAID, 'pack')).toMatchObject({ confirm: false, destructive: false });
  });

  it('offers no shipment when there is nothing to put in it', () => {
    // `createFulfillment` answers 400 to an empty `lines` array; an operator
    // would read that as the order being broken.
    const noLines = { order: { ...PAID.order }, lines: [] } as unknown as ShopOrderRow;
    expect(columnOf(noLines)).toBe('to_pack');
    expect(movesFor(noLines, 'writer')).toEqual([]);
    expect(planMove(noLines, 'pack', 'owner')).toBeNull();
  });

  it('will not offer to pack goods it cannot name a line id for', () => {
    /*
     * Coverage and packability are different questions, and conflating them is a
     * button that does nothing. A line missing its `id` still represents goods
     * the customer has not received — `coverageOf` says so — but
     * `createFulfillment` names `orderLineId`, so no parcel can contain it.
     */
    const anonymous = {
      order: { ...PAID.order },
      lines: [{ ...PAID.lines[0], id: undefined, qty: 2, fulfilledQty: 0 }],
    } as unknown as ShopOrderRow;

    expect(coverageOf(anonymous).outstanding).toBe(2);
    expect(movesFor(anonymous, 'writer')).toEqual([]);
    expect(planMove(anonymous, 'pack', 'owner')).toBeNull();
  });

  it('counts only the packable units in the hint', () => {
    const mixed = {
      order: { ...PAID.order },
      lines: [
        { ...PAID.lines[0], id: 'oln_real', qty: 2, fulfilledQty: 0 },
        { ...PAID.lines[0], id: '', qty: 5, fulfilledQty: 0 },
      ],
    } as unknown as ShopOrderRow;

    expect(coverageOf(mixed).outstanding).toBe(7);
    expect(movesFor(mixed, 'writer').find((m) => m.key === 'pack')?.hint).toContain('2 items');
    expect(planMove(mixed, 'pack', 'writer')?.steps[0]).toMatchObject({
      body: { lines: [{ orderLineId: 'oln_real', qty: 2 }] },
    });
  });

  it('labels the second parcel as the rest of the work, not a fresh start', () => {
    const fresh = movesFor(PAID, 'owner').find((m) => m.key === 'pack');
    const rest = movesFor(withLines(PAID, [{ qty: 3, fulfilledQty: 1 }]), 'owner').find(
      (m) => m.key === 'pack',
    );
    expect(fresh?.label).toBe('Start packing');
    expect(rest?.label).toBe('Pack what is left');
    expect(rest?.hint).toContain('2 items');
  });
});

// ------------------------------------------------------------------- the plan

describe('planMove', () => {
  it('packs only what is OUTSTANDING, never the whole line again', () => {
    /*
     * The wrong implementation this catches: `qty: line.qty`. On a line of 3
     * with 1 already covered it asks for 3 more, and
     * `shop_order_lines_fulfilled_ck` refuses the lot — a 409 on the ordinary
     * "ship what is left" click.
     */
    const partly = withLines(PAID, [
      { qty: 3, fulfilledQty: 1 },
      { qty: 2, fulfilledQty: 2 },
    ]);

    const plan = planMove(partly, 'pack', 'writer');
    expect(plan?.needsDetail).toBe(false);
    expect(plan?.steps).toHaveLength(1);

    const step = plan?.steps[0];
    expect(step).toMatchObject({ kind: 'write', call: 'createFulfillment', method: 'POST' });
    expect(step && 'body' in step ? step.body : null).toEqual({
      lines: [{ orderLineId: `${PAID.lines[0].id}-0`, qty: 2 }],
    });
    expect(step && 'path' in step ? step.path : '').toBe(
      `/shop/admin/orders/${PAID.order.id}/fulfillments`,
    );
  });

  it('models `deliver` as a read that finds the parcel, then a PATCH on IT', () => {
    /*
     * The two-step shape is the point. The fulfilment id is not on the list
     * payload at any price, so a plan that patched `/orders/:id` — or that
     * pretended one round trip would do — would be describing work that cannot
     * happen.
     */
    const shipped = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'fulfilled',
      fulfilledAt: NOW,
    });

    const plan = planMove(shipped, 'deliver', 'writer');
    expect(plan?.needsDetail).toBe(true);
    expect(plan?.steps).toHaveLength(2);

    expect(plan?.steps[0]).toEqual({
      kind: 'read',
      call: 'getOrder',
      method: 'GET',
      path: `/shop/admin/orders/${PAID.order.id}`,
      orderId: PAID.order.id,
      find: { fulfillmentStatus: 'shipped' },
      whenMissing:
        'No parcel on this order has been shipped yet, so there is nothing to mark delivered. Nothing was changed.',
      binds: 'fulfillmentId',
    });
    expect(plan?.steps[1]).toEqual({
      kind: 'write',
      call: 'setFulfillmentStatus',
      method: 'PATCH',
      path: '/shop/admin/fulfillments/{fulfillmentId}',
      fulfillmentId: { from: 'step', index: 0 },
      body: { status: 'delivered' },
    });
  });

  it('looks for a PENDING parcel when shipping and a SHIPPED one when delivering', () => {
    const packing = withLines(PAID, [{ qty: 2, fulfilledQty: 1 }]);
    const shipped = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      status: 'fulfilled',
      fulfilledAt: NOW,
    });

    const ship = planMove(packing, 'ship', 'writer');
    const deliver = planMove(shipped, 'deliver', 'writer');
    const find = (plan: ReturnType<typeof planMove>) => {
      const step = plan?.steps[0];
      return step && step.kind === 'read' ? step.find.fulfillmentStatus : null;
    };

    expect(find(ship)).toBe('pending');
    expect(find(deliver)).toBe('shipped');
    expect(ship?.steps[1]).toMatchObject({ body: { status: 'shipped' } });
  });

  it('is serialisable — the UI can put a plan in state and read it back', () => {
    const plan = planMove(
      withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
        status: 'fulfilled',
        fulfilledAt: NOW,
      }),
      'deliver',
      'owner',
    );
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it('refuses a move the row has already moved past', () => {
    // A stale board: the operator packed this in another tab.
    expect(planMove(PAID, 'ship', 'owner')).toBeNull();
    expect(planMove(PAID, 'deliver', 'owner')).toBeNull();
    expect(planMove(withOrder(PAID, { status: 'cancelled' }), 'cancel', 'owner')).toBeNull();
  });
});

// --------------------------------------------------------------- the age band

describe('ageBand', () => {
  const paidDaysAgo = (days: number) =>
    withOrder(PAID, { paidAt: NOW - days * DAY, placedAt: NOW - days * DAY - 1000 });

  it('is fresh for the first day, ageing from one, overdue from three', () => {
    expect(ageBand(paidDaysAgo(0), NOW)).toBe('fresh');
    expect(ageBand(withOrder(PAID, { paidAt: NOW - DAY + 1000 }), NOW)).toBe('fresh');
    expect(ageBand(paidDaysAgo(1), NOW)).toBe('ageing');
    expect(ageBand(paidDaysAgo(2), NOW)).toBe('ageing');
    expect(ageBand(paidDaysAgo(3), NOW)).toBe('overdue');
    expect(ageBand(paidDaysAgo(30), NOW)).toBe('overdue');
  });

  it('ages a packed-but-unshipped order too — the parcel is on the bench', () => {
    const boxed = withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
      paidAt: NOW - 4 * DAY,
    });
    expect(columnOf(boxed)).toBe('packing');
    expect(ageBand(boxed, NOW)).toBe('overdue');
  });

  it('never marks an order that is not waiting on the operator', () => {
    /*
     * The whole point of the band. A delivered order, a cancelled one and an
     * order the customer has not paid for are not the shop being slow, and a red
     * mark on any of them teaches the operator to ignore the colour.
     */
    const old = { paidAt: NOW - 90 * DAY, placedAt: NOW - 90 * DAY };
    const cases: ShopOrderRow[] = [
      withOrder(PAID, { ...old, status: 'pending', paidAt: null }),
      withOrder(withLines(PAID, [{ qty: 1, fulfilledQty: 1 }]), {
        ...old,
        status: 'fulfilled',
        fulfilledAt: NOW - 89 * DAY,
      }),
      withOrder(PAID, { ...old, status: 'cancelled' }),
      withOrder(PAID, { ...old, status: 'refunded' }),
      withOrder(PAID, { ...old, status: 'weird' as ShopOrder['status'] }),
    ];
    for (const row of cases) expect(ageBand(row, NOW)).toBe('fresh');
  });

  it('falls back to `placedAt`, and treats an unreadable date as fresh', () => {
    const noPaidAt = withOrder(PAID, { paidAt: null, placedAt: NOW - 5 * DAY });
    expect(ageBand(noPaidAt, NOW)).toBe('overdue');

    const broken = withOrder(PAID, {
      paidAt: undefined as unknown as number,
      placedAt: undefined as unknown as number,
    });
    expect(ageBand(broken, NOW)).toBe('fresh');
    expect(ageBand(withOrder(PAID, { paidAt: NaN, placedAt: NaN }), NOW)).toBe('fresh');
  });

  it('does not read a clock-skewed future payment as age', () => {
    expect(ageBand(withOrder(PAID, { paidAt: NOW + 5 * DAY }), NOW)).toBe('fresh');
  });
});

// ---------------------------------------------------------------- the summary

describe('summarise', () => {
  it('counts the live board and totals the FROZEN grand totals', () => {
    /*
     * THE ASSERTION THAT CATCHES A RECOMPUTATION. In the capture, order
     * `2026-000006-S` has `subtotal 2300000 + shippingTotal 300000` but a frozen
     * `grandTotal` of `2500000` — ₦1,000 of it was discounted. So:
     *
     *   sum(grandTotal)          = 12 900 000  ← the receipts
     *   sum(subtotal + shipping) = 13 000 000  ← re-quoting the order
     *   sum(lineTotal)           = 11 500 000  ← re-adding the items
     *
     * Only the first is the money the customers were charged. Frozen totals are
     * copied, never recomputed (CLAUDE.md §6).
     */
    const board = summarise(LIVE_ROWS, NOW);

    expect(board.generatedAt).toBe(NOW);
    expect(board.total).toBe(5);
    expect(board.columns.map((c) => c.column)).toEqual([...BOARD_COLUMNS]);

    const toPack = board.columns.find((c) => c.column === 'to_pack');
    expect(toPack).toMatchObject({ count: 5, label: 'To pack' });
    expect(toPack?.money).toEqual([{ currency: 'NGN', total: 12_900_000 }]);

    const lineSum = LIVE_ROWS.reduce(
      (n, r) => n + r.lines.reduce((m, l) => m + l.lineTotal, 0),
      0,
    );
    expect(toPack?.money[0].total).not.toBe(lineSum);
  });

  it('reports empty columns rather than making the board reconstruct them', () => {
    const board = summarise(LIVE_ROWS, NOW);
    const shipped = board.columns.find((c) => c.column === 'shipped');
    // A zero row here invents nothing: no currency, no amount.
    expect(shipped).toMatchObject({ count: 0, money: [], ageing: 0, overdue: 0 });
  });

  it('NEVER sums across currencies', () => {
    /*
     * `server/shop/admin/stats.ts` refuses the same thing: two ISO-4217 codes
     * cannot be added, and a number that looks like a total but reconciles
     * against nothing is worse than two numbers.
     */
    const usd = withOrder(PAID, { id: 'ord_usd', currency: 'USD', grandTotal: 1000 });
    const board = summarise([...LIVE_ROWS, usd], NOW);
    const toPack = board.columns.find((c) => c.column === 'to_pack');

    expect(toPack?.count).toBe(6);
    expect(toPack?.money).toEqual([
      { currency: 'NGN', total: 12_900_000 },
      { currency: 'USD', total: 1000 },
    ]);
    expect(toPack?.money.some((m) => m.total === 12_901_000)).toBe(false);
  });

  it('counts a row whose money cannot be read, and adds nothing for it', () => {
    const noCurrency = withOrder(PAID, {
      id: 'ord_broken',
      currency: undefined as unknown as string,
      grandTotal: undefined as unknown as number,
    });
    const toPack = summarise([...LIVE_ROWS, noCurrency], NOW).columns.find(
      (c) => c.column === 'to_pack',
    );

    // The card is on the board, so the count says so; the total stays a number.
    expect(toPack?.count).toBe(6);
    expect(toPack?.money).toEqual([{ currency: 'NGN', total: 12_900_000 }]);
    expect(Number.isFinite(toPack?.money[0].total)).toBe(true);
  });

  it('counts the neglect it found, per column', () => {
    const rows = [
      withOrder(PAID, { id: 'a', paidAt: NOW - 4 * DAY }),
      withOrder(PAID, { id: 'b', paidAt: NOW - 2 * DAY }),
      withOrder(PAID, { id: 'c', paidAt: NOW - 1000 }),
    ];
    const toPack = summarise(rows, NOW).columns.find((c) => c.column === 'to_pack');
    expect(toPack).toMatchObject({ count: 3, ageing: 1, overdue: 1 });
  });

  it('survives an empty board', () => {
    const board = summarise([], NOW);
    expect(board.total).toBe(0);
    expect(board.columns).toHaveLength(BOARD_COLUMNS.length);
    expect(board.columns.every((c) => c.count === 0 && c.money.length === 0)).toBe(true);
  });
});

// -------------------------------------------------------------- the bad rows

describe('a malformed row', () => {
  /*
   * THE FAILURE THIS SUITE EXISTS TO PREVENT A SECOND TIME. `/shop/orders` was
   * unreachable in production because ONE `undefined` reached a formatter that
   * throws. On a board the blast radius is worse than a table's: every function
   * here runs inside a `.map()` over the whole page, so one bad row would take
   * the other eleven and the header with it.
   */
  const BAD: unknown[] = [
    null,
    undefined,
    {},
    { order: null, lines: null },
    { order: {}, lines: [] },
    { order: { status: 'paid' } },
    { order: { status: 'paid', id: 'ord_x' }, lines: 'not an array' },
    { order: { status: 'paid', id: 'ord_x' }, lines: [null, undefined, 42, 'x'] },
    { order: { status: 'paid', id: 'ord_x' }, lines: [{ qty: null, fulfilledQty: 'two' }] },
    { order: { status: 'paid', id: 'ord_x' }, lines: [{ qty: NaN, fulfilledQty: Infinity }] },
    { order: { status: 'paid', id: 'ord_x' }, lines: [{ qty: -3, fulfilledQty: -9 }] },
    { order: { status: 42, placedAt: 'yesterday' }, lines: [] },
    { order: { status: 'paid', id: 'ord_x', placedAt: undefined }, lines: [{ qty: 1 }] },
    [],
    'an order, honestly',
  ];

  it('gets a column and no throw, every time', () => {
    for (const bad of BAD) {
      const row = bad as ShopOrderRow;
      expect(() => columnOf(row)).not.toThrow();
      expect(BOARD_COLUMNS).toContain(columnOf(row));
      expect(() => movesFor(row, 'owner')).not.toThrow();
      expect(() => movesFor(row, 'writer')).not.toThrow();
      expect(() => ageBand(row, NOW)).not.toThrow();
      expect(() => coverageOf(row)).not.toThrow();
      expect(() => moneyStateOf(row)).not.toThrow();
      for (const move of ['pack', 'ship', 'deliver', 'cancel'] as const) {
        expect(() => planMove(row, move, 'owner')).not.toThrow();
      }
    }
  });

  it('never offers a move it cannot plan', () => {
    for (const bad of BAD) {
      const row = bad as ShopOrderRow;
      for (const role of ['owner', 'writer'] as const) {
        for (const move of movesFor(row, role)) {
          expect(planMove(row, move.key, role)).not.toBeNull();
        }
      }
    }
  });

  it('never produces a negative or non-finite coverage', () => {
    for (const bad of BAD) {
      const coverage = coverageOf(bad as ShopOrderRow);
      for (const n of [coverage.ordered, coverage.covered, coverage.outstanding]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('summarises a page that is half rubbish without losing the good rows', () => {
    const board = summarise([...LIVE_ROWS, ...(BAD as ShopOrderRow[])], NOW);

    expect(board.total).toBe(LIVE_ROWS.length + BAD.length);
    expect(board.columns.find((c) => c.column === 'to_pack')?.money).toEqual([
      { currency: 'NGN', total: 12_900_000 },
    ]);
    for (const column of board.columns) {
      for (const money of column.money) expect(Number.isFinite(money.total)).toBe(true);
    }
  });

  it('does not throw on a nonsense `now`', () => {
    for (const now of [NaN, Infinity, -Infinity, undefined as unknown as number]) {
      expect(() => ageBand(PAID, now)).not.toThrow();
      expect(ageBand(PAID, now)).toBe('fresh');
      expect(() => summarise(LIVE_ROWS, now)).not.toThrow();
    }
  });
});
