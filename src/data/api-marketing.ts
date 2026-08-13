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
import { apiFetch } from './api';
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

// -------------------------------------------------------------------- client

/*
 * Stream B fills this in (plan Task B1). It stays an object rather than loose
 * functions for the same reason `shopApi` does: one import per screen, and a
 * mock in a test replaces one thing.
 */
export const marketingApi = {
  getSummary: () => apiFetch<MarketingSummary>('/marketing/summary'),
};

export type { Page } from './api';
export { seg };
