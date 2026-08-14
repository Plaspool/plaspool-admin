import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, COLUMN_HEADING, legalTargets, resolveDrop } from './ReturnsBoard';
import { monogram, worthOf } from './ReturnCard';
import type { ReturnAction, ReturnListItem, ReturnStatus } from '../../data/api-marketing';

/**
 * What a drop DECIDES — and the card's two derived numbers.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TESTING THE DECISION, NOT THE GESTURE.
 *
 * Driving synthetic pointer events through a drag library in jsdom tests the
 * library. What matters here is the RULE the drop applies, and the rule is a
 * pure function precisely so it can be pinned without a DOM: a board that gets
 * this wrong awards points by accident, which is the one failure the whole
 * arrangement exists to prevent.
 *
 * The form-and-request path that follows a drop is exercised with ordinary
 * clicks in the route suite, where a form is a form.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const card = (status: ReturnStatus, allowed: ReturnAction[]): ReturnListItem =>
  ({
    id: 'ret_1',
    status,
    revision: 1,
    customerEmail: 'dara@example.test',
    customerName: null,
    qtyDeclared: 6,
    qtyAccepted: null,
    qtyRejected: null,
    pointsPerUnitSnapshot: 7,
    pointsAwarded: null,
    pickupScheduledAt: null,
    pickupAddress: null,
    allowedActions: allowed,
    serviceArea: { id: 'area_cabbage', name: 'Cabbage Quarter' },
    createdAt: 0,
    updatedAt: 0,
    program: {
      id: 'prg_caps',
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
    },
  }) as ReturnListItem;

/** The four `allowedActions` arrays the server really serves, written out so
 *  these tests describe the state machine rather than a convenient fiction. */
const REQUESTED = card('requested', ['schedule', 'reject', 'cancel', 'note']);
const SCHEDULED = card('scheduled', ['collect', 'schedule', 'reject', 'cancel', 'note']);
const COLLECTED = card('collected', ['receive', 'cancel', 'note']);
const RECEIVED = card('received', ['inspect', 'note']);

describe('a drop opens a form and never performs the move', () => {
  it('resolves a legal drop to the ACTION whose form finishes it', () => {
    /*
     * The whole rule in one assertion: releasing on Scheduled yields
     * `{kind:'form', action:'schedule'}` — an INTENT — and the caller opens the
     * pickup form. Nothing here returns "moved".
     */
    expect(resolveDrop(REQUESTED, 'scheduled')).toEqual({ kind: 'form', action: 'schedule' });
    expect(resolveDrop(SCHEDULED, 'collected')).toEqual({ kind: 'form', action: 'collect' });
    expect(resolveDrop(COLLECTED, 'received')).toEqual({ kind: 'form', action: 'receive' });
  });

  it('never yields `inspect` from a drop — counting is not a destination', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE ONE THIS FILE EXISTS FOR.
     *
     * Dropping on Received means "this arrived", which is `receive`. The
     * INSPECTION — the act that awards points — is a separate deliberate step on
     * a card that is already in that column, because it needs counted
     * quantities that no gesture can supply.
     *
     * If a drop could ever resolve to `inspect`, releasing a card would award
     * points against numbers nobody typed. No arrangement of these four columns
     * may produce it.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const outcomes = [REQUESTED, SCHEDULED, COLLECTED, RECEIVED].flatMap((from) =>
      BOARD_COLUMNS.map((to) => resolveDrop(from, to)),
    );
    for (const outcome of outcomes) {
      if (outcome.kind === 'form') expect(outcome.action).not.toBe('inspect');
    }
    /* …and a card already on the bench does not move by being dropped on the
     * bench it is already on. */
    expect(resolveDrop(RECEIVED, 'received')).toEqual({ kind: 'noop' });
  });

  it('treats a release on the card’s own column as a no-op, not an error', () => {
    // The operator changed their mind mid-drag. Dragging a card back is what
    // that is for, and it deserves no message.
    expect(resolveDrop(REQUESTED, 'requested')).toEqual({ kind: 'noop' });
    expect(resolveDrop(SCHEDULED, 'scheduled')).toEqual({ kind: 'noop' });
  });

  it('REFUSES a skip through the pipeline, and says which rule stopped it', () => {
    /*
     * A requested return has not been collected, so it cannot arrive at the
     * warehouse. The refusal carries a SENTENCE because a card that springs back
     * silently reads as a broken board.
     */
    const outcome = resolveDrop(REQUESTED, 'received');
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain(COLUMN_HEADING.requested);
      expect(outcome.reason).toContain(COLUMN_HEADING.received);
    }
    expect(resolveDrop(REQUESTED, 'collected').kind).toBe('refused');
    expect(resolveDrop(RECEIVED, 'collected').kind).toBe('refused');
  });

  it('refuses everything dropped back into Requested — a return is born there', () => {
    // There is no un-schedule: a reschedule IS a schedule, and it happens on the
    // card rather than by dragging it backwards.
    for (const from of [SCHEDULED, COLLECTED, RECEIVED]) {
      expect(resolveDrop(from, 'requested').kind).toBe('refused');
    }
  });

  it('ASKS `allowedActions` — it does not keep a status table of its own', () => {
    /*
     * ═══════════════════════════════════════════════════════════════════════
     * THE MUTATION THIS GUARDS. Replace the `allowedActions.includes(action)`
     * check with a hardcoded `requested → scheduled` map and every assertion
     * above still passes: the map agrees with the state machine TODAY. It would
     * stop agreeing the first time a branch was added, and the symptom would be
     * a card that moves on screen and 409s on the wire.
     *
     * So this drives a card whose status says one thing and whose SERVER ANSWER
     * says another. Only an implementation that reads `allowedActions` gets it
     * right.
     * ═══════════════════════════════════════════════════════════════════════
     */
    const frozen = card('requested', ['reject', 'cancel', 'note']);
    expect(resolveDrop(frozen, 'scheduled').kind).toBe('refused');

    /* …and the mirror: a card the server says MAY be collected is collectable,
     * whatever a hardcoded pipeline would have said about its stage. */
    const unusual = card('requested', ['collect', 'note']);
    expect(resolveDrop(unusual, 'collected')).toEqual({ kind: 'form', action: 'collect' });
  });

  it('lists exactly the columns a card in hand may enter', () => {
    // The board dims everything else while the card is held, so an illegal
    // target is visible BEFORE the release rather than explained after it.
    expect(legalTargets(REQUESTED)).toEqual(['scheduled']);
    /* A scheduled card may be RESCHEDULED — `schedule` is legal from
     * `scheduled` — but that is the card's own column, so it is a no-op rather
     * than a target. Only `collected` lights up. */
    expect(legalTargets(SCHEDULED)).toEqual(['collected']);
    expect(legalTargets(COLLECTED)).toEqual(['received']);
    /* Nothing lights up for a received card: the only thing left to do with it
     * is count what arrived, and that is not a column. */
    expect(legalTargets(RECEIVED)).toEqual([]);
  });
});

describe('the two numbers a card derives', () => {
  it('prices an open return at quantity × the rate it was PROMISED', () => {
    /*
     * The snapshot, never the programme's current rate. A shop that repriced on
     * Wednesday must not see every Monday card silently restated — which is the
     * whole reason `pointsPerUnitSnapshot` is on the row at all.
     */
    expect(worthOf(REQUESTED)).toBe(42);
  });

  it('shows what was ACTUALLY awarded once the counting has happened', () => {
    // By then the estimate is history: the customer said six, the driver came
    // back with five, and the card should say what was paid rather than what was
    // hoped for.
    const awarded = { ...RECEIVED, status: 'awarded' as const, pointsAwarded: 35 };
    expect(worthOf(awarded)).toBe(35);
  });

  it('builds a monogram from whatever is actually known about a person', () => {
    expect(monogram('Dara Adeyemi', 'd@x.io')).toBe('DA');
    expect(monogram('Tolu', 't@x.io')).toBe('TO');
    // Guest checkout is the DEFAULT path, so the common case is no name at all.
    expect(monogram(null, 'chi@example.test')).toBe('CH');
    /* Punctuation and digits are dropped rather than drawn: an address starting
     * `21st` or `_dara` would otherwise put noise where a person goes. */
    expect(monogram(null, '21-dara@example.test')).toBe('DA');

    /*
     * THE LOCAL PART, NEVER THE DOMAIN. Everybody at one company shares a
     * domain, so a monogram drawn from it would be identical for exactly the
     * customers a monogram exists to tell apart.
     */
    expect(monogram(null, 'ada@bigcorp.test')).toBe('AD');
    expect(monogram(null, 'bola@bigcorp.test')).toBe('BO');
    /* …and the domain is the LAST resort, for the absurd-but-legal address whose
     * local part has no letters in it at all. */
    expect(monogram(null, '7@xi.io')).toBe('XI');
  });
});
