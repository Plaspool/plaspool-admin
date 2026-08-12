import { sql } from 'drizzle-orm';
import { toEpochMs, toEpochMsOrNull } from '../../../db/client';
import type { Db } from '../../../db/client';
import type { EmailKind, Mailer } from '../mailer';

/**
 * The email outbox sweeper (brief §5).
 *
 * THE INTENT IS ALREADY WRITTEN WHEN THIS RUNS. Every transition that mails a
 * customer inserts the rendered message in the SAME STATEMENT as the state change
 * (`repo/orders.ts`, `repo/fulfillments.ts`), so this file never decides *whether* a
 * message is owed — only whether it has been handed to a provider yet. That split is
 * the whole design:
 *
 * - **A mailer failure must never roll back a paid order.** The order committed in a
 *   different statement, minutes earlier. There is no code path from here back to
 *   `shop_orders`, which is the strongest form of that guarantee — not a `catch`
 *   somebody could remove.
 * - **A paid order must not depend on an email provider being up.** The capture
 *   commits whether or not this sweeper ever runs.
 *
 * NOTHING HERE THROWS. A `Mailer` that rejects is recorded on the row and the sweep
 * continues to the next intent: one bad address must not stop every other customer's
 * mail, and an exception escaping a cron handler is a sweep that stops at its first
 * problem forever.
 */

/** How many intents one sweep will attempt. Bounds the work, not the queue. */
export const EMAIL_SWEEP_LIMIT = 50;

/**
 * After this many failed attempts an intent stops being retried.
 *
 * NOT A DELETE, AND THE ROW STAYS VISIBLE with its `last_error`. An address that is
 * permanently undeliverable would otherwise consume the whole sweep budget forever,
 * starving every other message — which is the tight-retry failure GAUNTLET I Round 1
 * #2 recorded, in slow motion. Recovery is `UPDATE … SET attempts = 0`, deliberately
 * a human decision.
 */
export const EMAIL_ATTEMPT_LIMIT = 8;

export interface EmailIntent {
  id: string;
  orderId: string;
  kind: EmailKind;
  to: string;
  subject: string;
  body: string;
  createdAt: number;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
}

function rowToIntent(row: Record<string, unknown>): EmailIntent {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    kind: row.kind as EmailKind,
    to: String(row.to_email),
    subject: String(row.subject),
    body: String(row.body),
    createdAt: toEpochMs(row.created_at),
    sentAt: toEpochMsOrNull(row.sent_at),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

const INTENT_COLUMNS = sql.raw(
  'id, order_id, kind, to_email, subject, body, created_at, sent_at, attempts, last_error',
);

/** Every intent for one order, newest last. For the admin order view and for tests. */
export async function listIntents(db: Db, orderId: string): Promise<EmailIntent[]> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM shop_order_email_intents
     WHERE order_id = ${orderId} ORDER BY created_at ASC, id ASC`);
  return res.rows.map(rowToIntent);
}

export interface SweepSummary {
  sent: number;
  failed: number;
  /** Claimed by another sweeper between the read and the claim. */
  skipped: number;
}

/**
 * Deliver what is owed. Returns counts and never throws.
 *
 * THE CLAIM IS A CAS ON `attempts`, WHICH IS WHY THERE IS NO LEASE COLUMN.
 *
 * Two sweepers running at once both read `attempts = 0`; both then try
 * `SET attempts = 1 WHERE attempts = 0`, and exactly one matches. The loser skips the
 * row without sending, so concurrent sweeps cannot double-deliver — the property a
 * `claimed_at` column is usually added for, obtained from a column that had to exist
 * anyway.
 *
 * WHAT REMAINS, STATED PLAINLY: if the process dies between the claim and the
 * `sent_at` write, the next sweep retries and the customer may receive the message
 * twice. That is the irreducible at-least-once property of an outbox without a
 * distributed transaction across the provider, and contract §6 rule 2 says the same
 * thing about events. It is bounded to a crash window rather than being a race any
 * two sweepers can lose.
 */
export async function sweepEmailIntents(
  db: Db,
  mailer: Mailer,
  now: number,
  limit: number = EMAIL_SWEEP_LIMIT,
): Promise<SweepSummary> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM shop_order_email_intents
     WHERE sent_at IS NULL AND attempts < ${EMAIL_ATTEMPT_LIMIT}
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit}`);

  const summary: SweepSummary = { sent: 0, failed: 0, skipped: 0 };

  for (const row of res.rows) {
    const intent = rowToIntent(row);

    const claimed = await db.execute(sql`
      UPDATE shop_order_email_intents
         SET attempts = attempts + 1
       WHERE id = ${intent.id} AND sent_at IS NULL AND attempts = ${intent.attempts}
      RETURNING id`);
    if (claimed.rows.length === 0) {
      summary.skipped += 1;
      continue;
    }

    try {
      await mailer.send({ to: intent.to, subject: intent.subject, body: intent.body });
      await db.execute(sql`
        UPDATE shop_order_email_intents
           SET sent_at = ${now}, last_error = NULL
         WHERE id = ${intent.id} AND sent_at IS NULL`);
      summary.sent += 1;
    } catch (err: unknown) {
      /*
       * THE MESSAGE, NOT THE ERROR OBJECT, AND CAPPED. `server/middleware/errors.ts`
       * makes the same choice for the same reason: an error object passed whole to a
       * log can carry a `params` or a `query` property, and a provider's rejection
       * can quote the address it refused. A recipient address is already in the row;
       * a provider's prose about it does not need to be, at length.
       */
      const detail = (err instanceof Error ? err.message : 'send failed').slice(0, 500);
      await db.execute(sql`
        UPDATE shop_order_email_intents SET last_error = ${detail} WHERE id = ${intent.id}`);
      summary.failed += 1;
    }
  }

  return summary;
}
