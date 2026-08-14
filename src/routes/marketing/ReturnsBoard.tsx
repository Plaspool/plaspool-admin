import { Fragment } from 'react';
import { Plus } from 'lucide-react';
import { fmtUnits, labelsOf, type ReturnListItem, type ReturnStatus } from '../../data/api-marketing';
import { ReturnCard } from './ReturnCard';
import type { StageAction } from './StageForm';

/**
 * One district's board — four lists on a canvas, and the rule that a gesture
 * cannot award points.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DROP IS THE INTENT; THE FORM IS THE ACT.
 *
 * Releasing a card on Scheduled does not move it. It opens the pickup form with
 * the card held where it was, and the move commits when the form does. Abandon
 * the form and the card is already home.
 *
 * This is not caution for its own sake. Two of these transitions CANNOT be
 * completed by a gesture: scheduling needs a date and a driver, and inspecting
 * needs counted quantities. A board that let a drop finish either would be
 * inventing the missing half — and in the inspect case it would be awarding
 * points nobody counted. A board where a gesture alone can award points is a
 * board that will award points by accident.
 *
 * THE LISTS ARE FIXED WIDTH. The whole value of a board is that things stay
 * where you put them; a column that grew as cards arrived would move every other
 * column under the pointer mid-drag.
 *
 * NO COLOURED DOTS BESIDE THE COLUMN NAMES. Urgency belongs on the card, because
 * every card in a column has a different age — the column heading has nothing
 * truthful to say with a colour.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The four open stages, in pipeline order. Terminal states are not columns: a
 * board is a dispatch surface, and an awarded return is history.
 *
 * `as const` RATHER THAN `readonly ReturnStatus[]`, so `BoardColumn` is the four
 * and not all seven. With the wider annotation the two tables below would have
 * to carry rows for `awarded`, `rejected` and `cancelled` — entries whose only
 * possible value is "not a column", written three times, in two places.
 */
export const BOARD_COLUMNS = ['requested', 'scheduled', 'collected', 'received'] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Is this stage a column at all? Terminal returns are on nobody's board. */
export const isBoardColumn = (status: ReturnStatus): status is BoardColumn =>
  (BOARD_COLUMNS as readonly ReturnStatus[]).includes(status);

/** The heading over each list. `collected` reads "Picked up" — a display label,
 *  never the wire value. */
export const COLUMN_HEADING: Record<BoardColumn, string> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  collected: 'Picked up',
  received: 'Received',
};

/**
 * WHICH TRANSITION MOVES A CARD INTO A COLUMN.
 *
 * The board speaks in COLUMNS and the state machine speaks in ACTIONS, and this
 * is the only place the two are mapped. `received → inspect` is the interesting
 * row: dropping a card on Received means "this arrived", which is the `receive`
 * transition — the INSPECTION is a separate act on a card that is already there,
 * because counting is a form and not a destination.
 */
const ENTRY_ACTION: Record<BoardColumn, StageAction | null> = {
  /* Nothing moves INTO Requested. A return is born there and only ever leaves;
   * there is no un-schedule, because a reschedule is a schedule. */
  requested: null,
  scheduled: 'schedule',
  collected: 'collect',
  received: 'receive',
};

export type DropOutcome =
  | { kind: 'form'; action: StageAction }
  /** The card was released where it already lives. Not an error and not worth a
   *  message — the operator changed their mind mid-drag, which is what dragging
   *  a card back is for. */
  | { kind: 'noop' }
  /** The server does not allow it. `reason` is shown on the card as it springs
   *  back, because a card that refuses a drop silently reads as a broken board. */
  | { kind: 'refused'; reason: string };

/**
 * THE WHOLE DECISION A DROP MAKES, as a pure function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TESTED HERE RATHER THAN THROUGH THE GESTURE, deliberately. Driving synthetic
 * pointer events through a drag library in jsdom tests the library; this tests
 * the RULE — which is the part that decides whether a board can award points by
 * accident.
 *
 * IT ASKS `allowedActions`, WHICH IS THE SERVER'S ANSWER. A board with its own
 * status→action table would drift from the state machine the first time a branch
 * was added, and would drift silently: the card would move, the request would be
 * refused, and the only symptom would be a card springing back with a 409 nobody
 * could explain from the screen.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function resolveDrop(card: ReturnListItem, target: BoardColumn): DropOutcome {
  if (card.status === target) return { kind: 'noop' };

  const action = ENTRY_ACTION[target];
  if (action === null) {
    return { kind: 'refused', reason: `Nothing moves back into ${COLUMN_HEADING.requested}.` };
  }

  /*
   * THE SERVER'S ANSWER, NOT A TABLE OF OUR OWN. `allowedActions` is ordered and
   * served on every row precisely so a screen never has to guess; a board that
   * kept its own status→action map would drift the first time the state machine
   * gained a branch, and would drift SILENTLY — the card would move, the request
   * would 409, and nothing on screen could explain why.
   */
  if (!card.allowedActions.includes(action)) {
    const from = isBoardColumn(card.status) ? COLUMN_HEADING[card.status] : card.status;
    return {
      kind: 'refused',
      reason: `A return in ${from} cannot go straight to ${COLUMN_HEADING[target]}.`,
    };
  }

  return { kind: 'form', action };
}

/** Which columns a card in hand may legally enter — everything else is dimmed
 *  while it is held, so an illegal target is visible before the release rather
 *  than explained after it. */
export function legalTargets(card: ReturnListItem): BoardColumn[] {
  return BOARD_COLUMNS.filter((column) => resolveDrop(card, column).kind === 'form');
}

export function ReturnsBoard({
  rows,
  now,
  areaName,
  selection,
  onOpen,
  onToggle,
  onLog,
  columnRef,
  columnState,
  renderCard,
}: {
  /** Every open return on THIS board, in one list. The columns are drawn from
   *  it rather than fetched separately: one page, four groupings. */
  rows: ReturnListItem[];
  now: number;
  areaName: string | null;
  selection?: ReadonlySet<string>;
  onOpen: (row: ReturnListItem) => void;
  onToggle?: (row: ReturnListItem) => void;
  onLog: () => void;
  /** Lets the drag layer register each column as a drop target without this
   *  component knowing anything about the library doing it. */
  columnRef?: (status: BoardColumn) => ((node: HTMLElement | null) => void) | undefined;
  /**
   * How a column should be drawn WHILE A CARD IS IN HAND: `'legal'` for one the
   * card may enter, `'illegal'` for one it may not, `'over'` for the one under
   * the pointer, `null` when nothing is being dragged.
   *
   * A STATE RATHER THAN A BOOLEAN, because "dimmed" and "outlined" are two
   * different messages and a card must be able to see both at once across four
   * columns. Passed in rather than computed here: this component does not know
   * which card is in hand, and should not.
   */
  columnState?: (status: BoardColumn) => 'legal' | 'illegal' | 'over' | null;
  /**
   * Wrap each card — the seam the drag layer attaches through.
   *
   * A RENDER PROP RATHER THAN dnd-kit IMPORTS IN HERE. This component's job is
   * the arrangement (four fixed lists, headings, the create control under
   * Requested) and it stays testable without a drag library or a DOM. The screen
   * that owns the `DndContext` supplies the draggable wrapper.
   */
  renderCard?: (row: ReturnListItem) => React.ReactNode;
}) {
  /* A board holds the OPEN stages only — an awarded or cancelled return is
   * history, and a column for it would be an archive pretending to be a
   * dispatch list. The type guard is what narrows `row.status` to a column. */
  const open = rows.filter((row) => isBoardColumn(row.status));
  const load = open.reduce((sum, row) => sum + row.qtyDeclared, 0);
  const oldest = open.reduce((max, row) => Math.max(max, now - row.createdAt), 0);
  const labels = open.length > 0 ? labelsOf(open[0].program) : null;

  return (
    <section className="mktboard" aria-label={areaName === null ? 'Board' : `${areaName} board`}>
      <header className="mktboard__head">
        <h2 className="mktboard__title">{areaName ?? 'Outside the served areas'}</h2>
        <p className="mktboard__stats">
          {/* The three numbers that decide whether one van is enough today. */}
          <span>
            Open <b>{open.length}</b>
          </span>
          {labels !== null && (
            <span>
              Load <b>{fmtUnits(load, labels)}</b>
            </span>
          )}
          {oldest > 0 && (
            <span>
              Oldest <b>{Math.floor(oldest / 86_400_000)}d</b>
            </span>
          )}
        </p>
      </header>

      <div className="mktboard__canvas">
        {BOARD_COLUMNS.map((status) => {
          const cards = open.filter((row) => row.status === status);
          const picked = cards.filter((row) => selection?.has(row.id) === true).length;
          const state = columnState?.(status) ?? null;
          return (
            <div
              className={`mktlist${state === null ? '' : ` mktlist--${state}`}`}
              key={status}
              ref={columnRef?.(status)}
              data-column={status}
            >
              <header className="mktlist__head">
                {/* NO COLOURED DOT HERE. See the file header. */}
                <h3 className="mktlist__name">{COLUMN_HEADING[status]}</h3>
                <span className="mktlist__count">
                  {cards.length}
                  {picked > 0 && <span className="mktlist__picked"> · {picked} picked</span>}
                </span>
              </header>

              <div className="mktlist__cards">
                {cards.map((row) =>
                  renderCard !== undefined ? (
                    <Fragment key={row.id}>{renderCard(row)}</Fragment>
                  ) : (
                    <ReturnCard
                      key={row.id}
                      row={row}
                      now={now}
                      selected={selection === undefined ? undefined : selection.has(row.id)}
                      onOpen={onOpen}
                      onToggle={onToggle}
                    />
                  ),
                )}

                {cards.length === 0 && (
                  <p className="mktlist__empty">
                    {/* Said in the district's own words, so an empty Received
                        list on one board does not read as an empty warehouse. */}
                    {status === 'received'
                      ? `Nothing from ${areaName ?? 'here'} is on the bench`
                      : 'Nothing here'}
                  </p>
                )}
              </div>

              {/*
                "Log a return" APPEARS UNDER REQUESTED ONLY, because that is the
                one list a return can be BORN into. The others are reached by
                moving, and a create button under them would be offering to
                fabricate a history that never happened.
              */}
              {status === 'requested' && (
                <button type="button" className="mktlist__add" onClick={onLog}>
                  <Plus className="mktlist__plus" aria-hidden="true" />
                  Log a return
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
