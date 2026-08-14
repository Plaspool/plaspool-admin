import { Link } from 'react-router-dom';
import { Flag } from 'lucide-react';
import { fmtUnits, labelsOf, type ReturnListItem } from '../../data/api-marketing';
import { DANGER_MS, WARN_MS, ageModifier, ago, primaryOf } from './queue-shared';
import { ACTION_VERB } from './StageForm';

/**
 * What needs a person — above the boards, and across all of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "NEEDS ACTION" IS A TABLE AND NOT A COLUMN, AND THAT IS THE STRUCTURAL
 * DECISION THE WHOLE SCREEN FOLLOWS FROM.
 *
 * A column is a place a card IS, and a card can only be in one place — so
 * needs-action cannot be a column without lying about where the work sits. It is
 * a JUDGEMENT about a card, which makes it a table. A return legitimately
 * appears here and on its board at the same time, and the two are answering
 * different questions: the desk answers "what do I do next?", the board answers
 * "where is everything?".
 *
 * IT IS WHOLE-OF-CITY WHILE THE BOARD IS ONE DISTRICT, deliberately. "What needs
 * me" is a question about the day rather than about a district, and an operator
 * must not have to visit six boards to discover that two of them are on fire.
 * The Area column is how a row says which board it lives on.
 *
 * IT SAYS *WHY* EACH ROW IS HERE, not just what stage it is at. "No pickup
 * booked" and "Arrived — not counted" are the two things a person can actually
 * do something about; "requested" and "received" are the database's words for
 * the same two facts and are worse at prompting an action.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Why this row is on the desk.
 *
 * DERIVED FROM THE STATUS, which is the only honest source: the server decides
 * `needsAction` as `requested + received`, and these are those two stages said
 * in words a person can act on. Anything else reaching here is a row the desk
 * should not have been given, and it says so rather than inventing a reason.
 */
export function whyItIsHere(row: ReturnListItem): string {
  if (row.status === 'requested') return 'No pickup booked';
  if (row.status === 'received') return 'Arrived — not counted';
  return 'Waiting on you';
}

/** The desk's own rows, out of whatever page the queue is holding. The server
 *  already answers this shape for `view=needs_action`; this keeps the desk
 *  honest when it is handed a wider page. */
export function deskRows(rows: readonly ReturnListItem[]): ReturnListItem[] {
  return rows.filter((row) => row.status === 'requested' || row.status === 'received');
}

/** How many of them are past the danger band — the "Overdue" figure. */
export function overdueCount(rows: readonly ReturnListItem[], now: number): number {
  return rows.filter((row) => now - row.createdAt >= DANGER_MS).length;
}

export function ReturnsDesk({
  rows,
  now,
  onAct,
}: {
  /** Whole-of-city needs-action rows, oldest first. */
  rows: ReturnListItem[];
  now: number;
  /** Open the form for a row's next legal step. The desk never performs a
   *  transition itself — same rule as a drop on the board: the gesture is the
   *  intent and the form is the act. */
  onAct: (row: ReturnListItem) => void;
}) {
  const needsPickup = rows.filter((row) => row.status === 'requested').length;
  const needsCounting = rows.filter((row) => row.status === 'received').length;
  const overdue = overdueCount(rows, now);

  if (rows.length === 0) {
    return (
      <section className="mktdesk mktdesk--clear" aria-label="Waiting on you">
        <p className="mktdesk__clear">
          Nothing is waiting on you. Everything open is moving without you.
        </p>
      </section>
    );
  }

  return (
    <section className="mktdesk" aria-label="Waiting on you">
      <header className="mktdesk__head">
        <h2 className="mktdesk__title">
          <Flag className="mktdesk__flag" aria-hidden="true" />
          Waiting on you <span className="mktdesk__total">{rows.length}</span>
        </h2>
        <p className="mktdesk__tally">
          {/*
            THE THREE NUMBERS AN OPERATOR PLANS A MORNING WITH. Two are the
            stages the admin is the blocker on; the third is how many of them
            have been waiting long enough to be embarrassing.
          */}
          <span>
            Needs a pickup <b>{needsPickup}</b>
          </span>
          <span>
            Needs inspecting <b>{needsCounting}</b>
          </span>
          {overdue > 0 && (
            <span className="mktdesk__overdue">
              Overdue <b>{overdue}</b>
            </span>
          )}
        </p>
      </header>

      {/* Tabular by nature, so it scrolls inside its own box rather than making
          the page scroll sideways — the `.dtable__scroll` doctrine. */}
      <div className="mktdesk__scroll">
        <table className="mktdesk__table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Load</th>
              <th scope="col">Area</th>
              <th scope="col">Waiting</th>
              <th scope="col">Why it is here</th>
              <th scope="col">
                <span className="mktdesk__sr">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const waited = Math.max(0, now - row.createdAt);
              const labels = labelsOf(row.program);
              const action = primaryOf(row);
              return (
                <tr key={row.id}>
                  <th scope="row" className="mktdesk__who">
                    <Link className="mktdesk__name" to={`?id=${encodeURIComponent(row.id)}`}>
                      {row.customerName ?? row.customerEmail}
                    </Link>
                    <span className="mktdesk__id">{row.id}</span>
                  </th>
                  <td>{fmtUnits(row.qtyDeclared, labels)}</td>
                  <td>
                    {/* WHICH BOARD IT LIVES ON. A row with no area belongs to no
                        board at all, and saying so here is the only place an
                        operator meets that fact before trying to award it. */}
                    {row.serviceArea?.name ?? (
                      <span className="mktdesk__nowhere">No served area</span>
                    )}
                  </td>
                  {/* COLOUR IS NEVER THE ONLY CARRIER — the words say it too, for
                      anyone who cannot separate the red band from the amber. */}
                  <td className={`mktage${ageModifier(waited)}`}>{ago(waited)}</td>
                  <td>{whyItIsHere(row)}</td>
                  <td className="mktdesk__do">
                    {action !== null && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => onAct(row)}
                      >
                        {ACTION_VERB[action]}…
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mktdesk__foot">
        {/* Stated rather than implied, because the board below it is one
            district and the difference is the whole arrangement. */}
        Every served area, oldest first. The board below shows one at a time.
        {overdue > 0 && ` Red is past ${Math.round(DANGER_MS / 3_600_000)}h, amber past ${Math.round(WARN_MS / 3_600_000)}h.`}
      </p>
    </section>
  );
}
