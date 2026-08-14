import { describe, expect, it } from 'vitest';
import { busiestBoard, currentBoard, groupedForSwitcher } from './BoardSwitcher';
import { deskRows, overdueCount, whyItIsHere } from './ReturnsDesk';
import { DANGER_MS, WARN_MS, ageModifier } from './queue-shared';
import { OUT_OF_AREA, type ReturnListItem, type ServiceArea } from '../../data/api-marketing';

/**
 * The board's DECISIONS, tested as functions rather than as pixels.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE PURE FUNCTIONS AND WHY THAT IS THE TEST STRATEGY.
 *
 * Everything asserted here is a judgement the screen makes before it draws
 * anything: which board to open on, which districts are reachable, why a row is
 * on the desk, which colour band a wait falls in. Each is a rule somebody argued
 * for — and each would otherwise only be observable by reading a rendered DOM,
 * where a passing assertion proves the markup exists rather than that the rule
 * is right.
 *
 * The rendering that consumes them is exercised in the route suite with real
 * clicks. This file is the layer where the rules themselves cannot drift.
 *
 * EVERY PLACE NAME HERE IS INVENTED. The served set is editable by the owner, so
 * a test named after a district this business really serves would be asserting
 * against data rather than against behaviour — and would put a real place name
 * in a source file, which the grep guard forbids.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const area = (over: Partial<ServiceArea> & { id: string }): ServiceArea => ({
  key: over.id.replace(/^area_/, '').replace(/_/g, '-'),
  region: 'Farflung Province',
  name: 'Cabbage Quarter',
  active: true,
  seeded: true,
  revision: 1,
  needsAction: 0,
  open: 0,
  loadUnits: 0,
  oldestAgeMs: null,
  ...over,
});

const NOW = 1_786_600_000_000;
const HOUR = 3_600_000;

const row = (over: Partial<ReturnListItem> & { id: string }): ReturnListItem =>
  ({
    status: 'requested',
    revision: 1,
    customerEmail: 'dara@example.test',
    customerName: null,
    qtyDeclared: 6,
    qtyAccepted: null,
    qtyRejected: null,
    pointsAwarded: null,
    pickupScheduledAt: null,
    pickupAddress: null,
    allowedActions: ['schedule', 'reject', 'cancel', 'note'],
    serviceArea: { id: 'area_cabbage', name: 'Cabbage Quarter' },
    createdAt: NOW,
    updatedAt: NOW,
    program: {
      id: 'prg_caps',
      name: 'Cap Returns',
      pointsLabelSingular: 'Bottle Cap',
      pointsLabelPlural: 'Bottle Caps',
      unitLabelSingular: 'canister',
      unitLabelPlural: 'canisters',
    },
    ...over,
  }) as ReturnListItem;

describe('which board the switcher is showing', () => {
  it('resolves the URL’s district to its area', () => {
    const areas = [area({ id: 'a' }), area({ id: 'b', name: 'Turnip Hill' })];
    expect(currentBoard(areas, 'b')?.name).toBe('Turnip Hill');
  });

  it('has NO area for the out-of-area footer, because it is not a place', () => {
    /*
     * The footer is the ABSENCE of a board. Given an area row it would sort
     * among the districts and read as somewhere a van goes — which is exactly
     * the claim this design refuses to make.
     */
    const areas = [area({ id: 'a' })];
    expect(currentBoard(areas, OUT_OF_AREA)).toBeNull();
    expect(currentBoard(areas, null)).toBeNull();
    /* …and a district that has been switched off since the URL was written is
     * not a board either, rather than a crash. */
    expect(currentBoard(areas, 'area_retired')).toBeNull();
  });
});

describe('the board a screen opens on', () => {
  it('is the BUSIEST served district, by what needs a person', () => {
    /*
     * Busiest is `needsAction` rather than `open` — the same judgement the desk
     * makes. Landing an operator on the board with the most work waiting is the
     * one default that is never wrong; alphabetical order is a click they always
     * have to undo.
     */
    const areas = [
      area({ id: 'quiet', needsAction: 0, open: 9 }),
      area({ id: 'busy', needsAction: 4, open: 4 }),
      area({ id: 'middling', needsAction: 2, open: 8 }),
    ];
    expect(busiestBoard(areas)?.id).toBe('busy');
  });

  it('is the first served district on a quiet morning, not nothing', () => {
    // Zero everywhere is a quiet morning, not a failure — so it still opens a
    // board rather than an empty state asking somebody to choose.
    const areas = [area({ id: 'first' }), area({ id: 'second' })];
    expect(busiestBoard(areas)?.id).toBe('first');
  });

  it('NEVER opens on a district that is switched off', () => {
    /*
     * An unserved area cannot take a return, so a board for one is a dispatch
     * list for a place with no driver. This is the guard: a switched-off area
     * with work on it — which is possible, because switching one off is refused
     * only while returns are OPEN — must still not be the default board.
     */
    const areas = [
      area({ id: 'off', active: false, needsAction: 99 }),
      area({ id: 'on', active: true, needsAction: 1 }),
    ];
    expect(busiestBoard(areas)?.id).toBe('on');
    expect(busiestBoard([area({ id: 'off', active: false, needsAction: 99 })])).toBeNull();
  });
});

describe('how the switcher groups its rows', () => {
  it('is a FLAT list while one region is served', () => {
    /*
     * A single region heading over every row is chrome that tells you nothing
     * you did not already know. The headings appear by themselves the day a
     * second region is switched on — which is the whole national-model claim,
     * made by a function rather than by a migration.
     */
    const groups = groupedForSwitcher([
      area({ id: 'a' }),
      area({ id: 'b', name: 'Turnip Hill' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].region).toBeNull();
    expect(groups[0].areas.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('grows headings the moment a SECOND region has a served area', () => {
    const groups = groupedForSwitcher([
      area({ id: 'a' }),
      area({ id: 'b', region: 'Nearby Province', name: 'Turnip Hill' }),
    ]);
    expect(groups.map((g) => g.region)).toEqual(['Farflung Province', 'Nearby Province']);
  });

  it('leaves the switched-off areas out entirely — they are not boards', () => {
    // They are still LISTED on the Areas screen, which is where an owner turns
    // one on. The switcher is for places a van goes today.
    const groups = groupedForSwitcher([
      area({ id: 'on' }),
      area({ id: 'off', active: false, name: 'Distant Marsh' }),
    ]);
    expect(groups[0].areas.map((a) => a.id)).toEqual(['on']);
  });
});

describe('the desk — a judgement about a card, not a place it is', () => {
  it('holds only the two stages a person is the blocker on', () => {
    /*
     * `scheduled` and `collected` are waiting on a DRIVER. A desk that listed
     * them would be a desk nobody could empty, which is the same argument the
     * server makes when it computes `needsAction` as `requested + received`.
     */
    const rows = [
      row({ id: 'r1', status: 'requested' }),
      row({ id: 'r2', status: 'scheduled' }),
      row({ id: 'r3', status: 'collected' }),
      row({ id: 'r4', status: 'received' }),
      row({ id: 'r5', status: 'awarded' }),
    ];
    expect(deskRows(rows).map((r) => r.id)).toEqual(['r1', 'r4']);
  });

  it('says WHY a row is here, in words somebody can act on', () => {
    // "requested" and "received" are the database's words for the same two
    // facts, and they are worse at prompting an action.
    expect(whyItIsHere(row({ id: 'r', status: 'requested' }))).toBe('No pickup booked');
    expect(whyItIsHere(row({ id: 'r', status: 'received' }))).toBe('Arrived — not counted');
  });

  it('counts the overdue by the same band the card’s label bar uses', () => {
    /*
     * ONE THRESHOLD, TWO SURFACES. The desk's "Overdue 1" and the red bar on a
     * card are the same claim; two constants would drift into a desk that says
     * nothing is late above a board full of red cards.
     */
    const rows = [
      row({ id: 'fresh', createdAt: NOW - 1 * HOUR }),
      row({ id: 'warn', createdAt: NOW - 50 * HOUR }),
      row({ id: 'late', createdAt: NOW - 100 * HOUR }),
    ];
    expect(overdueCount(rows, NOW)).toBe(1);
    expect(ageModifier(NOW - rows[2].createdAt)).toBe(' mktage--danger');
    expect(ageModifier(NOW - rows[1].createdAt)).toBe(' mktage--warn');
    expect(ageModifier(NOW - rows[0].createdAt)).toBe('');
    /* The bands themselves, stated once so a change to either is a change to a
     * named number rather than to a magic one. */
    expect(WARN_MS).toBe(48 * HOUR);
    expect(DANGER_MS).toBe(96 * HOUR);
  });
});
