/**
 * The marketing screens' test fixtures, in one module so every suite lies the
 * same way.
 *
 * EVERY FIXTURE USES ABSURD LABELS — "Bottle Cap"/"Bottle Caps" for the points
 * word, "canister"/"canisters" for the unit — and that is the point of the file
 * existing at all. The programme this section ships with counts one particular
 * returnable thing, so a screen that hardcoded THAT noun would pass any test
 * written with realistic fixtures and fail the first customer who renamed the
 * program. With these, a hardcode is visible: the assertion asks for "6
 * canisters", and the suites additionally assert the seeded preset's own noun
 * appears nowhere in what was rendered. The noun is not spelled out in this
 * comment either — the guard greps source, so prose about it would trip it.
 *
 * THE SECOND RENAME IS BUILT IN, and it is the part worth reading. The ledger
 * rows and the `inspected` timeline event below say "Jar Lid" — the wording the
 * program had when those rows were written — while the program itself now says
 * "Bottle Cap". History keeps what it was told; only live values get today's
 * words. A screen that re-renders a stored `reason` through the current labels
 * passes every hand-written check and fails these, which is exactly the bug the
 * snapshot rule exists to catch.
 *
 * NO `Date.now()` ANYWHERE. Every timestamp hangs off `NOW`, so a suite can
 * `vi.setSystemTime(NOW)` and assert on an age, a countdown or a derived banner
 * status without the answer depending on the minute the test ran.
 */
import {
  labelsOf,
  type AreasView,
  type Banner,
  type CustomerRow,
  type CustomerSummary,
  type EmbeddedProgram,
  type LedgerEntry,
  type MarketingSettings,
  type MarketingSummary,
  type ReturnCostAnalytics,
  type Program,
  type ProgramLabels,
  type ReturnAction,
  type ReturnCounts,
  type ReturnDetail,
  type ReturnEvent,
  type ReturnListItem,
  type ReturnRequest,
  type ReturnStatus,
  type ReturnsPage,
  type ServiceArea,
} from './api-marketing';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 2026-08-13T05:46:40Z. Fixed, because an age of "100 hours" has to mean the
 *  same thing in CI as it does on a laptop that ran the suite at midnight. */
export const NOW = 1786600000000;

// ------------------------------------------------------------------ programs

/**
 * The programme every fixture points at, named absurdly on purpose.
 *
 * `revision: 1` is load-bearing: the Overview's first-run checklist reads it as
 * "nobody has reviewed the seeded preset yet", so this row exercises the
 * checklist's visible arm and `renamedProgram` below exercises its absence.
 */
export const capsProgram: Program = {
  id: 'prg_caps',
  key: 'bottle-caps',
  kind: 'unit_return',
  name: 'Canister Returns',
  pointsLabelSingular: 'Bottle Cap',
  pointsLabelPlural: 'Bottle Caps',
  unitLabelSingular: 'canister',
  unitLabelPlural: 'canisters',
  minUnitsPerReturn: 4,
  pointsPerUnit: 7,
  /* 0920 — ₦100 a unit in reward money and ₦850 to buy one new, which is the
   * shape of the owner's own arithmetic and what makes the design gallery's
   * cost figures read like the real screen's. */
  unitCostMinor: 10000,
  unitMarketCostMinor: 85000,
  status: 'active',
  conditions: {},
  seeded: true,
  awardedTotal: 350,
  openReturns: 5,
  revision: 1,
  createdAt: NOW - 30 * DAY,
  updatedAt: NOW - 30 * DAY,
};

/** A second, edited program — the "Seeded preset" chip must NOT appear on it,
 *  and the checklist must treat a `revision > 1` preset as reviewed. */
export const renamedProgram: Program = {
  ...capsProgram,
  id: 'prg_reviewed',
  key: 'canister-returns-2',
  name: 'Canister Returns (trial)',
  seeded: false,
  revision: 4,
  awardedTotal: 70,
  openReturns: 0,
  updatedAt: NOW - 2 * DAY,
};

/**
 * The `adhoc` kind: points for a reason, nothing counted.
 *
 * Its null unit labels are the reason `fmtUnits` has a fallback at all, and the
 * program editor's kind control has to hide the unit + rules fields for it.
 */
export const goodwillProgram: Program = {
  id: 'prg_goodwill',
  key: 'goodwill',
  kind: 'adhoc',
  /* No costing rate: points granted by hand count no units, so there is
   * nothing for a per-unit cost to be about. */
  unitCostMinor: null,
  unitMarketCostMinor: null,
  name: 'Goodwill',
  pointsLabelSingular: 'Bottle Cap',
  pointsLabelPlural: 'Bottle Caps',
  unitLabelSingular: null,
  unitLabelPlural: null,
  minUnitsPerReturn: null,
  pointsPerUnit: null,
  status: 'paused',
  conditions: {},
  seeded: false,
  awardedTotal: 40,
  openReturns: 0,
  revision: 2,
  createdAt: NOW - 12 * DAY,
  updatedAt: NOW - 5 * DAY,
};

export const programs: Program[] = [capsProgram, renamedProgram, goodwillProgram];

export const capsLabels: ProgramLabels = labelsOf(capsProgram);
/** Unit-less labels — what `fmtUnits` falls back to "unit"/"units" for. */
export const goodwillLabels: ProgramLabels = labelsOf(goodwillProgram);

/** The label bundle every returns payload embeds, so no row guesses its words. */
export const capsEmbedded: EmbeddedProgram = {
  id: capsProgram.id,
  name: capsProgram.name,
  pointsLabelSingular: capsProgram.pointsLabelSingular,
  pointsLabelPlural: capsProgram.pointsLabelPlural,
  unitLabelSingular: capsProgram.unitLabelSingular,
  unitLabelPlural: capsProgram.unitLabelPlural,
};

// ------------------------------------------------------------------- returns

/**
 * ORDERED, AND THE ORDER IS THE CONTRACT (spec D4): the pipeline-advancing
 * action first, then reject, cancel, note. The queue renders exactly one button
 * and it is `allowedActions[0]`.
 *
 * The server computes these — `allowedActionsFor()` is pinned by an exact-array
 * test on the backend — and this map exists so the screens can be tested against
 * the same shape while the backend is absent. It is a fixture, never a fallback
 * a screen may reach for: a UI that computes its own actions is the drift the
 * served array was introduced to kill.
 */
export const ALLOWED_ACTIONS: Record<ReturnStatus, ReturnAction[]> = {
  requested: ['schedule', 'reject', 'cancel', 'note'],
  // Reschedule is `scheduled → scheduled`, so `schedule` is legal here too.
  scheduled: ['collect', 'schedule', 'reject', 'cancel', 'note'],
  // Cancel but NOT reject: this is the lost-in-transit escape.
  collected: ['receive', 'cancel', 'note'],
  // Once the goods are in hand you must inspect — no cancel, no reject.
  received: ['inspect', 'note'],
  awarded: ['note'],
  rejected: ['note'],
  cancelled: ['note'],
};

const REVISION_AT: Record<ReturnStatus, number> = {
  requested: 1,
  scheduled: 2,
  collected: 3,
  received: 4,
  awarded: 5,
  rejected: 2,
  cancelled: 3,
};

function row(
  id: string,
  status: ReturnStatus,
  email: string,
  ageMs: number,
  over: Partial<ReturnListItem> = {},
): ReturnListItem {
  return {
    id,
    status,
    revision: REVISION_AT[status],
    customerEmail: email,
    customerName: null,
    qtyDeclared: 6,
    qtyAccepted: null,
    qtyRejected: null,
    /** The absurd programme's rate, so a card's "worth" line is arithmetic over
     *  fixture numbers rather than over the seeded preset's. */
    pointsPerUnitSnapshot: 7,
    pointsAwarded: null,
    pickupScheduledAt: null,
    pickupAddress: '12 Adeola Odeku Street, Lagos',
    allowedActions: ALLOWED_ACTIONS[status],
    /**
     * EVERY FIXTURE ROW IS ON A BOARD, because the ordinary case is: a return
     * with no service area cannot be awarded, so an un-areaed row is the
     * exception the out-of-area footer exists for and a test that wants one says
     * so with `{ serviceArea: null }`.
     *
     * The name is invented, like the labels beside it — a fixture named after a
     * district this business really serves could not tell code that reads the
     * area off the row from code that hardcoded the place.
     */
    serviceArea: { id: 'area_cabbage_quarter', name: 'Cabbage Quarter' },
    createdAt: NOW - ageMs,
    updatedAt: NOW - ageMs,
    program: capsEmbedded,
    ...over,
  };
}

/**
 * One row per status, with ages chosen to exercise the queue's aging bands
 * (`--warn` at 48h, `--danger` at 96h) rather than to look plausible.
 *
 * The open ones carry DIFFERENT EMAILS on purpose: one open return per email is
 * a partial unique index on the server, so a fixture with two open rows for one
 * address describes a database state that cannot exist.
 */
export const requestedOld = row('ret_dara_1', 'requested', 'dara@example.com', 100 * HOUR, {
  customerName: 'Dara A.',
});
export const requestedNew = row('ret_bode_1', 'requested', 'bode@example.com', 3 * HOUR, {
  qtyDeclared: 4,
});
export const scheduledRow = row('ret_ngozi_1', 'scheduled', 'ngozi@example.com', 50 * HOUR, {
  pickupScheduledAt: NOW + 20 * HOUR,
  updatedAt: NOW - 26 * HOUR,
});
export const collectedRow = row('ret_kemi_1', 'collected', 'kemi@example.com', 30 * HOUR, {
  pickupScheduledAt: NOW - 4 * HOUR,
  updatedAt: NOW - 4 * HOUR,
});
export const receivedRow = row('ret_tunde_1', 'received', 'tunde@example.com', 26 * HOUR, {
  customerName: 'Tunde B.',
  pickupScheduledAt: NOW - 6 * HOUR,
  updatedAt: NOW - 90 * MINUTE,
});
export const awardedRow = row('ret_dara_0', 'awarded', 'dara@example.com', 9 * DAY, {
  customerName: 'Dara A.',
  qtyAccepted: 5,
  qtyRejected: 1,
  pointsAwarded: 35,
  pickupScheduledAt: NOW - 8 * DAY,
  updatedAt: NOW - 7 * DAY,
});
export const rejectedRow = row('ret_femi_1', 'rejected', 'femi@example.com', 6 * DAY, {
  qtyDeclared: 5,
  updatedAt: NOW - 5 * DAY,
});
export const cancelledRow = row('ret_ada_1', 'cancelled', 'ada@example.com', 4 * DAY, {
  pickupScheduledAt: NOW - 3 * DAY - 12 * HOUR,
  updatedAt: NOW - 3 * DAY,
});

export const returnRows: ReturnListItem[] = [
  requestedOld,
  requestedNew,
  scheduledRow,
  collectedRow,
  receivedRow,
  awardedRow,
  rejectedRow,
  cancelledRow,
];

/** Real aggregates over the rows above — the tab strip shows these, so they are
 *  counted rather than invented (a fake tab count is the thing the house style
 *  objects to; honest ones are the whole reason `counts` rides on every page). */
export const returnCounts: ReturnCounts = {
  requested: 2,
  scheduled: 1,
  collected: 1,
  received: 1,
  awarded: 1,
  rejected: 1,
  cancelled: 1,
  needsAction: 3,
};

/** `?view=all`, with a cursor so the "Show more" pager has something to do. */
export const returnsPage: ReturnsPage = {
  items: returnRows,
  nextCursor: 'ret_ada_1',
  counts: returnCounts,
};

/** `?view=needs_action` — the queue's default. Requested + received only. */
export const needsActionPage: ReturnsPage = {
  items: [requestedOld, requestedNew, receivedRow],
  nextCursor: null,
  counts: returnCounts,
};

/**
 * The boards, and the returns that belong to none of them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY PLACE NAME HERE IS INVENTED, exactly as the labels are absurd. The
 * served set is a row-level flag an owner edits, so a fixture named after a
 * district this business really serves would assert against data rather than
 * behaviour — and would put a real place name in a source file, which the
 * section's grep guard forbids.
 *
 * `cabbage` is the busiest board and `turnip` is idle, because the two
 * interesting switcher states are "has work" and "listed but not switchable".
 * ═══════════════════════════════════════════════════════════════════════════
 */
const area = (over: Partial<ServiceArea> & { id: string; name: string }): ServiceArea => ({
  key: over.id.replace(/^area_/, '').replace(/_/g, '-'),
  region: 'Farflung Province',
  active: true,
  seeded: true,
  revision: 1,
  needsAction: 0,
  open: 0,
  loadUnits: 0,
  oldestAgeMs: null,
  /* No standard by default — most districts have none, and the screen has to
   * read correctly in that state before it reads correctly with one. */
  stdTransportMinor: null,
  stdLocalMinor: null,
  stdDriverMinor: null,
  stdFeesMinor: null,
  ...over,
});

export const cabbageArea = area({
  id: 'area_cabbage_quarter',
  name: 'Cabbage Quarter',
  needsAction: 3,
  open: 5,
  loadUnits: 29,
  oldestAgeMs: 100 * HOUR,
  /* THE ONE DISTRICT WITH A STANDARD PICKUP COST (0920), so the cost form's
   * placeholder has something to show and Turnip Hill beside it exercises the
   * commoner state of having none. Transport and local only: a district with a
   * standard for every line is the rare case, and a fixture that never leaves
   * one blank would hide the per-line fallback. */
  stdTransportMinor: 200000,
  stdLocalMinor: 50000,
});

/** Listed, greyed and inert — hiding it would read as "we do not serve there". */
export const turnipArea = area({ id: 'area_turnip_hill', name: 'Turnip Hill' });

/** Switched off, so it is on the Areas screen and NOT in the switcher. */
export const marshArea = area({ id: 'area_distant_marsh', name: 'Distant Marsh', active: false });

export const areasView: AreasView = {
  areas: [cabbageArea, turnipArea],
  outOfArea: { needsAction: 0, open: 0 },
};

/** Every region loaded, one switched on — what the Areas screen draws. */
export const allAreasView: AreasView = {
  areas: [
    cabbageArea,
    turnipArea,
    { ...marshArea, region: 'Nearby Province' },
  ],
  outOfArea: { needsAction: 1, open: 2 },
};

/** One district's board: the four open stages, no closed rows. */
export const boardPage: ReturnsPage = {
  items: [requestedOld, requestedNew, scheduledRow, collectedRow, receivedRow],
  nextCursor: null,
  counts: returnCounts,
};

/**
 * THE WORDING THIS RETURN WAS AWARDED UNDER, before the program was renamed.
 *
 * Used by the `inspected` event and the ledger row for the same request, so any
 * surface that re-renders history through `capsLabels` prints "Bottle Caps" and
 * fails a test that asked for this.
 */
export const OLD_LABELS = {
  pointsLabelSingular: 'Jar Lid',
  pointsLabelPlural: 'Jar Lids',
  unitLabelSingular: 'tub',
  unitLabelPlural: 'tubs',
} as const;

function timeline(item: ReturnListItem): ReturnEvent[] {
  const t = item.createdAt;
  const by = { actorType: 'admin' as const, actorId: 'u_owner' };
  const opened: ReturnEvent = {
    id: `mev_${item.id}_1`,
    type: 'requested',
    ...by,
    note: 'Called in — wants a pickup this week.',
    data: { qtyDeclared: item.qtyDeclared, source: 'admin' },
    occurredAt: t,
  };
  const scheduled: ReturnEvent = {
    id: `mev_${item.id}_2`,
    type: 'scheduled',
    ...by,
    note: null,
    data: { pickupAt: item.pickupScheduledAt, driverName: 'Emeka O.' },
    occurredAt: t + HOUR,
  };
  const collected: ReturnEvent = {
    id: `mev_${item.id}_3`,
    type: 'collected',
    ...by,
    note: null,
    data: null,
    occurredAt: t + 20 * HOUR,
  };
  const received: ReturnEvent = {
    id: `mev_${item.id}_4`,
    type: 'received',
    ...by,
    note: null,
    data: null,
    occurredAt: t + 23 * HOUR,
  };
  const note: ReturnEvent = {
    id: `mev_${item.id}_5`,
    type: 'note',
    ...by,
    note: 'One canister is dented — checking whether it still counts.',
    data: null,
    occurredAt: t + 24 * HOUR,
  };
  const inspected: ReturnEvent = {
    id: `mev_${item.id}_6`,
    type: 'inspected',
    ...by,
    note: null,
    // The four label values AS WRITTEN, beside the quantities — spec D5.
    data: {
      qtyAccepted: 5,
      qtyRejected: 1,
      pointsAwarded: 35,
      outcome: 'awarded',
      ...OLD_LABELS,
    },
    occurredAt: t + 25 * HOUR,
  };
  const rejected: ReturnEvent = {
    id: `mev_${item.id}_7`,
    type: 'rejected',
    ...by,
    note: null,
    data: { reason: 'Not ours — different brand entirely.' },
    occurredAt: t + 2 * HOUR,
  };
  const cancelled: ReturnEvent = {
    id: `mev_${item.id}_8`,
    type: 'cancelled',
    ...by,
    note: null,
    data: { reason: 'Customer moved house before the pickup.' },
    occurredAt: t + 26 * HOUR,
  };

  // Oldest first, matching the server's `(request_id, occurred_at, id)` index.
  // The timeline panel renders newest-first; that reversal is the screen's.
  switch (item.status) {
    case 'requested':
      return [opened];
    case 'scheduled':
      return [opened, scheduled];
    case 'collected':
      return [opened, scheduled, collected];
    case 'received':
      return [opened, scheduled, collected, received, note];
    case 'awarded':
      return [opened, scheduled, collected, received, note, inspected];
    case 'rejected':
      return [opened, rejected];
    case 'cancelled':
      return [opened, scheduled, cancelled];
  }
}

function request(item: ReturnListItem): ReturnRequest {
  const closed = item.status === 'awarded' || item.status === 'rejected' || item.status === 'cancelled';
  return {
    id: item.id,
    status: item.status,
    revision: item.revision,
    customerEmail: item.customerEmail,
    customerId: item.customerEmail === 'dara@example.com' ? 'cus_dara' : null,
    customerName: item.customerName,
    customerPhone: '+234 801 234 5678',
    pickupAddress: item.pickupAddress,
    serviceAreaId: item.serviceArea?.id ?? null,
    qtyDeclared: item.qtyDeclared,
    qtyAccepted: item.qtyAccepted,
    qtyRejected: item.qtyRejected,
    // Frozen at creation: repricing the program cannot change this promise.
    pointsPerUnitSnapshot: 7,
    pointsAwarded: item.pointsAwarded,
    /* 0920. The money rate is frozen the same way; the pickup's own costs are
     * recorded only once the van has actually been, so an open return has
     * none — which is the state the cost form opens in. */
    unitCostMinorSnapshot: 10000,
    costTransportMinor: closed ? 250000 : null,
    costLocalMinor: closed ? 80000 : null,
    costDriverMinor: null,
    costFeesMinor: null,
    costNote: null,
    rejectedReason: item.status === 'rejected' ? 'Not ours — different brand entirely.' : null,
    cancelReason: item.status === 'cancelled' ? 'Customer moved house before the pickup.' : null,
    source: 'admin',
    pickupScheduledAt: item.pickupScheduledAt,
    driverName: item.pickupScheduledAt === null ? null : 'Emeka O.',
    driverPhone: item.pickupScheduledAt === null ? null : '+234 802 000 1111',
    scheduledAt: item.pickupScheduledAt === null ? null : item.createdAt + HOUR,
    collectedAt: ['collected', 'received', 'awarded'].includes(item.status)
      ? item.createdAt + 20 * HOUR
      : null,
    receivedAt: ['received', 'awarded'].includes(item.status) ? item.createdAt + 23 * HOUR : null,
    closedAt: closed ? item.updatedAt : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    allowedActions: item.allowedActions,
  };
}

function intents(status: ReturnStatus): ReturnDetail['emailIntents'] {
  // "Queued", never a fake "sent": nothing schedules the sweep, so an intent
  // with no `sentAt` is the normal state right after an inspection.
  if (status === 'awarded') {
    return [{ kind: 'return_awarded', sentAt: null, attempts: 0, lastError: null }];
  }
  if (status === 'rejected') {
    return [{ kind: 'return_rejected', sentAt: NOW - 5 * DAY, attempts: 1, lastError: null }];
  }
  return [];
}

function detail(item: ReturnListItem): ReturnDetail {
  return {
    request: request(item),
    program: {
      ...capsEmbedded,
      status: capsProgram.status,
      pointsPerUnit: capsProgram.pointsPerUnit as number,
      minUnitsPerReturn: capsProgram.minUnitsPerReturn as number,
      unitCostMinor: capsProgram.unitCostMinor,
      unitMarketCostMinor: capsProgram.unitMarketCostMinor,
    },
    events: timeline(item),
    emailIntents: intents(item.status),
  };
}

/** Every status as a full detail payload — the lifecycle screen's whole matrix. */
export const returnDetails: Record<ReturnStatus, ReturnDetail> = {
  requested: detail(requestedOld),
  scheduled: detail(scheduledRow),
  collected: detail(collectedRow),
  received: detail(receivedRow),
  awarded: detail(awardedRow),
  rejected: detail(rejectedRow),
  cancelled: detail(cancelledRow),
};

/** The inspection hero: 6 declared, waiting to be counted. */
export const receivedDetail = returnDetails.received;

// -------------------------------------------------------------------- ledger

/**
 * One customer's history, newest first, with the `balanceAfter` chain intact:
 * every row's `balanceAfter` is the row before it plus this row's `delta`, which
 * is what lets a ledger row render "120 → 180" with no window function and no
 * arithmetic on the client beyond one subtraction.
 *
 * The oldest row is the award, in the wording the program had THEN.
 */
export const ledgerWalk: LedgerEntry[] = [
  {
    id: 'pts_5',
    kind: 'redemption_release',
    delta: 40,
    balanceAfter: 180,
    reason: 'Order 1042 cancelled — redeemed points returned',
    programId: null,
    programName: null,
    returnRequestId: null,
    orderId: 'ord_1042',
    actorType: 'system',
    actorId: null,
    createdAt: NOW - 2 * HOUR,
  },
  {
    id: 'pts_4',
    kind: 'redemption',
    delta: -40,
    balanceAfter: 140,
    reason: 'Redeemed against order 1042',
    programId: null,
    programName: null,
    returnRequestId: null,
    orderId: 'ord_1042',
    actorType: 'customer',
    actorId: null,
    createdAt: NOW - 3 * DAY,
  },
  {
    id: 'pts_3',
    kind: 'manual',
    delta: 60,
    balanceAfter: 180,
    reason: 'Goodwill — box arrived crushed',
    programId: goodwillProgram.id,
    programName: goodwillProgram.name,
    returnRequestId: null,
    orderId: null,
    actorType: 'admin',
    actorId: 'u_owner',
    createdAt: NOW - 5 * DAY,
  },
  {
    id: 'pts_2',
    kind: 'manual',
    delta: 85,
    balanceAfter: 120,
    reason: 'Walk-in return, counted at the counter',
    programId: capsProgram.id,
    programName: capsProgram.name,
    returnRequestId: null,
    orderId: null,
    actorType: 'admin',
    actorId: 'u_owner',
    createdAt: NOW - 6 * DAY,
  },
  {
    id: 'pts_1',
    kind: 'return_award',
    delta: 35,
    balanceAfter: 35,
    /*
     * WRITTEN WHEN THE PROGRAM SAID "JAR LIDS", and displayed verbatim ever
     * after. `programName` is left as today's name deliberately: the spec makes
     * the REASON STRING the snapshot (D2d), and whether the name beside it is a
     * join or a copy is the server's business — a fixture that assumed the
     * stricter answer would be asserting something the contract never promised.
     */
    reason: `5 accepted × 7 = 35 ${OLD_LABELS.pointsLabelPlural} to dara@example.com`,
    programId: capsProgram.id,
    programName: capsProgram.name,
    returnRequestId: awardedRow.id,
    orderId: null,
    actorType: 'admin',
    actorId: 'u_owner',
    createdAt: NOW - 7 * DAY,
  },
];

// ----------------------------------------------------------------- customers

export const customerRows: CustomerRow[] = [
  {
    email: 'dara@example.com',
    customerId: 'cus_dara',
    displayName: 'Dara A.',
    guest: false,
    balance: 180,
    lifetimeEarned: 180,
    lastEntryAt: NOW - 2 * HOUR,
    lastEntry: {
      kind: 'redemption_release',
      delta: 40,
      reason: 'Order 1042 cancelled — redeemed points returned',
    },
  },
  /* A `shop_customers` match with no points history at all — the row that
     proves the directory searches beyond balance-holders, and the one an admin
     needs in order to credit somebody for the first time. */
  {
    email: 'ada@example.com',
    customerId: null,
    displayName: null,
    guest: true,
    balance: 0,
    lifetimeEarned: 0,
    lastEntryAt: null,
    lastEntry: null,
  },
];

export const customerSummary: CustomerSummary = {
  email: 'dara@example.com',
  customerId: 'cus_dara',
  displayName: 'Dara A.',
  balance: 180,
  lifetimeEarned: 180,
  openReturn: { id: requestedOld.id, status: 'requested' },
};

/** An address nothing has ever paid or earned under: ZEROS, not a 404. The
 *  walk-in credit path opens exactly this. */
export const unknownCustomer: CustomerSummary = {
  email: 'nobody@example.com',
  customerId: null,
  displayName: null,
  balance: 0,
  lifetimeEarned: 0,
  openReturn: null,
};

// ------------------------------------------------------------------- banners

/**
 * Five banners, one per derived status at `NOW` — draft, scheduled, live, ended,
 * archived. `deriveBannerStatus` decides which is which; nothing here stores a
 * derived status, because the whole point of the shared function is that the
 * stored intent and the clock are separate things.
 */
export const draftBanner: Banner = {
  id: 'bnr_draft',
  title: 'Half term sale',
  body: 'Two weeks of reductions across the shop.',
  ctaText: null,
  ctaUrl: null,
  placement: 'section',
  status: 'draft',
  startsAt: null,
  endsAt: null,
  priority: 0,
  revision: 1,
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - 2 * DAY,
};

export const scheduledBanner: Banner = {
  id: 'bnr_scheduled',
  title: 'Free delivery week',
  body: 'On every order over ₦50,000.',
  ctaText: 'See the terms',
  ctaUrl: '/delivery',
  placement: 'popup',
  status: 'live',
  startsAt: NOW + 2 * DAY,
  endsAt: NOW + 9 * DAY,
  priority: 5,
  revision: 2,
  createdAt: NOW - 3 * DAY,
  updatedAt: NOW - DAY,
};

export const liveBanner: Banner = {
  id: 'bnr_live',
  title: 'Send your empties back',
  body: 'Book a pickup and earn on every one we accept.',
  ctaText: 'Book a pickup',
  ctaUrl: 'https://example.com/returns',
  placement: 'top_bar',
  status: 'live',
  startsAt: NOW - DAY,
  endsAt: NOW + 7 * DAY,
  priority: 10,
  revision: 3,
  createdAt: NOW - 8 * DAY,
  updatedAt: NOW - DAY,
};

export const endedBanner: Banner = {
  id: 'bnr_ended',
  title: 'Restock day',
  body: 'Everything back in stock from Monday.',
  ctaText: null,
  ctaUrl: null,
  placement: 'top_bar',
  status: 'live',
  startsAt: NOW - 10 * DAY,
  endsAt: NOW - DAY,
  priority: 2,
  revision: 4,
  createdAt: NOW - 12 * DAY,
  updatedAt: NOW - 10 * DAY,
};

export const archivedBanner: Banner = {
  id: 'bnr_archived',
  title: 'Last year’s launch',
  body: '',
  ctaText: null,
  ctaUrl: null,
  placement: 'section',
  status: 'archived',
  startsAt: null,
  endsAt: null,
  priority: 0,
  revision: 6,
  createdAt: NOW - 300 * DAY,
  updatedAt: NOW - 200 * DAY,
};

export const banners: Banner[] = [
  draftBanner,
  scheduledBanner,
  liveBanner,
  endedBanner,
  archivedBanner,
];

/** Derived `live` and still invisible: same placement as `liveBanner`, lower
 *  priority. The "Why not showing?" evaluator's beaten-by-priority case. */
export const rivalBanner: Banner = {
  id: 'bnr_rival',
  title: 'Weekend opening hours',
  body: 'Open until 6pm on Saturdays.',
  ctaText: null,
  ctaUrl: null,
  placement: 'top_bar',
  status: 'live',
  startsAt: NOW - 2 * DAY,
  endsAt: null,
  priority: 1,
  revision: 1,
  createdAt: NOW - 2 * DAY,
  updatedAt: NOW - 2 * DAY,
};

export const bannersWithRival: Banner[] = [...banners, rivalBanner];

// ------------------------------------------------------------------ settings

export const settings: MarketingSettings = {
  pointsLabelSingular: 'Bottle Cap',
  pointsLabelPlural: 'Bottle Caps',
  redemptionEnabled: true,
  // 100 points are worth ₦5.00 — an integer rational, never a float.
  redemptionRatePoints: 100,
  redemptionRateMinor: 500,
  redemptionCurrency: 'NGN',
  minRedeemPoints: 50,
  maxRedeemBps: 5000,
  defaultReturnProgramId: capsProgram.id,
  revision: 4,
  updatedAt: NOW - DAY,
};

/** The shipped state: redemption OFF with a zero rate, which the DB's CHECK
 *  makes the only safe default — a forgotten review costs copy, never money. */
export const freshSettings: MarketingSettings = {
  ...settings,
  redemptionEnabled: false,
  redemptionRateMinor: 0,
  minRedeemPoints: 0,
  maxRedeemBps: 10000,
  revision: 1,
};

// ------------------------------------------------------------------- summary

export const summary: MarketingSummary = {
  tiles: {
    // Over 48h, so the tile renders its `--alert` variant.
    needsScheduling: { count: 2, oldestAgeMs: 100 * HOUR },
    outForPickup: { count: 1, nextPickupAt: NOW + 20 * HOUR },
    toInspect: { count: 1, oldestAgeMs: 26 * HOUR },
    awarded30d: { points: 350, returns: 9 },
  },
  oldestOpen: [requestedOld, scheduledRow, collectedRow, receivedRow, requestedNew],
  latestLedger: ledgerWalk.map((entry) => ({ ...entry, customerEmail: 'dara@example.com' })),
  // Non-archived only — the server filters, the client derives each chip.
  banners: banners.filter((banner) => banner.status !== 'archived'),
  pendingEmailIntents: 1,
};

// -------------------------------------------------- what an item costs us

/**
 * The returns-cost aggregate, with the owner's own arithmetic in it.
 *
 * ₦100 paid an item and ₦212 to fetch them, so an item really costs ₦312 —
 * which is the shape of the sentence that started the feature ("the headline
 * says a hundred, but we are actually getting them for three hundred and
 * something"). Every figure below is internally consistent: the totals divide
 * by 1 240 kept to give `perUnit`, and the two months sum to the totals. A
 * fixture whose numbers do not add up would let a screen that mis-divides
 * them look correct.
 *
 * `coverage` HAS ONE OF EACH so the disclosure banner's three arms are all
 * exercised — including `uncosted`, the one that means the headline is an
 * UNDERSTATEMENT and the screen has to say so.
 */
export const returnCostAnalytics: ReturnCostAnalytics = {
  generatedAt: NOW,
  range: '90',
  rates: { unitCostMinor: 10000, unitMarketCostMinor: 85000, currency: 'NGN' },
  totals: {
    returns: 96,
    unitsKept: 1240,
    unitsRejected: 61,
    rewardMinor: 12400000,
    transportMinor: 19840000,
    localMinor: 4960000,
    driverMinor: 1240000,
    feesMinor: 620000,
    collectionMinor: 26660000,
    allInMinor: 39060000,
  },
  perUnit: { allIn: 31500, reward: 10000, transport: 16000, local: 4000, driver: 1000, fees: 500 },
  byMonth: [
    {
      month: '2026-07',
      unitsKept: 500,
      rewardMinor: 5000000,
      transportMinor: 9000000,
      localMinor: 2000000,
      driverMinor: 500000,
      feesMinor: 250000,
      allInMinor: 16750000,
      perUnitMinor: 33500,
    },
    {
      month: '2026-08',
      unitsKept: 740,
      rewardMinor: 7400000,
      transportMinor: 10840000,
      localMinor: 2960000,
      driverMinor: 740000,
      feesMinor: 370000,
      allInMinor: 22310000,
      perUnitMinor: 30149,
    },
  ],
  byArea: [
    {
      areaId: turnipArea.id,
      region: turnipArea.region,
      name: turnipArea.name,
      returns: 12,
      unitsKept: 140,
      rewardMinor: 1400000,
      collectionMinor: 7000000,
      allInMinor: 8400000,
      perUnitMinor: 60000,
      estimated: 4,
    },
    {
      areaId: cabbageArea.id,
      region: cabbageArea.region,
      name: cabbageArea.name,
      returns: 80,
      unitsKept: 1080,
      rewardMinor: 10800000,
      collectionMinor: 18660000,
      allInMinor: 29460000,
      perUnitMinor: 27278,
      estimated: 0,
    },
    /* The out-of-area group: the ABSENCE of a district, so its id is null
     * rather than a fabricated one. The screen must name it rather than
     * render a blank cell. */
    {
      areaId: null,
      region: null,
      name: null,
      returns: 4,
      unitsKept: 20,
      rewardMinor: 200000,
      collectionMinor: 1000000,
      allInMinor: 1200000,
      perUnitMinor: 60000,
      estimated: 4,
    },
  ],
  costliest: [
    {
      id: 'ret_tunde_1',
      customerEmail: 'tunde@example.com',
      customerName: 'Tunde B.',
      areaName: turnipArea.name,
      closedAt: NOW - 3 * DAY,
      unitsKept: 4,
      allInMinor: 440000,
      perUnitMinor: 110000,
      estimated: false,
    },
    {
      id: 'ret_dara_0',
      customerEmail: 'dara@example.com',
      customerName: 'Dara A.',
      areaName: null,
      closedAt: NOW - 9 * DAY,
      unitsKept: 6,
      allInMinor: 360000,
      perUnitMinor: 60000,
      estimated: true,
    },
  ],
  coverage: { recorded: 78, estimated: 14, uncosted: 4 },
};

/** The first day of the programme: nothing settled, so every per-item figure
 *  divides by zero and the screen must say so rather than print ₦0. */
export const emptyReturnCostAnalytics: ReturnCostAnalytics = {
  generatedAt: NOW,
  range: '90',
  rates: { unitCostMinor: null, unitMarketCostMinor: null, currency: 'NGN' },
  totals: {
    returns: 0,
    unitsKept: 0,
    unitsRejected: 0,
    rewardMinor: 0,
    transportMinor: 0,
    localMinor: 0,
    driverMinor: 0,
    feesMinor: 0,
    collectionMinor: 0,
    allInMinor: 0,
  },
  perUnit: { allIn: 0, reward: 0, transport: 0, local: 0, driver: 0, fees: 0 },
  byMonth: [],
  byArea: [],
  costliest: [],
  coverage: { recorded: 0, estimated: 0, uncosted: 0 },
};

/** A deployment on its first day: real zeros, not skeletons, and every arm of
 *  the first-run checklist still showing. */
export const freshSummary: MarketingSummary = {
  tiles: {
    needsScheduling: { count: 0, oldestAgeMs: null },
    outForPickup: { count: 0, nextPickupAt: null },
    toInspect: { count: 0, oldestAgeMs: null },
    awarded30d: { points: 0, returns: 0 },
  },
  oldestOpen: [],
  latestLedger: [],
  banners: [],
  pendingEmailIntents: 0,
};
