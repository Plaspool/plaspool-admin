import { fmtUnits, labelsOf, type BulkAction, type ReturnListItem } from '../../data/api-marketing';
import { ACTION_VERB } from './StageForm';

/**
 * Many cards at once — and the rule that keeps it honest.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BAR OFFERS ONLY WHAT IS LEGAL FOR *EVERY* CARD PICKED — the INTERSECTION
 * of what the server allows each one — AND SHOWS THE REST GREYED WITH THE
 * REASON, rather than hiding them.
 *
 * Hiding is the tempting choice and it is wrong: a control that silently
 * disappears reads as a bug. Two Requested cards and one Picked-up card share
 * only "schedule" and "note", so the operator needs to SEE that "Mark picked up"
 * exists and why it is unavailable — otherwise they conclude the board has lost
 * a feature and go looking for it.
 *
 * `inspect` IS NOT HERE AT ALL, and that is a different kind of absence.
 * Counting what arrived is a form per return — the quantities differ by
 * definition — so "inspect fifty returns with one body" is a sentence with no
 * meaning. The server's bulk schema has no such action either, so this is a
 * contract rather than a UI convention.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The verbs a selection can be given, in the order the bar draws them. The
 *  pipeline-advancing ones first, then the two that close a return, then the
 *  note that is legal in every state. */
export const BULK_ACTIONS: readonly BulkAction[] = [
  'schedule',
  'collect',
  'receive',
  'reject',
  'cancel',
  'note',
];

export interface BulkOffer {
  action: BulkAction;
  /** Legal for EVERY card in the selection. */
  legal: boolean;
  /** Why not, when not — named for the operator rather than for the log. */
  reason: string | null;
}

/**
 * What the bar may offer for this selection, and why each refusal happened.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COMPUTED FROM `allowedActions`, WHICH IS THE SERVER'S ANSWER — never from a
 * status→action table of this screen's own. The board makes the same choice for
 * a drop, and for the same reason: a second table drifts from the state machine
 * the first time a branch is added, and drifts silently.
 *
 * THE REASON NAMES A CARD. "Not legal for every card" is true and useless;
 * "Tolu Bassey has already been picked up" is what tells somebody which card to
 * deselect. So the first offender is found and named.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function offersFor(picked: readonly ReturnListItem[]): BulkOffer[] {
  return BULK_ACTIONS.map((action) => {
    if (picked.length === 0) return { action, legal: false, reason: 'Nothing is selected.' };

    const offender = picked.find((row) => !row.allowedActions.includes(action));
    if (offender === undefined) return { action, legal: true, reason: null };

    const who = offender.customerName ?? offender.customerEmail;
    return {
      action,
      legal: false,
      reason: `Not legal for ${who} — ${ACTION_VERB[action].toLowerCase()} is not an option at this stage.`,
    };
  });
}

export function SelectionBar({
  picked,
  onRun,
  onClear,
}: {
  picked: ReturnListItem[];
  onRun: (action: BulkAction) => void;
  onClear: () => void;
}) {
  if (picked.length === 0) return null;

  const load = picked.reduce((sum, row) => sum + row.qtyDeclared, 0);
  const labels = labelsOf(picked[0].program);
  const offers = offersFor(picked);

  return (
    <div className="mktsel" role="region" aria-label="Selected returns">
      <p className="mktsel__count">
        <b>{picked.length}</b> selected · {fmtUnits(load, labels)}
      </p>

      <div className="mktsel__acts">
        {offers.map((offer) => (
          <button
            key={offer.action}
            type="button"
            className={`btn btn--sm${offer.legal ? '' : ' is-disabled'}`}
            /*
             * `aria-disabled` AND NOT `disabled`. A disabled button is removed
             * from the tab order and reads nothing to a screen reader, so the
             * REASON — the whole point of greying rather than hiding — becomes
             * unreachable for exactly the person who most needs it read aloud.
             * The click handler refuses instead.
             */
            aria-disabled={!offer.legal}
            title={offer.reason ?? undefined}
            onClick={() => {
              if (offer.legal) onRun(offer.action);
            }}
          >
            {offer.action === 'schedule' && picked.length > 1
              ? `Schedule one pickup for all ${picked.length}…`
              : ACTION_VERB[offer.action]}
          </button>
        ))}
      </div>

      {/* The reason for the FIRST refusal, in the bar itself — a `title` alone
          is hover-only, and nothing on these screens may convey information by
          hover (spec D11). */}
      {offers.some((offer) => !offer.legal) && (
        <p className="mktsel__why">
          {offers.find((offer) => !offer.legal)?.reason} Greyed actions are not legal for every card
          you picked.
        </p>
      )}

      <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
