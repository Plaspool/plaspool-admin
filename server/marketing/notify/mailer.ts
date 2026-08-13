import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../db/client';
import type { EmailIntentKind } from '../returns/events';
import type { Mailer } from '../../mail/port';

/**
 * What a queued notification IS — the words, and the row they were frozen into.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE MESSAGE; `sweep.ts` IS THE DELIVERY. The split is the one
 * `server/shop/orders/repo/emails.ts` makes between rendering and sweeping, and
 * it is what makes spec D6's central rule structural rather than remembered:
 * **nothing is rendered at delivery time.** The sweeper reaches a message only
 * through `toMessage`, which copies four columns; there is no code path from it
 * to a renderer, so it cannot accidentally re-word a letter using labels the
 * shop has renamed since.
 *
 * THE RENDERERS ARE RE-EXPORTED, NOT REIMPLEMENTED. They live in
 * `../returns/events.ts` beside the INSERT that stores their output, because the
 * inspection has to write the rendered body in the SAME STATEMENT as the award
 * (D6, and `returns/repo.ts` explains why that statement cannot be split). A
 * second implementation here would be a second wording of a message a customer
 * keeps forever — the exact drift `shared/marketing/copy.ts` exists to prevent —
 * so this module names them where the notify subsystem's callers look for them
 * and adds nothing of its own to the words.
 *
 * NEITHER HALF KNOWS A NOUN. Every customer-facing word arrives as
 * `ProgramLabels` read off the program row at the instant of the award; the
 * shipped preset's wording exists only as seed data in migration 0011, and both
 * streams grep for it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export { renderReturnAwarded, renderReturnRejected } from '../returns/events';
export type { EmailIntentKind, RenderedNotification, ReturnMailView } from '../returns/events';

/**
 * One row of `marketing_email_intents`, as the sweeper reads it.
 *
 * `subject`, `text` and `html` are COLUMNS and not a rendering — they were
 * written by the transition that owed them. Reading them back is the whole of
 * what delivery does with the words.
 */
export interface MarketingEmailIntent {
  id: string;
  kind: EmailIntentKind;
  returnRequestId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  createdAt: number;
  sentAt: number | null;
  /** The CAS column. Claimed with `SET attempts = n + 1 WHERE attempts = n`. */
  attempts: number;
  lastError: string | null;
}

/**
 * The projection, in one place, so the SELECT and `rowToIntent` cannot drift.
 *
 * `"text"` IS QUOTED. The column is deliberately named after the message part it
 * carries (`schema.ts` explains the choice), and unquoted `text` in a select
 * list is a type name to anybody reading it — the migration quotes it in its
 * CHECK for the same reason.
 */
export const INTENT_COLUMNS = sql.raw(
  'id, kind, return_request_id, to_email, subject, "text", html, created_at, sent_at, ' +
    'attempts, last_error',
);

export function rowToIntent(row: Record<string, unknown>): MarketingEmailIntent {
  return {
    id: String(row.id),
    kind: row.kind as EmailIntentKind,
    returnRequestId: String(row.return_request_id),
    to: String(row.to_email),
    subject: String(row.subject),
    text: String(row.text),
    html: String(row.html),
    createdAt: toEpochMs(row.created_at),
    sentAt: toEpochMsOrNull(row.sent_at),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

/**
 * The argument type of `Mailer.send`, derived rather than restated.
 *
 * The `labels.ts` reason: a port that grows a required field must break the one
 * place that builds its argument, at compile time, instead of being discovered
 * by a message that arrives missing something.
 */
export type OutboundMessage = Parameters<Mailer['send']>[0];

/**
 * The stored row, as a message — a copy of four columns and NOTHING ELSE.
 *
 * THE ONE ROUTE FROM A ROW TO A TRANSPORT, and it is this small on purpose.
 * Every alternative shape ("render the intent", "format the body") is an
 * invitation to consult the program row at delivery time, which is how a
 * customer who returned six canisters in March receives, in June, a letter about
 * whatever the programme is called now. Both parts travel: `server/mail/port.ts`
 * requires `text` AND `html` so no client is left with only one, and both were
 * written together at the instant the award happened.
 */
export function toMessage(intent: MarketingEmailIntent): OutboundMessage {
  return {
    to: intent.to,
    subject: intent.subject,
    text: intent.text,
    html: intent.html,
  };
}
