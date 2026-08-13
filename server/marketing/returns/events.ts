import { sql } from 'drizzle-orm';
import { escapeHtml } from '../../email/render';
import { awardSentence, awardedSubject, fmtUnits } from '../../../shared/marketing/copy';
import type { SQL } from 'drizzle-orm';
import type { ProgramLabels } from '../../../shared/marketing/copy';
import type { ActorType } from '../ledger/fragments';

/**
 * Everything a transition owes BESIDES the request row itself — the timeline
 * entry and the customer's notification — as fragments, plus the words that
 * notification is made of.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE FRAGMENTS: the `server/shop/catalog/events.ts` argument,
 * unchanged. A history entry that can be lost while its cause commits is worse
 * than no entry, because the system then believes something happened that
 * nobody will act on — and here the something is money. `db.transaction` throws
 * on the Neon HTTP driver, so "the same transaction" has to mean "the same
 * statement": both builders below emit `INSERT … SELECT … FROM <cte>`, and a CAS
 * that matched nothing therefore writes neither of them.
 *
 * WHY THE COPY IS IN THE SAME FILE AS THE SQL. The notification's subject and
 * body are COLUMNS — pre-rendered at write time from the labels of that instant
 * (spec D6) — so the words are not decoration on top of the row, they are part
 * of it. Rendering them anywhere further from the insert invites the one bug
 * this whole arrangement exists to prevent: a body rendered at DELIVERY time
 * against labels the shop has since renamed, telling a customer they earned
 * something nobody ever promised them.
 *
 * THE SENTENCE ITSELF IS NOT WRITTEN HERE. `awardSentence` and `awardedSubject`
 * come from `shared/marketing/copy.ts`, which the admin UI also imports — so the
 * live line under the inspection form, the confirm dialog, the success toast and
 * the customer's inbox carry ONE string rather than four that agreed on the day
 * they were written (spec D11). `server/shop/cart/totals/compute.ts` already
 * imports `shared/commerce` across the same boundary.
 *
 * NOTE FOR A7 (`notify/mailer.ts`): the two renderers below are the ones that
 * task's `renderReturnAwarded` / `renderReturnRejected` name. They live here
 * because A4's inspect statement must write the rendered body in the SAME
 * statement as the award, which is three tasks before the notify subsystem
 * exists. Import them there; a second implementation would be a second wording
 * of a message a customer keeps forever.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** `marketing_return_events_type_ck`, in TypeScript. */
export type ReturnEventType =
  | 'requested'
  | 'scheduled'
  | 'collected'
  | 'received'
  | 'inspected'
  | 'rejected'
  | 'cancelled'
  | 'note';

/** `marketing_email_intents_kind_ck` — the two outcomes of an inspection. */
export type EmailIntentKind = 'return_awarded' | 'return_rejected';

export interface TimelineEntryDraft {
  /** A FROM clause rooted in a preceding data-modifying CTE. ZERO ROWS THERE
   *  MEANS ZERO EVENTS — the guarantee, and why this takes a clause. */
  from: SQL;
  id: string;
  /** An expression over `from` — `upd.id`. Never a bound id copied from the
   *  request, which would record history for a row the CAS did not move. */
  requestId: SQL;
  type: ReturnEventType;
  actorType: ActorType;
  actorId: string | null;
  /** The human sentence, when there is one: a note, a rejection reason. */
  note: string | null;
  /** Structured history. For `inspected` this carries the counts AND the label
   *  values as they read at that instant (spec D2d) — a rename then changes the
   *  future and never the past. */
  data: Record<string, unknown> | null;
  occurredAt: number;
}

export function timelineEntryFragment(entry: TimelineEntryDraft): SQL {
  /*
   * `NULL::jsonb` rather than a bound `null`: a parameter in a SELECT list has
   * no target column to infer from, and an untyped NULL is SQLSTATE 42P18 at run
   * time rather than at build time. Every other value below is cast for the same
   * reason.
   */
  const data =
    entry.data === null ? sql`NULL::jsonb` : sql`${JSON.stringify(entry.data)}::jsonb`;

  return sql`
    INSERT INTO marketing_return_events
      (id, request_id, type, actor_type, actor_id, note, data, occurred_at)
    SELECT ${entry.id}::text, (${entry.requestId})::text, ${entry.type}::text,
           ${entry.actorType}::text, ${entry.actorId}::text, ${entry.note}::text,
           ${data}, ${entry.occurredAt}::bigint
      FROM ${entry.from}
    RETURNING id, type, actor_type, actor_id, note, data, occurred_at`;
}

/** The columns `timelineEntryFragment` returns, for an outer SELECT that wants
 *  the row back — `addNote` is the one caller that does. A transition ignores
 *  them; a `RETURNING` nothing selects from still executes. */
export const TIMELINE_COLUMNS = sql.raw(
  'id, type, actor_type, actor_id, note, data, occurred_at',
);

export interface EmailIntentDraft {
  from: SQL;
  id: string;
  kind: EmailIntentKind;
  requestId: SQL;
  toEmail: SQL;
  subject: string;
  text: string;
  html: string;
  createdAt: number;
}

/**
 * The outbox row, written in the same statement as the transition that owes it.
 *
 * `ON CONFLICT (dedupe_key) DO NOTHING` IS THE IDEMPOTENCY, and it is a
 * constraint rather than a check: `'<kind>:<request_id>'` is UNIQUE, so a
 * replayed inspect — an admin's second tap on a flaky connection — writes no
 * second mail even though it arrives as a complete second statement. One
 * message per outcome per return, structurally.
 */
export function emailIntentFragment(intent: EmailIntentDraft): SQL {
  /*
   * THE KEY IS BUILT IN SQL, off the same expression that fills
   * `return_request_id`. Passing it in as a string would let the two disagree —
   * a key naming one request stored against another — and the whole value of the
   * UNIQUE is that it names the thing being deduplicated. `dedupeKeyFor` below is
   * the TypeScript twin for readers that need to NAME an intent rather than write
   * one; the format lives in both, and `repo.test.ts` compares them.
   */
  const dedupeKey = sql`${intent.kind}::text || ':' || (${intent.requestId})::text`;

  return sql`
    INSERT INTO marketing_email_intents
      (id, kind, return_request_id, dedupe_key, to_email, subject, "text", html, created_at)
    SELECT ${intent.id}::text, ${intent.kind}::text, (${intent.requestId})::text,
           ${dedupeKey}, (${intent.toEmail})::text,
           ${intent.subject}::text, ${intent.text}::text, ${intent.html}::text,
           ${intent.createdAt}::bigint
      FROM ${intent.from}
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1`;
}

// ------------------------------------------------------------------- the words

/** What a notification is rendered from — the request's own snapshot, never a
 *  join taken at delivery time. */
export interface ReturnMailView {
  customerEmail: string;
  qtyAccepted: number;
  qtyRejected: number;
  /** The rate the customer was PROMISED, copied onto the row at creation. */
  pointsPerUnitSnapshot: number;
  rejectedReason: string | null;
}

export interface RenderedNotification {
  subject: string;
  text: string;
  html: string;
}

/**
 * The awarded mail.
 *
 * ITS FIRST LINE IS THE SENTENCE THAT TRAVELS, verbatim — the same string the
 * admin saw under the inspection form and confirmed in the dialog. That is what
 * makes a dispute reconstructible: whatever surface either side quotes, the
 * arithmetic is inside the sentence rather than implied by it.
 */
export function renderReturnAwarded(
  request: ReturnMailView,
  labels: ProgramLabels,
): RenderedNotification {
  const points = request.qtyAccepted * request.pointsPerUnitSnapshot;
  const sentence = awardSentence(
    labels,
    request.qtyAccepted,
    request.pointsPerUnitSnapshot,
    request.customerEmail,
  );
  const shortfall =
    request.qtyRejected > 0
      ? ` We could not accept ${fmtUnits(request.qtyRejected, labels)}${
          request.rejectedReason === null ? '' : ` — ${request.rejectedReason}`
        }.`
      : '';
  const detail = `We have finished checking your ${labels.name} return: ${fmtUnits(
    request.qtyAccepted,
    labels,
  )} accepted.${shortfall}`;

  return {
    subject: awardedSubject(labels, points),
    text: `${sentence}\n\n${detail}\n`,
    html: paragraphs([sentence, detail]),
  };
}

/**
 * The rejected mail — an inspection that accepted nothing.
 *
 * NO QUANTITY ARITHMETIC IN THE COPY, because there is no honest number to
 * lead with: nothing was accepted, and a driver who came back empty makes the
 * rejected count zero too. What the customer needs is the outcome and the
 * reason, both in words this deployment chose.
 */
export function renderReturnRejected(
  request: ReturnMailView,
  labels: ProgramLabels,
): RenderedNotification {
  const outcome =
    `We have finished checking your ${labels.name} return, and it did not earn ` +
    `${labels.points.other} this time.`;
  const reason = request.rejectedReason === null ? [] : [`Reason: ${request.rejectedReason}`];
  const invitation = 'If you think that is wrong, reply to this message and we will look again.';
  const lines = [outcome, ...reason, invitation];

  return {
    subject: `About your ${labels.name} return`,
    text: `${lines.join('\n\n')}\n`,
    html: paragraphs(lines),
  };
}

/**
 * `'<kind>:<request_id>'`, the dedupe key spec D6 freezes.
 *
 * Exported because the sweeper and any future re-send path have to be able to
 * name an intent without re-deriving the format, and because a key built two
 * ways is a key that stops deduplicating the day one of them gains a space.
 */
export function dedupeKeyFor(kind: EmailIntentKind, requestId: string): string {
  return `${kind}:${requestId}`;
}

/** Wrap a list of sentences as HTML paragraphs, ESCAPED. */
function paragraphs(lines: readonly string[]): string {
  /*
   * `escapeHtml` is IMPORTED rather than copied, unlike `newId` in
   * `server/marketing/ids.ts`. That copy exists because spec D9 forbids
   * importing `server/shop/**` at all; nothing forbids `server/email/render.ts`,
   * and an HTML escaper is the wrong thing to have two of — the second copy is
   * the one that forgets `'`, and every value interpolated here (the program's
   * name, its points word, a rejection reason, the customer's own address) is
   * something a person typed into a form.
   */
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
}
