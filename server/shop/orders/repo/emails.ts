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
  /** The designed HTML part (migration 0320). `null` on rows written before it,
   * which the sweeper delivers by deriving one from `body` exactly as the old
   * code always did — see `portMailer` in `../mailer.ts`. */
  html: string | null;
  createdAt: number;
  sentAt: number | null;
  attempts: number;
  lastError: string | null;
  /** An operator gave up on this unsent intent (migration 0660). The sweeper
   * skips it and the backlog stops counting it; retry clears it. */
  dismissedAt: number | null;
}

function rowToIntent(row: Record<string, unknown>): EmailIntent {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    kind: row.kind as EmailKind,
    to: String(row.to_email),
    subject: String(row.subject),
    body: String(row.body),
    html: row.html == null ? null : String(row.html),
    createdAt: toEpochMs(row.created_at),
    sentAt: toEpochMsOrNull(row.sent_at),
    attempts: Number(row.attempts),
    lastError: row.last_error == null ? null : String(row.last_error),
    dismissedAt: toEpochMsOrNull(row.dismissed_at),
  };
}

const INTENT_COLUMNS = sql.raw(
  'id, order_id, kind, to_email, subject, body, html, created_at, sent_at, attempts, last_error, dismissed_at',
);

/** Every intent for one order, newest last. For the admin order view and for tests. */
export async function listIntents(db: Db, orderId: string): Promise<EmailIntent[]> {
  const res = await db.execute(sql`
    SELECT ${INTENT_COLUMNS} FROM shop_order_email_intents
     WHERE order_id = ${orderId} ORDER BY created_at ASC, id ASC`);
  return res.rows.map(rowToIntent);
}

/**
 * The four ways the outbox screen slices intents (migration 0660's range).
 *
 * `attention` is the row the Home banner counts: unsent, out of retries, and
 * not yet dismissed. `queued` is everything the sweeper will still try. The
 * four are disjoint and cover the table, so the screen's tab counts sum to the
 * row count and an intent is never in two tabs at once.
 */
export type OutboxBucket = 'attention' | 'queued' | 'sent' | 'dismissed';

/** An intent joined with the one order fact the list screen needs. */
export interface OutboxItem extends EmailIntent {
  orderNumber: string;
}

function bucketPredicate(bucket: OutboxBucket) {
  switch (bucket) {
    case 'attention':
      return sql`i.sent_at IS NULL AND i.dismissed_at IS NULL
                 AND i.attempts >= ${EMAIL_ATTEMPT_LIMIT}`;
    case 'queued':
      return sql`i.sent_at IS NULL AND i.dismissed_at IS NULL
                 AND i.attempts < ${EMAIL_ATTEMPT_LIMIT}`;
    case 'sent':
      return sql`i.sent_at IS NOT NULL`;
    case 'dismissed':
      return sql`i.sent_at IS NULL AND i.dismissed_at IS NOT NULL`;
  }
}

/** How many rows the outbox screen shows per bucket. The table is small by
 * construction (a handful of intents per order), so this bounds pathology, not
 * everyday use. */
export const OUTBOX_LIMIT = 200;

/**
 * Cross-order intent list for the outbox screen, newest first.
 *
 * NEWEST FIRST, unlike the sweeper's oldest-first: the operator arrives from an
 * alert about what just went wrong, and the sweeper's fairness ordering would
 * put that at the bottom.
 */
export async function listOutbox(
  db: Db,
  bucket: OutboxBucket,
  limit: number = OUTBOX_LIMIT,
): Promise<OutboxItem[]> {
  const res = await db.execute(sql`
    SELECT i.id, i.order_id, i.kind, i.to_email, i.subject, i.body, i.html,
           i.created_at, i.sent_at, i.attempts, i.last_error, i.dismissed_at,
           o.order_number
      FROM shop_order_email_intents i
      JOIN shop_orders o ON o.id = i.order_id
     WHERE ${bucketPredicate(bucket)}
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ${limit}`);
  return res.rows.map((row) => ({
    ...rowToIntent(row),
    orderNumber: String(row.order_number),
  }));
}

/** One grouped scan for the outbox tabs, so the counts and the rows come from
 * the same predicates and cannot drift. */
export async function countOutbox(db: Db): Promise<Record<OutboxBucket, number>> {
  const res = await db.execute(sql`
    SELECT count(*) FILTER (WHERE i.sent_at IS NULL AND i.dismissed_at IS NULL
                              AND i.attempts >= ${EMAIL_ATTEMPT_LIMIT})::int AS attention,
           count(*) FILTER (WHERE i.sent_at IS NULL AND i.dismissed_at IS NULL
                              AND i.attempts < ${EMAIL_ATTEMPT_LIMIT})::int AS queued,
           count(*) FILTER (WHERE i.sent_at IS NOT NULL)::int AS sent,
           count(*) FILTER (WHERE i.sent_at IS NULL AND i.dismissed_at IS NOT NULL)::int
             AS dismissed
      FROM shop_order_email_intents i`);
  const row = res.rows[0] ?? {};
  return {
    attention: Number(row.attention ?? 0),
    queued: Number(row.queued ?? 0),
    sent: Number(row.sent ?? 0),
    dismissed: Number(row.dismissed ?? 0),
  };
}

/**
 * The documented recovery (`UPDATE … SET attempts = 0`), with a session instead
 * of a psql prompt. Also clears a dismissal — the two verbs invert each other.
 *
 * UNSENT ROWS ONLY. Retrying a sent intent would re-deliver a message the
 * customer already has, so a sent id answers `false` and the route 404s rather
 * than quietly double-sending.
 */
export async function retryIntent(db: Db, id: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE shop_order_email_intents
       SET attempts = 0, dismissed_at = NULL
     WHERE id = ${id} AND sent_at IS NULL
    RETURNING id`);
  return res.rows.length > 0;
}

/**
 * "Stop counting this at me." Unsent rows only, idempotent on repeat — the
 * second dismiss finds `dismissed_at` already set and keeps the FIRST time, so
 * the audit answer to "when did we give up" never moves.
 */
export async function dismissIntent(db: Db, id: string, now: number): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE shop_order_email_intents
       SET dismissed_at = COALESCE(dismissed_at, ${now})
     WHERE id = ${id} AND sent_at IS NULL
    RETURNING id`);
  return res.rows.length > 0;
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
       AND dismissed_at IS NULL
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
      await mailer.send({
        to: intent.to,
        subject: intent.subject,
        body: intent.body,
        html: intent.html,
      });
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
