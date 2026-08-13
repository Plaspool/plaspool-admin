/**
 * The marketing section's half of the wire: rewards programs, the returns
 * pipeline, the points ledger, banners, discount codes.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api.ts`, for the reason
 * `api-email.ts` and `api-categories.ts` both give at the top of their own
 * files: `api.ts` is appended to by several writers at once, and a file several
 * writers append to is a file that loses a block. Not a second convention —
 * `apiFetch` below is `api.ts`'s own request function, so `credentials:
 * 'include'`, the error envelope and the §8 status table are the shared ones.
 *
 * THE TYPES BELOW ARE THE FROZEN CONTRACT (spec §Frozen API contract, 2026-08-13).
 * The backend and this screen layer are built simultaneously by two streams that
 * never read each other's code; this file is the only thing they agree on, so a
 * change here is a change to somebody else's half. Amend the spec first.
 *
 * NOTHING IN THIS FILE MAY SAY "SPOOL". Every customer-facing noun — the
 * program's name, its points word, its unit word — travels on the API response
 * that needs it, because a rewards program that can be renamed is a program
 * whose words cannot live in the client. "Spool Points" is seed data in
 * migration 0011 and nowhere else; `marketing-no-spool.test.ts` greps this file
 * and the screens to keep it that way.
 */
import { apiFetch, type Page } from './api';
import {
  awardSentence,
  awardedSubject,
  fmtPoints,
  fmtUnits,
  type ProgramLabels,
} from '../../shared/marketing/copy';
import {
  deriveBannerStatus,
  type BannerSchedule,
  type DerivedBannerStatus,
} from '../../shared/marketing/banners';

/*
 * Re-exported rather than redeclared: the server renders the same sentences into
 * the same mail, and `shared/` is where a rule both sides obey has to live. A
 * screen imports everything it needs from this one module.
 */
export {
  awardSentence,
  awardedSubject,
  deriveBannerStatus,
  fmtPoints,
  fmtUnits,
  type BannerSchedule,
  type DerivedBannerStatus,
  type ProgramLabels,
};

/** Path params are user data — an email is a path segment on three routes. */
const seg = (value: string): string => encodeURIComponent(value);

// ------------------------------------------------------------------ programs

export interface Program {
  id: string;
  /**
   * The immutable machine handle. Never in a PATCH body — the update schema is
   * `.strict()` and structurally omits this field, which is what makes renaming
   * safe: the words change, the identity does not.
   */
  key: string;
  kind: 'unit_return' | 'adhoc';
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  /** Null for `adhoc` programs — nothing is being counted. */
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
  minUnitsPerReturn: number | null;
  pointsPerUnit: number | null;
  status: 'active' | 'paused';
  /** Reserved extension point. Pinned to `{}` in v1 by the server's zod. */
  conditions: Record<string, never>;
  /**
   * True only for rows migration 0011 seeded. The "Seeded preset" chip reads
   * THIS — never `key === 'spool-return'`, which the grep guard forbids and
   * which would be wrong the moment a second preset ships.
   */
  seeded: boolean;
  awardedTotal: number;
  openReturns: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProgramDraft {
  key: string;
  kind: 'unit_return' | 'adhoc';
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular?: string;
  unitLabelPlural?: string;
  minUnitsPerReturn?: number;
  pointsPerUnit?: number;
}

/** Note the absent `key`/`kind`: sending either is a 400, by design. */
export interface ProgramPatch {
  expectedRevision: number;
  name?: string;
  pointsLabelSingular?: string;
  pointsLabelPlural?: string;
  unitLabelSingular?: string;
  unitLabelPlural?: string;
  minUnitsPerReturn?: number;
  pointsPerUnit?: number;
  status?: 'active' | 'paused';
}

/** The labels a screen formats with, lifted off whichever payload carried them. */
export function labelsOf(p: {
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
}): ProgramLabels {
  return {
    name: p.name,
    points: { one: p.pointsLabelSingular, other: p.pointsLabelPlural },
    unit:
      p.unitLabelSingular && p.unitLabelPlural
        ? { one: p.unitLabelSingular, other: p.unitLabelPlural }
        : null,
  };
}

// ------------------------------------------------------------------- returns

export type ReturnStatus =
  | 'requested'
  | 'scheduled'
  | 'collected'
  | 'received'
  | 'awarded'
  | 'rejected'
  | 'cancelled';

export type ReturnAction =
  | 'schedule'
  | 'collect'
  | 'receive'
  | 'inspect'
  | 'reject'
  | 'cancel'
  | 'note';

/** The label bundle every returns payload embeds, so no screen guesses words. */
export interface EmbeddedProgram {
  id: string;
  name: string;
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  unitLabelSingular: string | null;
  unitLabelPlural: string | null;
}

export interface ReturnListItem {
  id: string;
  status: ReturnStatus;
  /** On the LIST, not just the detail: the queue's inline actions are CAS writes. */
  revision: number;
  customerEmail: string;
  customerName: string | null;
  qtyDeclared: number;
  qtyAccepted: number | null;
  qtyRejected: number | null;
  pointsAwarded: number | null;
  pickupScheduledAt: number | null;
  pickupAddress: string | null;
  /**
   * ORDERED, and the order is contract: the pipeline-advancing action first,
   * then reject, cancel, note. The queue renders exactly one button and it is
   * `allowedActions[0]`, so a server that reorders this array silently rewrites
   * every row's primary control. Pinned by a test on both sides.
   */
  allowedActions: ReturnAction[];
  createdAt: number;
  updatedAt: number;
  program: EmbeddedProgram;
}

export interface ReturnEvent {
  id: string;
  type:
    | 'requested'
    | 'scheduled'
    | 'collected'
    | 'received'
    | 'inspected'
    | 'rejected'
    | 'cancelled'
    | 'note';
  actorType: 'admin' | 'customer' | 'system';
  actorId: string | null;
  note: string | null;
  /**
   * Render-final snapshot. The `inspected` event carries the quantities, the
   * points, AND the label wording that was true at the time — display it
   * verbatim; formatting it through today's labels would let a rename rewrite
   * what history says happened.
   */
  data: Record<string, unknown> | null;
  occurredAt: number;
}

export interface ReturnRequest {
  id: string;
  status: ReturnStatus;
  revision: number;
  customerEmail: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  pickupAddress: string | null;
  qtyDeclared: number;
  qtyAccepted: number | null;
  qtyRejected: number | null;
  /** Frozen when the request was made, so a repricing cannot change a promise. */
  pointsPerUnitSnapshot: number;
  pointsAwarded: number | null;
  rejectedReason: string | null;
  cancelReason: string | null;
  source: 'customer' | 'admin';
  pickupScheduledAt: number | null;
  driverName: string | null;
  driverPhone: string | null;
  scheduledAt: number | null;
  collectedAt: number | null;
  receivedAt: number | null;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
  allowedActions: ReturnAction[];
}

export interface EmailIntentState {
  kind: string;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
}

export interface ReturnDetail {
  request: ReturnRequest;
  program: EmbeddedProgram & {
    status: 'active' | 'paused';
    pointsPerUnit: number;
    minUnitsPerReturn: number;
  };
  events: ReturnEvent[];
  /** So the awarded screen can say "queued" honestly instead of faking "sent". */
  emailIntents: EmailIntentState[];
}

export interface ReturnCounts {
  requested: number;
  scheduled: number;
  collected: number;
  received: number;
  awarded: number;
  rejected: number;
  cancelled: number;
  /** requested + received — the two stages where the admin is the blocker. */
  needsAction: number;
}

export interface ReturnsPage {
  items: ReturnListItem[];
  nextCursor: string | null;
  counts: ReturnCounts;
}

export type ReturnsView =
  | 'needs_action'
  | 'requested'
  | 'scheduled'
  | 'collected'
  | 'received'
  | 'done'
  | 'all';

export interface ReturnIntake {
  email: string;
  qtyDeclared: number;
  programId?: string;
  customerName?: string;
  customerPhone?: string;
  pickupAddress?: string;
  note?: string;
}

// -------------------------------------------------------------------- ledger

export type LedgerKind = 'return_award' | 'manual' | 'redemption' | 'redemption_release';

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  delta: number;
  /** Stored at write time, so a row renders "120 → 180" without a window function. */
  balanceAfter: number;
  /** A render-final snapshot. Display verbatim — see `ReturnEvent.data`. */
  reason: string;
  programId: string | null;
  programName: string | null;
  returnRequestId: string | null;
  orderId: string | null;
  actorType: 'admin' | 'customer' | 'system';
  actorId: string | null;
  createdAt: number;
}

export interface CustomerRow {
  email: string;
  customerId: string | null;
  displayName: string | null;
  /** No account — earned under a checkout email. The default population here. */
  guest: boolean;
  balance: number;
  lifetimeEarned: number;
  lastEntryAt: number | null;
  lastEntry: { kind: LedgerKind; delta: number; reason: string } | null;
}

export interface CustomerSummary {
  email: string;
  customerId: string | null;
  displayName: string | null;
  balance: number;
  lifetimeEarned: number;
  openReturn: { id: string; status: ReturnStatus } | null;
}

export interface AdjustmentDraft {
  email: string;
  /** Non-zero. Negative is a debit, and a debit below zero is refused. */
  delta: number;
  reason: string;
  programId?: string;
  customerId?: string;
}

// ------------------------------------------------------------------ settings

export interface MarketingSettings {
  /** Cross-program words, for surfaces that span programs (balances, checkout). */
  pointsLabelSingular: string;
  pointsLabelPlural: string;
  redemptionEnabled: boolean;
  /** An integer rational: `ratePoints` points are worth `rateMinor` minor units. */
  redemptionRatePoints: number;
  redemptionRateMinor: number;
  redemptionCurrency: string;
  minRedeemPoints: number;
  /** Cap on the share of an order that points may pay, in basis points. */
  maxRedeemBps: number;
  defaultReturnProgramId: string | null;
  revision: number;
  updatedAt: number;
}

export interface SettingsPatch {
  expectedRevision: number;
  pointsLabelSingular?: string;
  pointsLabelPlural?: string;
  redemptionEnabled?: boolean;
  redemptionRatePoints?: number;
  redemptionRateMinor?: number;
  redemptionCurrency?: string;
  minRedeemPoints?: number;
  maxRedeemBps?: number;
  defaultReturnProgramId?: string | null;
}

/** Settings-level labels, for the balance tiles that are not about one program. */
export function settingsLabels(s: MarketingSettings): ProgramLabels {
  return {
    name: '',
    points: { one: s.pointsLabelSingular, other: s.pointsLabelPlural },
    unit: null,
  };
}

// ------------------------------------------------------------------- banners

export interface Banner {
  id: string;
  title: string;
  body: string;
  ctaText: string | null;
  ctaUrl: string | null;
  placement: 'top_bar' | 'popup' | 'section';
  /** Stored intent. What the site shows is this crossed with the clock. */
  status: 'draft' | 'live' | 'archived';
  startsAt: number | null;
  endsAt: number | null;
  priority: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface BannerDraft {
  title: string;
  body?: string;
  ctaText?: string | null;
  ctaUrl?: string | null;
  placement: 'top_bar' | 'popup' | 'section';
  startsAt?: number | null;
  endsAt?: number | null;
  priority?: number;
}

export interface BannerPatch extends Partial<BannerDraft> {
  expectedRevision: number;
  /** Archiving is a status change. There is no DELETE — a banner that ran is history. */
  status?: 'draft' | 'live' | 'archived';
}

// ----------------------------------------------------------------- discounts

export interface Discount {
  id: string;
  code: string;
  kind: 'percent' | 'fixed_amount';
  percentBps: number | null;
  amountMinor: number | null;
  currency: string | null;
  status: 'active' | 'disabled';
  startsAt: number | null;
  endsAt: number | null;
  maxRedemptions: number | null;
  redeemedCount: number;
  note: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

// ------------------------------------------------------------------- summary

export interface MarketingSummary {
  tiles: {
    needsScheduling: { count: number; oldestAgeMs: number | null };
    outForPickup: { count: number; nextPickupAt: number | null };
    toInspect: { count: number; oldestAgeMs: number | null };
    awarded30d: { points: number; returns: number };
  };
  /** ≤5, oldest first. */
  oldestOpen: ReturnListItem[];
  /** ≤8. Carries the email because the Overview is not scoped to one customer. */
  latestLedger: (LedgerEntry & { customerEmail: string })[];
  /** Non-archived only; the client derives each one's display status. */
  banners: Banner[];
  /** Queued mail, so a dropped sweep is visible rather than silent. */
  pendingEmailIntents: number;
}

// ------------------------------------------------------------- write bodies

/** `POST /returns/:id/schedule`. Legal from `requested` AND from `scheduled` —
 *  a reschedule is a second `scheduled` event, not a silent edit of the first. */
export interface ScheduleDraft {
  expectedRevision: number;
  /** Epoch-ms. The form's date input is local; the caller converts. */
  pickupAt: number;
  driverName?: string;
  driverPhone?: string;
  /** Required only when the row carries no address yet — the server checks both. */
  pickupAddress?: string;
  note?: string;
}

/**
 * `POST /returns/:id/inspect` — the one write that awards anything.
 *
 * `qtyRejected` IS DERIVED IN THE UI AND TYPED BY NOBODY (spec D5): staff enter
 * Received and Accepted, the screen subtracts, and the classic "your numbers
 * don't add up" validation error cannot happen because there is no third box to
 * disagree with. It still travels on the wire because the server records both
 * counts and the DB's award CHECK is written over them.
 */
export interface InspectDraft {
  expectedRevision: number;
  qtyAccepted: number;
  qtyRejected: number;
  /** Required by the server iff `qtyRejected > 0`; a 400 names this field. */
  rejectedReason?: string;
  note?: string;
}

export interface InspectResult {
  request: ReturnRequest;
  /** Null when nothing was accepted — the request went to `rejected` and no
   *  ledger row exists to point at. */
  award: { points: number; balance: number } | null;
}

export interface AdjustmentResult {
  entry: LedgerEntry;
  balance: number;
}

/** `?kind=` on the ledger. `awards`/`manual`/`redemptions` are groups of ledger
 *  kinds, not the kinds themselves — `redemptions` covers the release rows too. */
export type LedgerFilter = 'awards' | 'manual' | 'redemptions' | 'all';

export interface SweepResult {
  sent: number;
  failed: number;
  skipped: number;
}

// -------------------------------------------------------------------- client

const BASE = '/marketing';

/**
 * Drop the optional text fields a form left empty.
 *
 * An untouched optional input is `''`, and `''` is not "absent" to a schema
 * built from `str().min(1).optional()` — it is a present value that fails, i.e.
 * a 400 naming a field the operator never filled in. `api-shop.ts` does the
 * same thing inline for a price's `reason`; this is that rule with a name.
 *
 * `null` AND `0` AND `false` SURVIVE, deliberately. `null` is how a banner
 * clears its end date and how settings clear the default program — dropping it
 * would turn "unset this" into "leave it alone", which is the worst kind of
 * silent no-op: the form says saved and the value is still there.
 *
 * Applied ONLY to the bodies whose optional fields are genuinely optional
 * (intake, transitions, adjustments). Program/settings/banner patches are left
 * alone on purpose: every field those forms show is one the operator meant, so
 * an empty required label has to come back as a 400 they can see rather than a
 * key that quietly never left the browser.
 */
function filled<T extends object>(body: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === '') continue;
    out[key] = value;
  }
  return out as T;
}

/**
 * The five plain transitions, which differ only in a path segment and a body.
 *
 * THE RESPONSE ENVELOPE IS `{ request }`, AND THE CONTRACT STATES THAT OUTRIGHT
 * ONLY FOR `/inspect` (#11 → `{request, award}`). The other five are read as the
 * same wrapper by parallel construction: it is the shape `/inspect` has, the
 * shape every other write on this surface has (`{program}`, `{banner}`,
 * `{event}`), and the key the 409 payloads carry the re-read entity under. Named
 * here rather than assumed silently — if the backend stream answers a bare row
 * this function is the single line that changes, and no screen notices, because
 * every one of them re-reads the detail after a mutation for the timeline.
 */
async function transition(
  id: string,
  action: 'schedule' | 'collect' | 'receive' | 'reject' | 'cancel',
  body: { expectedRevision: number } & Record<string, unknown>,
): Promise<ReturnRequest> {
  const res = await apiFetch<{ request: ReturnRequest }>(
    `${BASE}/returns/${seg(id)}/${action}`,
    { method: 'POST', body: filled(body), id, subject: 'Return' },
  );
  return res.request;
}

/**
 * ONE FUNCTION PER CONTRACT ROW, AND NO FUNCTION THAT IS NOT ONE.
 *
 * An object rather than loose exports for the reason `shopApi` is one: a screen
 * imports a single name, and a suite that needs to fake the whole surface fakes
 * one thing. Everything goes through `apiFetch`, so the session cookie, the
 * error envelope and §8's status table are the shared ones — this module has no
 * dialect of its own.
 *
 * Two conventions the routes impose, both easy to get wrong in a way that only
 * shows up as a 400 in production:
 *
 *  - **Queries travel in the options object**, never in a template string, so
 *    `url()` drops the empty ones. Every query schema is `.strict()`, and
 *    `?q=` with nothing after it is a present field with an unacceptable value.
 *  - **Path params go through `seg()`.** Three routes take an EMAIL as a path
 *    segment, and `+` in a local part is a legal character that means something
 *    else entirely once it is in a URL.
 *
 * The public pair — `GET /api/public/marketing/{banners,rewards}` — has no
 * client here on purpose: it is cookieless, cached, and belongs to the
 * storefront. So does `POST /api/marketing/returns/request`, the customer-facing
 * intake; the admin's own intake is `createReturn` below.
 */
export const marketingApi = {
  // -------------------------------------------------------------- programs
  /** #1. Carries `awardedTotal`/`openReturns` aggregates — the table's columns. */
  async listPrograms(signal?: AbortSignal): Promise<Program[]> {
    const res = await apiFetch<{ programs: Program[] }>(`${BASE}/programs`, { signal });
    return res.programs ?? [];
  },

  /** #2. OWNER-ONLY, 201. Unit fields are required iff `kind: 'unit_return'`. */
  async createProgram(draft: ProgramDraft): Promise<Program> {
    const res = await apiFetch<{ program: Program }>(`${BASE}/programs`, {
      method: 'POST',
      body: draft,
      subject: 'Program',
    });
    return res.program;
  },

  /**
   * #3. OWNER-ONLY, CAS.
   *
   * `ProgramPatch` HAS NO `key` AND NO `kind`, and that absence is the whole
   * rename-safety story on this side of the wire: the server's schema is
   * `.strict()`, so a body carrying either is a 400 rather than a program whose
   * stable handle just moved under every ledger row that references it.
   */
  async patchProgram(id: string, patch: ProgramPatch): Promise<Program> {
    const res = await apiFetch<{ program: Program }>(`${BASE}/programs/${seg(id)}`, {
      method: 'PATCH',
      body: patch,
      id,
      subject: 'Program',
    });
    return res.program;
  },

  // --------------------------------------------------------------- returns
  /**
   * #4. The queue.
   *
   * `view` is first and required because there is no unfiltered queue in the
   * UI — the screen opens on `needs_action` and every tab is a view. The rest
   * ride in an options object rather than three more positional strings, so
   * that transposing a search term and a program id is a type error instead of
   * a filter that quietly matches nothing.
   *
   * `counts` comes back on EVERY response, not from a second request: the tab
   * strip shows real aggregates, which is what makes counted tabs honest here
   * (`shop.css`'s objection to fake ones).
   */
  async listReturns(
    view: ReturnsView,
    query: { q?: string; programId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ReturnsPage> {
    return apiFetch<ReturnsPage>(`${BASE}/returns`, { query: { view, ...query }, signal });
  },

  /** #5. The ADMIN intake, 201 with the full detail. Program defaults to
   *  `settings.defaultReturnProgramId` server-side when none is named. */
  async createReturn(intake: ReturnIntake): Promise<ReturnDetail> {
    return apiFetch<ReturnDetail>(`${BASE}/returns`, {
      method: 'POST',
      body: filled(intake),
      subject: 'Return',
    });
  },

  /** #7. Request + program labels + timeline + mail state, in one read. */
  async getReturn(id: string, signal?: AbortSignal): Promise<ReturnDetail> {
    return apiFetch<ReturnDetail>(`${BASE}/returns/${seg(id)}`, {
      id,
      subject: 'Return',
      signal,
    });
  },

  /** #8. Also the reschedule: `scheduled → scheduled` is legal and emits a
   *  second `scheduled` event, so the history shows the pickup moved. */
  async schedule(id: string, draft: ScheduleDraft): Promise<ReturnRequest> {
    return transition(id, 'schedule', { ...draft });
  },

  /** #9. From `scheduled`. The driver has the goods. */
  async collect(id: string, draft: { expectedRevision: number; note?: string }): Promise<ReturnRequest> {
    return transition(id, 'collect', { ...draft });
  },

  /** #10. From `collected`. The goods are at the warehouse, uninspected. */
  async receive(id: string, draft: { expectedRevision: number; note?: string }): Promise<ReturnRequest> {
    return transition(id, 'receive', { ...draft });
  },

  /**
   * #11. THE WRITE. From `received` only — awarding before inspection is an
   * `invalid_transition`, not a shortcut.
   *
   * Replaying one that already succeeded answers `409 already_awarded {entryId}`,
   * which the caller treats as SUCCESS: it means the first attempt landed and the
   * response to it was lost, so a retry after a dropped connection is safe.
   */
  async inspect(id: string, draft: InspectDraft): Promise<InspectResult> {
    return apiFetch<InspectResult>(`${BASE}/returns/${seg(id)}/inspect`, {
      method: 'POST',
      body: filled(draft),
      id,
      subject: 'Return',
    });
  },

  /** #12. Pre-receipt refusal only. Once goods are in hand the honest route is
   *  `inspect` with `qtyAccepted: 0`, so the quantities are still recorded. */
  async reject(id: string, draft: { expectedRevision: number; reason: string }): Promise<ReturnRequest> {
    return transition(id, 'reject', { ...draft });
  },

  /** #13. From requested/scheduled/collected — `collected` is deliberately
   *  cancellable, because that is the lost-in-transit escape. */
  async cancel(id: string, draft: { expectedRevision: number; reason?: string }): Promise<ReturnRequest> {
    return transition(id, 'cancel', { ...draft });
  },

  /** #14. 201. Legal in every state and it bumps nothing — a note is not an edit. */
  async addNote(id: string, note: string): Promise<ReturnEvent> {
    const res = await apiFetch<{ event: ReturnEvent }>(`${BASE}/returns/${seg(id)}/notes`, {
      method: 'POST',
      body: { note },
      id,
      subject: 'Return',
    });
    return res.event;
  },

  // ------------------------------------------------------------- customers
  /**
   * #15. `query` matches an email prefix OR a customer-id prefix, over the union
   * of balance-holders and a read-only search of the shop's own customers — so
   * somebody with no points history is findable and creditable.
   *
   * `query`, NOT `q`: the returns list uses `q` and this one uses `query`. Both
   * schemas are `.strict()`, so the two are not interchangeable and the mistake
   * is a 400 rather than an ignored filter. Copied from the contract, not
   * remembered.
   *
   * An empty query is not an empty result — it is the "Recently active" list,
   * ordered by last entry.
   */
  async listCustomers(
    query: { query?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<CustomerRow>> {
    return apiFetch<Page<CustomerRow>>(`${BASE}/customers`, { query: { ...query }, signal });
  },

  /**
   * #16. AN UNKNOWN EMAIL IS ZEROS, NOT A 404 — a customer with no history is a
   * customer with a zero balance, and the walk-in credit path depends on it: the
   * Customers screen offers "Credit <typed email> anyway" for an address nothing
   * matched, and that link opens this.
   */
  async getCustomer(email: string, signal?: AbortSignal): Promise<CustomerSummary> {
    return apiFetch<CustomerSummary>(`${BASE}/customers/${seg(email)}`, {
      id: email,
      subject: 'Customer',
      signal,
    });
  },

  /** #17. Keyset, newest first. `reason` on every row is a SNAPSHOT — render it
   *  verbatim, never through today's labels. */
  async getLedger(
    email: string,
    query: { kind?: LedgerFilter; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Page<LedgerEntry>> {
    return apiFetch<Page<LedgerEntry>>(`${BASE}/customers/${seg(email)}/ledger`, {
      query: { ...query },
      id: email,
      subject: 'Customer',
      signal,
    });
  },

  /**
   * #18. OWNER-ONLY, 201. A negative delta is a debit and a debit below zero is
   * refused by the column itself (`409 insufficient_balance {balance}`), not by
   * a check this client could get wrong.
   */
  async adjust(draft: AdjustmentDraft): Promise<AdjustmentResult> {
    return apiFetch<AdjustmentResult>(`${BASE}/adjustments`, {
      method: 'POST',
      body: filled(draft),
      subject: 'Customer',
    });
  },

  // -------------------------------------------------------------- settings
  /** #19. Readable by any staff — the balance tiles need the cross-program words. */
  async getSettings(signal?: AbortSignal): Promise<MarketingSettings> {
    const res = await apiFetch<{ settings: MarketingSettings }>(`${BASE}/settings`, { signal });
    return res.settings;
  },

  /**
   * #20. OWNER-ONLY, CAS.
   *
   * A `defaultReturnProgramId` naming a program that is no longer there answers
   * **400 `bad_request` detail `defaultReturnProgramId`**, not 404: a raced
   * Select is a field error beside the field, not a missing page.
   */
  async patchSettings(patch: SettingsPatch): Promise<MarketingSettings> {
    const res = await apiFetch<{ settings: MarketingSettings }>(`${BASE}/settings`, {
      method: 'PATCH',
      body: patch,
    });
    return res.settings;
  },

  // --------------------------------------------------------------- banners
  /** #21. EVERY status, archived included — the display status is derived on
   *  this side by `deriveBannerStatus`, from the same rule the public WHERE uses. */
  async listBanners(signal?: AbortSignal): Promise<Banner[]> {
    const res = await apiFetch<{ banners: Banner[] }>(`${BASE}/banners`, { signal });
    return res.banners ?? [];
  },

  /** #22. 201, and it lands as a `draft`: nothing this screen creates is live
   *  until somebody switches it on. */
  async createBanner(draft: BannerDraft): Promise<Banner> {
    const res = await apiFetch<{ banner: Banner }>(`${BASE}/banners`, {
      method: 'POST',
      body: draft,
      subject: 'Banner',
    });
    return res.banner;
  },

  /** #23. CAS. Archiving is `status: 'archived'` through here — THERE IS NO
   *  DELETE ROUTE, because a banner that ran is a thing that happened. */
  async patchBanner(id: string, patch: BannerPatch): Promise<Banner> {
    const res = await apiFetch<{ banner: Banner }>(`${BASE}/banners/${seg(id)}`, {
      method: 'PATCH',
      body: patch,
      id,
      subject: 'Banner',
    });
    return res.banner;
  },

  // ------------------------------------------------------------- discounts
  /** #24. The model exists ahead of its screen; `/marketing/discounts` is an
   *  honest placeholder that fetches nothing, so nothing calls this yet. */
  async listDiscounts(signal?: AbortSignal): Promise<Discount[]> {
    const res = await apiFetch<{ discounts: Discount[] }>(`${BASE}/discounts`, { signal });
    return res.discounts ?? [];
  },

  // --------------------------------------------------------- summary + mail
  /** #28. Everything the Overview draws, in one request. */
  async getSummary(signal?: AbortSignal): Promise<MarketingSummary> {
    return apiFetch<MarketingSummary>(`${BASE}/summary`, { signal });
  },

  /**
   * #27. Drains the queued notifications. FIRE-AND-FORGET after an inspection:
   * nothing schedules this (both of the plan's daily cron slots are spent), so
   * the sweep that sends a customer's award mail is the one the admin's own
   * click triggers.
   *
   * A deployment with no mail transport answers **501 `mail_not_configured`**,
   * which is a setup banner and NEVER a retry loop — the intents stay queued and
   * `pendingEmailIntents` keeps them visible on the Overview.
   */
  async sweep(): Promise<SweepResult> {
    return apiFetch<SweepResult>(`${BASE}/sweep`, { method: 'POST', body: {} });
  },
};

export type MarketingApi = typeof marketingApi;

export type { Page } from './api';
export { seg };
