import { sql } from 'drizzle-orm';
import { escapeHtml } from '../../email/render';
import { BUILT_IN } from '../../email/system-templates';
import { p } from '../../mail/brand';
import { render } from '../../mail/transactional';
import { awardSentence, fmtPoints, fmtUnits } from '../../../shared/marketing/copy';
import type { SQL } from 'drizzle-orm';
import type { TemplateSet } from '../../email/system-templates';
import type { TemplateValues } from '../../mail/transactional';
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
 * THE SENTENCE ITSELF IS NOT WRITTEN HERE. `awardSentence` comes from
 * `shared/marketing/copy.ts`, which the admin UI also imports — so the live line
 * under the inspection form, the confirm dialog, the success toast and the
 * customer's inbox carry ONE string rather than four that agreed on the day they
 * were written (spec D11). `server/shop/cart/totals/compute.ts` already imports
 * `shared/commerce` across the same boundary.
 *
 * ═══════════════ THE LETTER ITSELF IS AN EDITABLE DEFAULT TEMPLATE ═══════════
 * `renderReturnAwarded` / `renderReturnRejected` do not build a subject or an
 * HTML document by hand — that is `server/mail/defaults.ts`'s `return.awarded`
 * and `return.rejected`, on the exact footing as `order.confirmation` and every
 * other message the shop sends itself: seeded into `email_templates` on first
 * read, editable by an owner from Emails → Templates, refused a delete or a
 * rename by the same trigger, and rendered through the same `{{…}}` engine
 * (`server/mail/transactional.ts`). What THIS FILE still owns is the VALUES —
 * `ProgramLabels` read at the instant of the award, turned into scalars and
 * blocks — because that step cannot move: A4's inspect statement needs the
 * rendered subject/text/html as plain strings to write in the same statement as
 * the award, and a template read is an `await` a SQL statement builder cannot
 * make. `server/shop/orders/mailer.ts`'s `renderKind`/`baseValues` do the same
 * split for order mail, one layer up because that pipeline has no such
 * statement-builder constraint.
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
 * The awarded mail — rendered from the editable `return.awarded` default
 * (`server/mail/defaults.ts`), exactly as `server/shop/orders/mailer.ts`'s
 * `renderConfirmation` renders `order.confirmation`.
 *
 * `templates` DEFAULTS TO `BUILT_IN` for the same reason every order render
 * function does: every existing caller — every test in this subsystem's
 * suites, and any future one that forgets the argument — still gets the
 * correct, branded, label-driven message rather than a compile error or a
 * blank. `repo.ts`'s `inspect()` is the one caller that threads a REAL
 * `TemplateSet` through, resolved once per request by the route.
 *
 * `{{award_sentence}}` CARRIES `awardSentence`'S OUTPUT WHOLE. Its first line
 * is that sentence verbatim — the same string the admin saw under the
 * inspection form and confirmed in the dialog — because it is substituted as
 * ONE placeholder rather than reassembled from smaller ones: an operator can
 * move it around the letter but cannot reword the arithmetic inside it. That
 * is what makes a dispute reconstructible, unchanged from before this letter
 * became an editable template.
 */
export function renderReturnAwarded(
  request: ReturnMailView,
  labels: ProgramLabels,
  templates: TemplateSet = BUILT_IN,
): RenderedNotification {
  const points = request.qtyAccepted * request.pointsPerUnitSnapshot;
  const sentence = awardSentence(
    labels,
    request.qtyAccepted,
    request.pointsPerUnitSnapshot,
    request.customerEmail,
  );
  /*
   * INLINE-APPENDED, NOT ITS OWN PARAGRAPH — it finishes the sentence the
   * default template starts ("…accepted.{{shortfall_note}}"), matching how
   * this shortfall has always read. A SCALAR, not a block: the whole composed
   * sentence — including a rejection reason a person typed — is escaped as
   * one unit on the way into the html part, the same guarantee `paragraphs()`
   * used to give per line.
   */
  const shortfallNote =
    request.qtyRejected > 0
      ? ` We could not accept ${fmtUnits(request.qtyRejected, labels)}${
          request.rejectedReason === null ? '' : ` — ${request.rejectedReason}`
        }.`
      : '';

  const values: TemplateValues = {
    scalars: {
      points_awarded: fmtPoints(points, labels),
      award_sentence: sentence,
      program_name: labels.name,
      qty_accepted_units: fmtUnits(request.qtyAccepted, labels),
      shortfall_note: shortfallNote,
    },
    blocks: {},
  };

  const message = render(templates.get('return.awarded'), request.customerEmail, values);
  return { subject: message.subject, text: message.body, html: message.html };
}

/**
 * The rejected mail — an inspection that accepted nothing. Rendered from the
 * editable `return.rejected` default, on the same footing as the award letter
 * above.
 *
 * NO QUANTITY ARITHMETIC IN THE COPY, because there is no honest number to
 * lead with: nothing was accepted, and a driver who came back empty makes the
 * rejected count zero too. What the customer needs is the outcome and the
 * reason, both in words the template — an operator's, or this default —
 * chooses.
 */
export function renderReturnRejected(
  request: ReturnMailView,
  labels: ProgramLabels,
  templates: TemplateSet = BUILT_IN,
): RenderedNotification {
  /*
   * A BLOCK, NOT A SCALAR — it is either nothing or a whole extra paragraph,
   * the same shape `server/shop/orders/mailer.ts`'s `tracking_panel` uses for
   * a fulfilment with no tracking number. Blocks are inserted RAW
   * (`server/mail/transactional.ts`), so the reason — something a person
   * typed — is escaped by hand here exactly as `paragraphs()` used to escape
   * every line.
   */
  const reasonNote =
    request.rejectedReason === null
      ? { html: '', text: '' }
      : {
          html: p(`Reason: ${escapeHtml(request.rejectedReason)}`),
          text: `Reason: ${request.rejectedReason}\n\n`,
        };

  const values: TemplateValues = {
    scalars: {
      program_name: labels.name,
      points_word: labels.points.other,
    },
    blocks: { reason_note: reasonNote },
  };

  const message = render(templates.get('return.rejected'), request.customerEmail, values);
  return { subject: message.subject, text: message.body, html: message.html };
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
