import { Fragment, useMemo } from 'react';
import { safeFormatMinor, type ShopOrderRow } from '../../data/api-shop';
import { BoardCard } from './BoardCard';
import {
  columnOf,
  terminalLaneOf,
  TERMINAL_LABEL,
  TERMINAL_LANES,
  type Role,
  type TerminalLane,
} from './pipeline';
import './board.css';

/**
 * THE ORDERS THAT ARE OVER — delivered, cancelled, refunded.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE COMPONENT AND NOT A SIXTH LANE.
 *
 * `Closed` used to sit on the working board, and it was the lane that grew
 * without bound: every order the shop had ever completed, parked at the right
 * of a rail that shows four or five lanes at a time, pushing the lanes with
 * live work in them past the edge. A board whose job is "what is waiting on
 * you" cannot spend a column on the answer "nothing, ever again".
 *
 * AND "CLOSED" WAS THE ONE WORD ON IT THAT SAID NOTHING. Every card here is
 * closed; what a person opening this tab wants is WHICH ending, because the
 * three mean opposite things about the money and about the customer. So the one
 * lane becomes three, split by `terminalLaneOf`.
 *
 * NO DRAG, NO MOVES, NO OPTIMISTIC PATCH — and that is why this is 90 lines
 * rather than 1,500. Every card here is terminal: `movesFor` returns nothing,
 * the server refuses every transition, and there is no drop that could mean
 * anything. `BoardScreen`'s entire machinery exists to make a move safe, and
 * there are no moves. Reusing it would have meant carrying a `DndContext`, three
 * sensors and a dialog stack to render a read-only list.
 *
 * THE CARD IS THE SAME `BoardCard` the working board draws, with no `onMove` and
 * no `onToggleSeen`. It reads identically because it IS identical — an operator
 * should not have to learn a second card to look at a finished order.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const NOTHING_HERE: Record<TerminalLane, string> = {
  delivered: 'Nothing has arrived yet on this page.',
  cancelled: 'No order on this page was cancelled. That is the good outcome.',
  refunded: 'No order on this page was refunded in full.',
};

export interface ClosedBoardProps {
  /** Every order on this page. The terminal ones are picked out here. */
  rows: readonly ShopOrderRow[];
  /** Epoch ms, passed in rather than read from a clock — the board's own rule. */
  now: number;
  /** Required by `BoardCard`; gates nothing here, since nothing is actionable. */
  role: Role;
}

/** The terminal rows only, grouped by ending, newest first within each. */
export function closedLanesOf(
  rows: readonly ShopOrderRow[],
): { lane: TerminalLane; cards: ShopOrderRow[] }[] {
  const out = new Map<TerminalLane, ShopOrderRow[]>();
  for (const lane of TERMINAL_LANES) out.set(lane, []);
  for (const row of Array.isArray(rows) ? rows : []) {
    /* `columnOf` FIRST, ALWAYS. `terminalLaneOf` answers for any row it is
     * handed — it would call a live `paid` order "refunded" — so the question
     * "is this over" has to be asked before "how did it end". */
    if (columnOf(row) !== 'closed') continue;
    out.get(terminalLaneOf(row))?.push(row);
  }
  return TERMINAL_LANES.map((lane) => ({ lane, cards: out.get(lane) ?? [] }));
}

export function ClosedBoard({ rows, now, role }: ClosedBoardProps) {
  const lanes = useMemo(() => closedLanesOf(rows), [rows]);
  const total = lanes.reduce((n, lane) => n + lane.cards.length, 0);

  if (total === 0) {
    return (
      <p className="notice">
        Nothing on this page has finished yet — no order here has been delivered,
        cancelled or refunded.
      </p>
    );
  }

  return (
    <div className="shopboard">
      <div className="shopboard__rail">
        <div className="shopboard__canvas shopboard__canvas--money">
          {lanes.map(({ lane, cards }) => {
            /* Summed HERE rather than from `summarise`, which counts by
             * `ColumnKey` and therefore has one figure for all three endings.
             * Grouped by currency for the same reason `summarise` does it: two
             * ISO codes cannot be added. */
            const money = new Map<string, number>();
            for (const row of cards) {
              const currency = row.order?.currency;
              const amount = row.order?.grandTotal;
              if (typeof currency !== 'string' || typeof amount !== 'number') continue;
              money.set(currency, (money.get(currency) ?? 0) + amount);
            }

            return (
              <section className="shoplist" data-lane={lane} key={lane}>
                <header className="shoplist__head">
                  <div className="shoplist__title">
                    <h3 className="shoplist__name">{TERMINAL_LABEL[lane]}</h3>
                    <span className="shoplist__count">{cards.length}</span>
                  </div>
                  {money.size > 0 && (
                    <p className="shoplist__money">
                      {[...money.entries()].map(([currency, amount]) => (
                        <span key={currency}>{safeFormatMinor(amount, currency)}</span>
                      ))}
                    </p>
                  )}
                </header>

                {/* `role="list"` alongside the `<ul>` — `board.css` removes the
                    markers, and Safari drops list semantics when it sees
                    `list-style: none`. */}
                <ul className="shoplist__cards" role="list">
                  {cards.map((row, position) => {
                    const id = row?.order?.id;
                    /* Stable ACROSS RENDERS — a row with no id still draws, and a
                     * random key would remount it on every render. */
                    const cardId =
                      typeof id === 'string' && id !== '' ? id : `${lane}#${position}`;
                    return (
                      <Fragment key={cardId}>
                        {/* `expanded={false}` and no `onMove`: a terminal order
                            has no moves, so the disclosure would open an empty
                            list. `role` is still required by the card and is
                            passed through — it changes nothing here, because
                            every move it gates is already unavailable. */}
                        <BoardCard
                          row={row}
                          now={now}
                          role={role}
                          lane="closed"
                          expanded={false}
                        />
                      </Fragment>
                    );
                  })}
                  {cards.length === 0 && (
                    <li className="shoplist__empty">{NOTHING_HERE[lane]}</li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
